import { z } from "zod";

import { AnalysisAccountingError, analysisWorkOwnerSchema, parseRequestAttempt, type AnalysisRequestAttempt } from "./analysis-accounting-contract.js";
import { ANALYSIS_LIMITS } from "./analysis-contract.js";
import { fundingDay, parseReservation, reservationAccounted, validateBatchSettlements, validateFundingAnalysis,
  type AnalysisReservation, type AnalysisStoredBatch } from "./analysis-funding.js";
import { parseAnalysisState, transitionAnalysis, type AnalysisRun, type AnalysisState } from "./analysis-state.js";
import type { GuideWithSteps } from "./domain.js";

/** Internal queue ownership only. A claim never grants permission to send images. */
export class AnalysisWorkError extends Error {
  override name = "AnalysisWorkError";
  constructor() { super("ANALYSIS_WORK_INVALID"); }
}

export type AnalysisWorkOwner = z.infer<typeof analysisWorkOwnerSchema>;
const claimSchema = z.object({
  runId: z.string().min(1).max(128), attemptId: analysisWorkOwnerSchema.shape.attemptId,
  expectedAttemptCount: z.number().int().min(0).max(ANALYSIS_LIMITS.maxAttempts),
  leaseMs: z.number().int().min(1).max(ANALYSIS_LIMITS.timeoutMs),
}).strict();
export type AnalysisWorkClaim = z.infer<typeof claimSchema>;
export type AnalysisWorkCandidate = { guideId: string; runId: string; expectedAttemptCount: number };
export type AnalysisWorkResult = { outcome: "claimed" | "exhausted"; run: AnalysisRun; replayed: boolean };
export interface AnalysisWorkRepository {
  /** Bounded read-only discovery, not ownership. Default time comes from the DB for PostgreSQL. */
  listAnalysisWork(limit?: number, now?: Date): Promise<AnalysisWorkCandidate[]>;
  /** Fixed global funded-work slot of one; CAS and orphan accounting are committed together. */
  claimAnalysisWork(guideId: string, command: AnalysisWorkClaim, now?: Date, beforeCommit?: () => void): Promise<AnalysisWorkResult | null>;
}

export function parseWorkClaim(raw: unknown): AnalysisWorkClaim {
  const parsed = claimSchema.safeParse(raw);
  if (!parsed.success) throw new AnalysisWorkError();
  return parsed.data;
}
export function workLimit(raw = 20): number {
  const parsed = z.number().int().min(1).max(50).safeParse(raw);
  if (!parsed.success) throw new AnalysisWorkError();
  return parsed.data;
}
export function workTime(raw = new Date()): Date {
  const now = new Date(raw.valueOf());
  if (!Number.isFinite(now.valueOf())) throw new AnalysisWorkError();
  return now;
}
export function workAvailableAt(run: AnalysisRun): string | null {
  return run.status === "queued" ? run.createdAt : run.status === "running" ? run.leaseExpiresAt : null;
}
export function ownsAnalysisWork(run: AnalysisRun, owner: AnalysisWorkOwner | undefined, now: Date): boolean {
  return Boolean(owner && run.status === "running" && run.attemptId === owner.attemptId &&
    run.attemptCount === owner.attemptCount && run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) > now.valueOf() &&
    Date.parse(run.updatedAt) <= now.valueOf());
}

/** Indexed columns are projections, never an independent source of truth. */
export function validateWorkProjection(run: AnalysisRun, row: { createdAt: Date; availableAt: Date | null; attemptCount: number }): void {
  const available = workAvailableAt(run);
  if (!(row.createdAt instanceof Date) || row.createdAt.valueOf() !== Date.parse(run.createdAt) ||
      row.attemptCount !== run.attemptCount || (available === null ? row.availableAt !== null :
        !(row.availableAt instanceof Date) || row.availableAt.valueOf() !== Date.parse(available))) throw new AnalysisWorkError();
}

/** Caller holds the global accounting-control lock, then the guide lock. No budget numbers change. */
export function prepareAnalysisWorkClaim(options: {
  guide: GuideWithSteps; analysis: AnalysisState; reservation: AnalysisReservation; batches: AnalysisStoredBatch[];
  attempts: AnalysisRequestAttempt[]; occupied: boolean; halted: boolean; command: AnalysisWorkClaim; now: Date;
}): { analysis: AnalysisState; attempts: AnalysisRequestAttempt[]; result: AnalysisWorkResult } | null {
  const command = parseWorkClaim(options.command);
  const now = workTime(options.now);
  const previous = parseAnalysisState(options.analysis);
  const reservation = parseReservation(options.reservation);
  if (reservation.guideId !== options.guide.id || reservation.runId !== command.runId || !reservation.details) return null;
  validateFundingAnalysis(previous, reservation, options.batches);
  const attempts = options.attempts.map(parseRequestAttempt);
  validateBatchSettlements(options.batches, attempts);
  reservationAccounted(reservation, attempts);
  const run = previous.runs.find((candidate) => candidate.id === command.runId)!;
  if (Date.parse(run.updatedAt) > now.valueOf() || Date.parse(run.createdAt) > now.valueOf()) return null;
  // A lost acknowledgement can recover the exact live lease, even while admission is halted.
  // Replay is NOT an instruction to execute the callback/provider a second time.
  if (run.attemptCount === command.expectedAttemptCount + 1 && ownsAnalysisWork(run,
    { attemptId: command.attemptId, attemptCount: run.attemptCount }, now)) {
    if (Date.parse(run.leaseExpiresAt!) - Date.parse(run.updatedAt) !== command.leaseMs) return null;
    if (options.guide.status !== "ready" || options.guide.errorCode !== null) return null;
    const eligible = transitionAnalysis(options.guide, previous, reservation.details.command, now);
    return eligible ? { analysis: previous, attempts, result: { outcome: "claimed", run, replayed: true } } : null;
  }
  if (run.attemptCount !== command.expectedAttemptCount ||
      (run.status !== "queued" && !(run.status === "running" && run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) <= now.valueOf()))) return null;
  const exhausted = run.attemptCount >= ANALYSIS_LIMITS.maxAttempts;
  if (!exhausted) {
    if (options.halted) throw new AnalysisAccountingError("ANALYSIS_ACCOUNTING_HALTED");
    // Cross-day rebudgeting belongs to B4-B. Never silently spend yesterday's reservation today.
    if (fundingDay(now) !== reservation.day) throw new AnalysisAccountingError("ANALYSIS_DAY_ROLLOVER");
    if (options.occupied || command.attemptId === run.attemptId) return null;
  }
  const analysis = transitionAnalysis(options.guide, previous, exhausted ? {
    type: "fail", runId: run.id, attemptId: run.attemptId!, attemptCount: run.attemptCount, errorCode: "AI_TIMEOUT",
  } : { type: "claim", ...command }, now);
  if (!analysis) return null;
  // A dead owner's sending entry may already have reached the provider. Keep its full maximum.
  const recovered = attempts.map((attempt) => attempt.status === "sending" ? parseRequestAttempt({ ...attempt,
    status: "uncertain", usage: { status: "unknown" }, finishedAt: now.toISOString() }) : attempt);
  reservationAccounted(reservation, recovered);
  return { analysis: parseAnalysisState(analysis), attempts: recovered,
    result: { outcome: exhausted ? "exhausted" : "claimed", run: analysis.runs.find((r) => r.id === run.id)!, replayed: false } };
}
