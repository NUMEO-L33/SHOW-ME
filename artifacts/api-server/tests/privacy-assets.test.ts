import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { reviewedAssetFixture } from "./helpers/privacy-assets-fixture.js";
import { testMediaPaths } from "./helpers/media-binaries.js";
import { attemptFrameObjectKey, DELETION_PENDING, finalizeGuideDeletion } from "../src/processor/asset-lifecycle.js";
import { privacyAssetKeys, privacyAssetDigest, privacyAssetBatchSchema } from "../src/processor/privacy-assets.js";
import { writePrivateRedactions } from "../src/processor/privacy-asset-writer.js";
import { cleanupPrivateRedactions } from "../src/processor/privacy-asset-cleanup.js";
import { privacyAfterEdit } from "../src/processor/privacy-review.js";
import { encodePrivacyPng, renderPrivateRedaction } from "../src/processor/privacy-render.js";
import { LocalStorage } from "../src/processor/storage.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { syntheticAnalysisInput } from "../src/processor/gemini/synthetic.js";
import request from "supertest";
import { createProcessorApp } from "../src/processor/server.js";
import { loadConfig } from "../src/processor/config.js";

async function fixture(t: TestContext) {
  const token = randomBytes(32).toString("base64url");
  const h = await createAnalysisHarness(t, 1, { guideId: randomUUID(), editToken: token });
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map(s => ({ ...s,
    representativeFrameKey: attemptFrameObjectKey(h.guideId, 1, s.position + 1, "frame") })));
  const guide = (await h.repository.getGuideById(h.guideId))!;
  const reviewed = await reviewedAssetFixture(h.repository, guide);
  const storage = new LocalStorage(join(h.root, "objects"));
  const file = join(h.root, "synthetic.jpg"), source = Buffer.from((await syntheticAnalysisInput()).images[0].bytes);
  await writeFile(file, source); await storage.putFile(guide.steps[0].representativeFrameKey!, file);
  const options = { repository: h.repository, storage, guideId: h.guideId, ...reviewed.request,
    workDir: join(h.root, "work"), ffmpegPath: testMediaPaths().ffmpegPath, signal: new AbortController().signal };
  const reserve = () => h.repository.executePrivacyAssetCommand(h.guideId, { type: "reserve", id: randomUUID(), ...reviewed.request });
  const fastRender: typeof renderPrivateRedaction = async () => encodePrivacyPng(Buffer.alloc(3), 1, 1);
  return { ...h, ...reviewed, token, guide, storage, source, options, reserve, fastRender };
}
const bytes = async (storage: LocalStorage, key: string) => {
  const chunks: Buffer[] = []; for await (const chunk of await storage.openRead(key)) chunks.push(chunk);
  return Buffer.concat(chunks);
};

test("private redactions persist real PNG and thumbnail, verify read-back, reopen and preserve originals/draft", async t => {
  const h = await fixture(t), original = await bytes(h.storage, h.guide.steps[0].representativeFrameKey!);
  const batch = await writePrivateRedactions(h.options);
  assert.equal(batch.status, "ready"); assert.equal(batch.receipts.length, 2);
  const keys = privacyAssetKeys(batch); assert.ok(keys.every(k => k.includes("/private-redactions/") && k.endsWith(".png")));
  for (const [i, variant] of (["frame", "thumbnail"] as const).entries()) {
    const png = await bytes(h.storage, keys[i]);
    assert.equal(png.readUInt32BE(16), i === 0 ? 640 : 320);
    assert.equal(png.readUInt32BE(20), i === 0 ? 360 : 180);
    assert.deepEqual(png, await renderPrivateRedaction({ bytes: original, width: 640, height: 360, masks: batch.frames[0].masks,
      variant, ffmpegPath: h.options.ffmpegPath, signal: h.options.signal }));
    assert.equal(batch.receipts[i].sha256, privacyAssetDigest(png));
  }
  assert.deepEqual(await bytes(h.storage, h.guide.steps[0].representativeFrameKey!), original);
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), h.state);
  const reopened = new JsonGuideRepository(h.repository.filePath);
  assert.deepEqual(await reopened.listPrivacyAssetBatches(h.guideId), [batch]);
  assert.equal(await reopened.deleteGuide(h.guideId), false);
  assert.equal((await reopened.getGuideById(h.guideId))!.steps.length, 1);
});

