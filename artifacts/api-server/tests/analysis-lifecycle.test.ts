import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAnalysisLifecycle, type ProcessorAnalysisContext } from "../src/processor/analysis-lifecycle.js";
import { attachFixedSyntheticAnalysisRuntime } from "../src/processor/analysis-synthetic-runtime.js";
import { loadConfig } from "../src/processor/config.js";
import { testMediaPaths } from "./helpers/media-binaries.js";
import { startProcessor } from "../src/processor/index.js";

const context = () => ({ repository: {}, storage: {} }) as ProcessorAnalysisContext;

test("asynchronous bootstrap is awaited, never starts itself, and rejects failed preflight", async () => {
  const ctx = context(); let finish!: () => void; let starts = 0;
  const pending = createAnalysisLifecycle(ctx, async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { ...ctx, admission: { async request() { return null; } }, start() { starts++; }, async stop() {} };
  });
  assert.equal(starts, 0); finish(); const lifecycle = (await pending)!; assert.equal(starts, 0);
  lifecycle.start(); assert.equal(starts, 1); await lifecycle.stop();
  await assert.rejects(createAnalysisLifecycle(ctx, async () => { throw new Error("fixture-preflight-failed"); }), /fixture-preflight-failed/);
});
const call = (lifecycle: NonNullable<Awaited<ReturnType<typeof createAnalysisLifecycle>>>) => lifecycle.admission.request("fixture", {} as never, new AbortController().signal);
test("availability stays off before start and after stop, including an in-flight successful check", async () => {
  const ctx = context(); let resolve!: (value: boolean) => void;
  const lifecycle = (await createAnalysisLifecycle(ctx, () => ({ ...ctx, admission: { async request() { return null; },
    inspectAvailability: () => new Promise<boolean>(done => { resolve = done; }) }, start() {}, async stop() {} })))!;
  const inspect = () => lifecycle.admission.inspectAvailability!({} as never, new AbortController().signal);
  assert.equal(await inspect(), false); lifecycle.start(); const pending = inspect();
  await lifecycle.stop(); resolve(true); assert.equal(await pending, false); assert.equal(await inspect(), false);
});
test("no analysis factory means disabled; start and stop gate admission and are idempotent", async () => {
  const ctx = context(); assert.equal(await createAnalysisLifecycle(ctx), undefined);
  let starts = 0, stops = 0, calls = 0;
  const lifecycle = (await createAnalysisLifecycle(ctx, () => ({ ...ctx, admission: { async request() { calls++; return null; } },
    start() { starts++; }, async stop() { stops++; } })))!;
  await assert.rejects(call(lifecycle), /ANALYSIS_UNAVAILABLE/);
  lifecycle.start(); lifecycle.start(); assert.equal(starts, 1); assert.equal(await call(lifecycle), null);
  await Promise.all([lifecycle.stop(), lifecycle.stop()]); lifecycle.start();
  await assert.rejects(call(lifecycle), /ANALYSIS_UNAVAILABLE/); assert.equal(stops, 1); assert.equal(calls, 1);
});
test("different API DB/storage objects are rejected and the mismatched runtime is stopped", async () => {
  const ctx = context(); let stops = 0;
  await assert.rejects(createAnalysisLifecycle(ctx, () => ({ ...ctx, repository: {} as never,
    admission: { async request() { return null; } }, start() {}, async stop() { stops++; } })), /ANALYSIS_UNAVAILABLE/);
  assert.equal(stops, 1);
  assert.throws(() => attachFixedSyntheticAnalysisRuntime(ctx, {} as never), /ANALYSIS_UNAVAILABLE/);
});
test("shutdown blocks admission immediately even while worker stop is pending or fails", async () => {
  const ctx = context(); let finish!: () => void;
  const lifecycle = (await createAnalysisLifecycle(ctx, () => ({ ...ctx, admission: { async request() { return null; } }, start() {},
    stop: () => new Promise<void>((resolve) => { finish = resolve; }) })))!;
  lifecycle.start(); const pending = lifecycle.stop(); await assert.rejects(call(lifecycle)); finish(); await pending;
  const failed = (await createAnalysisLifecycle(ctx, () => ({ ...ctx, admission: { async request() { return null; } }, start() {},
    async stop() { throw new Error("fixture stop error"); } })))!;
  failed.start(); await assert.rejects(failed.stop()); await assert.rejects(call(failed));
});
test("actual processor starts analysis only after startup checks and stops it before repository close", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "showme-analysis-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { ...loadConfig({ NODE_ENV: "test", DATA_DIR: root, SHOWME_STORAGE: "local" }), ...testMediaPaths(), port: 0 };
  const events: string[] = [];
  const processor = await startProcessor(config, { createAnalysis: (ctx) => {
    events.push("composed"); ctx.repository.close = async () => { events.push("db-close"); };
    return { ...ctx, admission: { async request() { throw new Error("no AI in lifecycle test"); } },
      start() { events.push("start"); }, async stop() { events.push("stop"); } };
  } });
  t.after(() => processor.close()); assert.deepEqual(events, ["composed", "start"]);
  assert.equal(processor.server.listening, true);
  await Promise.all([processor.close(), processor.close()]);
  assert.deepEqual(events, ["composed", "start", "stop", "db-close"]); assert.equal(processor.server.listening, false);
});
test("actual processor startup failure stops the unstarted analysis runtime and closes resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "showme-analysis-start-failure-"));
  t.after(() => rm(root, { recursive: true, force: true })); const events: string[] = [];
  const config = { ...loadConfig({ NODE_ENV: "test", DATA_DIR: root, SHOWME_STORAGE: "local" }), ...testMediaPaths(),
    port: 0, ffmpegPath: join(root, "nonexistent-fixture-ffmpeg") };
  await assert.rejects(startProcessor(config, { createAnalysis: (ctx) => {
    ctx.repository.close = async () => { events.push("db-close"); };
    return { ...ctx, admission: { async request() { return null; } }, start() { events.push("start"); }, async stop() { events.push("stop"); } };
  } }));
  assert.deepEqual(events, ["stop", "db-close"]);
});
