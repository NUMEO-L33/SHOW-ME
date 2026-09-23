import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { publicationPreparationFixture } from "./helpers/publication-preparation-fixture.js";
import { attemptFrameObjectKey, DELETION_PENDING, finalizeGuideDeletion } from "../src/processor/asset-lifecycle.js";
import { preparePublicationAssets, cleanupPublicationPreparation } from "../src/processor/publication-preparation.js";
import { privateAssetWriterBusy } from "../src/processor/privacy-asset-session.js";
import { writePrivateRedactions } from "../src/processor/privacy-asset-writer.js";
import { privacyAssetDigest, privacyAssetKeys } from "../src/processor/privacy-assets.js";
import { privacyAfterEdit } from "../src/processor/privacy-review.js";
import { renderPrivateRedaction } from "../src/processor/privacy-render.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { StorageWriteSettledError } from "../src/processor/storage.js";

const deferred = () => {
  let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve };
};
async function idle() {
  for (let i = 0; i < 500 && privateAssetWriterBusy(); i++) await delay(10);
  assert.equal(privateAssetWriterBusy(), false);
}
async function fixture(t: TestContext) {
  const h = await createAnalysisHarness(t, 1, { guideId: randomUUID(), editToken: "fixture" });
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map(s => ({ ...s,
    representativeFrameKey: attemptFrameObjectKey(h.guideId, 1, s.position + 1, "frame") })));
  const guide = (await h.repository.getGuideById(h.guideId))!;
  const prepared = await publicationPreparationFixture(h.repository, guide, h.root);
  const getJob = () => h.repository.getPublicationJob(h.guideId, prepared.job.id);
  const cancel = () => h.repository.executePublicationCommand(h.guideId, { type: "cancel", id: prepared.job.id });
  const edit = async () => {
    const document = structuredClone(prepared.state.draft!.document); document.title = "private edit";
    document.privacy = privacyAfterEdit(prepared.state.draft!.document, document);
    await h.repository.executeAnalysisCommand(h.guideId, { type: "save-editor-draft", expectedRevision: prepared.request.revision,
      expectedInputFingerprint: prepared.request.inputFingerprint, document });
  };
  return { ...h, ...prepared, guide, getJob, cancel, edit };
}
const bytes = async (storage: Awaited<ReturnType<typeof fixture>>["storage"], key: string) => {
  const chunks: Buffer[] = []; for await (const chunk of await storage.openRead(key)) chunks.push(chunk);
  return Buffer.concat(chunks);
};

test("publication preparation uses its single reserved batch for real PNGs, persists receipts atomically and never publishes", async t => {
  const h = await fixture(t), before = await h.repository.getGuideById(h.guideId);
  const put = t.mock.method(h.storage, "putFile", h.storage.putFile.bind(h.storage));
  const ready = await preparePublicationAssets(h.options);
  assert.equal(ready.phase, "assets-ready"); assert.equal(ready.status, "running"); assert.equal(ready.batchId, h.job.batchId);
  const [batch] = await h.repository.listPrivacyAssetBatches(h.guideId);
  assert.equal(batch.status, "ready"); assert.equal(batch.writerId, ready.leaseId); assert.equal(put.mock.callCount(), 2);
  for (const [i, key] of privacyAssetKeys(batch).entries()) {
    const png = await bytes(h.storage, key);
    assert.deepEqual(png, await renderPrivateRedaction({ bytes: h.source, width: 640, height: 360, masks: batch.frames[0].masks,
      variant: i === 0 ? "frame" : "thumbnail", signal: h.options.signal, ffmpegPath: h.options.ffmpegPath }));
    assert.equal(batch.receipts[i].sha256, privacyAssetDigest(png));
  }
  assert.deepEqual(await bytes(h.storage, h.guide.steps[0].representativeFrameKey!), h.source);
  assert.deepEqual(await h.repository.getGuideById(h.guideId), before);
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), h.state);
  assert.deepEqual(await readdir(h.options.workDir), []);
  assert.deepEqual(await new JsonGuideRepository(h.repository.filePath).getPublicationJob(h.guideId, h.job.id), ready);
  await assert.rejects(preparePublicationAssets(h.options), /PRIVACY_ASSET_WRITE_UNAVAILABLE/);
  assert.equal(put.mock.callCount(), 2); assert.equal((await h.getJob())!.phase, "assets-ready");
});

test("concurrent preparations claim only once, and aborted/stale calls cannot allocate another asset batch", async t => {
  const h = await fixture(t), put = t.mock.method(h.storage, "putFile", h.storage.putFile.bind(h.storage));
  for (const options of [{ ...h.options, signal: AbortSignal.abort() }, { ...h.options, expectedVersion: 99 }])
    await assert.rejects(preparePublicationAssets(options));
  assert.equal((await h.getJob())!.status, "queued");
  const calls = await Promise.allSettled(Array.from({ length: 12 }, () => preparePublicationAssets({ ...h.options, render: h.fastRender })));
  assert.equal(calls.filter(c => c.status === "fulfilled").length, 1);
  assert.equal(put.mock.callCount(), 2); assert.equal((await h.repository.listPrivacyAssetBatches(h.guideId)).length, 1);
});

