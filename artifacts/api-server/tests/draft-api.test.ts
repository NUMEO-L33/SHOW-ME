import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import request from "supertest";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { loadConfig } from "../src/processor/config.js";
import { createProcessorApp } from "../src/processor/server.js";
import { LocalStorage } from "../src/processor/storage.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { analysisManifest, initialDraft } from "../src/processor/analysis-contract.js";
import { emptyAnalysisState } from "../src/processor/analysis-state.js";
import { emptyFundingLedger } from "../src/processor/analysis-funding.js";
import { postgresAccountingFixture } from "./helpers/accounting-postgres-fixture.js";
import { guideDrafts, guides } from "../src/processor/db/schema.js";

async function harness(t: TestContext) {
  const token = randomBytes(32).toString("base64url");
  const h = await createAnalysisHarness(t, 3, { guideId: randomUUID(), editToken: token });
  const storage = new LocalStorage(join(h.root, "objects"));
  t.mock.method(storage, "openRead", async () => { throw new Error("Draft editing must not read an image"); });
  const config = loadConfig({ NODE_ENV: "test", DATA_DIR: h.root, SHOWME_STORAGE: "local", CORS_ORIGINS: "http://localhost:3000" });
  const app = createProcessorApp({ config, storage, repository: h.repository,
    pipeline: { async process() { throw new Error("no processing"); }, async processClaimed() { throw new Error("no processing"); } },
    analysisAdmission: { async request() { throw new Error("no AI admission"); } },
  });
  const url = `/api/guides/${h.guideId}/draft`;
  const auth = `Bearer ${token}`;
  const fingerprint = analysisManifest(h.guide).fingerprint;
  const document = { ...initialDraft(analysisManifest(h.guide)), title: "사진 보내기", intent: { goal: "사진 보내기", audience: "처음 사용하는 분", notes: "추측 금지" } };
  const body = { expectedRevision: 0, inputFingerprint: fingerprint, document };
  return { ...h, app, url, auth, token, body };
}

test("draft GET is owner-only, read-only, no-store and does not initialize AI or expose private metadata", async t => {
  const h = await harness(t);
  const before = await readFile(h.repository.filePath, "utf8");
  const response = await request(h.app).get(h.url).set("Authorization", h.auth).expect(200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.draft.persisted, false);
  assert.equal(response.body.draft.revision, 0);
  assert.equal(response.body.draft.document.steps.length, 3);
  assert.equal(await readFile(h.repository.filePath, "utf8"), before);
  for (const secret of [h.token, h.guide.editTokenHash, "ObjectKey", "mediaAttempt", "media-a", "guides/"]) assert.ok(!response.text.includes(secret));
  for (const auth of ["", `Bearer ${randomBytes(32).toString("base64url")}`]) {
    await request(h.app).get(`${h.url}?editToken=${h.token}`).set("Authorization", auth).expect(404);
    await request(h.app).put(h.url).set("Authorization", auth).send(h.body).expect(404);
  }
  assert.equal(await readFile(h.repository.filePath, "utf8"), before);
});

test("human title, intent, text, tap and merged/deleted steps persist atomically and survive repository reopen", async t => {
  const h = await harness(t);
  const [a, b] = h.body.document.steps;
  const document = { ...h.body.document, steps: [{ ...b, id: a.id, sourceStepIds: [a.id, b.id], instruction: "확인 버튼을 누르세요.",
    elements: [{ id: "tap-one", type: "tap", center: { x: 20, y: 70 }, radius: 5, zIndex: 10, visible: true }] }] };
  const response = await request(h.app).put(h.url).set("Authorization", h.auth).send({ ...h.body, document }).expect(200);
  assert.equal(response.body.draft.revision, 1);
  assert.equal(response.body.draft.persisted, true);
  assert.deepEqual(response.body.draft.document, document);
  const reopened = new JsonGuideRepository(h.repository.filePath);
  assert.deepEqual((await reopened.getAnalysisState(h.guideId))?.draft?.document, document);
  assert.deepEqual((await reopened.getAnalysisState(h.guideId))?.runs, []);
  assert.deepEqual(await reopened.getGuideById(h.guideId), h.guide);
  assert.deepEqual((await request(h.app).get(h.url).set("Authorization", h.auth).expect(200)).body.draft, response.body.draft);
});

