import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { publicationPreparationFixture } from "./helpers/publication-preparation-fixture.js";
import { attemptFrameObjectKey, DELETION_PENDING, finalizeGuideDeletion } from "../src/processor/asset-lifecycle.js";
import { cleanupPrivateAssetLifecycle } from "../src/processor/index.js";
import { preparePublicationAssets } from "../src/processor/publication-preparation.js";
import { cleanupExpiredPrivateMedia, PRIVATE_MEDIA_EXPIRED, PRIVATE_RETENTION_MS, privateCleanupSchema, sweepExpiredPrivateMedia } from "../src/processor/private-retention.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import type { PublicationJob } from "../src/processor/publication-jobs.js";
import { privacyAfterEdit } from "../src/processor/privacy-review.js";
import request from "supertest";
import { createProcessorApp } from "../src/processor/server.js";
import { loadConfig } from "../src/processor/config.js";

const NOW = Date.parse("2026-09-01T12:00:00.000Z"), DAY = 24 * 60 * 60_000;
const options = { maxSteps: 1, activeGraceMs: 60_000, abandonedDraftGraceMs: PRIVATE_RETENTION_MS };
const owner = (job: PublicationJob) => ({ id: job.id, leaseId: job.leaseId!, expectedVersion: job.version });
async function fixture(t: TestContext, publishOffset = 0) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const token = randomBytes(32).toString("base64url");
  const h = await createAnalysisHarness(t, 1, { guideId: randomUUID(), editToken: token });
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map(s => ({ ...s, representativeFrameKey: attemptFrameObjectKey(h.guideId, 1, 1, "frame") })));
  const guide = (await h.repository.getGuideById(h.guideId))!, f = await publicationPreparationFixture(h.repository, guide, h.root);
  const source = join(h.root, "source.bin"); await writeFile(source, "synthetic source only"); await f.storage.putFile(guide.originalObjectKey, source);
  const prepare = (job = f.job) => preparePublicationAssets({ ...f.options, jobId: job.id, expectedVersion: job.version, render: f.fastRender });
  t.mock.timers.setTime(NOW + publishOffset);
  const ready = await prepare(), published = (await h.repository.commitPublication(h.guideId, owner(ready)))!;
  const updated = (await h.repository.getGuideById(h.guideId))!;
  const expire = () => h.repository.expirePrivateDraft(h.guideId, { expectedUpdatedAt: updated.updatedAt, updatedBefore: updated.updatedAt });
  const request = () => h.repository.executePublicationCommand(h.guideId, { type: "request", id: randomUUID(), expectedDraftRevision: f.request.revision,
    expectedInputFingerprint: f.request.inputFingerprint, expectedReviewFingerprint: f.request.reviewFingerprint, originalSharingEnabled: false });
  return { ...h, ...f, guide: updated, ready, published, expire, request, prepare, token };
}

test("seven-day sweep erases private source and draft, preserves published pixels until the exact fifteen-day boundary", async t => {
  const h = await fixture(t), query = { slug: h.published.head.publicSlug }, image = h.published.publication.images[0].frame.key;
  t.mock.timers.setTime(NOW + 7 * DAY - 1);
  await cleanupPrivateAssetLifecycle(h.repository, h.storage, { ...options, now: Date.now() });
  assert.equal((await h.repository.getGuideById(h.guideId))!.status, "ready"); await access(join(h.storage.root, h.guide.originalObjectKey));
  t.mock.timers.setTime(NOW + 7 * DAY);
  await cleanupPrivateAssetLifecycle(h.repository, h.storage, { ...options, now: Date.now() });
  const expired = (await h.repository.getGuideById(h.guideId))!;
  assert.equal(expired.errorCode, PRIVATE_MEDIA_EXPIRED); assert.equal(expired.updatedAt, h.guide.updatedAt); assert.deepEqual(expired.steps, []);
  assert.equal(expired.sourceSizeBytes, 0); assert.notEqual(expired.sourceFilename, h.guide.sourceFilename);
  assert.equal((await h.repository.getAnalysisState(h.guideId))!.draft, null);
  assert.equal(await h.repository.getPrivateCleanup(h.guideId), null);
  for (const key of [h.guide.originalObjectKey, h.guide.steps[0].representativeFrameKey!]) await assert.rejects(access(join(h.storage.root, key)));
  await access(join(h.storage.root, image)); assert.ok(await h.repository.getAccessiblePublication(query));
  assert.deepEqual((await h.repository.getPublicationState(h.guideId))!.head, h.published.head);
  t.mock.timers.setTime(NOW + 15 * DAY - 1);
  await cleanupPrivateAssetLifecycle(h.repository, h.storage, { ...options, now: Date.now() });
  assert.ok(await h.repository.getAccessiblePublication(query));
  t.mock.timers.setTime(NOW + 15 * DAY);
  assert.equal(await h.repository.getAccessiblePublication(query), null);
  await cleanupPrivateAssetLifecycle(h.repository, h.storage, { ...options, now: Date.now() });
  assert.equal(await h.repository.getGuideById(h.guideId), null); await assert.rejects(access(join(h.storage.root, image)));
});

