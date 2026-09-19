import assert from "node:assert/strict";
import { test } from "node:test";

import { ANALYSIS_OPERATIONS_REVIEW_MAX_MS, AnalysisOperationsReviewError, analysisOperationsCheckNames,
  assertAnalysisOperationsBasis, checkAnalysisOperationsReview } from "../src/processor/analysis-operations-review.js";
import { GEMINI_TEST_MODEL } from "../src/processor/gemini/request.js";
import { operationsBasisFixture, operationsReviewFixture } from "./helpers/operations-review-fixture.js";

const at = new Date("2026-09-19T12:00:00.000Z");
function fixture() {
  const limit = { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicrousd: 1_000_000 };
  return operationsReviewFixture(at, { version: "fictional-policy", accountingOnly: true,
    price: { model: GEMINI_TEST_MODEL, version: "fictional-price", inputMicrousdPerMillionTokens: 100000, outputMicrousdPerMillionTokens: 200000 },
    maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 0, globalLimit: { ...limit }, guideLimit: { ...limit } });
}
const denied = (error: unknown) => {
  assert.ok(error instanceof AnalysisOperationsReviewError);
  assert.equal(error.message, "ANALYSIS_OPERATIONS_REVIEW_UNAVAILABLE"); return true;
};

test("operator review retains manual provenance and observation time across reads; no cloud or image calls", (t) => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("no external request"); });
  const raw = fixture(); const before = structuredClone(raw);
  const first = checkAnalysisOperationsReview(raw, at);
  const later = checkAnalysisOperationsReview(raw, new Date(at.valueOf() + 60_000));
  assert.deepEqual(later, first); assert.deepEqual(raw, before);
  assert.equal(first.basis.kind, "operator-review"); assert.equal(first.basis.changeDetection, "operator-recheck-required");
  first.review.checks.storageAccess = { status: "unknown" };
  first.review.policy.globalLimit.requests = 0;
  assert.deepEqual(raw, before);
});

for (const name of analysisOperationsCheckNames) {
  test(`operator ${name}: unknown, rejected, missing, undocumented and future checks are not approvals`, () => {
    const invalid = [{ status: "unknown" }, { status: "rejected" }, undefined, { status: "confirmed" },
      { status: "confirmed", evidenceRef: "fictional", observedAt: new Date(at.valueOf() + 1).toISOString() },
      { status: "confirmed", evidenceRef: "", observedAt: at.toISOString() }];
    for (const check of invalid) {
      const raw = fixture(); Object.assign(raw.checks, { [name]: check });
      assert.throws(() => checkAnalysisOperationsReview(raw, at), denied);
    }
  });
}

test("missing, pending, revoked and unauditable operator records fail closed", () => {
  const invalid: unknown[] = [undefined, null, {}, { ready: true },
    ...[{ state: "pending" }, { state: "revoked" }, { reviewerRef: "" }, { id: "" }, { revision: 0 },
      { revision: 1.5 }, { kind: "verified-free-project" }, { scope: "user_video" }, { mode: "paid_capped" },
      { paidFallback: true }, { changeDetection: "automatic" }, { unknown: true }, { model: "other" }].map((v) => ({ ...fixture(), ...v }))];
  for (const raw of invalid) assert.throws(() => checkAnalysisOperationsReview(raw, at), denied);
});

test("expiry is at most 24h from the oldest observation, not from record creation or last read", () => {
  const raw = fixture();
  checkAnalysisOperationsReview(raw, new Date(at.valueOf() + ANALYSIS_OPERATIONS_REVIEW_MAX_MS - 1));
  assert.throws(() => checkAnalysisOperationsReview(raw, new Date(at.valueOf() + ANALYSIS_OPERATIONS_REVIEW_MAX_MS)), denied);
  raw.expiresAt = new Date(at.valueOf() + ANALYSIS_OPERATIONS_REVIEW_MAX_MS + 1).toISOString();
  assert.throws(() => checkAnalysisOperationsReview(raw, at), denied);
  raw.expiresAt = fixture().expiresAt;
  raw.checks.storageAccess = { status: "confirmed", evidenceRef: "old-storage-check", observedAt: new Date(at.valueOf() - 1).toISOString() };
  assert.throws(() => checkAnalysisOperationsReview(raw, at), denied);
  raw.expiresAt = new Date(Date.parse(raw.expiresAt) - 1).toISOString();
  const { basis } = checkAnalysisOperationsReview(raw, at);
  assert.equal(basis.oldestObservationAt, raw.checks.storageAccess.observedAt);
  raw.recordedAt = new Date(at.valueOf() + 60_000).toISOString();
  raw.expiresAt = new Date(Date.parse(raw.expiresAt) + 60_000).toISOString();
  assert.throws(() => checkAnalysisOperationsReview(raw, new Date(raw.recordedAt)), denied);
});

test("invalid time, backwards/future observation chronology and empty validity are refused", () => {
  for (const date of [new Date(NaN), new Date(at.valueOf() - 1), new Date(at.valueOf() + ANALYSIS_OPERATIONS_REVIEW_MAX_MS)]) {
    assert.throws(() => checkAnalysisOperationsReview(fixture(), date), denied);
  }
  for (const change of [{ recordedAt: new Date(at.valueOf() - 1).toISOString() },
    { expiresAt: at.toISOString() }, { recordedAt: "invalid" }, { expiresAt: "invalid" }]) {
    assert.throws(() => checkAnalysisOperationsReview({ ...fixture(), ...change }, at), denied);
  }
});

test("review summaries cannot relabel human checks or silently extend their lifetime", () => {
  const basis = operationsBasisFixture(at, "review");
  for (const raw of [undefined, {}, { ...basis, kind: "verified" }, { ...basis, revision: 0 },
    { ...basis, changeDetection: "automatic" }, { ...basis, extra: "secret" },
    { ...basis, oldestObservationAt: new Date(at.valueOf() + 1).toISOString() },
    { ...basis, expiresAt: new Date(at.valueOf() + ANALYSIS_OPERATIONS_REVIEW_MAX_MS + 1).toISOString() }]) {
    assert.throws(() => assertAnalysisOperationsBasis(raw, at), denied);
  }
});

test("reviewed caps retain provider/app unit distinctions and prohibit empty app budgets", () => {
  const raw = fixture(); checkAnalysisOperationsReview(raw, at);
  assert.ok(raw.policy.globalLimit.inputTokens > raw.providerLimits.inputTokensPerMinute);
  for (const change of [
    (r: ReturnType<typeof fixture>) => { r.providerLimits.requestsPerDay = 99; },
    (r: ReturnType<typeof fixture>) => { r.providerLimits.inputTokensPerMinute = 999; },
    (r: ReturnType<typeof fixture>) => { r.policy.guideLimit.requests = 0; },
    (r: ReturnType<typeof fixture>) => { r.policy.globalLimit.costMicrousd = 0; },
  ]) { const review = fixture(); change(review); assert.throws(() => checkAnalysisOperationsReview(review, at), denied); }
});
