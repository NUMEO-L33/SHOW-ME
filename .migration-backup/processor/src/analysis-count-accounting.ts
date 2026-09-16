import { createHash } from "node:crypto";
import { z } from "zod";

import { analysisBudgetUnitsSchema, reserveAnalysisBudget } from "./analysis-budget.js";
import { analysisWorkOwnerSchema, budgetUnitFields, parseAccountingControl, sameBudgetUnits, zeroBudgetUnits,
  type AnalysisAccountingControl, type AnalysisRequestAttempt } from "./analysis-accounting-contract.js";
import { analysisManifest } from "./analysis-contract.js";
import { fundingDay, parseBudgetWindow, parseReservation, reservationAccounted, validateBatchSettlements, validateFundingAnalysis,
  type AnalysisBudgetWindow, type AnalysisReservation, type AnalysisStoredBatch } from "./analysis-funding.js";
import { quotaScopeKey } from "./analysis-quota-charge.js";
import { providerQuotaLimitsSchema } from "./analysis-provider-quota.js";
import { parseAnalysisState, type AnalysisState } from "./analysis-state.js";
import { ownsAnalysisWork } from "./analysis-work.js";
import type { GuideWithSteps } from "./domain.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "./gemini/request.js";

/** Storage/accounting only. No count record, replay or transition authorizes a network call. */
export class AnalysisCountError extends Error {
  override name = "AnalysisCountError";
  constructor(readonly code: "ANALYSIS_COUNT_INVALID" | "ANALYSIS_COUNT_LIMIT" | "ANALYSIS_COUNT_UNAVAILABLE" = "ANALYSIS_COUNT_INVALID") { super(code); }
}
const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().safe();
const canonicalTime = z.string().datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const identity = { runId: z.string().min(1).max(128), batchIndex: z.number().int().min(0).max(5),
  // The generation slot this measurement precedes, NOT a count retry ordinal.
  generationOrdinal: z.union([z.literal(0), z.literal(1)]) };
const bindingSchema = z.object({ projectRef: id, inputApprovalId: id, inputFingerprint: hash, requestFingerprint: hash,
  model: z.literal(GEMINI_TEST_MODEL), promptVersion: z.literal(GEMINI_PROMPT_VERSION) }).strict();
export type AnalysisCountBinding = z.infer<typeof bindingSchema>;
const usageSchema = z.discriminatedUnion("status", [z.object({ status: z.literal("unknown") }).strict(),
  z.object({ status: z.literal("known"), totalTokens: positive }).strict()]);