test("publishing six days after editing does not buy six extra private days", async t => {
  const h = await fixture(t, 6 * DAY);
  assert.equal(h.guide.updatedAt, new Date(NOW).toISOString());
  assert.equal(h.published.head.expiresAt, new Date(NOW + 21 * DAY).toISOString());
  t.mock.timers.setTime(NOW + 7 * DAY);
  await cleanupPrivateAssetLifecycle(h.repository, h.storage, { ...options, now: Date.now() });
  assert.equal((await h.repository.getGuideById(h.guideId))!.errorCode, PRIVATE_MEDIA_EXPIRED);
  t.mock.timers.setTime(NOW + 20 * DAY);
  assert.ok(await h.repository.getAccessiblePublication({ slug: h.published.head.publicSlug }));
  t.mock.timers.setTime(NOW + 21 * DAY);
  await cleanupPrivateAssetLifecycle(h.repository, h.storage, { ...options, now: Date.now() });
  assert.equal(await h.repository.getGuideById(h.guideId), null);
});

test("private expiry fences edits, re-analysis, media retries and pending publication while scrubbing unpublished text", async t => {
  const h = await fixture(t), pending = await h.prepare((await h.request())!);
  t.mock.timers.setTime(NOW + 7 * DAY); assert.ok(await h.expire());
  const cancelled = (await h.repository.getPublicationJob(h.guideId, pending.id))!;
  assert.equal(cancelled.status, "cancelled"); assert.notDeepEqual(cancelled.content, pending.content);
  assert.equal(await h.repository.executeAnalysisCommand(h.guideId, { type: "initialize" }), null);
  assert.equal(await h.repository.executeAnalysisCommand(h.guideId, { type: "save-editor-draft", expectedRevision: h.state.draft!.revision,
    expectedInputFingerprint: h.manifest.fingerprint, document: h.state.draft!.document }), null);
  assert.equal(await h.repository.updateStatus(h.guideId, "ready", { errorCode: null }), null);
  assert.equal(await h.repository.claimProcessingAttempt(h.guideId, "late", { expectedStatuses: ["failed"] }), null);
  await assert.rejects(h.repository.replaceSteps(h.guideId, h.guide.steps));
  await assert.rejects(h.request()); assert.equal(await h.repository.commitPublication(h.guideId, owner(pending)), null);
  assert.equal(await cleanupExpiredPrivateMedia(h.repository, h.storage, h.guideId), true);
  assert.deepEqual((await h.repository.listPrivacyAssetBatches(h.guideId)).map(b => b.id), [h.ready.batchId]);
  assert.ok(await h.repository.getAccessiblePublication({ slug: h.published.head.publicSlug }));
});

test("unknown processed writer retains cleanup evidence across reopen, never deletes the active publication", async t => {
  const h = await fixture(t), pending = (await h.request())!, leaseId = randomUUID();
  const claimed = (await h.repository.executePublicationCommand(h.guideId, { type: "claim", id: pending.id, expectedVersion: pending.version, leaseId }))!;
  t.mock.timers.setTime(NOW + 7 * DAY); await h.expire();
  assert.equal(await cleanupExpiredPrivateMedia(h.repository, h.storage, h.guideId), false);
  const reopened = new JsonGuideRepository(h.repository.filePath), ledger = (await reopened.getPrivateCleanup(h.guideId))!;
  assert.ok(ledger); assert.equal(await reopened.completePrivateCleanup(h.guideId, randomUUID()), false);
  const batch = (await reopened.listPrivacyAssetBatches(h.guideId)).find(b => b.id === claimed.batchId)!;
  assert.equal(batch.writerSettled, false); assert.equal(batch.status, "cleanup");
  assert.ok(await reopened.getAccessiblePublication({ slug: h.published.head.publicSlug }));
  assert.equal(await reopened.deleteGuide(h.guideId), false);
  assert.ok(await reopened.executePrivacyAssetCommand(h.guideId, { type: "settle", id: batch.id, writerId: leaseId, receipts: null }));
  assert.equal(await cleanupExpiredPrivateMedia(reopened, h.storage, h.guideId), true);
  assert.equal(await reopened.getPrivateCleanup(h.guideId), null);
});

