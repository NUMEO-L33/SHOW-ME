import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { publicationPreparationFixture } from "./helpers/publication-preparation-fixture.js";
import { attemptFrameObjectKey, DELETION_PENDING } from "../src/processor/asset-lifecycle.js";
import { preparePublicationAssets } from "../src/processor/publication-preparation.js";
import { PublicationRecoveryWorker } from "../src/processor/publication-recovery.js";
import { privateAssetWriterBusy } from "../src/processor/privacy-asset-session.js";
import { privacyAssetKeys } from "../src/processor/privacy-assets.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import type { PublicationJob } from "../src/processor/publication-jobs.js";

const owner = (job: PublicationJob) => ({ id: job.id, leaseId: job.leaseId!, expectedVersion: job.version });
const withdraw = (version: number, jobId: string | null = null) => ({ type: "withdraw" as const, expectedHeadVersion: version, expectedJobId: jobId });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t: TestContext) {
  const h = await createAnalysisHarness(t, 1);
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map(s => ({ ...s,
    representativeFrameKey: attemptFrameObjectKey(h.guideId, 1, 1, "frame") })));
  const guide = (await h.repository.getGuideById(h.guideId))!, f = await publicationPreparationFixture(h.repository, guide, h.root);
  const prepare = (job = f.job, real = false) => preparePublicationAssets({ ...f.options, jobId: job.id,
    expectedVersion: job.version, render: real ? undefined : f.fastRender });
  const publish = async (job = f.job, real = false) => {
    const ready = await prepare(job, real), committed = (await h.repository.commitPublication(h.guideId, owner(ready)))!;
    return { ready, ...committed };
  };
  const request = (at?: Date) => h.repository.executePublicationCommand(h.guideId, { type: "request", id: randomUUID(),
    expectedDraftRevision: f.request.revision, expectedInputFingerprint: f.request.inputFingerprint,
    expectedReviewFingerprint: f.request.reviewFingerprint, originalSharingEnabled: false }, at);
  const worker = (at?: Date) => new PublicationRecoveryWorker({ repository: h.repository, storage: f.storage, clock: at ? () => at : undefined });
  return { ...h, ...f, guide, prepare, publish, request, worker };
}

test("withdrawal denies current and old image authority before physical cleanup, preserving source and immutable history", async t => {
  const h = await fixture(t), published = await h.publish(h.job, true), query = { slug: published.head.publicSlug, publicationId: published.publication.id };
  const before = await h.repository.getGuideById(h.guideId);
  assert.ok(await h.repository.getAccessiblePublication(query));
  const result = (await h.repository.stopPublication(h.guideId, withdraw(1)))!;
  assert.equal(result.head!.activePublicationId, null); assert.equal(result.changed, true);
  const reopened = new JsonGuideRepository(h.repository.filePath);
  assert.equal(await reopened.getAccessiblePublication(query), null);
  const stream = await h.storage.openRead(published.publication.images[0].frame.key); stream.destroy();
  assert.equal((await h.worker().tick()).cleaned, 1);
  await assert.rejects(h.storage.openRead(published.publication.images[0].frame.key));
  const source = await h.storage.openRead(h.guide.steps[0].representativeFrameKey!); source.destroy();
  assert.deepEqual(await reopened.getGuideById(h.guideId), before); assert.deepEqual(await reopened.getAnalysisState(h.guideId), h.state);
  assert.deepEqual((await reopened.getPublicationState(h.guideId))!.publications, [published.publication]);
  assert.equal((await reopened.commitPublication(h.guideId, owner(published.ready)))!.active, false);
});

for (const phase of ["queued", "running"] as const)
test(`withdraw before first publication fences ${phase} work, while an old retry cannot stop a fresh request`, async t => {
  const h = await fixture(t);
  const job = phase === "queued" ? h.job : (await h.repository.executePublicationCommand(h.guideId,
    { type: "claim", id: h.job.id, expectedVersion: 1, leaseId: randomUUID() }))!;
  const command = withdraw(0, job.id), result = (await h.repository.stopPublication(h.guideId, command))!;
  assert.equal(result.head, null); assert.deepEqual(result.cancelledJobIds, [job.id]);
  assert.equal((await h.repository.getPublicationJob(h.guideId, job.id))!.status, "cancelled");
  assert.equal(await h.repository.commitPublication(h.guideId, owner({ ...job, leaseId: job.leaseId ?? randomUUID() })), null);
  const bytes = await readFile(h.repository.filePath);
  assert.equal((await h.repository.stopPublication(h.guideId, command))!.changed, false);
  assert.deepEqual(await readFile(h.repository.filePath), bytes);
  const next = (await h.request())!;
  assert.equal(await h.repository.stopPublication(h.guideId, command), null);
  assert.equal((await h.repository.getPublicationJob(h.guideId, next.id))!.status, "queued");
  if (phase === "running") assert.equal((await h.repository.listPrivacyAssetBatches(h.guideId)).find(a => a.id === job.batchId)!.writerSettled, false);
});