export const analysisCountCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reserve"), ...identity, binding: bindingSchema, owner: analysisWorkOwnerSchema }).strict(),
  z.object({ type: z.literal("sending"), ...identity, binding: bindingSchema, owner: analysisWorkOwnerSchema,
    limits: providerQuotaLimitsSchema, notAfter: z.string().datetime() }).strict(),
  z.object({ type: z.literal("claim-launch"), ...identity, binding: bindingSchema, owner: analysisWorkOwnerSchema,
    limits: providerQuotaLimitsSchema, notAfter: z.string().datetime() }).strict(),
  z.object({ type: z.literal("settle"), ...identity, bindingHash: hash, usage: usageSchema }).strict(),
  z.object({ type: z.literal("release"), ...identity, bindingHash: hash }).strict(),
  z.object({ type: z.literal("recover"), ...identity, bindingHash: hash }).strict(),
]);
export type AnalysisCountCommand = z.infer<typeof analysisCountCommandSchema>;
export type AnalysisCountLaunchCommand = Extract<AnalysisCountCommand, { type: "claim-launch" }>;
export const analysisCountRecordSchema = z.object({
  guideId: z.string().min(1).max(128), ...identity, operation: z.literal("countTokens"),
  requestKey: hash, bindingHash: hash, scopeKey: hash, owner: analysisWorkOwnerSchema,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), status: z.enum(["reserved", "sending", "launch_claimed", "settled", "uncertain", "overrun", "released"]),
  maximum: analysisBudgetUnitsSchema, charged: analysisBudgetUnitsSchema,
  // Conservative accounting proxy from the funded input price, NOT an invoice or free-tier proof.
  accountingInputRate: positive, usage: usageSchema.nullable(),
  createdAt: canonicalTime, sentAt: canonicalTime.nullable(), finishedAt: canonicalTime.nullable(),
}).strict();
export type AnalysisCountRecord = z.infer<typeof analysisCountRecordSchema>;
export type AnalysisCountResult = { record: AnalysisCountRecord; replayed: boolean; halted: boolean };
function invalid(): never { throw new AnalysisCountError(); }
const digest = (raw: unknown) => createHash("sha256").update(JSON.stringify(raw)).digest("hex");
export function countRequestKey(guideId: string, value: Pick<AnalysisCountCommand, "runId" | "batchIndex" | "generationOrdinal">) {
  // Stable across project/approval changes, takeover, reconnection and day rollover. No lease or random dispatch ID.
  return digest(["showme-countTokens-v1", guideId, value.runId, value.batchIndex, value.generationOrdinal]);
}
export function countBindingHash(raw: AnalysisCountBinding) {
  const parsed = bindingSchema.safeParse(raw); return parsed.success ? digest(parsed.data) : invalid();
}
export function parseCountCommand(raw: unknown): AnalysisCountCommand {
  const parsed = analysisCountCommandSchema.safeParse(raw); return parsed.success ? parsed.data : invalid();
}
function cost(tokens: number, rate: number) {
  const amount = (BigInt(tokens) * BigInt(rate) + 999_999n) / 1_000_000n;
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : invalid();
}
export function parseCountRecord(raw: unknown): AnalysisCountRecord {
  const parsed = analysisCountRecordSchema.safeParse(raw); if (!parsed.success) invalid();
  const r = parsed.data;
  if (r.requestKey !== countRequestKey(r.guideId, r) || fundingDay(new Date(r.createdAt)) !== r.day ||
      r.maximum.requests !== 1 || r.maximum.inputTokens < 1 || r.maximum.outputTokens !== 0 ||
      r.maximum.costMicrousd !== cost(r.maximum.inputTokens, r.accountingInputRate) ||
      budgetUnitFields.some((f) => r.charged[f] > r.maximum[f]) ||
      (r.sentAt && (r.sentAt < r.createdAt || fundingDay(new Date(r.sentAt)) !== r.day)) ||
      (r.finishedAt && r.finishedAt < (r.sentAt ?? r.createdAt))) invalid();
  if (["reserved", "sending", "launch_claimed"].includes(r.status)) {
    if (r.usage || r.finishedAt || Boolean(r.sentAt) !== (r.status !== "reserved") || !sameBudgetUnits(r.charged, r.maximum)) invalid();
  } else if (r.status === "released") {
    if (r.sentAt || r.usage || !r.finishedAt || !sameBudgetUnits(r.charged, zeroBudgetUnits())) invalid();
  } else {
    if (!r.sentAt || !r.finishedAt || !r.usage) invalid();
    if (r.status === "settled") {
      if (r.usage.status !== "known" || !sameBudgetUnits(r.charged, { requests: 1, inputTokens: r.usage.totalTokens,
        outputTokens: 0, costMicrousd: cost(r.usage.totalTokens, r.accountingInputRate) })) invalid();
    } else if (!sameBudgetUnits(r.charged, r.maximum) || (r.status === "uncertain" ? r.usage.status !== "unknown" :
      r.usage.status !== "known" || r.usage.totalTokens <= r.maximum.inputTokens)) invalid();
  }
  return r;
}

