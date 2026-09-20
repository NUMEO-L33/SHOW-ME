import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import express from "express";
import request from "supertest";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { analysisManifest, initialDraft } from "../src/processor/analysis-contract.js";
import { attemptFrameObjectKey } from "../src/processor/asset-lifecycle.js";
import { createPrivacyPreviewRouter } from "../src/processor/privacy-preview-api.js";
import { encodePrivacyPng, type renderPrivateRedaction } from "../src/processor/privacy-render.js";

async function harness(t: TestContext) {
  const token = randomBytes(32).toString("base64url");
  const h = await createAnalysisHarness(t, 2, { guideId: randomUUID(), editToken: token });
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map(step => ({ ...step,
    representativeFrameKey: attemptFrameObjectKey(h.guideId, 1, step.position + 1, "frame") })));
  const guide = (await h.repository.getGuideById(h.guideId))!, manifest = analysisManifest(guide);
  const document = initialDraft(manifest);
  document.steps[0].elements = [{ id: "mask", type: "privacy-mask", enabled: true, visible: false, zIndex: 0,
    bounds: { x: 20, y: 30, width: 30, height: 20 } }];
  await h.repository.executeAnalysisCommand(h.guideId, { type: "save-editor-draft", expectedRevision: 0, expectedInputFingerprint: manifest.fingerprint, document });
  const seen: Parameters<typeof renderPrivateRedaction>[0][] = [];
  let afterRender: (() => Promise<void>) | undefined, reads = 0;
  const app = express();
  const openRead = async (key: string) => { reads++; assert.equal(key, guide.steps[0].representativeFrameKey); return Readable.from([Buffer.from("fixture")]); };
  const storage = { openRead };
  app.use(`/api/guides/:guideId/privacy-preview`, createPrivacyPreviewRouter({ repository: h.repository, storage, ffmpegPath: "fixture",
    authenticate: async req => {
      if (req.header("authorization") !== `Bearer ${token}`) throw Object.assign(new Error("denied"), { code: "GUIDE_NOT_FOUND" });
      const current = await h.repository.getGuideById(req.params.guideId as string);
      if (!current) throw Object.assign(new Error("denied"), { code: "GUIDE_NOT_FOUND" }); return current;
    },
    render: async input => { seen.push(input); await afterRender?.(); return encodePrivacyPng(Buffer.alloc(3), 1, 1); },
  }));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(404).json({ code: "GUIDE_NOT_FOUND" }); });
  const url = `/api/guides/${h.guideId}/privacy-preview/${document.steps[0].id}/frame`;
  const headers = { Authorization: `Bearer ${token}`, "X-ShowMe-Draft-Revision": "1", "X-ShowMe-Input-Fingerprint": manifest.fingerprint };
  return { ...h, guide, manifest, document, app, url, headers, storage, seen, reads: () => reads, after: (callback: () => Promise<void>) => { afterRender = callback; } };
}

test("saved owner preview renders enabled masks even when hidden and never alters source/draft", async t => {
  const h = await harness(t), before = await readFile(h.repository.filePath);
  const response = await request(h.app).get(h.url).set(h.headers).expect(200);
  assert.equal(response.headers["content-type"], "image/png"); assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-showme-draft-revision"], "1");
  assert.deepEqual(h.seen[0].masks, [{ x: 20, y: 30, width: 30, height: 20 }]);
  assert.equal(h.seen[0].width, 640); assert.equal(h.seen[0].height, 360);
  assert.deepEqual(await readFile(h.repository.filePath), before);
  await request(h.app).get(h.url.replace(/frame$/, "thumbnail")).set(h.headers).expect(200);
  assert.equal(h.seen[1].variant, "thumbnail"); assert.equal(h.reads(), 2);
});

test("missing/wrong owner, arbitrary queries/variants and stale revision/fingerprint never read storage", async t => {
  const h = await harness(t);
  await request(h.app).get(h.url).expect(404);
  await request(h.app).get(h.url).set({ ...h.headers, Authorization: "Bearer wrong" }).expect(404);
  await request(h.app).get(`${h.url}?asset_token=anything`).set(h.headers).expect(400);
  await request(h.app).get(h.url.replace(/frame$/, "original")).set(h.headers).expect(400);
  for (const headers of [{ ...h.headers, "X-ShowMe-Draft-Revision": "0" }, { ...h.headers, "X-ShowMe-Draft-Revision": "01" }])
    await request(h.app).get(h.url).set(headers).expect(400);
  await request(h.app).get(h.url).set({ ...h.headers, "X-ShowMe-Draft-Revision": "2" }).expect(409);
  await request(h.app).get(h.url).set({ ...h.headers, "X-ShowMe-Input-Fingerprint": "f".repeat(64) }).expect(409);
  assert.equal(h.reads(), 0); assert.equal(h.seen.length, 0);
});

