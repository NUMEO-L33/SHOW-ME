import { createHash } from "node:crypto";
import { z } from "zod";

import { analysisBudgetPriceSchema, analysisBudgetUnitsSchema, quoteAnalysisBudget, reserveAnalysisBudget } from "./analysis-budget.js";
import { analysisBatches, analysisManifest } from "./analysis-contract.js";
import { parseAnalysisCommand, parseAnalysisState, transitionAnalysis, type AnalysisCommand, type AnalysisState } from "./analysis-state.js";
import type { GuideWithSteps } from "./domain.js";
import { GEMINI_MAX_OUTPUT_TOKENS } from "./gemini/request.js";

/** Internal B2 storage contract only. A reservation is NOT permission to call AI. */
export class AnalysisFundingError extends Error {
  override name = "AnalysisFundingError";
  constructor(readonly code: "ANALYSIS_FUNDING_INVALID" | "ANALYSIS_BUDGET_LIMIT" | "ANALYSIS_POLICY_CHANGED") { super(code); }
}

const id = z.string().min(1).max(128);
const counter = z.number().int().nonnegative().safe();
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const analysisFundingPolicySchema = z.object({
  version: id,
  // A separate runtime gate must prove free-tier eligibility / spending consent.
  // This policy only accounts for conservative usage, not a billing entitlement.
  accountingOnly: z.literal(true),
  price: analysisBudgetPriceSchema,
  maxInputTokensPerRequest: counter.positive(),
  maxOutputTokensPerRequest: counter.min(1).max(GEMINI_MAX_OUTPUT_TOKENS),
  transientRetries: z.union([z.literal(0), z.literal(1)]),
  globalLimit: analysisBudgetUnitsSchema, guideLimit: analysisBudgetUnitsSchema,
}).strict();
export type AnalysisFundingPolicy = z.infer<typeof analysisFundingPolicySchema>;
export type AnalysisFundingCommand = Extract<AnalysisCommand, { type: "request" }>;
const requestCommand = z.custom<AnalysisFundingCommand>((raw) => {
  try { return parseAnalysisCommand(raw).type === "request"; } catch { return false; }
});
const windowSchema = z.object({
  day: daySchema, scope: z.string().regex(/^(global|guide:.{1,128})$/), policyVersion: id,
  limit: analysisBudgetUnitsSchema, used: analysisBudgetUnitsSchema,
}).strict();
const reservationSchema = z.object({
  guideId: id, runId: id, day: daySchema, maximum: analysisBudgetUnitsSchema,
  // Null is an irreversible deletion tombstone: no media/consent/policy details.
  details: z.object({
    requestFingerprint: fingerprint, command: requestCommand, policy: analysisFundingPolicySchema,
    frameCount: counter.min(1).max(24), createdAt: z.string().datetime(),
  }).strict().nullable(),
}).strict();
const batchSchema = z.object({
  guideId: id, runId: id, index: counter.max(5), status: z.literal("queued"),
  targetIds: z.array(id).min(1).max(4), contextIds: z.array(id).max(2),
}).strict();
export type AnalysisBudgetWindow = z.infer<typeof windowSchema>;
export type AnalysisReservation = z.infer<typeof reservationSchema>;
export type AnalysisStoredBatch = z.infer<typeof batchSchema>;
const ledgerSchema = z.object({ windows: z.array(windowSchema), reservations: z.array(reservationSchema), batches: z.array(batchSchema) }).strict();
export type AnalysisFundingLedger = z.infer<typeof ledgerSchema>;
export type AnalysisFundingResult = { analysis: AnalysisState; reservation: AnalysisReservation; batches: AnalysisStoredBatch[]; replayed: boolean };

export interface AnalysisFundingRepository {
  reserveAnalysisRequest(guideId: string, command: AnalysisFundingCommand, policy: AnalysisFundingPolicy, now?: Date): Promise<AnalysisFundingResult | null>;
  getAnalysisFunding(guideId: string, runId: string): Promise<{ reservation: AnalysisReservation; batches: AnalysisStoredBatch[] } | null>;
  getAnalysisBudgetWindow(day: string, scope: string): Promise<AnalysisBudgetWindow | null>;
}

