import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { publicationPreparationFixture } from "./helpers/publication-preparation-fixture.js";
import { attemptFrameObjectKey, DELETION_PENDING, finalizeGuideDeletion } from "../src/processor/asset-lifecycle.js";
import { preparePublicationAssets } from "../src/processor/publication-preparation.js";
import { PublicationRecoveryWorker } from "../src/processor/publication-recovery.js";
import { PUBLICATION_LIFETIME_MS } from "../src/processor/publication-commit.js";
import { privacyAssetKeys } from "../src/processor/privacy-assets.js";
import { privacyAfterEdit } from "../src/processor/privacy-review.js";
import { cleanupPrivateRedactions } from "../src/processor/privacy-asset-cleanup.js";
import { JsonGuideRepository } from "../src/processor/repository.js";

async function fixture(t: TestContext) {
  const h = await createAnalysisHarness(t, 1);
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map(s => ({ ...s,
    representativeFrameKey: attemptFrameObjectKey(h.guideId, 1, 1, "frame") })));
  const guide = (await h.repository.getGuideById(h.guideId))!, f = await publicationPreparationFixture(h.repository, guide, h.root);
  const prepare = (real = false) => preparePublicationAssets({ ...f.options, render: real ? undefined : f.fastRender });
  const owner = (job: Awaited<ReturnType<typeof prepare>>) => ({ id: job.id, leaseId: job.leaseId!, expectedVersion: job.version });
  // Metadata-only fixtures for clock/race tests; the first test uses the actual renderer and storage.
  const another = async (at?: Date) => {
    const job = (await h.repository.executePublicationCommand(h.guideId, { type: "request", id: randomUUID(),
      expectedDraftRevision: f.request.revision, expectedInputFingerprint: f.request.inputFingerprint,
      expectedReviewFingerprint: f.request.reviewFingerprint, originalSharingEnabled: false }, at))!;
    const running = (await h.repository.executePublicationCommand(h.guideId, { type: "claim", id: job.id,
      expectedVersion: job.version, leaseId: randomUUID() }, at))!;
    const batch = (await h.repository.listPrivacyAssetBatches(h.guideId)).find(b => b.id === job.batchId)!;
    return (await h.repository.executePublicationCommand(h.guideId, { type: "complete-assets", ...owner(running),
      receipts: privacyAssetKeys(batch).map(key => ({ key, sha256: "a".repeat(64), size: 100 })) }, at))!;
  };
  const edit = async () => {
    const document = structuredClone(f.state.draft!.document); document.title = "private new title";
    document.privacy = privacyAfterEdit(f.state.draft!.document, document);
    await h.repository.executeAnalysisCommand(h.guideId, { type: "save-editor-draft", expectedRevision: f.request.revision,
      expectedInputFingerprint: f.request.inputFingerprint, document });
  };
  return { ...h, ...f, guide, prepare, owner, another, edit };
}

test("real PNG preparation commits one immutable snapshot, independent slug and fixed lifetime without altering source or draft", async t => {
  const h = await fixture(t), before = await h.repository.getGuideById(h.guideId), ready = await h.prepare(true);
  assert.deepEqual(await h.repository.getPublicationState(h.guideId), { head: null, publications: [] });
  const result = (await h.repository.commitPublication(h.guideId, h.owner(ready)))!;
  assert.equal(result.active, true); assert.equal(result.replayed, false); assert.equal(result.publication.batchId, ready.batchId);
  assert.match(result.head.publicSlug, /^[A-Za-z0-9_-]{32}$/); assert.notEqual(result.head.publicSlug, h.guide.slug);
  assert.equal(Date.parse(result.head.expiresAt) - Date.parse(result.head.firstPublishedAt), PUBLICATION_LIFETIME_MS);
  assert.deepEqual(result.publication.content, ready.content);
  assert.equal((await h.repository.getPublicationJob(h.guideId, ready.id))!.status, "succeeded");
  assert.deepEqual(await h.repository.getGuideById(h.guideId), before); assert.deepEqual(await h.repository.getAnalysisState(h.guideId), h.state);
  for (const forbidden of ["sourceKey", "originalObjectKey", "sourceFilename", "editToken", "privacy-mask", "intent"])
    assert.ok(!JSON.stringify(result.publication).includes(forbidden));
  const reopened = new JsonGuideRepository(h.repository.filePath);
  assert.deepEqual((await reopened.getPublicationState(h.guideId))!.publications, [result.publication]);
  result.publication.content.title = "not persisted";
  assert.equal((await reopened.getPublicationState(h.guideId))!.publications[0].content.title, ready.content.title);
});

