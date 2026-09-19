import type { AnalysisOperationsBasis, AnalysisOperationsReview } from "../../src/processor/analysis-operations-review.js";
import { ANALYSIS_OPERATIONS_REVIEW_MAX_MS } from "../../src/processor/analysis-operations-review.js";
import type { AnalysisFundingPolicy } from "../../src/processor/analysis-funding.js";
import { GEMINI_TEST_MODEL } from "../../src/processor/gemini/request.js";

/** Fictional operator records for local tests ONLY. Never import into product/startup code. */
export function operationsBasisFixture(at: Date, reviewId: string): AnalysisOperationsBasis {
  return { kind: "operator-review", reviewId, revision: 1, recordedAt: at.toISOString(), oldestObservationAt: at.toISOString(),
    expiresAt: new Date(at.valueOf() + ANALYSIS_OPERATIONS_REVIEW_MAX_MS).toISOString(), changeDetection: "operator-recheck-required" };
}

export function operationsReviewFixture(at: Date, policy: AnalysisFundingPolicy): AnalysisOperationsReview {
  const basis = operationsBasisFixture(at, "fixture-review");
  const check = { status: "confirmed" as const, observedAt: at.toISOString(), evidenceRef: "fictional-observation" };
  return { kind: "operator-analysis-review-v1", id: basis.reviewId, revision: basis.revision, state: "approved",
    reviewerRef: "fictional-reviewer", recordedAt: basis.recordedAt, expiresAt: basis.expiresAt,
    deploymentRef: "fixture-deployment", projectRef: "fixture-project", credentialRef: "fixture-key-version", storageRef: "fixture-storage",
    model: GEMINI_TEST_MODEL, scope: "approved_synthetic", mode: "free_only", paidFallback: false, changeDetection: basis.changeDetection,
    checks: { storageAccess: { ...check }, freeProject: { ...check }, providerLimits: { ...check }, hostingBudget: { ...check }, projectSenders: { ...check } },
    providerLimits: { requestsPerMinute: 15, inputTokensPerMinute: 250_000, requestsPerDay: 100, resetTimeZone: "America/Los_Angeles" },
    policy: structuredClone(policy) };
}
