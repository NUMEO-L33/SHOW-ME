import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import request from "supertest";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { reviewedAssetFixture } from "./helpers/privacy-assets-fixture.js";
import { attemptFrameObjectKey, DELETION_PENDING, finalizeGuideDeletion } from "../src/processor/asset-lifecycle.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { privacyAfterEdit } from "../src/processor/privacy-review.js";
import { privacyAssetKeys } from "../src/processor/privacy-assets.js";
import { cleanupPrivateRedactions } from "../src/processor/privacy-asset-cleanup.js";
import { publicationJobSchema, PUBLICATION_JOB_LIMIT, PUBLICATION_LEASE_MS, type PublicationRequest } from "../src/processor/publication-jobs.js";
import { LocalStorage } from "../src/processor/storage.js";
import { createProcessorApp } from "../src/processor/server.js";
import { loadConfig } from "../src/processor/config.js";

async function fixture(t: TestContext) {
  const token = randomBytes(32).toString("base64url");
  const h = await createAnalysisHarness(t, 1, { guideId: randomUUID(), editToken: token });
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map(s => ({ ...s,
    representativeFrameKey: attemptFrameObjectKey(h.guideId, 1, s.position + 1, "frame") })));
  const guide = (await h.repository.getGuideById(h.guideId))!;
  const reviewed = await reviewedAssetFixture(h.repository, guide);
  const command: PublicationRequest = { type: "request", id: randomUUID(), expectedDraftRevision: reviewed.request.revision,
    expectedInputFingerprint: reviewed.request.inputFingerprint, expectedReviewFingerprint: reviewed.request.reviewFingerprint,
    originalSharingEnabled: false };
  const storage = new LocalStorage(join(h.root, "objects"));
  const execute = (c: Parameters<typeof h.repository.executePublicationCommand>[1], now?: Date) => h.repository.executePublicationCommand(h.guideId, c, now);
  const start = async (now = new Date()) => {
    const job = (await execute(command, now))!;
    return (await execute({ type: "claim", id: job.id, expectedVersion: job.version, leaseId: randomUUID() }, now))!;
  };
  const edit = async () => {
    const document = structuredClone(reviewed.state.draft!.document); document.title = "수정한 비공개 제목";
    document.privacy = privacyAfterEdit(reviewed.state.draft!.document, document);
    return h.repository.executeAnalysisCommand(h.guideId, { type: "save-editor-draft", expectedRevision: reviewed.request.revision,
      expectedInputFingerprint: reviewed.request.inputFingerprint, document });
  };
  return { ...h, ...reviewed, token, guide, command, storage, execute, start, edit };
}

test("publication intake persists an allowlisted snapshot and asset ownership atomically; replay survives reopen", async t => {
  const h = await fixture(t), before = await h.repository.getGuideById(h.guideId);
  const job = (await h.execute(h.command))!;
  assert.equal(job.status, "queued"); assert.equal(job.phase, "queued"); assert.equal(job.originalSharingEnabled, false);
  assert.deepEqual(job.content, { title: h.state.draft!.document.title, steps: [{ id: "step-0", shortLabel: "1단계 화면",
    instruction: "이 화면에서 할 일을 확인해 주세요.", taps: [] }] });
  for (const forbidden of ["sourceFilename", "originalObjectKey", "intent", "privacyReview", "privacy-mask", "editToken"])
    assert.ok(!JSON.stringify(job).includes(forbidden));
  const [asset] = await h.repository.listPrivacyAssetBatches(h.guideId);
  assert.equal(asset.id, job.batchId); assert.equal(asset.status, "reserved");
  const reopened = new JsonGuideRepository(h.repository.filePath), bytes = await readFile(h.repository.filePath);
  assert.deepEqual(await reopened.getPublicationJob(h.guideId, job.id), job);
  assert.deepEqual(await reopened.executePublicationCommand(h.guideId, h.command), job);
  assert.deepEqual(await readFile(h.repository.filePath), bytes);
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), h.state);
  assert.deepEqual(await h.repository.getGuideById(h.guideId), before);
  job.content.title = "not persisted";
  assert.notEqual((await reopened.getPublicationJob(h.guideId, job.id))!.content.title, job.content.title);
});