test("duplicate commits and lost acknowledgement replay without moving the head or rewriting state", async t => {
  const h = await fixture(t), ready = await h.prepare(), command = h.owner(ready);
  const commits = await Promise.all(Array.from({ length: 12 }, () => h.repository.commitPublication(h.guideId, command)));
  assert.equal(commits.filter(c => c && !c.replayed).length, 1); assert.ok(commits.every(c => c?.head.version === 1));
  const before = await readFile(h.repository.filePath);
  const result = (await new JsonGuideRepository(h.repository.filePath).commitPublication(h.guideId, command))!;
  assert.equal(result.replayed, true); assert.deepEqual(await readFile(h.repository.filePath), before);
  assert.equal(await h.repository.commitPublication(h.guideId, { ...command, leaseId: randomUUID() }), null);
  assert.equal(await h.repository.commitPublication(h.guideId, { ...command, expectedVersion: ready.version + 1 }), null);
});

test("queued, rendering, wrong owner, wrong version and exact lease expiry cannot commit", async t => {
  const h = await fixture(t);
  assert.equal(await h.repository.commitPublication(h.guideId, { id: h.job.id, leaseId: randomUUID(), expectedVersion: 1 }), null);
  const running = (await h.repository.executePublicationCommand(h.guideId,
    { type: "claim", id: h.job.id, expectedVersion: 1, leaseId: randomUUID() }))!;
  assert.equal(await h.repository.commitPublication(h.guideId, h.owner(running)), null);
  const [batch] = await h.repository.listPrivacyAssetBatches(h.guideId);
  const ready = (await h.repository.executePublicationCommand(h.guideId, { type: "complete-assets", ...h.owner(running),
    receipts: privacyAssetKeys(batch).map(key => ({ key, sha256: "a".repeat(64), size: 100 })) }))!;
  for (const patch of [{ leaseId: randomUUID() }, { expectedVersion: ready.version + 1 }])
    assert.equal(await h.repository.commitPublication(h.guideId, { ...h.owner(ready), ...patch }), null);
  assert.equal(await h.repository.commitPublication(h.guideId, h.owner(ready), new Date(ready.leaseExpiresAt!)), null);
  assert.deepEqual(await h.repository.getPublicationState(h.guideId), { head: null, publications: [] });
});

for (const stop of ["edit", "cancel", "delete"] as const)
test(`${stop} before final commit prevents any snapshot or public reference`, async t => {
  const h = await fixture(t), ready = await h.prepare();
  if (stop === "edit") await h.edit();
  if (stop === "cancel") await h.repository.executePublicationCommand(h.guideId, { type: "cancel", id: ready.id });
  if (stop === "delete") await h.repository.updateStatus(h.guideId, "failed", { errorCode: DELETION_PENDING });
  assert.equal(await h.repository.commitPublication(h.guideId, h.owner(ready)), null);
  assert.deepEqual(await h.repository.getPublicationState(h.guideId), { head: null, publications: [] });
});

test("private edits do not change the committed snapshot and preparation cancellation cannot cancel a successful publication", async t => {
  const h = await fixture(t), ready = await h.prepare(), committed = (await h.repository.commitPublication(h.guideId, h.owner(ready)))!;
  await h.edit();
  const job = (await h.repository.getPublicationJob(h.guideId, ready.id))!;
  assert.equal((await h.repository.executePublicationCommand(h.guideId, { type: "cancel", id: job.id }))!.status, "succeeded");
  assert.equal((await h.repository.executePublicationCommand(h.guideId, { type: "abandon", id: job.id, leaseId: job.leaseId! }))!.status, "succeeded");
  assert.deepEqual((await h.repository.getPublicationState(h.guideId))!.publications[0], committed.publication);
  assert.equal(await cleanupPrivateRedactions(h.repository, h.storage, h.guideId), false);
  for (const image of committed.publication.images) { const stream = await h.storage.openRead(image.frame.key); stream.destroy(); }
});

test("republish swaps only after all preparation succeeds, keeps immutable history and cleans only superseded images", async t => {
  const h = await fixture(t), ready = await h.prepare(), first = (await h.repository.commitPublication(h.guideId, h.owner(ready)))!;
  const later = new Date(Date.parse(first.head.firstPublishedAt) + 86_400_000), next = await h.another(later);
  assert.equal((await h.repository.getPublicationState(h.guideId))!.head!.activePublicationId, ready.id);
  const second = (await h.repository.commitPublication(h.guideId, h.owner(next), later))!;
  assert.equal(second.head.activePublicationId, next.id); assert.equal(second.head.version, 2);
  assert.equal(second.head.publicSlug, first.head.publicSlug); assert.equal(second.head.firstPublishedAt, first.head.firstPublishedAt);
  assert.equal(second.head.expiresAt, first.head.expiresAt);
  const before = await readFile(h.repository.filePath), replay = (await h.repository.commitPublication(h.guideId, h.owner(ready), later))!;
  assert.equal(replay.active, false); assert.equal(replay.replayed, true); assert.deepEqual(await readFile(h.repository.filePath), before);
  const worker = new PublicationRecoveryWorker({ repository: h.repository, storage: h.storage });
  assert.equal((await worker.tick()).cleaned, 1);
  const remaining = await h.repository.listPrivacyAssetBatches(h.guideId);
  assert.equal(remaining.length, 1); assert.equal(remaining[0].id, next.batchId); assert.equal(remaining[0].status, "ready");
  assert.deepEqual((await h.repository.getPublicationState(h.guideId))!.publications[0], first.publication);
});

