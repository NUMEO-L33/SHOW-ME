import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DurableProcessingDispatcher } from "../src/dispatcher.js";
import type { GuideRepository } from "../src/domain.js";
import type { GuidePipeline } from "../src/pipeline.js";
import { ProcessingQueue } from "../src/queue.js";
import { JsonGuideRepository } from "../src/repository.js";

process.env.NODE_ENV = "test";

async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for durable dispatch");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function createQueuedGuide(repository: GuideRepository, id: string) {
  await repository.createGuide({
    id,
    slug: id,
    editToken: "test-edit-token",
    title: "Dispatcher test",
    status: "queued",
    originalObjectKey: `guides/${id}/source.mp4`,
    sourceFilename: "source.mp4",
    sourceMimeType: "video/mp4",
    sourceSizeBytes: 128,
  });
}

function repositoryProxy(
  repository: GuideRepository,
  overrides: Partial<GuideRepository>,
): GuideRepository {
  return new Proxy(repository, {
    get(target, property) {
      const source = property in overrides ? overrides : target;
      const value = Reflect.get(source, property, source);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}

test("periodic dispatcher backs off after a transient repository scan failure", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "showme-dispatcher-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = new JsonGuideRepository(join(root, "guides.json"));
  await createQueuedGuide(repository, "transient-scan");

  let scans = 0;
  const flakyRepository = repositoryProxy(repository, {
    async listByStatuses(statuses, limit) {
      scans += 1;
      if (scans === 1) throw new Error("temporary database outage");
      return repository.listByStatuses(statuses, limit);
    },
  });
  let invocations = 0;
  const pipeline: GuidePipeline = {
    async process(guideId) {
      invocations += 1;
      await repository.updateStatus(guideId, "ready", { expectedStatuses: ["queued"] });
    },
    async processClaimed() {},
  };
  const queue = new ProcessingQueue(1, 1);
  const dispatcher = new DurableProcessingDispatcher({
    repository: flakyRepository,
    queue,
    pipeline,
    maxProcessingAttempts: 3,
    queueCapacity: 1,
    activeStaleAfterMs: 0,
    pollIntervalMs: 5,
    maxBackoffMs: 20,
  });

  dispatcher.start();
  await eventually(async () => (await repository.getGuideById("transient-scan"))?.status === "ready");
  await dispatcher.stop();
  await queue.onIdle();

  assert.ok(scans >= 2);
  assert.equal(invocations, 1);
});

test("a rejected queue task is redispatched from durable queued state", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "showme-dispatcher-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = new JsonGuideRepository(join(root, "guides.json"));
  await createQueuedGuide(repository, "rejected-worker");

  let invocations = 0;
  const pipeline: GuidePipeline = {
    async process(guideId) {
      invocations += 1;
      if (invocations === 1) throw new Error("temporary claim failure");
      await repository.updateStatus(guideId, "ready", { expectedStatuses: ["queued"] });
    },
    async processClaimed() {},
  };
  const queue = new ProcessingQueue(1, 1);
  const dispatcher = new DurableProcessingDispatcher({
    repository,
    queue,
    pipeline,
    maxProcessingAttempts: 3,
    queueCapacity: 1,
    activeStaleAfterMs: 0,
    pollIntervalMs: 5,
    maxBackoffMs: 20,
  });

  dispatcher.start();
  await eventually(async () => (await repository.getGuideById("rejected-worker"))?.status === "ready");
  await dispatcher.stop();
  await queue.onIdle();

  assert.equal(invocations, 2);
});

test("a stale post-claim job is recovered by snapshot CAS", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "showme-dispatcher-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = new JsonGuideRepository(join(root, "guides.json"));
  await createQueuedGuide(repository, "post-claim-failure");
  const orphaned = await repository.claimProcessingAttempt(
    "post-claim-failure",
    "orphaned-attempt",
    { maxAttempts: 3 },
  );
  assert.equal(orphaned?.processingAttemptCount, 1);

  const invocations: Array<{ attemptId: string; attemptCount: number }> = [];
  const pipeline: GuidePipeline = {
    async process() {
      assert.fail("an already-claimed guide must use processClaimed");
    },
    async processClaimed(guideId, attemptId, attemptCount) {
      invocations.push({ attemptId, attemptCount });
      await repository.updateStatus(guideId, "failed", {
        expectedStatuses: ["probing"],
        expectedProcessingAttemptId: attemptId,
        expectedProcessingAttemptCount: attemptCount,
      });
    },
  };
  const queue = new ProcessingQueue(1, 1);
  const dispatcher = new DurableProcessingDispatcher({
    repository,
    queue,
    pipeline,
    maxProcessingAttempts: 3,
    queueCapacity: 1,
    activeStaleAfterMs: 0,
    createAttemptId: () => "recovered-attempt",
  });

  await dispatcher.dispatchOnce();
  await queue.onIdle();

  assert.deepEqual(invocations, [{ attemptId: "recovered-attempt", attemptCount: 2 }]);
  const recovered = await repository.getGuideById("post-claim-failure");
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.processingAttemptId, "recovered-attempt");
  assert.equal(recovered?.processingAttemptCount, 2);
});