function invalid(): never { throw new AnalysisFundingError("ANALYSIS_FUNDING_INVALID"); }
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw); return parsed.success ? parsed.data : invalid();
}
export function parseFundingPolicy(raw: unknown) { return parse(analysisFundingPolicySchema, raw); }
export function parseBudgetWindow(raw: unknown) { return parse(windowSchema, raw); }
export function parseStoredBatch(raw: unknown) { return parse(batchSchema, raw); }
export function fundingDay(now: Date) { return Number.isFinite(now.valueOf()) ? parse(daySchema, now.toISOString().slice(0, 10)) : invalid(); }
export function fundingWindowIdentity(day: string, scope: string) {
  return { day: parse(daySchema, day), scope: parse(windowSchema.shape.scope, scope) };
}
export function parseFundingCommand(raw: unknown): AnalysisFundingCommand {
  const command = parseAnalysisCommand(raw); return command.type === "request" ? command : invalid();
}
function requestFingerprint(command: AnalysisFundingCommand) {
  return createHash("sha256").update(JSON.stringify(parseFundingCommand(command))).digest("hex");
}
function quote(policy: AnalysisFundingPolicy, frameCount: number, model: string) {
  return quoteAnalysisBudget({ model, frameCount, maxInputTokensPerRequest: policy.maxInputTokensPerRequest,
    maxOutputTokensPerRequest: policy.maxOutputTokensPerRequest, transientRetries: policy.transientRetries }, policy.price);
}
export function parseReservation(raw: unknown): AnalysisReservation {
  const reservation = parse(reservationSchema, raw);
  if (reservation.details) {
    const { command, policy, frameCount, createdAt } = reservation.details;
    if (command.runId !== reservation.runId || command.provider !== "gemini" ||
        requestFingerprint(command) !== reservation.details.requestFingerprint || createdAt.slice(0, 10) !== reservation.day ||
        JSON.stringify(quote(policy, frameCount, command.model).maximum) !== JSON.stringify(reservation.maximum)) invalid();
  }
  return reservation;
}
export function emptyFundingLedger(): AnalysisFundingLedger { return { windows: [], reservations: [], batches: [] }; }

export function validateFundingAnalysis(analysis: AnalysisState, reservation: AnalysisReservation, batches: AnalysisStoredBatch[]): void {
  const run = analysis.runs.find((candidate) => candidate.id === reservation.runId);
  if (!run || !reservation.details || run.manifest.frames.length !== reservation.details.frameCount) invalid();
  const command: AnalysisFundingCommand = { type: "request", runId: run.id, baseDraftRevision: run.baseDraftRevision,
    consentVersion: run.consentVersion, provider: run.provider, model: run.model, promptVersion: run.promptVersion,
    expectedInputFingerprint: run.manifest.fingerprint };
  const expected = analysisBatches(run.manifest.frames).map((batch, index) => ({ guideId: reservation.guideId, runId: run.id,
    index, status: "queued" as const, targetIds: batch.targets.map((f) => f.stepId), contextIds: batch.context.map((f) => f.stepId) }));
  if (requestFingerprint(command) !== reservation.details.requestFingerprint || JSON.stringify(batches) !== JSON.stringify(expected)) invalid();
}

/** Full-file validation. Never reset a corrupt ledger to empty on reopen. */
export function parseFundingLedger(raw: unknown): AnalysisFundingLedger {
  const ledger = parse(ledgerSchema, raw);
  const key = (...parts: unknown[]) => JSON.stringify(parts);
  for (const keys of [ledger.windows.map((w) => key(w.day, w.scope)), ledger.reservations.map((r) => key(r.guideId, r.runId)),
    ledger.batches.map((b) => key(b.guideId, b.runId, b.index))]) if (new Set(keys).size !== keys.length) invalid();
  for (const reservation of ledger.reservations) {
    parseReservation(reservation);
    for (const scope of ["global", `guide:${reservation.guideId}`]) {
      if (!ledger.windows.some((w) => w.day === reservation.day && w.scope === scope)) invalid();
    }
    const batches = ledger.batches.filter((b) => b.guideId === reservation.guideId && b.runId === reservation.runId);
    if (!reservation.details && batches.length) invalid();
    if (reservation.details) {
      if (batches.length !== Math.ceil(reservation.details.frameCount / 4) ||
          batches.some((b, index) => b.index !== index) ||
          new Set(batches.flatMap((b) => b.targetIds)).size !== reservation.details.frameCount) invalid();
    }
  }
  for (const batch of ledger.batches) if (!ledger.reservations.some((r) => r.guideId === batch.guideId && r.runId === batch.runId && r.details)) invalid();
  for (const window of ledger.windows) {
    const reservations = ledger.reservations.filter((r) => r.day === window.day && (window.scope === "global" || window.scope === `guide:${r.guideId}`));
    for (const field of ["requests", "inputTokens", "outputTokens", "costMicrousd"] as const) {
      const total = reservations.reduce((sum, r) => sum + BigInt(r.maximum[field]), 0n);
      if (total !== BigInt(window.used[field]) || window.used[field] > window.limit[field]) invalid();
    }
  }
  return ledger;
}

