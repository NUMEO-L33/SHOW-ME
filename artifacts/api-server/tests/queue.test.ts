import assert from "node:assert/strict";
import { test } from "node:test";

import { ProcessingQueue, QueueCapacityError } from "../src/processor/queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for queue state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("coalesces a same-key retry that arrives before the running task releases its key", async () => {
  const first = deferred();
  const calls: string[] = [];
  const queue = new ProcessingQueue(1, 2);
  assert.equal(queue.enqueue("guide", async () => { calls.push("first"); await first.promise; }), true);
  assert.equal(queue.enqueue("guide", async () => { calls.push("retry"); }), false);
  first.resolve();
  await eventually(() => calls.length === 2 && queue.snapshot().running === 0);
  assert.deepEqual(calls, ["first", "retry"]);
});

test("rejects new keys beyond its bounded capacity", async () => {
  const blocker = deferred();
  const queue = new ProcessingQueue(1, 1);
  queue.enqueue("first", () => blocker.promise);
  assert.throws(() => queue.enqueue("second", async () => undefined), QueueCapacityError);
  blocker.resolve();
  await eventually(() => queue.snapshot().running === 0);
});

test("onIdle waits until running work and its coalesced rerun both finish", async () => {
  const first = deferred();
  const second = deferred();
  const queue = new ProcessingQueue(1, 2);
  queue.enqueue("guide", () => first.promise);
  queue.enqueue("guide", () => second.promise);
  let idle = false;
  const idlePromise = queue.onIdle().then(() => { idle = true; });
  first.resolve();
  await eventually(() => queue.snapshot().running === 1);
  assert.equal(idle, false);
  second.resolve();
  await idlePromise;
  assert.equal(idle, true);
});