export type CountTransition = AnalysisCountResult & { windows: AnalysisBudgetWindow[]; control: AnalysisAccountingControl };
export function prepareCountAccounting(options: {
  guideId: string; guide: GuideWithSteps | null; analysis: AnalysisState; reservation: AnalysisReservation;
  batches: AnalysisStoredBatch[]; attempts: AnalysisRequestAttempt[]; previous: AnalysisCountRecord | null;
  windows: AnalysisBudgetWindow[]; control: AnalysisAccountingControl; command: AnalysisCountCommand; now: Date;
}): CountTransition {
  const command = parseCountCommand(options.command); const control = parseAccountingControl(options.control);
  const reservation = parseReservation(options.reservation); const previous = options.previous ? parseCountRecord(options.previous) : null;
  const now = new Date(options.now.valueOf()); const day = fundingDay(now); const timestamp = now.toISOString();
  const analysis = parseAnalysisState(options.analysis); const run = analysis.runs.find((r) => r.id === command.runId);
  if (reservation.guideId !== options.guideId || reservation.runId !== command.runId ||
      (previous && (previous.requestKey !== countRequestKey(options.guideId, command) || previous.day !== reservation.day ||
        timestamp < (previous.finishedAt ?? previous.sentAt ?? previous.createdAt)))) invalid();
  if (previous && previous.status === "overrun" && !control.halted) invalid();
  if (previous && reservation.details) {
    const p = reservation.details.policy;
    if (previous.createdAt < reservation.details.createdAt || previous.accountingInputRate !== p.price.inputMicrousdPerMillionTokens ||
        previous.maximum.inputTokens !== p.maxInputTokensPerRequest) invalid();
  }
  const bindingHash = "binding" in command ? countBindingHash(command.binding) : command.bindingHash;
  if (previous && previous.bindingHash !== bindingHash) invalid();
  if (previous && "binding" in command && previous.scopeKey !== quotaScopeKey(command.binding.projectRef, command.binding.model)) invalid();
  function finish(record: AnalysisCountRecord, replayed = false): CountTransition {
    record = parseCountRecord(record);
    const halted = control.halted || record.status === "overrun";
    if (replayed) return { record, replayed, halted, control: { halted }, windows: [] };
    const windows = ["global", `guide:${options.guideId}`].map((scope) => {
      const w = parseBudgetWindow(options.windows.find((w) => w.scope === scope && w.day === reservation.day));
      if (!previous) {
        const policy = reservation.details!.policy;
        if (w.policyVersion !== policy.version || !sameBudgetUnits(w.limit, scope === "global" ? policy.globalLimit : policy.guideLimit)) invalid();
        const used = reserveAnalysisBudget(w.limit, w.used, record.maximum);
        if (!used) throw new AnalysisCountError("ANALYSIS_COUNT_LIMIT");
        return { ...w, used };
      }
      const used = { ...w.used };
      for (const field of budgetUnitFields) {
        const refund = previous.charged[field] - record.charged[field];
        if (refund < 0 || used[field] < previous.charged[field] || used[field] > w.limit[field]) invalid();
        used[field] -= refund;
      }
      return { ...w, used };
    });
    return { record, replayed, halted, windows, control: { halted } };
  }
  if (command.type === "reserve" && previous) return finish(previous, true); // Never a send permission.
  if (command.type === "settle" && previous && ["settled", "uncertain", "overrun"].includes(previous.status) &&
      JSON.stringify(previous.usage) === JSON.stringify(command.usage)) return finish(previous, true);
  if (command.type === "release" && previous?.status === "released") return finish(previous, true);
  if (command.type === "recover") {
    if (!previous) invalid();
    if (!["reserved", "sending", "launch_claimed"].includes(previous.status)) return finish(previous, true);
    if (run && ownsAnalysisWork(run, previous.owner, now) && day === previous.day && options.guide && reservation.details && !reservation.closedAt) {
      throw new AnalysisCountError("ANALYSIS_COUNT_UNAVAILABLE");
    }
    return finish(previous.status === "reserved" ? { ...previous, status: "released", charged: zeroBudgetUnits(), finishedAt: timestamp } :
      { ...previous, status: "uncertain", usage: { status: "unknown" }, finishedAt: timestamp });
  }
  if (command.type === "reserve" || command.type === "sending" || command.type === "claim-launch") {
    if (control.halted || !reservation.details || reservation.closedAt || !options.guide || !run ||
        options.guide.status !== "ready" || options.guide.errorCode !== null || !ownsAnalysisWork(run, command.owner, now) ||
        day !== reservation.day || run.model !== command.binding.model || run.promptVersion !== command.binding.promptVersion ||
        run.manifest.fingerprint !== command.binding.inputFingerprint || analysisManifest(options.guide).fingerprint !== command.binding.inputFingerprint ||
        !options.batches.some((b) => b.index === command.batchIndex && b.status === "queued") ||
        command.generationOrdinal > reservation.details.policy.transientRetries) throw new AnalysisCountError("ANALYSIS_COUNT_UNAVAILABLE");
    validateFundingAnalysis(analysis, reservation, options.batches);
    reservationAccounted(reservation, options.attempts); validateBatchSettlements(options.batches, options.attempts);
    // Slot 1 is available only for the existing narrowly qualified generation retry.
    if (command.generationOrdinal === 1 && !options.attempts.some((a) => a.batchIndex === command.batchIndex && a.ordinal === 0 &&
        a.retryableHttpStatus !== undefined && ["uncertain", "settled"].includes(a.status))) throw new AnalysisCountError("ANALYSIS_COUNT_UNAVAILABLE");
    if (options.attempts.some((a) => a.batchIndex === command.batchIndex && (a.ordinal > command.generationOrdinal ||
        (a.ordinal === command.generationOrdinal && a.status !== "reserved")))) throw new AnalysisCountError("ANALYSIS_COUNT_UNAVAILABLE");
    if (command.type === "reserve") {
      const p = reservation.details.policy;
      const maximum = { requests: 1, inputTokens: p.maxInputTokensPerRequest, outputTokens: 0,
        costMicrousd: cost(p.maxInputTokensPerRequest, p.price.inputMicrousdPerMillionTokens) };
      return finish({ guideId: options.guideId, runId: command.runId, batchIndex: command.batchIndex, generationOrdinal: command.generationOrdinal,
        operation: "countTokens", requestKey: countRequestKey(options.guideId, command), bindingHash,
        scopeKey: quotaScopeKey(command.binding.projectRef, command.binding.model), owner: command.owner, day,
        status: "reserved", maximum, charged: maximum, accountingInputRate: p.price.inputMicrousdPerMillionTokens,
        createdAt: timestamp, sentAt: null, finishedAt: null, usage: null });
    }
    if (!previous || previous.status !== (command.type === "claim-launch" ? "sending" : "reserved") ||
        JSON.stringify(previous.owner) !== JSON.stringify(command.owner) || (previous.sentAt && previous.sentAt < run.updatedAt)) {
      throw new AnalysisCountError("ANALYSIS_COUNT_UNAVAILABLE"); // A sending replay MUST NOT issue another quota receipt.
    }
    if (command.type === "claim-launch") return finish({ ...previous, status: "launch_claimed" });
    return finish({ ...previous, status: "sending", sentAt: timestamp });
  }
  if (!previous) invalid();
  if (command.type === "release") {
    if (previous.status !== "reserved") throw new AnalysisCountError("ANALYSIS_COUNT_UNAVAILABLE");
    return finish({ ...previous, status: "released", charged: zeroBudgetUnits(), finishedAt: timestamp });
  }
  if (!["sending", "launch_claimed", "uncertain"].includes(previous.status)) throw new AnalysisCountError("ANALYSIS_COUNT_UNAVAILABLE");
  const usage = command.usage;
  if (usage.status === "unknown") return finish({ ...previous, status: "uncertain", usage, finishedAt: timestamp });
  if (usage.totalTokens > previous.maximum.inputTokens) return finish({ ...previous, status: "overrun", usage, finishedAt: timestamp });
  return finish({ ...previous, status: "settled", usage, finishedAt: timestamp,
    charged: { requests: 1, inputTokens: usage.totalTokens, outputTokens: 0, costMicrousd: cost(usage.totalTokens, previous.accountingInputRate) } });
}
