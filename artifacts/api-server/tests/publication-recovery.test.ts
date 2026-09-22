import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { publicationPreparationFixture } from "./helpers/publication-preparation-fixture.js";
import { attemptFrameObjectKey, cleanupStorageKeys, privateStorageDeletesPending } from "../src/processor/asset-lifecycle.js";
import { preparePublicationAssets } from "../src/processor/publication-preparation.js";
import { PublicationRecoveryWorker } from "../src/processor/publication-recovery.js";
import { privacyAssetKeys } from "../src/processor/privacy-assets.js";
import { JsonGuideRepository } from "../src/processor/repository.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function until(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 500; n++) { if (await check()) return; await delay(10); }
  assert.fail("fixture did not settle");
}
async function fixture(t: TestContext) {
  const h = await createAnalysisHarness(t, 1);
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map(s => ({ ...s,
    representativeFrameKey: attemptFrameObjectKey(h.guideId, 1, 1, "frame") })));
  const guide = (await h.repository.getGuideById(h.guideId))!;
  const first = await publicationPreparationFixture(h.repository, guide, h.root);
  const add = async () => {
    const id = randomUUID();
    await h.repository.createGuide({ id, slug: id, editToken: "fixture", title: "fixture", status: "queued",
      originalObjectKey: `guides/${id}/source.mp4`, sourceFilename: "fixture.mp4", sourceMimeType: "video/mp4", sourceSizeBytes: 1 });
    await h.repository.claimProcessingAttempt(id, "fixture-attempt");
    await h.repository.updateStatus(id, "extracting");
    const next = (await h.repository.completeProcessingAttempt(id, { attemptId: "fixture-attempt", attemptCount: 1,
      steps: guide.steps.map(s => ({ ...s, id: `step-${id}`, representativeFrameKey: attemptFrameObjectKey(id, 1, 1, "frame") })) }))!;
    return publicationPreparationFixture(h.repository, next, h.root);
  };
  const worker = (overrides: Partial<ConstructorParameters<typeof PublicationRecoveryWorker>[0]> = {}) =>
    new PublicationRecoveryWorker({ repository: h.repository, storage: first.storage, ...overrides });
  const cancel = (job = first.job) => h.repository.executePublicationCommand(job.guideId, { type: "cancel", id: job.id });
  const claim = (job = first.job) => h.repository.executePublicationCommand(job.guideId,
    { type: "claim", id: job.id, expectedVersion: job.version, leaseId: randomUUID() });
  return { ...h, ...first, guide, add, worker, cancel, claim };
}

test("restart recovery expires abandoned work but never calls a renderer, retries an upload or settles an unknown writer", async t => {
  const h = await fixture(t), running = (await h.claim())!, queued = await h.add(), live = await h.add();
  const at = new Date(running.leaseExpiresAt!);
  const liveRunning = await h.repository.executePublicationCommand(live.job.guideId,
    { type: "claim", id: live.job.id, expectedVersion: 1, leaseId: randomUUID() }, at);
  const put = t.mock.method(h.storage, "putFile", async () => assert.fail("recovery must not write images"));
  const read = t.mock.method(h.storage, "openRead", async () => { throw new Error("recovery must not inspect pixels"); });
  const reopened = new JsonGuideRepository(h.repository.filePath), worker = h.worker({ repository: reopened, clock: () => at });
  const result = await worker.tick();
  assert.equal(result.recovered, 1); assert.equal(result.pending, 1); assert.equal(result.cleaned, 0);
  const failed = (await reopened.getPublicationJob(h.guideId, h.job.id))!;
  assert.equal(failed.errorCode, "LEASE_EXPIRED");
  const [asset] = await reopened.listPrivacyAssetBatches(h.guideId);
  assert.equal(asset.status, "cleanup"); assert.equal(asset.writerSettled, false);
  assert.equal(await reopened.deleteGuide(h.guideId), false);
  assert.deepEqual(await reopened.getPublicationJob(queued.job.guideId, queued.job.id), queued.job);
  assert.deepEqual(await reopened.getPublicationJob(live.job.guideId, live.job.id), liveRunning);
  assert.equal(put.mock.callCount(), 0); assert.equal(read.mock.callCount(), 0);
  assert.equal(worker.getStatus().nextPollMs, 30_000);
});

