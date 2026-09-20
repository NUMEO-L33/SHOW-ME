import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import express from "express";
import request from "supertest";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { analysisManifest, initialDraft } from "../src/processor/analysis-contract.js";
import { createDraftRouter } from "../src/processor/draft-api.js";
import { privacyAfterEdit } from "../src/processor/privacy-review.js";

async function harness(t: TestContext, frames = 2) {
  const h = await createAnalysisHarness(t, frames), manifest = analysisManifest(h.guide);
  await h.repository.executeAnalysisCommand(h.guideId, { type: "save-editor-draft", expectedRevision: 0,
    expectedInputFingerprint: manifest.fingerprint, document: initialDraft(manifest) });
  const app = express(), url = `/api/guides/${h.guideId}/draft/privacy`;
  app.use("/api/guides/:guideId/draft", createDraftRouter({ repository: h.repository, authenticate: async req => {
    const guide = await h.repository.getGuideById(req.params.guideId as string);
    if (!guide || req.header("Authorization") !== "Bearer fixture-token") throw Object.assign(new Error("private"), { code: "GUIDE_NOT_FOUND" });
    return guide;
  } }));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(404).json({ code: "GUIDE_NOT_FOUND" }); });
  const headers = { Authorization: "Bearer fixture-token" };
  const current = (await request(app).get(url).set(headers).expect(200)).body;
  const body = { type: "review-privacy", expectedRevision: 1, expectedInputFingerprint: manifest.fingerprint,
    expectedReviewFingerprint: current.review.fingerprint, mutationId: randomUUID(), action: { type: "title", confirmed: true } };
  return { ...h, app, url, headers, body, current };
}

test("private review GET is read-only and owner-only; POST acknowledges a revision and replay exactly once", async t => {
  const h = await harness(t), before = await readFile(h.repository.filePath);
  const response = await request(h.app).get(h.url).set(h.headers).expect(200);
  assert.equal(response.headers["cache-control"], "no-store");
  for (const forbidden of ["fixture-token", "ObjectKey", "media-a", "private-fixture.mp4"]) assert.ok(!response.text.includes(forbidden));
  assert.deepEqual(await readFile(h.repository.filePath), before);
  for (const path of [h.url, `${h.url}?editToken=fixture-token`]) {
    await request(h.app).get(path).expect(404);
    await request(h.app).post(path).send(h.body).expect(404);
  }
  await request(h.app).get(h.url).set("Authorization", "Bearer wrong").expect(404);
  const saved = await request(h.app).post(h.url).set(h.headers).send(h.body).expect(200);
  assert.equal(saved.body.draft.revision, 2); assert.equal(saved.body.review.titleConfirmed, true);
  assert.equal(saved.body.review.complete, false); assert.equal(saved.body.review.publicationEnabled, false);
  assert.deepEqual((await request(h.app).post(h.url).set(h.headers).send(h.body).expect(200)).body, saved.body);
  assert.equal((await request(h.app).get(h.url.replace(/\/privacy$/, "")).set(h.headers).expect(200)).body.draft.document.schemaVersion, 2);
});

test("malformed, oversized, wrong snapshot and URL credentials fail without exposing input", async t => {
  const h = await harness(t);
  await request(h.app).post(h.url).set(h.headers).type("text").send("private-data").expect(415);
  await request(h.app).post(h.url).set(h.headers).type("json").send('{"private-data":').expect(400);
  await request(h.app).post(h.url).set(h.headers).send({ extra: "x".repeat(9_000) }).expect(413);
  await request(h.app).post(`${h.url}?asset_token=private`).set(h.headers).send(h.body).expect(400);
  await request(h.app).get(`${h.url}?asset_token=private`).set(h.headers).expect(400);
  await request(h.app).post(h.url).set(h.headers).send({ ...h.body, originalUrl: "private" }).expect(400);
  for (const changed of [{ expectedRevision: 8 }, { expectedReviewFingerprint: "a".repeat(64) }, { expectedInputFingerprint: "a".repeat(64) }]) {
    const response = await request(h.app).post(h.url).set(h.headers).send({ ...h.body, ...changed }).expect(409);
    assert.ok(!response.text.includes("private-data"));
  }
  assert.equal((await h.repository.getAnalysisState(h.guideId))!.draft!.revision, 1);
});

test("concurrent different privacy decisions do not overwrite; storage failure is not a confirmation", async t => {
  const h = await harness(t);
  const responses = await Promise.all([h.body, { ...h.body, mutationId: randomUUID(), action: { type: "text", stepId: "step-0", confirmed: true } }]
    .map(body => request(h.app).post(h.url).set(h.headers).send(body)));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const state = await h.repository.getAnalysisState(h.guideId);
  t.mock.method(h.repository, "executeAnalysisCommand", async () => { throw new Error("postgresql://private-key@host"); });
  const failed = await request(h.app).post(h.url).set(h.headers).send(h.body).expect(503);
  assert.ok(!failed.text.includes("private-key")); assert.deepEqual(await h.repository.getAnalysisState(h.guideId), state);
});

test("deletion while reading or after a review write suppresses late responses", async t => {
  const h = await harness(t), get = h.repository.getAnalysisState.bind(h.repository);
  t.mock.method(h.repository, "getAnalysisState", async (id: string) => { const state = await get(id); await h.repository.deleteGuide(id); return state; });
  await request(h.app).get(h.url).set(h.headers).expect(404);
  await request(h.app).post(h.url).set(h.headers).send(h.body).expect(404);
});

test("a maximum-step draft with twenty masks per frame remains editable after v2 confirmation metadata is added", async t => {
  const h = await harness(t, 24), document = structuredClone(h.current.draft.document);
  for (const step of document.steps) step.elements = Array.from({ length: 20 }, (_, i) => ({
    id: `${step.id}:mask:${i}:${"x".repeat(80)}`, type: "privacy-mask", enabled: true, visible: true, zIndex: 20,
    bounds: { x: i, y: 20, width: 20, height: 20 },
  }));
  const body = { expectedRevision: 1, inputFingerprint: h.current.draft.inputFingerprint, document };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 64 * 1024);
  await request(h.app).put(h.url.replace(/\/privacy$/, "")).set(h.headers).send(body).expect(200);
  const latest = (await request(h.app).get(h.url).set(h.headers).expect(200)).body;
  const confirmed = (await request(h.app).post(h.url).set(h.headers).send({ ...h.body, expectedRevision: 2,
    expectedReviewFingerprint: latest.review.fingerprint }).expect(200)).body.draft;
  const changed = structuredClone(confirmed.document); changed.title = "가림이 많은 합성 가이드";
  changed.privacy = privacyAfterEdit(confirmed.document, changed);
  const saved = await request(h.app).put(h.url.replace(/\/privacy$/, "")).set(h.headers).send({
    expectedRevision: confirmed.revision, inputFingerprint: confirmed.inputFingerprint, document: changed }).expect(200);
  assert.equal(saved.body.draft.document.privacy.titleFingerprint, null);
});