test("a reconstructed running lease is never permission to replay writes or cancel another owner", async t => {
  const h = await fixture(t), leaseId = randomUUID();
  const running = await h.repository.executePublicationCommand(h.guideId, { type: "claim", id: h.job.id, expectedVersion: 1, leaseId });
  const put = t.mock.method(h.storage, "putFile", async () => { assert.fail("no replay"); });
  const reopened = new JsonGuideRepository(h.repository.filePath);
  await assert.rejects(preparePublicationAssets({ ...h.options, repository: reopened, expectedVersion: running!.version }));
  assert.deepEqual(await h.getJob(), running); assert.equal(put.mock.callCount(), 0);
  assert.equal((await h.repository.listPrivacyAssetBatches(h.guideId))[0].writerSettled, false);
});

test("edit during rendering prevents the first object write and cleans only the failed preparation", async t => {
  const h = await fixture(t), put = t.mock.method(h.storage, "putFile", async () => { assert.fail("edited input must not write"); });
  await assert.rejects(preparePublicationAssets({ ...h.options, render: async () => { await h.edit(); return h.fastRender({} as never); } }));
  await idle(); assert.equal(put.mock.callCount(), 0);
  assert.equal((await h.getJob())!.errorCode, "INPUT_CHANGED");
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
  assert.equal((await h.repository.getAnalysisState(h.guideId))!.draft!.document.title, "private edit");
});

test("cancellation during an uncooperative write returns promptly, holds the shared slot and cleans a late commit", async t => {
  const h = await fixture(t), begun = deferred(), release = deferred(), put = h.storage.putFile.bind(h.storage), keys: string[] = [];
  t.mock.method(h.storage, "putFile", async (key: string, file: string) => { keys.push(key); begun.resolve(); await release.promise; await put(key, file); });
  const pending = preparePublicationAssets({ ...h.options, render: h.fastRender });
  const rejected = assert.rejects(pending, /PRIVACY_ASSET_WRITE_UNAVAILABLE/);
  await begun.promise; await h.cancel(); await rejected;
  assert.equal(privateAssetWriterBusy(), true);
  await assert.rejects(writePrivateRedactions({ ...h.options, ...h.request }));
  assert.equal(await cleanupPublicationPreparation(h.repository, h.storage, h.guideId, h.job.id), false);
  assert.equal(await h.repository.deleteGuide(h.guideId), false);
  release.resolve(); await idle();
  assert.equal(keys.length, 1); for (const key of keys) await assert.rejects(h.storage.openRead(key));
  assert.equal((await h.getJob())!.status, "cancelled"); assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
});

test("whole-guide deletion during writes cannot report completed deletion before the late writer is cleaned", async t => {
  const h = await fixture(t), begun = deferred(), release = deferred(), put = h.storage.putFile.bind(h.storage);
  t.mock.method(h.storage, "putFile", async (key: string, file: string) => { begun.resolve(); await release.promise; await put(key, file); });
  const pending = preparePublicationAssets({ ...h.options, render: h.fastRender }), rejected = assert.rejects(pending);
  await begun.promise; await h.repository.updateStatus(h.guideId, "failed", { errorCode: DELETION_PENDING });
  await rejected;
  assert.equal(await finalizeGuideDeletion(h.repository, h.storage, h.guideId, 1), false);
  release.resolve(); await idle();
  assert.equal(await finalizeGuideDeletion(h.repository, h.storage, h.guideId, 1), true);
  assert.equal(await h.getJob(), null);
});

test("abort during an uncooperative render holds ownership until it settles, without writing any pixels", async t => {
  const h = await fixture(t), begun = deferred(), release = deferred(), controller = new AbortController();
  const put = t.mock.method(h.storage, "putFile", async () => { assert.fail("late render must not write"); });
  const pending = preparePublicationAssets({ ...h.options, signal: controller.signal,
    render: async () => { begun.resolve(); await release.promise; return h.fastRender({} as never); } });
  const rejected = assert.rejects(pending); await begun.promise; controller.abort(); await rejected;
  assert.equal(privateAssetWriterBusy(), true);
  assert.equal((await h.repository.listPrivacyAssetBatches(h.guideId))[0].writerSettled, false);
  release.resolve(); await idle(); assert.equal(put.mock.callCount(), 0);
  assert.equal((await h.getJob())!.status, "failed"); assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
});

for (const failure of ["partial-put", "corrupt-read", "render-error"] as const)
test(`publication ${failure} never advances preparation and never falls back to source pixels`, async t => {
  const h = await fixture(t), put = h.storage.putFile.bind(h.storage), read = h.storage.openRead.bind(h.storage);
  t.mock.method(h.storage, "putFile", async (key: string, file: string) => { await put(key, file);
    if (failure === "partial-put") throw new StorageWriteSettledError(); });
  t.mock.method(h.storage, "openRead", async (key: string) => failure === "corrupt-read" && key.includes("private-redactions")
    ? Readable.from([Buffer.from("invalid")]) : read(key));
  await assert.rejects(preparePublicationAssets({ ...h.options, render: failure === "render-error"
    ? async () => { throw new Error("private source details"); } : h.fastRender }),
  e => e instanceof Error && e.message === "PRIVACY_ASSET_WRITE_UNAVAILABLE" && e.cause === undefined);
  await idle(); assert.equal((await h.getJob())!.status, "failed");
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
  assert.deepEqual(await bytes(h.storage, h.guide.steps[0].representativeFrameKey!), h.source);
});