test("reservation validates review/revision/source, bounds batches and never writes storage", async t => {
  const h = await fixture(t);
  for (const override of [{ revision: 1 }, { inputFingerprint: "0".repeat(64) }, { reviewFingerprint: "0".repeat(64) }])
    assert.equal(await h.repository.executePrivacyAssetCommand(h.guideId, { type: "reserve", id: randomUUID(), ...h.request, ...override }), null);
  for (let i = 0; i < 4; i++) assert.ok(await h.reserve());
  assert.equal(await h.reserve(), null);
  assert.equal(await cleanupPrivateRedactions(h.repository, h.storage, h.guideId), true);
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
});

test("only one writer claims; unknown writes block cleanup and guide removal, including after restart", async t => {
  const h = await fixture(t), batch = (await h.reserve())!;
  const claims = await Promise.all(Array.from({ length: 12 }, () => h.repository.executePrivacyAssetCommand(h.guideId,
    { type: "claim", id: batch.id, version: batch.version, writerId: randomUUID() })));
  assert.equal(claims.filter(Boolean).length, 1);
  const winner = claims.find(Boolean)!;
  const reopened = new JsonGuideRepository(h.repository.filePath);
  assert.equal(await cleanupPrivateRedactions(reopened, h.storage, h.guideId), false);
  assert.equal(await reopened.deleteGuide(h.guideId), false);
  assert.equal(await reopened.executePrivacyAssetCommand(h.guideId, { type: "settle", id: batch.id, writerId: randomUUID(), receipts: null }), null);
  assert.ok(await reopened.executePrivacyAssetCommand(h.guideId, { type: "settle", id: batch.id, writerId: winner.writerId!, receipts: null }));
  assert.equal(await cleanupPrivateRedactions(reopened, h.storage, h.guideId), true);
});

test("draft edit during writes rejects completion and cleans every reserved key", async t => {
  const h = await fixture(t); let once = false;
  const put = h.storage.putFile.bind(h.storage);
  t.mock.method(h.storage, "putFile", async (key: string, file: string) => {
    await put(key, file);
    if (!once) {
      once = true; const document = structuredClone(h.state.draft!.document); document.title = "Changed";
      document.privacy = privacyAfterEdit(h.state.draft!.document, document);
      await h.repository.executeAnalysisCommand(h.guideId, { type: "save-editor-draft", expectedRevision: h.request.revision,
        expectedInputFingerprint: h.request.inputFingerprint, document });
    }
  });
  await assert.rejects(writePrivateRedactions({ ...h.options, render: h.fastRender }), /PRIVACY_ASSET_WRITE_UNAVAILABLE/);
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
  assert.equal((await h.repository.getAnalysisState(h.guideId))!.draft!.document.title, "Changed");
});

for (const mode of ["partial-write", "corrupt-read", "source-error", "oversize-read", "render-error"] as const)
test(`private asset ${mode} fails closed, cleans ownership and never falls back to source`, async t => {
  const h = await fixture(t), put = h.storage.putFile.bind(h.storage), read = h.storage.openRead.bind(h.storage);
  const keys: string[] = [];
  t.mock.method(h.storage, "putFile", async (key: string, file: string) => { keys.push(key); await put(key, file);
    if (mode === "partial-write") throw new Error("private storage secret"); });
  t.mock.method(h.storage, "openRead", async (key: string) => {
    if (mode === "source-error") throw new Error("private key");
    if (mode === "oversize-read") return Readable.from([Buffer.alloc(2 * 1024 * 1024 + 1)]);
    if (mode === "corrupt-read" && key.includes("/private-redactions/")) return Readable.from([Buffer.from("corrupt")]);
    return read(key);
  });
  await assert.rejects(writePrivateRedactions({ ...h.options, render: mode === "render-error" ? async () => { throw new Error("private"); } : h.fastRender }),
    error => error instanceof Error && error.message === "PRIVACY_ASSET_WRITE_UNAVAILABLE" && error.cause === undefined);
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
  t.mock.restoreAll(); for (const key of keys) await assert.rejects(h.storage.openRead(key));
  assert.deepEqual(await bytes(h.storage, h.guide.steps[0].representativeFrameKey!), h.source);
});

test("delete failure retains the exact durable cleanup ledger for retry", async t => {
  const h = await fixture(t), batch = await writePrivateRedactions({ ...h.options, render: h.fastRender });
  t.mock.method(h.storage, "delete", async () => { throw new Error("unavailable"); });
  await assert.rejects(cleanupPrivateRedactions(h.repository, h.storage, h.guideId));
  assert.equal((await h.repository.listPrivacyAssetBatches(h.guideId))[0].status, "cleanup");
  assert.equal(await h.repository.deleteGuide(h.guideId), false);
  t.mock.restoreAll(); assert.equal(await cleanupPrivateRedactions(h.repository, h.storage, h.guideId), true);
  for (const key of privacyAssetKeys(batch)) await assert.rejects(h.storage.openRead(key));
});

