import assert from "node:assert/strict";
import { test } from "node:test";

import { AnalysisBudgetError, quoteAnalysisBudget, reserveAnalysisBudget, settleAnalysisRequest } from "../src/analysis-budget.js";
import { GEMINI_TEST_MODEL } from "../src/gemini/request.js";

// Fictional arithmetic fixtures. These are NOT Gemini prices or live limits.
const price = { model: GEMINI_TEST_MODEL, version: "fixture-v1", inputMicrousdPerMillionTokens: 100_000, outputMicrousdPerMillionTokens: 200_000 };
const plan = { model: GEMINI_TEST_MODEL, frameCount: 24, maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 1 };
const zero = { requests: 0, inputTokens: 0, outputTokens: 0, costMicrousd: 0 };
const failure = (code: AnalysisBudgetError["code"]) => (error: unknown) => error instanceof AnalysisBudgetError && error.code === code;

test("budget quote reserves all batches and retries with an explicit price snapshot", () => {
  const quoted = quoteAnalysisBudget(plan, price);
  assert.equal(quoted.batchCount, 6);
  assert.deepEqual(quoted.request.maximum, { requests: 1, inputTokens: 1000, outputTokens: 8192, costMicrousd: 1739 });
  assert.deepEqual(quoted.maximum, { requests: 12, inputTokens: 12000, outputTokens: 98304, costMicrousd: 20868 });
  assert.deepEqual(quoted.request.price, price);
  assert.notEqual(quoted.request.price, price);
  assert.equal(quoteAnalysisBudget({ ...plan, transientRetries: 0 }, price).maximum.requests, 6);
  assert.equal(quoteAnalysisBudget({ ...plan, frameCount: 1 }, price).maximum.requests, 2);
  assert.equal(quoteAnalysisBudget({ ...plan, frameCount: 5 }, price).batchCount, 2);
});

test("budget rounds each dispatched request up instead of rounding the whole run once", () => {
  const quoted = quoteAnalysisBudget({ ...plan, maxInputTokensPerRequest: 1, maxOutputTokensPerRequest: 1 },
    { ...price, inputMicrousdPerMillionTokens: 1, outputMicrousdPerMillionTokens: 1 });
  assert.equal(quoted.request.maximum.costMicrousd, 1);
  assert.equal(quoted.maximum.costMicrousd, 12);
});

test("budget rejects missing policy, model mismatches, invalid caps and extra fields", () => {
  for (const malformed of [undefined, {}, { ...plan, frameCount: 0 }, { ...plan, frameCount: 25 },
    { ...plan, frameCount: 1.5 }, { ...plan, maxInputTokensPerRequest: 0 },
    { ...plan, maxInputTokensPerRequest: Infinity }, { ...plan, maxOutputTokensPerRequest: 8193 },
    { ...plan, maxOutputTokensPerRequest: NaN }, { ...plan, transientRetries: 2 }, { ...plan, externalProcessing: true }]) {
    assert.throws(() => quoteAnalysisBudget(malformed, price), failure("ANALYSIS_BUDGET_INVALID"));
  }
  for (const malformed of [undefined, {}, { ...price, model: "gemini-3.8-flash" }, { ...price, model: "latest" },
    { ...price, inputMicrousdPerMillionTokens: 0 }, { ...price, outputMicrousdPerMillionTokens: -1 },
    { ...price, version: "private/key" }, { ...price, secret: "private" }]) {
    assert.throws(() => quoteAnalysisBudget(plan, malformed), failure("ANALYSIS_BUDGET_INVALID"));
  }
});