test("a queued backlog cannot consume the slot needed by stale active recovery", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "showme-dispatcher-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = new JsonGuideRepository(join(root, "guides.json"));
  await createQueuedGuide(repository, "fresh-queued");
  await createQueuedGuide(repository, "stale-active");
  await repository.claimProcessingAttempt("stale-active", "crashed-attempt", { maxAttempts: 3 });
  const invocations: string[] = [];
  const pipeline: GuidePipeline = {
    async process(guideId) {
      invocations.push(`queued:${guideId}`);
      await repository.updateStatus(guideId, "ready", { expectedStatuses: ["queued"] });
    },
    async processClaimed(guideId, attemptId, attemptCount) {
      invocations.push(`active:${guideId}`);
      await repository.updateStatus(guideId, "failed", {
        expectedStatuses: ["probing"],
        expectedProcessingAttemptId: attemptId,
        expectedProcessingAttemptCount: attemptCount,
      });
    },
  };
  const queue = new ProcessingQueue(1, 1);
  const dispatcher = new DurableProcessingDispatcher({
    repository,
    queue,
    pipeline,
    maxProcessingAttempts: 3,
    queueCapacity: 1,
    activeStaleAfterMs: 0,
    createAttemptId: () => "recovered-priority-attempt",
  });

  await dispatcher.dispatchOnce();
  await queue.onIdle();
  assert.deepEqual(invocations, ["active:stale-active"]);
  assert.equal((await repository.getGuideById("fresh-queued"))?.status, "queued");

  await dispatcher.dispatchOnce();
  await queue.onIdle();
  assert.deepEqual(invocations, ["active:stale-active", "queued:fresh-queued"]);
});

test("stale recovery fails closed when the processing attempt cap is exhausted", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "showme-dispatcher-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = new JsonGuideRepository(join(root, "guides.json"));
  await createQueuedGuide(repository, "exhausted-attempts");
  await repository.claimProcessingAttempt("exhausted-attempts", "only-attempt", {
    maxAttempts: 1,
  });

  let invocations = 0;
  const pipeline: GuidePipeline = {
    async process() { invocations += 1; },
    async processClaimed() { invocations += 1; },
  };
  const queue = new ProcessingQueue(1, 1);
  const dispatcher = new DurableProcessingDispatcher({
    repository,
    queue,
    pipeline,
    maxProcessingAttempts: 1,
    queueCapacity: 1,
    activeStaleAfterMs: 0,
  });

  await dispatcher.dispatchOnce();
  await queue.onIdle();

  const exhausted = await repository.getGuideById("exhausted-attempts");
  assert.equal(exhausted?.status, "failed");
  assert.equal(exhausted?.processingAttemptCount, 1);
  assert.equal(invocations, 0);
});

test("stop prevents new scans while queue onIdle still waits for dispatched work", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "showme-dispatcher-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = new JsonGuideRepository(join(root, "guides.json"));
  await createQueuedGuide(repository, "graceful-stop");

  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  let invocations = 0;
  const pipeline: GuidePipeline = {
    async process() {
      invocations += 1;
      await blocker;
    },
    async processClaimed() {},
  };
  const queue = new ProcessingQueue(1, 1);
  const dispatcher = new DurableProcessingDispatcher({
    repository,
    queue,
    pipeline,
    maxProcessingAttempts: 3,
    queueCapacity: 1,
    activeStaleAfterMs: 0,
    pollIntervalMs: 5,
    maxBackoffMs: 20,
  });

  dispatcher.start();
  await eventually(() => invocations === 1);
  await dispatcher.stop();
  let idle = false;
  const idlePromise = queue.onIdle().then(() => { idle = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(invocations, 1);
  assert.equal(idle, false);
  release();
  await idlePromise;
  assert.equal(idle, true);
});