test("concurrent draft changes fence completed images, and deleted guides cannot return pixels", async t => {
  const h = await harness(t);
  h.after(async () => { await h.repository.executeAnalysisCommand(h.guideId, { type: "save-editor-draft", expectedRevision: 1,
    expectedInputFingerprint: h.manifest.fingerprint, document: { ...h.document, title: "Changed during rendering" } }); });
  await request(h.app).get(h.url).set(h.headers).expect(409);
  h.after(async () => { await h.repository.deleteGuide(h.guideId); });
  await request(h.app).get(h.url).set({ ...h.headers, "X-ShowMe-Draft-Revision": "2" }).expect(404);
});

test("storage failure/oversize never leak error details or fall back to source pixels", async t => {
  const h = await harness(t);
  t.mock.method(h.storage, "openRead", async () => { throw new Error("private object key and secret"); });
  const response = await request(h.app).get(h.url).set(h.headers).expect(503);
  assert.ok(!response.text.includes("secret")); assert.equal(h.seen.length, 0);
  t.mock.restoreAll();
  t.mock.method(h.storage, "openRead", async () => Readable.from([Buffer.alloc(2 * 1024 * 1024 + 1)]));
  await request(h.app).get(h.url).set(h.headers).expect(503); assert.equal(h.seen.length, 0);
});

test("deleted/merged-away draft steps and foreign frame keys are not previewable", async t => {
  const h = await harness(t);
  await h.repository.executeAnalysisCommand(h.guideId, { type: "save-editor-draft", expectedRevision: 1,
    expectedInputFingerprint: h.manifest.fingerprint, document: { ...h.document, steps: [h.document.steps[1]] } });
  await request(h.app).get(h.url).set({ ...h.headers, "X-ShowMe-Draft-Revision": "2" }).expect(404);
  assert.equal(h.reads(), 0);
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map(step => ({ ...step, representativeFrameKey: "another-guide/private.jpg" })));
  await request(h.app).get(h.url).set(h.headers).expect(409); assert.equal(h.reads(), 0);
});

test("disabled masks remain unredacted deliberately, not interpreted as approval", async t => {
  const h = await harness(t);
  const mask = h.document.steps[0].elements[0];
  if (mask.type !== "privacy-mask") throw new Error("fixture");
  mask.enabled = false;
  await h.repository.executeAnalysisCommand(h.guideId, { type: "save-editor-draft", expectedRevision: 1,
    expectedInputFingerprint: h.manifest.fingerprint, document: h.document });
  await request(h.app).get(h.url).set({ ...h.headers, "X-ShowMe-Draft-Revision": "2" }).expect(200);
  assert.deepEqual(h.seen[0].masks, []);
  assert.equal((await h.repository.getAnalysisState(h.guideId))?.draft?.document.steps[0].privacyReview, "pending");
});

test("one in-flight private preview rejects concurrent decoding rather than queueing work", async t => {
  const h = await harness(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  h.after(async () => { entered(); await hold; });
  const first = request(h.app).get(h.url).set(h.headers).then(result => result);
  await started;
  try { await request(h.app).get(h.url).set(h.headers).expect(503); assert.equal(h.reads(), 1); }
  finally { release(); }
  assert.equal((await first).status, 200);
});

test("timed-out storage keeps its slot until settlement and closes late streams without rendering", async t => {
  const h = await harness(t);
  let entered!: () => void, release!: (stream: Readable) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<Readable>(resolve => { release = resolve; });
  t.mock.method(h.storage, "openRead", async () => { entered(); return hold; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = request(h.app).get(h.url).set(h.headers).then(result => result);
  await started; t.mock.timers.tick(25_001);
  assert.equal((await first).status, 503);
  await request(h.app).get(h.url).set(h.headers).expect(503);
  const late = Readable.from([Buffer.from("private fixture")]); release(late);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(late.destroyed, true); assert.equal(h.seen.length, 0);
  t.mock.timers.reset(); t.mock.restoreAll();
  await request(h.app).get(h.url).set(h.headers).expect(200);
});
