import { z } from "zod";

import { analysisFundingPolicySchema } from "./analysis-funding.js";
import { providerQuotaLimitsSchema } from "./analysis-provider-quota.js";
import { GEMINI_TEST_MODEL } from "./gemini/request.js";

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const timestamp = z.string().datetime();
// A conservative development review window, NOT a provider freshness guarantee.
export const ANALYSIS_OPERATIONS_REVIEW_MAX_MS = 24 * 60 * 60 * 1000;
export const analysisOperationsCheckNames = ["storageAccess", "freeProject", "providerLimits", "hostingBudget", "projectSenders"] as const;
const checkSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("confirmed"), observedAt: timestamp, evidenceRef: id }).strict(),
  z.object({ status: z.enum(["unknown", "rejected"]) }).strict(),
]);

/** Server-side operator record. Shape validation does NOT authenticate its author or prove cloud facts. */
export const analysisOperationsReviewSchema = z.object({
  kind: z.literal("operator-analysis-review-v1"), id, revision: z.number().int().positive().safe(),
  state: z.enum(["pending", "approved", "revoked"]), reviewerRef: id,
  recordedAt: timestamp, expiresAt: timestamp,
  deploymentRef: id, projectRef: id, credentialRef: id, storageRef: id,
  model: z.literal(GEMINI_TEST_MODEL), scope: z.literal("approved_synthetic"),
  mode: z.literal("free_only"), paidFallback: z.literal(false),
  changeDetection: z.literal("operator-recheck-required"),
  checks: z.object({ storageAccess: checkSchema, freeProject: checkSchema, providerLimits: checkSchema,
    hostingBudget: checkSchema, projectSenders: checkSchema }).strict(),
  providerLimits: providerQuotaLimitsSchema, policy: analysisFundingPolicySchema,
}).strict();
export type AnalysisOperationsReview = z.infer<typeof analysisOperationsReviewSchema>;

/** Carried through admission/send checks so a manual review cannot masquerade as live cloud verification. */
export const analysisOperationsBasisSchema = z.object({
  kind: z.literal("operator-review"), reviewId: id, revision: z.number().int().positive().safe(),
  recordedAt: timestamp, oldestObservationAt: timestamp, expiresAt: timestamp,
  changeDetection: z.literal("operator-recheck-required"),
}).strict();
export type AnalysisOperationsBasis = z.infer<typeof analysisOperationsBasisSchema>;

export class AnalysisOperationsReviewError extends Error {
  override name = "AnalysisOperationsReviewError";
  constructor() { super("ANALYSIS_OPERATIONS_REVIEW_UNAVAILABLE"); }
}
function unavailable(): never { throw new AnalysisOperationsReviewError(); }

export function assertAnalysisOperationsBasis(raw: unknown, at: Date): AnalysisOperationsBasis {
  const parsed = analysisOperationsBasisSchema.safeParse(raw);
  if (!parsed.success) unavailable();
  const basis = parsed.data;
  const time = at.valueOf(); const recorded = Date.parse(basis.recordedAt);
  const oldest = Date.parse(basis.oldestObservationAt); const expiry = Date.parse(basis.expiresAt);
  if (!Number.isFinite(time) || oldest > recorded || recorded > time || expiry <= time ||
      expiry <= recorded || expiry - oldest > ANALYSIS_OPERATIONS_REVIEW_MAX_MS) unavailable();
  return basis;
}

/** Checks the record, not the platform. Caller must resolve current, authenticated, non-revoked operator records. */
export function checkAnalysisOperationsReview(raw: unknown, at: Date) {
  const parsed = analysisOperationsReviewSchema.safeParse(raw);
  if (!parsed.success || parsed.data.state !== "approved") unavailable();
  const review = parsed.data;
  const observations = analysisOperationsCheckNames.map((name) => {
    const check = review.checks[name];
    if (check.status !== "confirmed" || Date.parse(check.observedAt) > Date.parse(review.recordedAt)) unavailable();
    return Date.parse(check.observedAt);
  });
  const basis = assertAnalysisOperationsBasis({ kind: "operator-review", reviewId: review.id, revision: review.revision,
    recordedAt: review.recordedAt, oldestObservationAt: new Date(Math.min(...observations)).toISOString(),
    expiresAt: review.expiresAt, changeDetection: review.changeDetection }, at);
  // The daily app budget and the provider's per-minute/per-day caps are different units.
  if (review.policy.price.model !== review.model ||
      review.policy.globalLimit.requests > review.providerLimits.requestsPerDay ||
      review.policy.maxInputTokensPerRequest > review.providerLimits.inputTokensPerMinute ||
      [review.policy.globalLimit, review.policy.guideLimit].some((limit) => Object.values(limit).some((value) => value === 0))) unavailable();
  return { review, basis };
}