test("withdraw compares both head and pending job, then atomically revokes the head and ready replacement", async t => {
  const h = await fixture(t), first = await h.publish(), next = await h.prepare((await h.request())!);
  for (const command of [withdraw(0, next.id), withdraw(1), withdraw(1, randomUUID())])
    assert.equal(await h.repository.stopPublication(h.guideId, command), null);
  assert.ok(await h.repository.getAccessiblePublication({ slug: first.head.publicSlug }));
  const result = (await h.repository.stopPublication(h.guideId, withdraw(1, next.id)))!;
  assert.deepEqual(result.cancelledJobIds, [next.id]); assert.equal(result.head!.version, 2);
  assert.equal(await h.repository.commitPublication(h.guideId, owner(next)), null);
  assert.equal(await h.repository.getAccessiblePublication({ slug: first.head.publicSlug }), null);
  assert.ok((await h.repository.listPrivacyAssetBatches(h.guideId)).every(a => a.status === "cleanup"));
});

test("explicit new publication after withdrawal keeps the deadline; old requests and old image IDs cannot reactivate", async t => {
  const h = await fixture(t), first = await h.publish(), stop = withdraw(1);
  await h.repository.stopPublication(h.guideId, stop); await h.worker().tick();
  const second = await h.publish((await h.request())!);
  assert.equal(second.head.version, 3); assert.equal(second.head.expiresAt, first.head.expiresAt);
  assert.equal(second.head.publicSlug, first.head.publicSlug);
  assert.equal(await h.repository.stopPublication(h.guideId, stop), null);
  assert.equal((await h.repository.commitPublication(h.guideId, owner(first.ready)))!.active, false);
  assert.equal(await h.repository.getAccessiblePublication({ slug: first.head.publicSlug, publicationId: first.publication.id }), null);
  assert.ok(await h.repository.getAccessiblePublication({ slug: first.head.publicSlug, publicationId: second.publication.id }));
});

test("exact fifteen-day boundary denies new reads and preparation even before the expiry sweep runs", async t => {
  const h = await fixture(t), first = await h.publish(), expiry = new Date(first.head.expiresAt), query = { slug: first.head.publicSlug };
  const before = new Date(expiry.getTime() - 1), queued = (await h.request(before))!;
  assert.ok(await h.repository.getAccessiblePublication(query, before));
  assert.equal(await h.repository.stopPublication(h.guideId, { type: "expire", expectedHeadVersion: 1 }, before), null);
  assert.equal(await h.repository.getAccessiblePublication(query, expiry), null);
  assert.equal(await h.request(expiry), null);
  assert.equal(await h.repository.executePublicationCommand(h.guideId, { type: "claim", id: queued.id, expectedVersion: 1, leaseId: randomUUID() }, expiry), null);
  assert.equal((await h.repository.getPublicationState(h.guideId))!.head!.activePublicationId, first.publication.id);
  assert.equal((await h.repository.listExpiredPublications({}, expiry)).length, 1);
  const result = await h.worker(expiry).tick();
  assert.equal(result.publicationsExpired, 1); assert.equal(result.cleaned, 2);
  assert.equal((await h.repository.getPublicationJob(h.guideId, queued.id))!.status, "cancelled");
  assert.deepEqual(await h.repository.listExpiredPublications({}, expiry), []);
  assert.equal((await h.repository.commitPublication(h.guideId, owner(first.ready), expiry))!.active, false);
});

test("expiry also finds a withdrawn head with a pending republish and keeps an unknown writer unsettled", async t => {
  const h = await fixture(t), first = await h.publish(); await h.repository.stopPublication(h.guideId, withdraw(1)); await h.worker().tick();
  const at = new Date(Date.parse(first.head.expiresAt) - 1), job = (await h.request(at))!;
  await h.repository.executePublicationCommand(h.guideId, { type: "claim", id: job.id, expectedVersion: 1, leaseId: randomUUID() }, at);
  const expiry = new Date(first.head.expiresAt), result = await h.worker(expiry).tick();
  assert.equal(result.publicationsExpired, 1); assert.equal(result.pending, 1);
  const [asset] = await h.repository.listPrivacyAssetBatches(h.guideId);
  assert.equal(asset.status, "cleanup"); assert.equal(asset.writerSettled, false);
  assert.equal((await h.repository.getPublicationState(h.guideId))!.head!.expiresAt, first.head.expiresAt);
});

test("withdraw during a non-cooperative put blocks late completion and only settles after the actual write ends", async t => {
  const h = await fixture(t), entered = deferred(), release = deferred(), put = h.storage.putFile.bind(h.storage);
  let first = true;
  t.mock.method(h.storage, "putFile", async (...args: Parameters<typeof put>) => { if (first) { first = false; entered.resolve(); await release.promise; } await put(...args); });
  const outcome = h.prepare().then(() => false, () => true);
  try {
    await entered.promise;
    assert.ok(await h.repository.stopPublication(h.guideId, withdraw(0, h.job.id)));
    const [asset] = await h.repository.listPrivacyAssetBatches(h.guideId);
    assert.equal(asset.writerSettled, false); assert.equal(asset.status, "cleanup");
  } finally { release.resolve(); }
  assert.equal(await outcome, true);
  for (let n = 0; n < 500 && privateAssetWriterBusy(); n++) await delay(10);
  assert.equal(privateAssetWriterBusy(), false);
  await h.worker().tick(); assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
  assert.equal((await h.repository.getPublicationState(h.guideId))!.head, null);
});