test("storage failure retains exact raw keys and retry after reopen leaves the published snapshot unchanged", async t => {
  const h = await fixture(t); t.mock.timers.setTime(NOW + 7 * DAY); await h.expire();
  const ledger = (await h.repository.getPrivateCleanup(h.guideId))!;
  assert.ok(ledger.keys.includes(h.guide.originalObjectKey)); assert.ok(!ledger.keys.some(k => k.includes("private-redactions")));
  t.mock.method(h.storage, "delete", async () => { throw new Error("synthetic storage failure"); });
  await assert.rejects(cleanupExpiredPrivateMedia(h.repository, h.storage, h.guideId));
  assert.deepEqual(await h.repository.getPrivateCleanup(h.guideId), ledger);
  t.mock.restoreAll(); const reopened = new JsonGuideRepository(h.repository.filePath);
  assert.equal(await cleanupExpiredPrivateMedia(reopened, h.storage, h.guideId), true);
  assert.deepEqual((await reopened.getPublicationState(h.guideId))!.publications, [h.published.publication]);
  assert.ok(await reopened.getAccessiblePublication({ slug: h.published.head.publicSlug }));
});

test("expiry persistence failure rolls back private metadata, source ledger and job cancellation together", async t => {
  const h = await fixture(t); await h.request(); const before = await readFile(h.repository.filePath);
  t.mock.timers.setTime(NOW + 7 * DAY);
  t.mock.method(h.repository as unknown as { writeState: () => Promise<void> }, "writeState", async () => { throw new Error("fixture"); });
  await assert.rejects(h.expire()); assert.deepEqual(await readFile(h.repository.filePath), before);
  t.mock.restoreAll(); assert.ok(await h.expire());
});

test("a fresh save after selection wins the expiry CAS and publication never renews the private clock", async t => {
  const h = await fixture(t); assert.equal(h.guide.updatedAt, new Date(NOW).toISOString());
  t.mock.timers.setTime(NOW + 6 * DAY);
  const document = { ...h.state.draft!.document, title: "fresh synthetic edit" };
  document.privacy = privacyAfterEdit(h.state.draft!.document, document);
  assert.ok(await h.repository.executeAnalysisCommand(h.guideId, { type: "save-editor-draft", expectedRevision: h.state.draft!.revision,
    expectedInputFingerprint: h.manifest.fingerprint, document }));
  t.mock.timers.setTime(NOW + 7 * DAY); assert.equal(await h.expire(), null);
  await cleanupPrivateAssetLifecycle(h.repository, h.storage, { ...options, now: Date.now() });
  assert.equal((await h.repository.getGuideById(h.guideId))!.status, "ready");
  assert.equal((await h.repository.getPublicationState(h.guideId))!.head!.expiresAt, h.published.head.expiresAt);
});

for (const mode of ["withdraw", "delete"] as const)
test(`${mode} still works after private expiry and removes retained published bytes`, async t => {
  const h = await fixture(t); t.mock.timers.setTime(NOW + 7 * DAY); await h.expire();
  if (mode === "withdraw") {
    assert.ok(await h.repository.stopPublication(h.guideId, { type: "withdraw", expectedHeadVersion: 1, expectedJobId: null }));
    assert.equal(await h.repository.getAccessiblePublication({ slug: h.published.head.publicSlug }), null);
    await cleanupPrivateAssetLifecycle(h.repository, h.storage, { ...options, now: Date.now() });
  } else {
    assert.ok(await h.repository.updateStatus(h.guideId, "failed", { errorCode: DELETION_PENDING }));
    assert.equal(await finalizeGuideDeletion(h.repository, h.storage, h.guideId, 1), true);
  }
  assert.equal(await h.repository.getGuideById(h.guideId), null);
  await assert.rejects(access(join(h.storage.root, h.published.publication.images[0].frame.key)));
});