export function initialBudgetWindow(day: string, scope: string, policy: AnalysisFundingPolicy): AnalysisBudgetWindow {
  return parseBudgetWindow({ ...fundingWindowIdentity(day, scope), policyVersion: policy.version,
    limit: scope === "global" ? policy.globalLimit : policy.guideLimit,
    used: { requests: 0, inputTokens: 0, outputTokens: 0, costMicrousd: 0 } });
}

/** Caller holds global-day, guide-day, then guide locks and commits all returned values together. */
export function prepareFundedAnalysis(options: {
  guide: GuideWithSteps; previous: AnalysisState; command: AnalysisFundingCommand; policy: AnalysisFundingPolicy; now: Date;
  existing: AnalysisReservation | null; batches: AnalysisStoredBatch[]; windows: AnalysisBudgetWindow[];
}): (AnalysisFundingResult & { windows: AnalysisBudgetWindow[] }) | null {
  const { guide, now } = options;
  const command = parseFundingCommand(options.command);
  const previous = parseAnalysisState(options.previous);
  const next = transitionAnalysis(guide, previous, command, now);
  if (!next) return null;
  if (options.existing) {
    const reservation = parseReservation(options.existing);
    if (reservation.guideId !== guide.id || reservation.runId !== command.runId || !reservation.details ||
        reservation.details.requestFingerprint !== requestFingerprint(command) || !previous.runs.some((r) => r.id === command.runId)) return null;
    // Replay is tied to the original policy/day, never repriced or re-reserved.
    const batches = options.batches.map(parseStoredBatch);
    validateFundingAnalysis(previous, reservation, batches);
    return { analysis: previous, reservation, batches, windows: [], replayed: true };
  }
  if (previous.runs.some((run) => run.id === command.runId)) return null; // Never fund a legacy unbudgeted run retroactively.
  const policy = parseFundingPolicy(options.policy);
  if (command.provider !== "gemini" || command.model !== policy.price.model) invalid();
  const manifest = analysisManifest(guide);
  const day = fundingDay(now);
  const maximum = quote(policy, manifest.frames.length, command.model).maximum;
  const windows = ["global", `guide:${guide.id}`].map((scope) => {
    const intended = initialBudgetWindow(day, scope, policy);
    const stored = options.windows.find((w) => w.day === day && w.scope === scope);
    const current = stored ? parseBudgetWindow(stored) : intended;
    if (current.policyVersion !== policy.version || JSON.stringify(current.limit) !== JSON.stringify(intended.limit)) {
      throw new AnalysisFundingError("ANALYSIS_POLICY_CHANGED");
    }
    const used = reserveAnalysisBudget(current.limit, current.used, maximum);
    if (!used) throw new AnalysisFundingError("ANALYSIS_BUDGET_LIMIT");
    return { ...current, used };
  });
  const reservation = parseReservation({ guideId: guide.id, runId: command.runId, day, maximum,
    details: { command, requestFingerprint: requestFingerprint(command), policy, frameCount: manifest.frames.length, createdAt: now.toISOString() } });
  const batches = analysisBatches(manifest.frames).map((batch, index) => parseStoredBatch({ guideId: guide.id, runId: command.runId,
    index, status: "queued", targetIds: batch.targets.map((f) => f.stepId), contextIds: batch.context.map((f) => f.stepId) }));
  return { analysis: parseAnalysisState(next), reservation, batches, windows, replayed: false };
}
