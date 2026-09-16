import assert from "node:assert/strict";
import { test } from "node:test";

import { generationProbeMode, matchesCountReference, reviewSyntheticGeneration, runGenerationProbe, SYNTHETIC_COUNT_REFERENCE } from "../src/gemini/generation-probe.js";
import { GeminiError } from "../src/gemini/provider.js";
import { GEMINI_TEST_MODEL } from "../src/gemini/request.js";
import { fakeOutput } from "./helpers/analysis-fixtures.js";

const env = { GEMINI_API_KEY: "AQ.synthetic-generation-test-key" };
const flags = ["--live", "--confirm-free-project", "--approve-synthetic-generation"];
const ids = [1, 2, 3, 4].map((n) => `token-probe-${n}`);
const reserve = async () => {};
const hasCode = (code: string) => (error: unknown) => error instanceof GeminiError && error.code === code;
function envelope(inputTokens = 7199) {
  return {
    modelVersion: GEMINI_TEST_MODEL,
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(fakeOutput(ids)) }] } }],
    usageMetadata: { promptTokenCount: inputTokens, candidatesTokenCount: 500, thoughtsTokenCount: 100, totalTokenCount: inputTokens + 600 },
  };
}

test("generation requires distinct fresh consent and never accepts count-only or saved smoke approval", () => {
  assert.equal(generationProbeMode([], {}), "dry-run");
  assert.equal(generationProbeMode(flags, env), "live");
  for (const args of [["--live"], ["--live", "--confirm-free-project", "--approve-synthetic-images"],
    flags.slice(1), [...flags, "--live"], [...flags, "--file", "private.jpg"], [...flags, "--model", "other-model"]]) {
    assert.throws(() => generationProbeMode(args, { ...env, SHOWME_GEMINI_FREE_TIER_CONFIRMED: "true" }), hasCode("GEMINI_DISABLED"));
  }
  assert.throws(() => generationProbeMode(flags, {}), hasCode("GEMINI_KEY_MISSING"));
});

test("the historical count reference only matches the same model and full request", () => {
  assert.equal(matchesCountReference(SYNTHETIC_COUNT_REFERENCE), true);
  assert.equal(matchesCountReference({ ...SYNTHETIC_COUNT_REFERENCE, model: "gemini-3.8-flash" }), false);
  assert.equal(matchesCountReference({ ...SYNTHETIC_COUNT_REFERENCE, requestFingerprint: "b".repeat(64) }), false);
});

test("generation dry run matches the actual counted six-frame input without reservation or network", async () => {
  const report = await runGenerationProbe([], env, {
    reserve: async () => { assert.fail("reservation prohibited"); }, fetch: async () => { assert.fail("network prohibited"); },
  });
  assert.equal(report.sameRequestAsCountProbe, true); assert.equal(report.networkCalls, 0);
  assert.equal(report.targetCount, 4); assert.equal(report.contextCount, 2);
  assert.equal(report.verifiedInputTokenUpperBound, null); assert.equal(report.enablesAnalysis, false);
  assert.ok(!JSON.stringify(report).includes(env.GEMINI_API_KEY));
});

test("generation sends once after reservation with the exact counted payload and preserves usage differences", async () => {
  let reserved = false; let calls = 0;
  const report = await runGenerationProbe(flags, env, { reserve: async () => { reserved = true; }, fetch: async (url, init) => {
    calls += 1; assert.ok(reserved);
    assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEST_MODEL}:generateContent`);
    assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("x-goog-api-key"), env.GEMINI_API_KEY);
    const request = JSON.parse(String(init?.body));
    assert.equal(request.contents[0].parts.filter((part: { inlineData?: unknown }) => part.inlineData).length, 6);
    assert.ok(request.generationConfig.responseJsonSchema); assert.ok(request.systemInstruction);
    return Response.json(envelope(7200));
  } });
  assert.equal(calls, 1); assert.equal(report.status, "generated-synthetic-only");
  if (report.status !== "generated-synthetic-only") assert.fail();
  assert.equal(report.differenceFromCountTokens, 1); assert.equal(report.outputTokensIncludingThinking, 600);
  assert.deepEqual(report.output.steps.map((step) => step.stepId), ids);
  assert.equal(report.verifiedInputTokenUpperBound, null); assert.equal(report.projectVerifiedAutomatically, false);
  assert.ok(!JSON.stringify(report).includes(env.GEMINI_API_KEY));
});

test("5xx and quota errors have no automatic retry or model fallback", async () => {
  for (const status of [429, 503]) {
    let calls = 0;
    await assert.rejects(runGenerationProbe(flags, env, { reserve, fetch: async () => {
      calls += 1; return new Response(env.GEMINI_API_KEY, { status });
    } }), (error: unknown) => error instanceof GeminiError && error.httpStatus === status && !String(error).includes(env.GEMINI_API_KEY));
    assert.equal(calls, 1);
  }
});

test("refusal or truncation returns its status once rather than inventing a validated result", async () => {
  for (const finishReason of ["SAFETY", "MAX_TOKENS"]) {
    let calls = 0;
    const report = await runGenerationProbe(flags, env, { reserve, fetch: async () => {
      calls += 1; return Response.json({ modelVersion: GEMINI_TEST_MODEL, candidates: [{ finishReason }] });
    } });
    assert.equal(calls, 1); assert.equal(report.status, finishReason === "SAFETY" ? "refused" : "incomplete");
    assert.ok(!("output" in report)); assert.ok(!("generatedInputTokens" in report));
  }
});

test("synthetic quality indicators flag non-Korean text and misplaced clicks without claiming privacy recall", () => {
  const output = fakeOutput(ids);
  for (const step of output.steps) { step.shortLabel = "다음"; step.instruction = "다음 버튼을 누르세요."; step.action = "tap"; step.target = { x: 50, y: 70 }; }
  assert.equal(reviewSyntheticGeneration(output).koreanLabelsAndInstructions, true);
  assert.equal(reviewSyntheticGeneration(output).tapCoordinatesInsideSyntheticButton, true);
  output.steps[0].shortLabel = "Next"; output.steps[1].target = { x: 10, y: 10 };
  const review = reviewSyntheticGeneration(output);
  assert.equal(review.koreanLabelsAndInstructions, false); assert.equal(review.tapCoordinatesInsideSyntheticButton, false);
  assert.equal(review.privacyRecallTested, false); assert.equal(review.humanReviewRequired, true);
});

test("a cancelled or locally denied generation cannot start a request", async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return Response.json(envelope()); };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runGenerationProbe(flags, env, { signal: controller.signal, reserve, fetch }), hasCode("GEMINI_CANCELLED"));
  await assert.rejects(runGenerationProbe(flags, env, { reserve: async () => { throw new GeminiError("GEMINI_LOCAL_LIMIT"); }, fetch }), hasCode("GEMINI_LOCAL_LIMIT"));
  assert.equal(calls, 0);
});