test("failed atomic file replacement preserves the previous head, job and both asset ledgers", async t => {
  const h = await fixture(t), ready = await h.prepare(); await h.repository.commitPublication(h.guideId, h.owner(ready));
  const next = await h.another(), before = await readFile(h.repository.filePath);
  t.mock.method(h.repository as unknown as { writeState: () => Promise<void> }, "writeState", async () => { throw new Error("fixture write failed"); });
  await assert.rejects(h.repository.commitPublication(h.guideId, h.owner(next)));
  assert.deepEqual(await readFile(h.repository.filePath), before);
  assert.equal((await h.repository.getPublicationJob(h.guideId, next.id))!.phase, "assets-ready");
  t.mock.restoreAll(); assert.equal((await h.repository.commitPublication(h.guideId, h.owner(next)))!.active, true);
});

test("first-publication expiry cannot be extended by republishing or duplicate success replay", async t => {
  const h = await fixture(t), ready = await h.prepare(), first = (await h.repository.commitPublication(h.guideId, h.owner(ready)))!;
  const expiry = new Date(first.head.expiresAt), next = await h.another(new Date(expiry.getTime() - 1));
  assert.equal(await h.repository.commitPublication(h.guideId, h.owner(next), expiry), null);
  const replay = (await h.repository.commitPublication(h.guideId, h.owner(ready), expiry))!;
  assert.equal(replay.active, false); assert.equal(replay.head.expiresAt, first.head.expiresAt);
  assert.equal((await h.repository.getPublicationState(h.guideId))!.publications.length, 1);
});

test("whole-guide deletion overrides active asset protection and removes snapshots/head without resurrection", async t => {
  const h = await fixture(t), ready = await h.prepare(); await h.repository.commitPublication(h.guideId, h.owner(ready));
  assert.equal(await h.repository.deleteGuide(h.guideId), false);
  await h.repository.updateStatus(h.guideId, "failed", { errorCode: DELETION_PENDING });
  assert.equal(await h.repository.commitPublication(h.guideId, h.owner(ready)), null);
  assert.equal(await finalizeGuideDeletion(h.repository, h.storage, h.guideId, 1), true);
  assert.equal(await h.repository.getPublicationState(h.guideId), null);
  assert.equal(await h.repository.commitPublication(h.guideId, h.owner(ready)), null);
});

test("v7 upgrades without read-side writes and committed state cannot hide in an older version", async t => {
  const h = await fixture(t), ready = await h.prepare(), state = JSON.parse(await readFile(h.repository.filePath, "utf8"));
  state.version = 7; delete state.publications; delete state.publicationHeads; delete state.privateCleanup;
  await writeFile(h.repository.filePath, JSON.stringify(state)); const before = await readFile(h.repository.filePath);
  assert.deepEqual(await h.repository.getPublicationState(h.guideId), { head: null, publications: [] });
  assert.deepEqual(await readFile(h.repository.filePath), before);
  assert.ok(await h.repository.commitPublication(h.guideId, h.owner(ready)));
  const current = JSON.parse(await readFile(h.repository.filePath, "utf8")); assert.equal(current.version, 9);
  current.version = 7; await writeFile(h.repository.filePath, JSON.stringify(current));
  await assert.rejects(h.repository.getPublicationState(h.guideId), /Invalid legacy committed publications/);
});

test("corrupt snapshot contents, raw image keys, dangling heads and orphaned success never become readable publications", async t => {
  const h = await fixture(t), ready = await h.prepare(); await h.repository.commitPublication(h.guideId, h.owner(ready));
  const original = JSON.parse(await readFile(h.repository.filePath, "utf8"));
  for (const damage of [
    (s: typeof original) => { s.publications[0].content.title = "tampered"; },
    (s: typeof original) => { s.publications[0].images[0].frame.key = h.guide.steps[0].representativeFrameKey; },
    (s: typeof original) => { s.publicationHeads[0].activePublicationId = randomUUID(); },
    (s: typeof original) => { s.publications = []; },
  ]) {
    const state = structuredClone(original); damage(state); await writeFile(h.repository.filePath, JSON.stringify(state));
    await assert.rejects(new JsonGuideRepository(h.repository.filePath).getPublicationState(h.guideId));
  }
});

test("commit remains an internal persistence method, not a public API or automatic server action", async () => {
  for (const file of ["src/processor/index.ts", "src/processor/server.ts"]) {
    const source = await readFile(file, "utf8"); assert.ok(!source.includes("commitPublication"));
  }
});