test("cleanup ledger enforces raw-only keys, bounded keysets and acknowledged deletion", async t => {
  const h = await fixture(t); t.mock.timers.setTime(NOW + 7 * DAY); await h.expire();
  const row = (await h.repository.getPrivateCleanup(h.guideId))!;
  for (const key of ["guides/other/source.mp4", `guides/${h.guideId}/frames/../secret`, h.published.publication.images[0].frame.key])
    assert.equal(privateCleanupSchema.safeParse({ ...row, keys: [key] }).success, false);
  assert.equal(privateCleanupSchema.safeParse({ ...row, keys: [row.keys[0], row.keys[0]] }).success, false);
  assert.equal((await h.repository.listPrivateCleanup({ limit: 1 })).length, 1);
  assert.deepEqual(await h.repository.listPrivateCleanup({ after: row.id }), []);
  await assert.rejects(h.repository.listPrivateCleanup({ limit: 21 }));
  await sweepExpiredPrivateMedia(h.repository, h.storage, { deadline: Date.now(), timeoutMs: 100 });
  assert.ok(await h.repository.getPrivateCleanup(h.guideId));
  await sweepExpiredPrivateMedia(h.repository, h.storage, { deadline: Date.now() + 30_000, timeoutMs: 30_000 });
  assert.equal(await h.repository.getPrivateCleanup(h.guideId), null);
});

test("JSON v8 upgrades on write without altering existing publication history on read", async t => {
  const h = await fixture(t), old = JSON.parse(await readFile(h.repository.filePath, "utf8"));
  old.version = 8; delete old.privateCleanup; await writeFile(h.repository.filePath, JSON.stringify(old));
  const before = await readFile(h.repository.filePath), reopened = new JsonGuideRepository(h.repository.filePath);
  assert.deepEqual((await reopened.getPublicationState(h.guideId))!.publications, [h.published.publication]);
  assert.deepEqual(await readFile(h.repository.filePath), before);
  t.mock.timers.setTime(NOW + 7 * DAY); assert.ok(await h.expire());
  assert.equal(JSON.parse(await readFile(h.repository.filePath, "utf8")).version, 9);
});

test("HTTP expiry denies still-valid old image tickets, editing and retries; whole deletion honors retained raw cleanup", async t => {
  const h = await fixture(t), config = loadConfig({ NODE_ENV: "test", DATA_DIR: h.root, SHOWME_STORAGE: "local" });
  const app = createProcessorApp({ config, repository: h.repository, storage: h.storage,
    pipeline: { async process() { assert.fail("no processing"); }, async processClaimed() { assert.fail("no processing"); } } });
  const url = `/api/guides/${h.guideId}`, auth = `Bearer ${h.token}`;
  t.mock.timers.setTime(NOW + 7 * DAY);
  const before = await request(app).get(url).set("Authorization", auth).expect(200);
  const ticket = before.body.guide.steps[0].frameUrl;
  await request(app).get(ticket).expect(200);
  await h.expire();
  await request(app).get(ticket).expect(404);
  await request(app).get(`${url}/assets/${h.guide.steps[0].id}/frame`).set("Authorization", auth).expect(404);
  await request(app).get(`${url}/draft`).set("Authorization", auth).expect(409).expect("Cache-Control", "no-store");
  await request(app).post(`${url}/retry`).set("Authorization", auth).expect(409);
  const status = await request(app).get(url).set("Authorization", auth).expect(200);
  assert.deepEqual(status.body.guide.steps, []); assert.ok(!status.text.includes(h.guide.sourceFilename));
  t.mock.method(h.storage, "delete", async () => { throw new Error("synthetic private object detail"); });
  const logs: string[] = []; t.mock.method(console, "error", (message: string) => { logs.push(message); });
  await request(app).delete(url).set("Authorization", auth).expect(503);
  assert.ok(await h.repository.getPrivateCleanup(h.guideId));
  assert.equal(await h.repository.getAccessiblePublication({ slug: h.published.head.publicSlug }), null);
  assert.ok(!logs.join("").includes("synthetic private object detail"));
  t.mock.restoreAll(); await request(app).delete(url).set("Authorization", auth).expect(204);
  assert.equal(await h.repository.getGuideById(h.guideId), null);
});
