import { z } from "zod";

import { ANALYSIS_LIMITS } from "./analysis-contract.js";
import { GEMINI_MAX_OUTPUT_TOKENS, GEMINI_MODELS } from "./gemini/request.js";

/** B1 arithmetic only: no storage, clock, environment, credentials or network. */
export class AnalysisBudgetError extends Error {
  override name = "AnalysisBudgetError";
  constructor(readonly code: "ANALYSIS_BUDGET_INVALID" | "ANALYSIS_BUDGET_OVERFLOW" | "ANALYSIS_BUDGET_EXCEEDED") {
    super(code);
  }
}

const counter = z.number().int().nonnegative().safe();
const unitFields = ["requests", "inputTokens", "outputTokens", "costMicrousd"] as const;
const unitsSchema = z.object({
  requests: counter, inputTokens: counter, outputTokens: counter, costMicrousd: counter,
}).strict();
export type AnalysisBudgetUnits = z.infer<typeof unitsSchema>;

// Rates are supplied by trusted, versioned server policy, not by HTTP callers.
// No built-in prices or free-tier assumptions: zero/unknown prices fail closed.
const priceSchema = z.object({
  model: z.enum(GEMINI_MODELS), version: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  inputMicrousdPerMillionTokens: counter.positive(), outputMicrousdPerMillionTokens: counter.positive(),
}).strict();
export type AnalysisBudgetPrice = z.infer<typeof priceSchema>;
const planSchema = z.object({
  model: z.enum(GEMINI_MODELS), frameCount: counter.min(1).max(ANALYSIS_LIMITS.maxFrames),
  // The future caller must PROVE this includes prompt, schema and all context
  // images. This module cannot estimate image tokens or authorize a live call.
  maxInputTokensPerRequest: counter.positive(),
  maxOutputTokensPerRequest: counter.min(1).max(GEMINI_MAX_OUTPUT_TOKENS),
  transientRetries: z.union([z.literal(0), z.literal(1)]),
}).strict();
const requestSchema = z.object({ price: priceSchema, maximum: unitsSchema }).strict();
const usageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unknown") }).strict(),
  z.object({ status: z.literal("known"), inputTokens: counter, outputTokens: counter }).strict(),
]);

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AnalysisBudgetError("ANALYSIS_BUDGET_INVALID");
  return parsed.data;
}

function integer(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new AnalysisBudgetError("ANALYSIS_BUDGET_OVERFLOW");
  return Number(value);
}

function charge(inputTokens: number, outputTokens: number, price: AnalysisBudgetPrice): number {
  const numerator = BigInt(inputTokens) * BigInt(price.inputMicrousdPerMillionTokens) +
    BigInt(outputTokens) * BigInt(price.outputMicrousdPerMillionTokens);
  return integer((numerator + 999_999n) / 1_000_000n);
}

export function quoteAnalysisBudget(rawPlan: unknown, rawPrice: unknown) {
  const plan = parse(planSchema, rawPlan);
  const price = parse(priceSchema, rawPrice);
  if (plan.model !== price.model) throw new AnalysisBudgetError("ANALYSIS_BUDGET_INVALID");
  const batchCount = Math.ceil(plan.frameCount / ANALYSIS_LIMITS.targetsPerBatch);
  const requests = batchCount * (1 + plan.transientRetries);
  const maximum: AnalysisBudgetUnits = {
    requests: 1, inputTokens: plan.maxInputTokensPerRequest, outputTokens: plan.maxOutputTokensPerRequest,
    costMicrousd: charge(plan.maxInputTokensPerRequest, plan.maxOutputTokensPerRequest, price),
  };
  return {
    batchCount,
    request: { price, maximum },
    maximum: {
      requests,
      inputTokens: integer(BigInt(maximum.inputTokens) * BigInt(requests)),
      outputTokens: integer(BigInt(maximum.outputTokens) * BigInt(requests)),
      // Round EACH request up before summing, including retry reservations.
      costMicrousd: integer(BigInt(maximum.costMicrousd) * BigInt(requests)),
    } satisfies AnalysisBudgetUnits,
  };
}

/**
 * Pure single-window check. Future repository must apply ALL windows atomically
 * under locks and deduplicate reservation IDs; this function provides neither.
 */
export function reserveAnalysisBudget(rawLimit: unknown, rawUsed: unknown, rawAddition: unknown): AnalysisBudgetUnits | null {
  const limit = parse(unitsSchema, rawLimit);
  const used = parse(unitsSchema, rawUsed);
  const addition = parse(unitsSchema, rawAddition);
  if (unitFields.some((field) => limit[field] === 0 || used[field] > limit[field] ||
      addition[field] > limit[field] - used[field])) return null;
  return {
    requests: used.requests + addition.requests,
    inputTokens: used.inputTokens + addition.inputTokens,
    outputTokens: used.outputTokens + addition.outputTokens,
    costMicrousd: used.costMicrousd + addition.costMicrousd,
  };
}

/**
 * Charge for ONE dispatched attempt. The caller must bind the original price
 * snapshot and persist settlement exactly once. Unknown usage keeps the entire
 * reservation; known usage never refunds the dispatched request count.
 */
export function settleAnalysisRequest(rawRequest: unknown, rawUsage: unknown): AnalysisBudgetUnits {
  const { price, maximum } = parse(requestSchema, rawRequest);
  if (maximum.requests !== 1 || maximum.inputTokens < 1 || maximum.outputTokens < 1 ||
      maximum.outputTokens > GEMINI_MAX_OUTPUT_TOKENS ||
      maximum.costMicrousd !== charge(maximum.inputTokens, maximum.outputTokens, price)) {
    throw new AnalysisBudgetError("ANALYSIS_BUDGET_INVALID");
  }
  const usage = parse(usageSchema, rawUsage);
  if (usage.status === "unknown") return { ...maximum };
  if (usage.inputTokens > maximum.inputTokens || usage.outputTokens > maximum.outputTokens) {
    // Keep the original reservation in storage and stop new admission; do not
    // silently cap an overrun or treat a provider contract breach as a refund.
    throw new AnalysisBudgetError("ANALYSIS_BUDGET_EXCEEDED");
  }
  return {
    requests: 1, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    costMicrousd: charge(usage.inputTokens, usage.outputTokens, price),
  };
}
