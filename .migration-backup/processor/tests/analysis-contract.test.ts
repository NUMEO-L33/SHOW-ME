import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AnalysisContractError, analysisBatches, analysisManifest, initialDraft, parseAnalysisOutput, parseDraftDocument,
} from "../src/analysis-contract.js";
import { createAnalysisHarness, fakeOutput } from "./helpers/analysis-fixtures.js";
import { parseAnalysisCommand } from "../src/analysis-state.js";

test("internal commands reject unknown operations and fields before mutation", () => {
  assert.throws(() => parseAnalysisCommand({ type: "publish" }), AnalysisContractError);
  assert.throws(() => parseAnalysisCommand({ type: "initialize", originalUrl: "private" }), AnalysisContractError);
  assert.throws(() => parseAnalysisCommand({ type: "save-draft", expectedRevision: 0 }), AnalysisContractError);
  assert.throws(() => parseAnalysisCommand({ type: "claim", runId: "r", attemptId: "a", expectedAttemptCount: -1, leaseMs: 1 }), AnalysisContractError);
});

test("AI output is sorted to server target order and cannot contain private region values", () => {
  const result = parseAnalysisOutput(fakeOutput(["b", "a"]), ["a", "b"], "b");
  assert.deepEqual(result.steps.map((step) => step.stepId), ["a", "b"]);
  const leaked = fakeOutput(["a"]);
  Object.assign(leaked.steps[0].privacy[0], { value: "010-1234-5678" });
  assert.throws(() => parseAnalysisOutput(leaked, ["a"]), AnalysisContractError);
});

const invalidOutputs: Array<[string, (output: ReturnType<typeof fakeOutput>) => void]> = [
  ["foreign step", (output) => { output.steps[0].stepId = "foreign"; }],
  ["missing step", (output) => { output.steps.pop(); }],
  ["duplicate step", (output) => { output.steps[1].stepId = output.steps[0].stepId; }],
  ["NaN coordinate", (output) => { output.steps[0].target.x = NaN; }],
  ["infinite coordinate", (output) => { output.steps[0].target.x = Infinity; }],
  ["negative coordinate", (output) => { output.steps[0].target.x = -1; }],
  ["overflowing rect", (output) => { output.steps[0].privacy[0].bounds.width = 95; }],
  ["empty rect", (output) => { output.steps[0].privacy[0].bounds.height = 0; }],
  ["last-step merge", (output) => { output.steps[1].mergeWithNext = true; }],
  ["HTML instruction", (output) => { output.steps[0].instruction = "<script>private</script>"; }],
  ["empty instruction", (output) => { output.steps[0].instruction = "  "; }],
  ["extra keys", (output) => { Object.assign(output, { originalUrl: "https://private.example" }); }],
];
for (const [name, mutate] of invalidOutputs) {
  test(`AI contract rejects ${name}`, () => {
    const output = fakeOutput(["a", "b"]);
    mutate(output);
    assert.throws(() => parseAnalysisOutput(output, ["a", "b"], "b"), AnalysisContractError);
  });
}

test("unknown actions are allowed only with no invented point and a review reason", () => {
  const step = fakeOutput(["a"]).steps[0];
  const valid = { schemaVersion: 1, steps: [{ ...step, action: "unknown", target: null, reviewReasons: ["unclear_action"] }] };
  assert.equal(parseAnalysisOutput(valid, ["a"]).steps[0].target, null);
  assert.throws(() => parseAnalysisOutput({ ...valid, steps: [{ ...valid.steps[0], reviewReasons: [] }] }, ["a"]));
  assert.throws(() => parseAnalysisOutput({ ...valid, steps: [{ ...valid.steps[0], target: { x: 50, y: 50 } }] }, ["a"]));
});

test("manifest binds frame source, dimensions and attempt but not heartbeat or source filename", async (context) => {
  const { guide } = await createAnalysisHarness(context);
  const manifest = analysisManifest(guide);
  assert.equal(analysisManifest({ ...guide, updatedAt: new Date().toISOString(), sourceFilename: "changed.mp4" }).fingerprint, manifest.fingerprint);
  assert.notEqual(analysisManifest({ ...guide, processingAttemptCount: 2 }).fingerprint, manifest.fingerprint);
  const changed = structuredClone(guide);
  changed.steps[0].representativeFrameKey = "different-source.jpg";
  assert.notEqual(analysisManifest(changed).fingerprint, manifest.fingerprint);
  assert.ok(!JSON.stringify(manifest).includes(".jpg"));
  assert.throws(() => analysisManifest({ ...guide, status: "extracting" }));
});

test("24 frames are bounded to six batches of four targets with at most two context frames", async (context) => {
  const { guide } = await createAnalysisHarness(context, 24);
  const batches = analysisBatches(analysisManifest(guide).frames);
  assert.equal(batches.length, 6);
  assert.equal(batches.flatMap((batch) => batch.targets).length, 24);
  for (const batch of batches) assert.ok(batch.targets.length + batch.context.length <= 6);
  assert.deepEqual(batches[1].context.map((frame) => frame.position), [3, 8]);
});

test("initial draft has no fabricated central pointer and validates frame ownership", async (context) => {
  const { guide } = await createAnalysisHarness(context);
  const manifest = analysisManifest(guide);
  const draft = initialDraft(manifest);
  assert.equal(draft.title, "새 가이드");
  assert.deepEqual(draft.steps[0].elements, []);
  const invalid = structuredClone(draft);
  invalid.steps[0].activeFrameStepId = "foreign";
  assert.throws(() => parseDraftDocument(invalid, manifest.frames));
  invalid.steps[0] = structuredClone(draft.steps[0]);
  invalid.steps[1].sourceStepIds = [draft.steps[0].id];
  assert.throws(() => parseDraftDocument(invalid, manifest.frames));
});
