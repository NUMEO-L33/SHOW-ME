import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DurableProcessingDispatcher } from "../src/processor/dispatcher.js";
import type { GuidePipeline } from "../src/processor/pipeline.js";
import { ProcessingQueue } from "../src/processor/queue.js";
import { JsonGuideRepository } from "../src/processor/repository.js";

process.env.NODE_ENV = "test";

test("concurrent stale dispatchers run only the successful snapshot CAS claim", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "showme-recovery-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = new JsonGuideRepository(join(root, "guides.json"));
  await repository.createGuide({
    id: "recoverable-guide",
    slug: "recoverable-guide",
    editToken: "test-edit-token",
    title: "Recovery test",
    status: "queued",
    originalObjectKey: "guides/recoverable-guide/source.mp4",
    sourceFilename: "source.mp4",
    sourceMimeType: "video/mp4",
    sourceSizeBytes: 128,
  });
  const interrupted = await repository.claimProcessingAttempt(
    "recoverable-guide",
    "interrupted-attempt",
    { maxAttempts: 3 },
  );
  assert.equal(interrupted?.processingAttemptCount, 1);

  const invocations: Array<{ guideId: string; attemptId: string; attemptCount: number }> = [];
  const pipeline: GuidePipeline = {
    async process() {},
    async processClaimed(guideId, attemptId, attemptCount) {
      invocations.push({ guideId, attemptId, attemptCount });
    },
  };
  const firstQueue = new ProcessingQueue(1, 1);
  const secondQueue = new ProcessingQueue(1, 1);
  const common = {
    repository,
    pipeline,
    maxProcessingAttempts: 3,
    queueCapacity: 1,
    activeStaleAfterMs: 0,
  };
  const first = new DurableProcessingDispatcher({
    ...common,
    queue: firstQueue,
    createAttemptId: () => "recovery-attempt-a",
  });
  const second = new DurableProcessingDispatcher({
    ...common,
    queue: secondQueue,
    createAttemptId: () => "recovery-attempt-b",
  });

  await Promise.all([
    first.dispatchOnce(),
    second.dispatchOnce(),
  ]);
  await Promise.all([firstQueue.onIdle(), secondQueue.onIdle()]);

  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].guideId, "recoverable-guide");
  assert.equal(invocations[0].attemptCount, 2);
  assert.notEqual(invocations[0].attemptId, "interrupted-attempt");
  const guide = await repository.getGuideById("recoverable-guide");
  assert.equal(guide?.processingAttemptId, invocations[0].attemptId);
  assert.equal(guide?.processingAttemptCount, 2);
});