test("lost claim acknowledgement never starts image I/O and reconciles only its own private nonce", async t => {
  const h = await fixture(t), execute = h.repository.executePublicationCommand.bind(h.repository);
  t.mock.method(h.repository, "executePublicationCommand", async (...args: Parameters<typeof execute>) => {
    const result = await execute(...args); if (args[1].type === "claim") throw new Error("lost ack"); return result;
  });
  const read = t.mock.method(h.storage, "openRead", async () => { assert.fail("no image read without claim ack"); });
  await assert.rejects(preparePublicationAssets(h.options)); await idle();
  assert.equal(read.mock.callCount(), 0); assert.equal((await h.getJob())!.status, "failed");
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
});

test("lost atomic preparation acknowledgement recovers the receipt without a duplicate put or render", async t => {
  const h = await fixture(t), execute = h.repository.executePublicationCommand.bind(h.repository);
  t.mock.method(h.repository, "executePublicationCommand", async (...args: Parameters<typeof execute>) => {
    const result = await execute(...args); if (args[1].type === "complete-assets") throw new Error("lost ack"); return result;
  });
  const put = t.mock.method(h.storage, "putFile", h.storage.putFile.bind(h.storage));
  const ready = await preparePublicationAssets({ ...h.options, render: h.fastRender });
  assert.equal(ready.phase, "assets-ready"); assert.equal(put.mock.callCount(), 2);
  assert.equal((await h.repository.listPrivacyAssetBatches(h.guideId))[0].status, "ready");
});

test("failed final DB write cancels and removes all private output rather than leaving a ready job alone", async t => {
  const h = await fixture(t), execute = h.repository.executePublicationCommand.bind(h.repository);
  t.mock.method(h.repository, "executePublicationCommand", async (...args: Parameters<typeof execute>) => {
    if (args[1].type === "complete-assets") throw new Error("DB unavailable"); return execute(...args);
  });
  await assert.rejects(preparePublicationAssets({ ...h.options, render: h.fastRender })); await idle();
  assert.equal((await h.getJob())!.status, "failed"); assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
});

test("failed deletion remains retryable after restart and never cleans another reserved batch", async t => {
  const h = await fixture(t);
  const other = (await h.repository.executePrivacyAssetCommand(h.guideId, { type: "reserve", id: randomUUID(), ...h.request }))!;
  const put = h.storage.putFile.bind(h.storage);
  // Local write is definitely finished; only the following deletion is failing.
  t.mock.method(h.storage, "putFile", async (key: string, file: string) => { await put(key, file); throw new StorageWriteSettledError(); });
  t.mock.method(h.storage, "delete", async () => { throw new Error("delete failed"); });
  await assert.rejects(preparePublicationAssets({ ...h.options, render: h.fastRender })); await idle();
  const batch = (await h.repository.listPrivacyAssetBatches(h.guideId)).find(b => b.id === h.job.batchId)!;
  assert.equal(batch.status, "cleanup"); assert.equal(batch.writerSettled, true);
  t.mock.restoreAll(); const reopened = new JsonGuideRepository(h.repository.filePath);
  assert.equal(await cleanupPublicationPreparation(reopened, h.storage, h.guideId, h.job.id), true);
  assert.deepEqual(await reopened.listPrivacyAssetBatches(h.guideId), [other]);
  for (const key of privacyAssetKeys(batch)) await assert.rejects(h.storage.openRead(key));
});

test("lease recovery during a pending put fences completion but never declares the remote writer settled early", async t => {
  const h = await fixture(t), begun = deferred(), release = deferred(), put = h.storage.putFile.bind(h.storage);
  t.mock.method(h.storage, "putFile", async (key: string, file: string) => { begun.resolve(); await release.promise; await put(key, file); });
  const pending = preparePublicationAssets({ ...h.options, render: h.fastRender }), rejected = assert.rejects(pending);
  await begun.promise; const running = (await h.getJob())!;
  await h.repository.executePublicationCommand(h.guideId, { type: "recover", id: running.id, expectedVersion: running.version }, new Date(running.leaseExpiresAt!));
  await rejected; assert.equal((await h.repository.listPrivacyAssetBatches(h.guideId))[0].writerSettled, false);
  release.resolve(); await idle();
  assert.equal((await h.getJob())!.errorCode, "LEASE_EXPIRED"); assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
});

test("preparation stays absent from product startup, HTTP and automatic AI execution", async () => {
  for (const file of ["src/processor/index.ts", "src/processor/server.ts"]) {
    const source = await readFile(file, "utf8"); assert.ok(!source.includes("publication-preparation"));
  }
});