test("invalid, unreviewed, stale and original-sharing requests never reserve assets", async t => {
  const h = await fixture(t);
  for (const patch of [{ expectedDraftRevision: 1 }, { expectedInputFingerprint: "0".repeat(64) },
    { expectedReviewFingerprint: "0".repeat(64) }, { originalSharingEnabled: true }]) {
    await assert.rejects(h.execute({ ...h.command, ...patch }), /PUBLICATION_(NOT_READY|ORIGINAL_UNAVAILABLE)/);
    assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), []);
  }
  await assert.rejects(h.execute({ ...h.command, sourceKey: "untrusted" } as PublicationRequest));
  await h.edit(); await assert.rejects(h.execute(h.command), /PUBLICATION_NOT_READY/);
  assert.equal(await h.repository.getPublicationJob(h.guideId, h.command.id), null);
});

test("same key with changed revision, input, review or original option conflicts even after cancellation", async t => {
  const h = await fixture(t); await h.execute(h.command); await h.execute({ type: "cancel", id: h.command.id });
  for (const patch of [{ expectedDraftRevision: h.command.expectedDraftRevision + 1 }, { expectedInputFingerprint: "0".repeat(64) },
    { expectedReviewFingerprint: "0".repeat(64) }, { originalSharingEnabled: true }])
    await assert.rejects(h.execute({ ...h.command, ...patch }), /PUBLICATION_CONFLICT/);
  assert.equal((await h.execute(h.command))!.status, "cancelled");
  assert.equal((await h.repository.listPrivacyAssetBatches(h.guideId)).length, 1);
});

test("concurrent duplicate requests and worker claims create one job, one batch and one owner", async t => {
  const h = await fixture(t);
  const jobs = await Promise.all(Array.from({ length: 12 }, () => h.execute(h.command)));
  assert.ok(jobs.every(j => j?.batchId === jobs[0]!.batchId));
  await assert.rejects(h.execute({ ...h.command, id: randomUUID() }), /PUBLICATION_CAPACITY/);
  const claims = await Promise.all(Array.from({ length: 12 }, () => h.execute({ type: "claim", id: h.command.id,
    expectedVersion: 1, leaseId: randomUUID() })));
  assert.equal(claims.filter(Boolean).length, 1);
  const job = claims.find(Boolean)!, [asset] = await h.repository.listPrivacyAssetBatches(h.guideId);
  assert.equal(asset.writerId, job.leaseId); assert.equal(asset.writerSettled, false);
  assert.equal(asset.status, "writing"); assert.equal(job.status, "running");
  assert.equal(await h.execute({ type: "claim", id: job.id, expectedVersion: job.version, leaseId: randomUUID() }), null);
});

test("editing queued input fails the job and cancels its reserved output without touching the edit", async t => {
  const h = await fixture(t), job = (await h.execute(h.command))!; await h.edit();
  assert.deepEqual(await h.execute(h.command), job); // retry is a lookup, not revalidation or recreation
  const failed = await h.execute({ type: "claim", id: job.id, expectedVersion: job.version, leaseId: randomUUID() });
  assert.equal(failed?.errorCode, "INPUT_CHANGED"); assert.equal(failed?.status, "failed");
  assert.equal((await h.repository.listPrivacyAssetBatches(h.guideId))[0].status, "cleanup");
  assert.equal(await cleanupPrivateRedactions(h.repository, h.storage, h.guideId), true);
  assert.equal((await h.repository.getAnalysisState(h.guideId))!.draft!.document.title, "수정한 비공개 제목");
});