test("restart cleanup removes actual prepared pixels only after cancellation and preserves draft/source/other reservations", async t => {
  const h = await fixture(t), ready = await preparePublicationAssets(h.options);
  const [asset] = await h.repository.listPrivacyAssetBatches(h.guideId);
  const other = (await h.repository.executePrivacyAssetCommand(h.guideId, { type: "reserve", id: randomUUID(), ...h.request }))!;
  const reopened = new JsonGuideRepository(h.repository.filePath), worker = h.worker({ repository: reopened });
  assert.equal((await worker.tick()).cleanupScanned, 0);
  assert.deepEqual(await reopened.getPublicationJob(h.guideId, h.job.id), ready);
  await h.cancel(); assert.equal((await worker.tick()).cleaned, 1);
  for (const key of privacyAssetKeys(asset)) await assert.rejects(h.storage.openRead(key));
  assert.deepEqual(await reopened.listPrivacyAssetBatches(h.guideId), [other]);
  assert.deepEqual(await reopened.getAnalysisState(h.guideId), h.state);
  const stream = await h.storage.openRead(h.guide.steps[0].representativeFrameKey!); stream.destroy();
  assert.deepEqual(await reopened.listPublicationRecovery({ kind: "cleanup" }), []);
});

test("expired already-settled preparation is safely removed instead of being published after restart", async t => {
  const h = await fixture(t), ready = await preparePublicationAssets(h.options);
  const worker = h.worker({ clock: () => new Date(ready.leaseExpiresAt!) });
  const result = await worker.tick(); assert.equal(result.recovered, 1); assert.equal(result.cleaned, 1);
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
  assert.equal((await h.repository.getPublicationJob(h.guideId, h.job.id))!.status, "failed");
});

test("twenty unresolved heads do not starve later cleanup; keyset cursors wrap and survive disappearing records", async t => {
  const h = await fixture(t), jobs = [h.job];
  for (let i = 0; i < 20; i++) jobs.push((await h.add()).job);
  jobs.sort((a, b) => a.batchId < b.batchId ? -1 : 1);
  for (const job of jobs.slice(0, 20)) { await h.claim(job); await h.cancel(job); }
  await h.cancel(jobs[20]);
  const worker = h.worker(), first = await worker.tick(), second = await worker.tick();
  assert.equal(first.cleanupScanned, 20); assert.equal(first.pending, 20); assert.equal(first.cleaned, 0);
  assert.equal(second.cleanupScanned, 1); assert.equal(second.cleaned, 1);
  assert.equal((await worker.tick()).cleanupScanned, 0); // Bounded wrap, not an unbounded second query.
  assert.equal((await worker.tick()).cleanupScanned, 20);
  const page = await h.repository.listPublicationRecovery({ kind: "cleanup", limit: 1 });
  assert.deepEqual(Object.keys(page[0]).sort(), ["batchId", "guideId", "id", "version"]);
  assert.equal(page[0].batchId, jobs[0].batchId);
});

test("per-job deletion errors advance the cursor, expose no raw details, and retry after reopen", async t => {
  const h = await fixture(t), next = await h.add(); await h.cancel(); await h.cancel(next.job);
  const jobs = [h.job, next.job].sort((a, b) => a.batchId < b.batchId ? -1 : 1), remove = h.storage.delete.bind(h.storage);
  t.mock.method(h.storage, "delete", async (key: string) => {
    if (key.includes(jobs[0].batchId)) throw new Error("secret url and filename"); await remove(key);
  });
  const worker = h.worker({ batchSize: 1 });
  assert.equal((await worker.tick()).failed, 1); assert.equal((await worker.tick()).cleaned, 1);
  assert.ok(!JSON.stringify(worker.getStatus()).includes("secret"));
  assert.equal((await h.repository.listPrivacyAssetBatches(jobs[0].guideId)).length, 1);
  t.mock.restoreAll();
  assert.equal((await h.worker({ repository: new JsonGuideRepository(h.repository.filePath) }).tick()).cleaned, 1);
});

test("recovery ticks coalesce locally and concurrent independent workers cannot recreate cleaned assets", async t => {
  const h = await fixture(t); await h.cancel();
  const worker = h.worker(), calls = Array.from({ length: 12 }, () => worker.tick());
  assert.ok(calls.every(p => p === calls[0])); await Promise.all(calls);
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
  await Promise.all([h.worker().tick(), h.worker().tick()]);
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
});

test("timeout retains the query lane and stop prevents late scan results from mutating or issuing storage operations", async t => {
  const h = await fixture(t), running = (await h.claim())!, begun = deferred(), release = deferred();
  const at = new Date(running.leaseExpiresAt!), rows = await h.repository.listPublicationRecovery({ kind: "expired" }, at);
  const scan = t.mock.method(h.repository, "listPublicationRecovery", async () => { begun.resolve(); await release.promise; return rows; });
  const execute = t.mock.method(h.repository, "executePublicationCommand", async () => assert.fail("no late recovery"));
  const worker = h.worker({ timeoutMs: 10, clock: () => at }), pending = worker.tick();
  await begun.promise; assert.equal((await pending).status, "degraded");
  assert.equal((await worker.tick()).status, "busy"); assert.equal(scan.mock.callCount(), 1);
  assert.deepEqual(await worker.stop(), { pendingIO: true });
  release.resolve(); await until(() => !worker.getStatus().pendingIO);
  assert.equal(execute.mock.callCount(), 0); assert.equal((await worker.tick()).status, "stopped");
  worker.start(); assert.equal(worker.getStatus().running, false);
});