test("budget arithmetic handles huge intermediate products exactly and rejects unsafe results", () => {
  const quoted = quoteAnalysisBudget({ ...plan, frameCount: 1, transientRetries: 0, maxInputTokensPerRequest: Number.MAX_SAFE_INTEGER,
    maxOutputTokensPerRequest: 1 }, { ...price, inputMicrousdPerMillionTokens: 1, outputMicrousdPerMillionTokens: 1 });
  assert.equal(quoted.maximum.inputTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(quoted.maximum.costMicrousd, 9_007_199_255);
  assert.throws(() => quoteAnalysisBudget({ ...plan, maxInputTokensPerRequest: Number.MAX_SAFE_INTEGER }, price), failure("ANALYSIS_BUDGET_OVERFLOW"));
  assert.throws(() => quoteAnalysisBudget({ ...plan, frameCount: 1, transientRetries: 0, maxInputTokensPerRequest: Number.MAX_SAFE_INTEGER },
    { ...price, inputMicrousdPerMillionTokens: Number.MAX_SAFE_INTEGER }), failure("ANALYSIS_BUDGET_OVERFLOW"));
});

test("budget reservation admits the exact boundary without mutating caller state", () => {
  const maximum = quoteAnalysisBudget(plan, price).maximum;
  const used = Object.freeze({ ...zero });
  assert.deepEqual(reserveAnalysisBudget(maximum, used, maximum), maximum);
  assert.deepEqual(used, zero);
  assert.equal(reserveAnalysisBudget(maximum, maximum, maximum), null);
  for (const field of ["requests", "inputTokens", "outputTokens", "costMicrousd"] as const) {
    assert.equal(reserveAnalysisBudget({ ...maximum, [field]: maximum[field] - 1 }, zero, maximum), null);
    assert.equal(reserveAnalysisBudget({ ...maximum, [field]: 0 }, zero, zero), null);
    assert.equal(reserveAnalysisBudget(maximum, { ...maximum, [field]: maximum[field] + 1 }, zero), null);
  }
});

test("budget reservation rejects corrupt inputs and cannot overflow at the safe-integer boundary", () => {
  const maximum = quoteAnalysisBudget(plan, price).maximum;
  for (const malformed of [undefined, { ...zero, requests: -1 }, { ...zero, inputTokens: 0.5 },
    { ...zero, costMicrousd: Number.MAX_SAFE_INTEGER + 1 }, { ...zero, private: "raw-secret" }]) {
    assert.throws(() => reserveAnalysisBudget(maximum, malformed, maximum), failure("ANALYSIS_BUDGET_INVALID"));
    assert.throws(() => reserveAnalysisBudget(malformed, zero, maximum), failure("ANALYSIS_BUDGET_INVALID"));
    assert.throws(() => reserveAnalysisBudget(maximum, zero, malformed), failure("ANALYSIS_BUDGET_INVALID"));
  }
  const full = { requests: Number.MAX_SAFE_INTEGER, inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: Number.MAX_SAFE_INTEGER, costMicrousd: Number.MAX_SAFE_INTEGER };
  const one = { requests: 1, inputTokens: 1, outputTokens: 1, costMicrousd: 1 };
  assert.equal(reserveAnalysisBudget(full, full, one), null);
  assert.deepEqual(reserveAnalysisBudget(full, { ...full, requests: full.requests - 1 }, { ...zero, requests: 1 }), full);
});

test("known request usage charges rounded actual usage and keeps the dispatched request count", () => {
  const quoted = quoteAnalysisBudget(plan, price);
  assert.deepEqual(settleAnalysisRequest(quoted.request, { status: "known", inputTokens: 100, outputTokens: 200 }),
    { requests: 1, inputTokens: 100, outputTokens: 200, costMicrousd: 50 });
  assert.deepEqual(settleAnalysisRequest(quoted.request, { status: "known", inputTokens: 0, outputTokens: 0 }), { ...zero, requests: 1 });
  assert.deepEqual(settleAnalysisRequest(quoted.request, { status: "known", inputTokens: 1000, outputTokens: 8192 }), quoted.request.maximum);
});

test("unknown request usage retains the entire reservation, without mutation or implicit refund", () => {
  const quoted = quoteAnalysisBudget(plan, price);
  const before = structuredClone(quoted);
  const result = settleAnalysisRequest(quoted.request, { status: "unknown" });
  assert.deepEqual(result, quoted.request.maximum);
  result.costMicrousd = 0;
  assert.deepEqual(quoted, before);
});

test("usage overrun or malformed usage is never silently clamped or settled to zero", () => {
  const quoted = quoteAnalysisBudget(plan, price);
  const before = structuredClone(quoted);
  for (const usage of [{ status: "known", inputTokens: 1001, outputTokens: 1 }, { status: "known", inputTokens: 0, outputTokens: 8193 }]) {
    assert.throws(() => settleAnalysisRequest(quoted.request, usage), failure("ANALYSIS_BUDGET_EXCEEDED"));
  }
  for (const usage of [undefined, { status: "unknown", inputTokens: 0 }, { status: "known", inputTokens: -1, outputTokens: 0 },
    { status: "known", inputTokens: 1.2, outputTokens: 0 }, { status: "known", inputTokens: 1, outputTokens: NaN },
    { status: "known", inputTokens: 1, outputTokens: 0, requests: 0 }]) {
    assert.throws(() => settleAnalysisRequest(quoted.request, usage), failure("ANALYSIS_BUDGET_INVALID"));
  }
  assert.deepEqual(quoted, before);
});

test("request settlement verifies the reservation against its saved price and single-request shape", () => {
  const quoted = quoteAnalysisBudget(plan, price);
  for (const maximum of [{ ...quoted.request.maximum, requests: 0 }, { ...quoted.request.maximum, requests: 2 },
    { ...quoted.request.maximum, costMicrousd: 0 }, { ...quoted.request.maximum, inputTokens: 0 },
    { ...quoted.request.maximum, outputTokens: 8193 }]) {
    assert.throws(() => settleAnalysisRequest({ ...quoted.request, maximum }, { status: "unknown" }), failure("ANALYSIS_BUDGET_INVALID"));
  }
  assert.throws(() => settleAnalysisRequest({ ...quoted.request, price: { ...price, outputMicrousdPerMillionTokens: 1 } },
    { status: "unknown" }), failure("ANALYSIS_BUDGET_INVALID"));
});
