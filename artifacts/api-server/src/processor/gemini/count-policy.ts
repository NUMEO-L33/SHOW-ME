import { z } from "zod";
import { ANALYSIS_LIMITS, AnalysisContractError } from "../analysis-contract.js";
import { buildTokenCountRequest } from "./count-request.js";
import type { AnalysisInput } from "./request.js";

/** Application payload/time limits, NOT a token estimate, provider promise or permission. */
export const boundedCountPolicySchema = z.object({
  kind: z.literal("bounded-count-before-generation-v1"),
  maxImages: z.number().int().min(1).max(6),
  maxImageBytes: z.number().int().min(4).max(ANALYSIS_LIMITS.maxImageBytes),
  maxTotalImageBytes: z.number().int().min(4).max(6 * ANALYSIS_LIMITS.maxImageBytes),
  maxRequestBytes: z.number().int().positive().max(18 * 1024 * 1024),
  timeoutMs: z.literal(20_000),
  attemptsPerSlot: z.literal(1),
}).strict();
export type BoundedCountPolicy = z.infer<typeof boundedCountPolicySchema>;
// Trusted approval must explicitly include a policy; importing these limits does not approve input.
export const SYNTHETIC_COUNT_LIMITS: Readonly<BoundedCountPolicy> = Object.freeze({
  kind: "bounded-count-before-generation-v1", maxImages: 6, maxImageBytes: ANALYSIS_LIMITS.maxImageBytes,
  maxTotalImageBytes: 6 * ANALYSIS_LIMITS.maxImageBytes, maxRequestBytes: 18 * 1024 * 1024,
  timeoutMs: 20_000, attemptsPerSlot: 1,
});

export function boundedCountBody(input: AnalysisInput, rawPolicy: BoundedCountPolicy): string {
  const policy = boundedCountPolicySchema.parse(rawPolicy);
  if (input.images.length > policy.maxImages || input.images.some((image) => image.bytes.byteLength > policy.maxImageBytes) ||
      input.images.reduce((sum, image) => sum + image.bytes.byteLength, 0) > policy.maxTotalImageBytes) throw new AnalysisContractError();
  const body = JSON.stringify(buildTokenCountRequest(input));
  if (Buffer.byteLength(body, "utf8") > policy.maxRequestBytes) throw new AnalysisContractError();
  return body;
}
