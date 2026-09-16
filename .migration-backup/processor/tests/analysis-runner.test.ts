import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { ANALYSIS_LIMITS, type AnalysisProvider } from "../src/analysis-contract.js";
import { executeAnalysisAttempt } from "../src/analysis-runner.js";
import { createAnalysisHarness, fakeOutput, fakeProvider } from "./helpers/analysis-fixtures.js";

const fixtureImage = async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

test("fake provider runs bounded image batches and persists only validated proposals and usage", async (context) => {
  const harness = await createAnalysisHarness(context, 6);
  await harness.initialize();
  await harness.start();
  let calls = 0;
  const provider = fakeProvider();
  const result = await executeAnalysisAttempt({
    ...harness, runId: "run-a", expectedAttemptCount: 0, loadImage: fixtureImage,
    provider: { ...provider, async analyzeFrames(input, signal) {
      calls += 1;
      assert.equal(input.images.length, input.targets.length + input.context.length);
      assert.ok(!JSON.stringify(input).includes("editToken"));
      return provider.analyzeFrames(input, signal);
    } },
  });
  assert.equal(calls, 2);
  assert.equal(result?.runs[0].status, "succeeded");
  assert.equal(result?.runs[0].inputTokens, 200);
  assert.equal(result?.draft?.document.steps.length, 6);
  const stored = await readFile(harness.repository.filePath, "utf8");
  assert.ok(!stored.includes('"bytes"'));
  assert.ok(!stored.includes('"images"'));
});

const failures: Array<[string, AnalysisProvider["analyzeFrames"], string]> = [
  ["refusal", async () => ({ status: "refused" }), "AI_REFUSED"],
  ["incomplete", async () => ({ status: "incomplete" }), "AI_INCOMPLETE"],
  ["invalid output", async () => ({ status: "completed", output: {}, inputTokens: 1, outputTokens: 1 }), "AI_INVALID_OUTPUT"],
  ["provider failure", async () => { throw new Error("private-provider-message-secret"); }, "AI_PROVIDER_FAILED"],
  ["invalid usage", async (input) => ({ status: "completed", output: fakeOutput(input.targets.map((frame) => frame.stepId)), inputTokens: -1, outputTokens: 2 }), "AI_INVALID_OUTPUT"],
];
for (const [name, analyzeFrames, expectedCode] of failures) {
  test(`${name} preserves media and the previous draft`, async (context) => {
    const harness = await createAnalysisHarness(context);
    const initial = await harness.initialize();
    await harness.start();
    const result = await executeAnalysisAttempt({
      ...harness, runId: "run-a", expectedAttemptCount: 0, loadImage: fixtureImage,
      provider: { ...fakeProvider(), analyzeFrames },
    });
    assert.equal(result?.runs[0].status, "failed");
    assert.equal(result?.runs[0].errorCode, expectedCode);
    assert.deepEqual(result?.draft, initial?.draft);
    assert.deepEqual(await harness.repository.getGuideById(harness.guideId), harness.guide);
    assert.ok(!(await readFile(harness.repository.filePath, "utf8")).includes("private-provider-message-secret"));
  });
}

test("provider ignoring abort cannot hang a worker or overwrite timeout with late success", { timeout: 5000 }, async (context) => {
  const harness = await createAnalysisHarness(context);
  await harness.initialize();
  await harness.start();
  let resolveResponse!: (response: Awaited<ReturnType<AnalysisProvider["analyzeFrames"]>>) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = executeAnalysisAttempt({
    ...harness, runId: "run-a", expectedAttemptCount: 0, loadImage: fixtureImage, timeoutMs: 1000,
    provider: { ...fakeProvider(), analyzeFrames() {
      entered();
      return new Promise((resolve) => { resolveResponse = resolve; });
    } },
  });
  await started;
  const result = await pending;
  assert.equal(result?.runs[0].errorCode, "AI_TIMEOUT");
  resolveResponse({ status: "completed", output: fakeOutput(harness.guide.steps.map((step) => step.id)), inputTokens: 1, outputTokens: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await harness.repository.getAnalysisState(harness.guideId))?.runs[0].status, "failed");
  assert.equal((await harness.repository.getAnalysisState(harness.guideId))?.draft?.revision, 0);
});

test("cancel during image loading prevents the provider call", async (context) => {
  const harness = await createAnalysisHarness(context);
  await harness.initialize();
  await harness.start();
  let calls = 0;
  const result = await executeAnalysisAttempt({
    ...harness, runId: "run-a", expectedAttemptCount: 0,
    loadImage: async () => {
      await harness.repository.executeAnalysisCommand(harness.guideId, { type: "cancel", runId: "run-a" });
      return fixtureImage();
    },
    provider: { ...fakeProvider(), async analyzeFrames() { calls += 1; return { status: "refused" }; } },
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
  assert.equal((await harness.repository.getAnalysisState(harness.guideId))?.runs[0].status, "cancelled");
});

test("full deletion during provider work cannot recreate a row on late completion", async (context) => {
  const harness = await createAnalysisHarness(context);
  await harness.initialize();
  await harness.start();
  const provider = fakeProvider();
  const result = await executeAnalysisAttempt({
    ...harness, runId: "run-a", expectedAttemptCount: 0, loadImage: fixtureImage,
    provider: { ...provider, async analyzeFrames(input, signal) {
      await harness.repository.deleteGuide(harness.guideId);
      return provider.analyzeFrames(input, signal);
    } },
  });
  assert.equal(result, null);
  assert.equal(await harness.repository.getGuideById(harness.guideId), null);
  assert.equal(await harness.repository.getAnalysisState(harness.guideId), null);
});

test("oversized image never reaches a provider", async (context) => {
  const harness = await createAnalysisHarness(context);
  await harness.initialize();
  await harness.start();
  let calls = 0;
  const result = await executeAnalysisAttempt({
    ...harness, runId: "run-a", expectedAttemptCount: 0,
    loadImage: async () => new Uint8Array(ANALYSIS_LIMITS.maxImageBytes + 1),
    provider: { ...fakeProvider(), async analyzeFrames() { calls += 1; return { status: "refused" }; } },
  });
  assert.equal(calls, 0);
  assert.equal(result?.runs[0].errorCode, "AI_INVALID_OUTPUT");
});

test("provider identity mismatch fails closed without spending", async (context) => {
  const harness = await createAnalysisHarness(context);
  await harness.initialize();
  await harness.start();
  let calls = 0;
  const result = await executeAnalysisAttempt({
    ...harness, runId: "run-a", expectedAttemptCount: 0, loadImage: fixtureImage,
    provider: { ...fakeProvider(), model: "unapproved", async analyzeFrames() { calls += 1; return { status: "refused" }; } },
  });
  assert.equal(calls, 0);
  assert.equal(result?.runs[0].errorCode, "AI_PROVIDER_FAILED");
});