test("cancellation wins over a late writer and cannot be undone by a retry or stale preparation", async t => {
  const h = await fixture(t), running = await h.start();
  assert.equal(await h.execute({ type: "fail", id: running.id, expectedVersion: running.version, leaseId: randomUUID() }), null);
  const cancelled = await h.execute({ type: "cancel", id: running.id });
  assert.deepEqual(await h.execute({ type: "cancel", id: running.id }), cancelled);
  assert.equal(await cleanupPrivateRedactions(h.repository, h.storage, h.guideId), false);
  const [asset] = await h.repository.listPrivacyAssetBatches(h.guideId);
  const settled = await h.repository.executePrivacyAssetCommand(h.guideId, { type: "settle", id: asset.id,
    writerId: running.leaseId!, receipts: privacyAssetKeys(asset).map(key => ({ key, sha256: "a".repeat(64), size: 100 })) });
  assert.equal(settled?.status, "cleanup");
  assert.equal(await h.execute({ type: "assets-ready", id: running.id, expectedVersion: running.version, leaseId: running.leaseId! }), null);
  assert.equal(await cleanupPrivateRedactions(h.repository, h.storage, h.guideId), true);
  assert.deepEqual(await h.execute(h.command), cancelled);
});

test("verified assets advance only to private preparation, never publication or success", async t => {
  const h = await fixture(t), running = await h.start(), [asset] = await h.repository.listPrivacyAssetBatches(h.guideId);
  const command = { type: "assets-ready" as const, id: running.id, expectedVersion: running.version, leaseId: running.leaseId! };
  assert.equal(await h.execute(command), null);
  await h.repository.executePrivacyAssetCommand(h.guideId, { type: "settle", id: asset.id, writerId: running.leaseId!,
    receipts: privacyAssetKeys(asset).map(key => ({ key, sha256: "a".repeat(64), size: 100 })) });
  const prepared = (await h.execute(command))!;
  assert.equal(prepared.phase, "assets-ready"); assert.equal(prepared.status, "running");
  assert.deepEqual(await h.execute({ ...command, expectedVersion: prepared.version }), prepared);
  assert.ok(!("publicSlug" in prepared) && !("publishedAt" in prepared));
  await h.edit();
  assert.equal((await h.execute({ ...command, expectedVersion: prepared.version }))!.errorCode, "INPUT_CHANGED");
  assert.equal((await h.repository.listPrivacyAssetBatches(h.guideId))[0].status, "cleanup");
});

test("lease expiry is exact, discoverable after restart and does not assume an unknown remote write stopped", async t => {
  const h = await fixture(t), at = new Date(), running = await h.start(at), reopened = new JsonGuideRepository(h.repository.filePath);
  const expiry = new Date(at.getTime() + PUBLICATION_LEASE_MS);
  assert.deepEqual(await reopened.listPublicationWork(20, new Date(expiry.getTime() - 1)), []);
  assert.deepEqual(await reopened.listPublicationWork(20, expiry), [{ guideId: h.guideId, id: running.id, version: running.version }]);
  const recover = { type: "recover" as const, id: running.id, expectedVersion: running.version };
  assert.equal(await h.execute(recover, new Date(expiry.getTime() - 1)), null);
  assert.equal(await h.execute({ type: "assets-ready", id: running.id, expectedVersion: running.version, leaseId: running.leaseId! }, expiry), null);
  const failed = (await h.execute(recover, expiry))!; assert.equal(failed.errorCode, "LEASE_EXPIRED");
  assert.equal(await h.execute(recover, expiry), null);
  const [asset] = await reopened.listPrivacyAssetBatches(h.guideId);
  assert.equal(asset.status, "cleanup"); assert.equal(asset.writerSettled, false);
  assert.equal(await cleanupPrivateRedactions(reopened, h.storage, h.guideId), false);
  assert.equal(await reopened.deleteGuide(h.guideId), false);
  assert.deepEqual(await reopened.listPublicationWork(20, expiry), []);
  assert.deepEqual(await reopened.executePublicationCommand(h.guideId, h.command), failed);
  assert.equal(await h.execute({ type: "claim", id: failed.id, expectedVersion: failed.version, leaseId: randomUUID() }), null);
});