test("stop write failure preserves the reference, pending job and both asset ledgers for a safe retry", async t => {
  const h = await fixture(t); await h.publish(); const next = await h.prepare((await h.request())!);
  const before = await readFile(h.repository.filePath), command = withdraw(1, next.id);
  t.mock.method(h.repository as unknown as { writeState: () => Promise<void> }, "writeState", async () => { throw new Error("fixture"); });
  await assert.rejects(h.repository.stopPublication(h.guideId, command));
  assert.deepEqual(await readFile(h.repository.filePath), before);
  t.mock.restoreAll(); assert.equal((await h.repository.stopPublication(h.guideId, command))!.changed, true);
});

test("deletion marker denies publication access and stop commands without changing the deletion decision", async t => {
  const h = await fixture(t), first = await h.publish();
  await h.repository.updateStatus(h.guideId, "failed", { errorCode: DELETION_PENDING });
  assert.equal(await h.repository.getAccessiblePublication({ slug: first.head.publicSlug }), null);
  assert.equal(await h.repository.stopPublication(h.guideId, withdraw(1)), null);
  assert.equal((await h.repository.getGuideById(h.guideId))!.errorCode, DELETION_PENDING);
});

test("missing or non-ready processed assets fail closed rather than returning source authority", async t => {
  const h = await fixture(t), first = await h.publish(), before = JSON.parse(await readFile(h.repository.filePath, "utf8"));
  for (const damage of [
    (state: typeof before) => { state.privacyAssets = []; },
    (state: typeof before) => { state.privacyAssets[0].status = "cleanup"; },
    (state: typeof before) => { state.privacyAssets[0].receipts[0].sha256 = "0".repeat(64); },
  ]) {
    const state = structuredClone(before); damage(state); await writeFile(h.repository.filePath, JSON.stringify(state));
    assert.equal(await h.repository.getAccessiblePublication({ slug: first.head.publicSlug }), null);
  }
});

test("cleanup failure never restores access and is retryable after reopening with source pixels unchanged", async t => {
  const h = await fixture(t), first = await h.publish(), at = new Date(first.head.expiresAt);
  t.mock.method(h.storage, "delete", async () => { throw new Error("private storage error"); });
  const result = await h.worker(at).tick(); assert.equal(result.publicationsExpired, 1); assert.equal(result.failed, 1);
  assert.equal(await h.repository.getAccessiblePublication({ slug: first.head.publicSlug }, at), null);
  const [asset] = await h.repository.listPrivacyAssetBatches(h.guideId); assert.equal(asset.status, "cleanup");
  t.mock.restoreAll();
  assert.equal((await new PublicationRecoveryWorker({ repository: new JsonGuideRepository(h.repository.filePath), storage: h.storage,
    clock: () => at }).tick()).cleaned, 1);
  for (const key of privacyAssetKeys(asset)) await assert.rejects(h.storage.openRead(key));
  const source = await h.storage.openRead(h.guide.steps[0].representativeFrameKey!); source.destroy();
});

test("expiry discovery is bounded, compares full cursors and rejects malformed control inputs", async t => {
  const h = await fixture(t), first = await h.publish(), at = new Date(first.head.expiresAt);
  const page = await h.repository.listExpiredPublications({ limit: 1 }, at);
  assert.equal(page.length, 1); assert.equal(page[0].guideId, h.guideId);
  assert.deepEqual(await h.repository.listExpiredPublications({ after: { expiresAt: page[0].expiresAt, publicSlug: page[0].publicSlug } }, at), []);
  assert.equal((await h.repository.listExpiredPublications({ after: { expiresAt: new Date(at.getTime() - 1).toISOString(), publicSlug: page[0].publicSlug } }, at)).length, 1);
  await assert.rejects(h.repository.listExpiredPublications({ limit: 21 }, at));
  await assert.rejects(h.repository.getAccessiblePublication({ slug: "../private" }));
  await assert.rejects(h.repository.stopPublication(h.guideId, withdraw(-1)));
  assert.equal(await h.repository.stopPublication("missing", withdraw(0)), null);
  assert.equal(await h.repository.getAccessiblePublication({ slug: "A".repeat(32) }), null);
});

test("internal expiry commands and automatic recovery are not directly exposed or started by HTTP", async () => {
  for (const file of ["src/processor/index.ts", "src/processor/server.ts"]) {
    const source = await readFile(file, "utf8");
    for (const method of ["stopPublication", "getAccessiblePublication", "PublicationRecoveryWorker"]) assert.ok(!source.includes(method));
  }
});