test("lost acknowledgement replay is idempotent; concurrent different editors cannot overwrite a winner", async t => {
  const h = await harness(t);
  const other = { ...h.body, document: { ...h.body.document, title: "다른 창" } };
  const results = await Promise.all([h.body, other].map(body => request(h.app).put(h.url).set("Authorization", h.auth).send(body)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const won = results[0].status === 200 ? h.body : other;
  const snapshot = results.find(r => r.status === 200)!.body.draft;
  assert.deepEqual((await request(h.app).put(h.url).set("Authorization", h.auth).send(won).expect(200)).body.draft, snapshot);
  await request(h.app).put(h.url).set("Authorization", h.auth).send({ ...won, expectedRevision: 1, document: { ...won.document, title: "후속 편집" } }).expect(200);
  await request(h.app).put(h.url).set("Authorization", h.auth).send(won).expect(409);
  assert.equal((await h.repository.getAnalysisState(h.guideId))?.draft?.revision, 2);
});

test("invalid fields, foreign frames, duplicate sources, privacy approval, coordinates and oversized values cannot persist", async t => {
  const h = await harness(t);
  const step = h.body.document.steps[0];
  const invalidDocuments = [
    { ...h.body.document, title: "" }, { ...h.body.document, title: "x".repeat(121) },
    { ...h.body.document, title: "<script>" }, { ...h.body.document, intent: { ...h.body.document.intent, notes: "x".repeat(1001) } },
    { ...h.body.document, steps: [] }, { ...h.body.document, steps: [{ ...step, activeFrameStepId: "foreign" }] },
    { ...h.body.document, steps: [{ ...step, frameUrl: "https://private.invalid/image" }] },
    { ...h.body.document, steps: [{ ...step, privacyReview: "approved" }] },
    { ...h.body.document, steps: [{ ...step, instruction: "x".repeat(501) }] },
    { ...h.body.document, steps: [step, { ...step, id: "different-id" }] },
    { ...h.body.document, steps: [{ ...step, elements: [{ id: "tap", type: "tap", center: { x: 101, y: 0 }, radius: 5, zIndex: 1, visible: true }] }] },
  ];
  for (const document of invalidDocuments) await request(h.app).put(h.url).set("Authorization", h.auth).send({ ...h.body, document }).expect(400);
  await request(h.app).put(h.url).set("Authorization", h.auth).send({ ...h.body, provider: "gemini" }).expect(400);
  assert.equal((await h.repository.getAnalysisState(h.guideId))?.draft, null);
});

test("draft requests reject non-JSON, broken JSON and large bodies without echoing input", async t => {
  const h = await harness(t);
  await request(h.app).put(h.url).set("Authorization", h.auth).type("text").send("private-input").expect(415);
  const broken = await request(h.app).put(h.url).set("Authorization", h.auth).type("json").send('{"secret":"private-input"').expect(400);
  assert.ok(!broken.text.includes("private-input"));
  await request(h.app).put(h.url).set("Authorization", h.auth).send({ x: "x".repeat(70_000) }).expect(413);
  const preflight = await request(h.app).options(h.url).set("Origin", "http://localhost:3000").set("Access-Control-Request-Method", "PUT").expect(204);
  assert.ok(preflight.headers["access-control-allow-methods"].includes("PUT"));
});

test("media replacement and deletion fence editing; whole-guide deletion removes the server draft", async t => {
  const h = await harness(t);
  await request(h.app).put(h.url).set("Authorization", h.auth).send(h.body).expect(200);
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map(step => ({ ...step, representativeFrameKey: `${step.id}-changed.jpg` })));
  await request(h.app).get(h.url).set("Authorization", h.auth).expect(409);
  await request(h.app).put(h.url).set("Authorization", h.auth).send({ ...h.body, expectedRevision: 1 }).expect(409);
  await h.repository.updateStatus(h.guideId, "failed", { errorCode: "DELETION_PENDING" });
  await request(h.app).put(h.url).set("Authorization", h.auth).send(h.body).expect(409);
  await request(h.app).delete(`/api/guides/${h.guideId}`).set("Authorization", h.auth).expect(204);
  assert.equal(await h.repository.getAnalysisState(h.guideId), null);
  await request(h.app).get(h.url).set("Authorization", h.auth).expect(404);
});

test("a deletion while awaiting draft state cannot expose a late draft response", async t => {
  const h = await harness(t);
  const read = h.repository.getAnalysisState.bind(h.repository);
  t.mock.method(h.repository, "getAnalysisState", async (id: string) => {
    const value = await read(id);
    await h.repository.deleteGuide(id);
    return value;
  });
  await request(h.app).get(h.url).set("Authorization", h.auth).expect(404);
});

test("repository failures and missing schema do not pretend to save or leak inner connection errors", async t => {
  const h = await harness(t);
  t.mock.method(h.repository, "executeAnalysisCommand", async () => { throw new Error("postgresql://private:secret@private-host private-note"); });
  const response = await request(h.app).put(h.url).set("Authorization", h.auth).send(h.body).expect(503);
  assert.equal(response.body.code, "DRAFT_UNAVAILABLE");
  assert.ok(!response.text.includes("private"));
  assert.equal((await h.repository.getAnalysisState(h.guideId))?.draft, null);
});

test("Postgres editor path holds the parent lock and rolls back failed draft writes (transaction double)", async t => {
  const h = await harness(t);
  const fixture = postgresAccountingFixture(h.guide, emptyAnalysisState(), emptyFundingLedger());
  const command = { type: "save-editor-draft" as const, expectedRevision: 0, expectedInputFingerprint: h.body.inputFingerprint, document: h.body.document };
  const result = await fixture.repository.executeAnalysisCommand(h.guideId, command);
  assert.equal(result?.draft?.revision, 1);
  assert.ok(fixture.locks.some(lock => lock.table === guides && lock.mode === "update"));
  assert.deepEqual(fixture.writes, [guideDrafts]);
  fixture.failWrite(guideDrafts);
  await assert.rejects(fixture.repository.executeAnalysisCommand(h.guideId, { ...command, expectedRevision: 1, document: { ...h.body.document, title: "실패할 편집" } }));
  assert.deepEqual((await fixture.repository.getAnalysisState(h.guideId))?.draft, result?.draft);
});