test("whole deletion fences a queued claim and removes history only after asset cleanup", async t => {
  const h = await fixture(t), job = (await h.execute(h.command))!;
  assert.equal(await h.repository.deleteGuide(h.guideId), false);
  await h.repository.updateStatus(h.guideId, "failed", { errorCode: DELETION_PENDING });
  assert.equal((await h.execute({ type: "claim", id: job.id, expectedVersion: job.version, leaseId: randomUUID() }))!.errorCode, "INPUT_CHANGED");
  assert.equal(await finalizeGuideDeletion(h.repository, h.storage, h.guideId, 1), true);
  assert.equal(await h.repository.getPublicationJob(h.guideId, job.id), null);
  assert.equal(await h.execute(h.command), null);
});

test("v6 upgrade preserves asset ownership without write-on-read; old hidden jobs and corrupted snapshots are rejected", async t => {
  const h = await fixture(t);
  const batch = await h.repository.executePrivacyAssetCommand(h.guideId, { type: "reserve", id: randomUUID(), ...h.request });
  const legacy = JSON.parse(await readFile(h.repository.filePath, "utf8")); legacy.version = 6; delete legacy.publicationJobs; delete legacy.publications; delete legacy.publicationHeads; delete legacy.privateCleanup;
  await writeFile(h.repository.filePath, JSON.stringify(legacy));
  const before = await readFile(h.repository.filePath);
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guideId), [batch]);
  assert.deepEqual(await h.repository.listPublicationWork(), []);
  assert.deepEqual(await readFile(h.repository.filePath), before);
  const job = (await h.execute(h.command))!;
  assert.equal(JSON.parse(await readFile(h.repository.filePath, "utf8")).version, 9);
  assert.throws(() => publicationJobSchema.parse({ ...job, content: { ...job.content, title: "tampered" } }));
  assert.throws(() => publicationJobSchema.parse({ ...job, status: "running" }));
  const invalid = JSON.parse(await readFile(h.repository.filePath, "utf8")); invalid.version = 6;
  await writeFile(h.repository.filePath, JSON.stringify(invalid));
  await assert.rejects(h.repository.listPublicationWork(), /Invalid legacy publication state/);
});

test("terminal idempotency history is bounded without discarding replay protection", async t => {
  const h = await fixture(t);
  for (let i = 0; i < PUBLICATION_JOB_LIMIT; i++) {
    const job = (await h.execute({ ...h.command, id: i === 0 ? h.command.id : randomUUID() }))!;
    await h.execute({ type: "cancel", id: job.id });
    assert.equal(await cleanupPrivateRedactions(h.repository, h.storage, h.guideId), true);
  }
  await assert.rejects(h.execute({ ...h.command, id: randomUUID() }), /PUBLICATION_CAPACITY/);
  assert.equal((await h.execute(h.command))!.status, "cancelled");
  assert.deepEqual(await h.repository.listPublicationWork(), []);
  await assert.rejects(h.repository.listPublicationWork(0)); await assert.rejects(h.repository.listPublicationWork(101));
});

test("legacy job command endpoint stays absent and owner job lookup never exposes snapshots or asset keys", async t => {
  const h = await fixture(t), job = (await h.execute(h.command))!;
  const app = createProcessorApp({ config: loadConfig({ NODE_ENV: "test", DATA_DIR: join(h.root, "app"), SHOWME_STORAGE: "local" }),
    repository: h.repository, storage: h.storage, pipeline: { async process() {}, async processClaimed() {} } });
  for (const auth of [undefined, `Bearer ${h.token}`]) {
    const post = request(app).post(`/api/guides/${h.guideId}/publications`).send(h.command);
    if (auth) post.set("Authorization", auth); await post.expect(404);
    const get = request(app).get(`/api/guides/${h.guideId}/publications/${job.id}`);
    if (auth) get.set("Authorization", auth);
    const status = await get.expect(auth ? 200 : 404);
    assert.ok(!status.text.includes(job.batchId)); assert.ok(!status.text.includes("contentFingerprint"));
  }
  const response = await request(app).get(`/api/guides/${h.guideId}`).set("Authorization", `Bearer ${h.token}`).expect(200);
  assert.ok(!JSON.stringify(response.body).includes(job.batchId));
  await request(app).delete(`/api/guides/${h.guideId}`).set("Authorization", `Bearer ${h.token}`).expect(204);
  assert.equal(await h.repository.getPublicationJob(h.guideId, job.id), null);
});