test("timeout holds writer ownership until late storage settles; deletion never reports premature success", async t => {
  const h = await fixture(t), put = h.storage.putFile.bind(h.storage);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { release = r; }), began = new Promise<void>(r => { started = r; });
  t.mock.method(h.storage, "putFile", async (key: string, file: string) => { started(); await gate; await put(key, file); });
  const abort = new AbortController();
  const pending = writePrivateRedactions({ ...h.options, render: h.fastRender, signal: abort.signal });
  const rejected = assert.rejects(pending, /PRIVACY_ASSET_WRITE_UNAVAILABLE/);
  await began; abort.abort(); await rejected;
  const batch = (await h.repository.listPrivacyAssetBatches(h.guideId))[0];
  await h.repository.updateStatus(h.guideId, "failed", { errorCode: DELETION_PENDING });
  assert.equal(await finalizeGuideDeletion(h.repository, h.storage, h.guideId, 1), false);
  await assert.rejects(writePrivateRedactions(h.options)); // still holds the process slot
  release();
  for (let i = 0; i < 200 && (await h.repository.listPrivacyAssetBatches(h.guideId)).length; i++) await delay(10);
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
  for (const key of privacyAssetKeys(batch)) await assert.rejects(h.storage.openRead(key));
  assert.equal(await finalizeGuideDeletion(h.repository, h.storage, h.guideId, 1), true);
});

test("legacy JSON v5 upgrades without rewriting on read; malformed asset identities fail closed", async t => {
  const h = await fixture(t), file = JSON.parse(await readFile(h.repository.filePath, "utf8"));
  file.version = 5; delete file.privacyAssets; delete file.publicationJobs; delete file.publications; delete file.publicationHeads; delete file.privateCleanup;
  await writeFile(h.repository.filePath, JSON.stringify(file));
  const before = await readFile(h.repository.filePath);
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
  assert.deepEqual(await readFile(h.repository.filePath), before);
  const batch = (await h.reserve())!;
  assert.equal(JSON.parse(await readFile(h.repository.filePath, "utf8")).version, 9);
  assert.throws(() => privacyAssetBatchSchema.parse({ ...batch, status: "ready" }));
  assert.throws(() => privacyAssetBatchSchema.parse({ ...batch, frames: [...batch.frames, batch.frames[0]] }));
  assert.throws(() => privacyAssetBatchSchema.parse({ ...batch, frames: [{ ...batch.frames[0], sourceKey: "guides/another/private.jpg" }] }));
});

test("saved redactions have no public/raw-key route; authenticated whole-guide DELETE removes them", async t => {
  const h = await fixture(t), batch = await writePrivateRedactions({ ...h.options, render: h.fastRender });
  const config = loadConfig({ NODE_ENV: "test", DATA_DIR: join(h.root, "app"), SHOWME_STORAGE: "local" });
  const app = createProcessorApp({ config, repository: h.repository, storage: h.storage,
    pipeline: { async process() {}, async processClaimed() {} } });
  for (const key of privacyAssetKeys(batch)) {
    await request(app).get(`/${key}`).expect(404);
    await request(app).get(`/api/${key}`).expect(404);
  }
  await request(app).get(`/api/guides/${h.guideId}/privacy-assets`).expect(404);
  await request(app).get(`/api/guides/${h.guideId}/assets/${h.guide.steps[0].id}/frame`).expect(404);
  const owner = await request(app).get(`/api/guides/${h.guideId}`).set("Authorization", `Bearer ${h.token}`).expect(200);
  assert.ok(!JSON.stringify(owner.body).includes("private-redactions"));
  await request(app).delete(`/api/guides/${h.guideId}`).set("Authorization", `Bearer ${h.token}`).expect(204);
  assert.equal(await h.repository.getGuideById(h.guideId), null);
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
  for (const key of privacyAssetKeys(batch)) await assert.rejects(h.storage.openRead(key));
});

test("aborted calls and changed stored render plans cannot acquire write permission", async t => {
  const h = await fixture(t), before = await readFile(h.repository.filePath);
  await assert.rejects(writePrivateRedactions({ ...h.options, signal: AbortSignal.abort("private") }));
  assert.deepEqual(await readFile(h.repository.filePath), before);
  const batch = (await h.reserve())!;
  const raw = JSON.parse(await readFile(h.repository.filePath, "utf8")); raw.privacyAssets[0].frames[0].masks = [];
  await writeFile(h.repository.filePath, JSON.stringify(raw));
  assert.equal(await h.repository.executePrivacyAssetCommand(h.guideId, { type: "claim", id: batch.id, version: batch.version, writerId: randomUUID() }), null);
});