test("shutdown during a delayed asset read prevents its later cancellation/deletion writes", async t => {
  const h = await fixture(t); await h.cancel();
  const list = h.repository.listPrivacyAssetBatches.bind(h.repository), begun = deferred(), release = deferred();
  t.mock.method(h.repository, "listPrivacyAssetBatches", async (guideId: string) => { begun.resolve(); await release.promise; return list(guideId); });
  const execute = t.mock.method(h.repository, "executePrivacyAssetCommand", async () => assert.fail("no late mutation"));
  const remove = t.mock.method(h.storage, "delete", async () => assert.fail("no late storage call"));
  const worker = h.worker(), pending = worker.tick(); await begun.promise;
  assert.deepEqual(await worker.stop(), { pendingIO: true }); assert.equal((await pending).status, "stopped");
  release.resolve(); await until(() => !worker.getStatus().pendingIO);
  assert.equal(execute.mock.callCount(), 0); assert.equal(remove.mock.callCount(), 0);
});

test("a timed-out remote delete holds the storage lane and its late success cannot erase the cleanup ledger", async t => {
  const h = await fixture(t); await h.cancel(); const next = await h.add(); await h.cancel(next.job);
  const begun = deferred(), release = deferred();
  const remove = t.mock.method(h.storage, "delete", async () => { begun.resolve(); await release.promise; });
  const worker = h.worker({ deleteTimeoutMs: 10 }), pending = worker.tick(); await begun.promise;
  const result = await pending; assert.equal(result.failed, 1); assert.equal(result.cleanupScanned, 1);
  assert.equal(worker.getStatus().pendingIO, true); assert.equal((await worker.tick()).status, "busy");
  assert.equal(remove.mock.callCount(), 2); assert.deepEqual(await worker.stop(), { pendingIO: true });
  release.resolve(); await until(() => !privateStorageDeletesPending(h.storage));
  assert.equal((await h.repository.listPublicationRecovery({ kind: "cleanup" })).length, 2);
  t.mock.restoreAll(); assert.equal((await h.worker().tick()).cleaned, 2);
});

test("aborted cleanup starts no storage calls and deletion batching does not start more keys after shutdown", async t => {
  const h = await fixture(t), controller = new AbortController(), calls: string[] = [];
  t.mock.method(h.storage, "delete", async (key: string) => { calls.push(key); controller.abort(); });
  await assert.rejects(cleanupStorageKeys(h.storage, ["a"], { signal: AbortSignal.abort() }));
  assert.deepEqual(calls, []);
  await assert.rejects(cleanupStorageKeys(h.storage, Array.from({ length: 48 }, (_, i) => `fixture-${i}`), { signal: controller.signal }));
  assert.ok(calls.length <= 20); await until(() => !privateStorageDeletesPending(h.storage));
});

test("explicit start polls persisted cleanup and repeated stop prevents all subsequent scans", async t => {
  const h = await fixture(t); await h.cancel();
  const scan = t.mock.method(h.repository, "listPublicationRecovery", h.repository.listPublicationRecovery.bind(h.repository));
  const worker = h.worker({ pollMs: 10 }); t.after(() => worker.stop());
  assert.equal(scan.mock.callCount(), 0); worker.start(); worker.start();
  await until(async () => (await h.repository.listPrivacyAssetBatches(h.guideId)).length === 0);
  await worker.stop(); const count = scan.mock.callCount(); await delay(30); await worker.stop();
  assert.equal(scan.mock.callCount(), count); assert.equal(worker.getStatus().running, false);
});

test("invalid scan/cadence bounds fail closed and product startup does not activate recovery", async t => {
  const h = await fixture(t);
  for (const query of [{ kind: "cleanup", limit: 0 }, { kind: "expired", limit: 21 }, { kind: "cleanup", after: "invalid" }, { kind: "unknown" }])
    await assert.rejects(h.repository.listPublicationRecovery(query as never));
  for (const options of [{ batchSize: 21 }, { pollMs: 0 }, { timeoutMs: 30_001 }, { deleteTimeoutMs: -1 }])
    assert.throws(() => h.worker(options));
  for (const file of ["src/processor/index.ts", "src/processor/server.ts"])
    assert.ok(!(await readFile(file, "utf8")).includes("publication-recovery"));
});
