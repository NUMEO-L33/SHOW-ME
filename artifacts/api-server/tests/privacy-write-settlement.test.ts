import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { publicationPreparationFixture } from "./helpers/publication-preparation-fixture.js";
import { lateStorageFixture } from "./helpers/late-storage-fixture.js";
import { attemptFrameObjectKey } from "../src/processor/asset-lifecycle.js";
import { cleanupPrivateRedactions } from "../src/processor/privacy-asset-cleanup.js";
import { privateAssetWriterBusy } from "../src/processor/privacy-asset-session.js";
import { writePrivateRedactions } from "../src/processor/privacy-asset-writer.js";
import { privacyAssetKeys } from "../src/processor/privacy-assets.js";
import { preparePublicationAssets, cleanupPublicationPreparation } from "../src/processor/publication-preparation.js";
import { PublicationRecoveryWorker } from "../src/processor/publication-recovery.js";
import { JsonGuideRepository } from "../src/processor/repository.js";

for (const lane of ["standalone", "publication"] as const)
for (const failure of ["result", "rejection"] as const)
for (const failAt of [1, 2])
test(`${lane}: SDK ${failure} at put ${failAt} retains cleanup ownership through late commits and restart`, async t => {
  const h = await createAnalysisHarness(t, 1, { guideId: randomUUID(), editToken: "synthetic" });
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map(s => ({ ...s,
    representativeFrameKey: attemptFrameObjectKey(h.guideId, 1, s.position + 1, "frame") })));
  const guide = (await h.repository.getGuideById(h.guideId))!;
  const p = await publicationPreparationFixture(h.repository, guide, h.root);
  // Standalone E2 must own its own reservation, not the publication job's.
  if (lane === "standalone") {
    await h.repository.executePublicationCommand(h.guideId, { type: "cancel", id: p.job.id });
    assert.equal(await cleanupPublicationPreparation(h.repository, p.storage, h.guideId, p.job.id), true);
  }
  const sourceKey = guide.steps[0].representativeFrameKey!;
  const remote = lateStorageFixture(sourceKey, p.source, failure, failAt);
  const options = { ...p.options, storage: remote.storage, render: p.fastRender };
  await assert.rejects(lane === "publication" ? preparePublicationAssets(options)
    : writePrivateRedactions({ ...options, ...p.request }),
  e => e instanceof Error && e.message === "PRIVACY_ASSET_WRITE_UNAVAILABLE" && e.cause === undefined);
  assert.equal(privateAssetWriterBusy(), false); // Durable ownership, not a permanently occupied process slot.
  assert.equal(remote.puts.length, failAt);
  assert.deepEqual(await readdir(p.options.workDir), []);
  const reopened = new JsonGuideRepository(h.repository.filePath);
  const batches = await reopened.listPrivacyAssetBatches(h.guideId);
  assert.equal(batches.length, 1);
  const [batch] = batches, keys = privacyAssetKeys(batch);
  assert.equal(batch.status, "cleanup"); assert.equal(batch.writerSettled, false);
  assert.deepEqual(batch.receipts, []);
  assert.deepEqual(remote.deletes, keys.map(remote.name));
  for (const key of keys) assert.equal(remote.bytes(key), undefined);
  const cleanup = () => lane === "publication"
    ? cleanupPublicationPreparation(reopened, remote.storage, h.guideId, p.job.id)
    : cleanupPrivateRedactions(reopened, remote.storage, h.guideId);
  // Repeated absence/deletes are not proof that an upload can no longer commit.
  assert.equal(await cleanup(), false);
  assert.equal(await reopened.deleteGuide(h.guideId), false);
  remote.commitLate(); assert.ok(remote.bytes(keys[failAt - 1]));
  if (lane === "publication") {
    assert.equal((await reopened.getPublicationJob(h.guideId, p.job.id))!.status, "failed");
    const worker = new PublicationRecoveryWorker({ repository: reopened, storage: remote.storage });
    const report = await worker.tick();
    assert.equal(report.status, "pending"); assert.equal(report.pending, 1); assert.equal(report.cleaned, 0);
    assert.equal((await worker.stop()).pendingIO, false);
    await assert.rejects(preparePublicationAssets({ ...options, repository: reopened }));
  } else assert.equal(await cleanup(), false);
  for (const key of keys) assert.equal(remote.bytes(key), undefined);
  // Even a second, later commit remains addressable; never retry the upload.
  remote.commitLate(); assert.equal(await cleanup(), false);
  for (const key of keys) assert.equal(remote.bytes(key), undefined);
  assert.equal(remote.puts.length, failAt);
  assert.ok(remote.deletes.every(k => keys.map(remote.name).includes(k)));
  assert.equal((await reopened.listPrivacyAssetBatches(h.guideId))[0].writerSettled, false);
  assert.equal(await reopened.deleteGuide(h.guideId), false);
  assert.deepEqual(remote.bytes(sourceKey), p.source);
  assert.deepEqual(await reopened.getAnalysisState(h.guideId), p.state);
});
