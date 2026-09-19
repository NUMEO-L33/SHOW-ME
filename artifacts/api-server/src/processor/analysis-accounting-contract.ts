import { z } from "zod";

import { analysisBudgetUnitsSchema, type AnalysisBudgetUnits } from "./analysis-budget.js";
import { ANALYSIS_LIMITS } from "./analysis-contract.js";
import { analysisActivationSchema } from "./analysis-activation.js";

/** Internal accounting only; none of these records authorizes a provider call. */
export class AnalysisAccountingError extends Error {
  override name = "AnalysisAccountingError";
  constructor(readonly code: "ANALYSIS_ACCOUNTING_INVALID" | "ANALYSIS_ACCOUNTING_HALTED" | "ANALYSIS_DAY_ROLLOVER") { super(code); }
}

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const counter = z.number().int().nonnegative().safe();
export const analysisWorkOwnerSchema = z.object({
  attemptId: id, attemptCount: counter.min(1).max(ANALYSIS_LIMITS.maxAttempts),
}).strict();
export const accountingUsageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unknown") }).strict(),
  z.object({ status: z.literal("known"), inputTokens: counter, outputTokens: counter }).strict(),
]);
const identity = { runId: z.string().min(1).max(128), batchIndex: counter.max(5), ordinal: z.union([z.literal(0), z.literal(1)]), dispatchId: id };
export const retryableHttpStatusSchema = z.union([z.literal(500), z.literal(502), z.literal(503), z.literal(504)]);
export type RetryableHttpStatus = z.infer<typeof retryableHttpStatusSchema>;
const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("allocate"), ...identity, owner: analysisWorkOwnerSchema.optional() }).strict(),
  z.object({ type: z.literal("sending"), ...identity, owner: analysisWorkOwnerSchema.optional() }).strict(),
  z.object({ type: z.literal("settle"), ...identity, usage: accountingUsageSchema, retryableHttpStatus: retryableHttpStatusSchema.optional() }).strict(),
  z.object({ type: z.literal("release"), ...identity }).strict(),
]);
export type AnalysisAccountingCommand = z.infer<typeof commandSchema>;
export const accountingControlSchema = z.object({ halted: z.boolean(), activation: analysisActivationSchema.optional() }).strict();
export type AnalysisAccountingControl = z.infer<typeof accountingControlSchema>;
export const analysisRequestAttemptSchema = z.object({
  guideId: z.string().min(1).max(128), ...identity,
  status: z.enum(["reserved", "sending", "settled", "uncertain", "overrun", "released"]),
  maximum: analysisBudgetUnitsSchema, charged: analysisBudgetUnitsSchema,
  usage: accountingUsageSchema.nullable(),
  retryableHttpStatus: retryableHttpStatusSchema.optional(),
  createdAt: z.string().datetime(), sentAt: z.string().datetime().nullable(), finishedAt: z.string().datetime().nullable(),
}).strict();
export type AnalysisRequestAttempt = z.infer<typeof analysisRequestAttemptSchema>;
export type AnalysisAccountingResult = { attempt: AnalysisRequestAttempt; replayed: boolean; halted: boolean };
export interface AnalysisAccountingRepository {
  executeAnalysisAccounting(guideId: string, command: AnalysisAccountingCommand, now?: Date, beforeCommit?: () => void): Promise<AnalysisAccountingResult | null>;
  getAnalysisRequestAttempts(guideId: string, runId: string): Promise<AnalysisRequestAttempt[] | null>;
  getAnalysisAccountingControl(): Promise<AnalysisAccountingControl>;
}

export const budgetUnitFields = ["requests", "inputTokens", "outputTokens", "costMicrousd"] as const;
export function accountingInvalid(): never { throw new AnalysisAccountingError("ANALYSIS_ACCOUNTING_INVALID"); }
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  return result.success ? result.data : accountingInvalid();
}
export function parseAccountingCommand(raw: unknown) {
  const command = parse(commandSchema, raw);
  if (command.type === "settle" && command.retryableHttpStatus !== undefined &&
      (command.usage.status !== "unknown" || command.ordinal !== 0)) accountingInvalid();
  return command;
}
export function parseAccountingControl(raw: unknown) { return parse(accountingControlSchema, raw); }
export function sameBudgetUnits(a: AnalysisBudgetUnits, b: AnalysisBudgetUnits) { return budgetUnitFields.every((key) => a[key] === b[key]); }
export function zeroBudgetUnits(): AnalysisBudgetUnits { return { requests: 0, inputTokens: 0, outputTokens: 0, costMicrousd: 0 }; }
export function parseRequestAttempt(raw: unknown): AnalysisRequestAttempt {
  const a = parse(analysisRequestAttemptSchema, raw);
  if (a.retryableHttpStatus !== undefined && (a.ordinal !== 0 || !["uncertain", "settled", "overrun"].includes(a.status))) accountingInvalid();
  if (a.maximum.requests !== 1 || a.maximum.inputTokens < 1 || a.maximum.outputTokens < 1 || a.maximum.costMicrousd < 1 ||
      budgetUnitFields.some((key) => a.charged[key] > a.maximum[key]) ||
      (a.sentAt && a.sentAt < a.createdAt) || (a.finishedAt && a.finishedAt < (a.sentAt ?? a.createdAt))) accountingInvalid();
  if (a.status === "reserved" || a.status === "sending") {
    if (a.usage !== null || a.finishedAt !== null || Boolean(a.sentAt) !== (a.status === "sending") ||
        !sameBudgetUnits(a.charged, a.maximum)) accountingInvalid();
  } else if (a.status === "released") {
    if (a.sentAt !== null || !a.finishedAt || a.usage !== null || !sameBudgetUnits(a.charged, zeroBudgetUnits())) accountingInvalid();
  } else {
    if (!a.sentAt || !a.finishedAt || !a.usage) accountingInvalid();
    if (a.status === "settled") {
      if (a.usage.status !== "known" || a.charged.requests !== 1 || a.charged.inputTokens !== a.usage.inputTokens ||
          a.charged.outputTokens !== a.usage.outputTokens) accountingInvalid();
    } else if (!sameBudgetUnits(a.charged, a.maximum) ||
        (a.status === "uncertain" ? a.usage.status !== "unknown" : a.usage.status !== "known" ||
          (a.usage.inputTokens <= a.maximum.inputTokens && a.usage.outputTokens <= a.maximum.outputTokens))) accountingInvalid();
  }
  return a;
}
