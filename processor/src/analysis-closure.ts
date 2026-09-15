import { accountingInvalid, budgetUnitFields, parseRequestAttempt, zeroBudgetUnits, type AnalysisRequestAttempt } from "./analysis-accounting-contract.js";
import { fundingDay, parseBudgetWindow, parseReservation, reservationAccounted, validateBatchSettlements, validateFundingAnalysis,
  type AnalysisBudgetWindow, type AnalysisReservation, type AnalysisStoredBatch } from "./analysis-funding.js";
import { parseAnalysisState, type AnalysisRun, type AnalysisState } from "./analysis-state.js";
import { workAvailableAt, workTime } from "./analysis-work.js";

export type AnalysisClosureCandidate = { guideId: string; runId: string };
export type AnalysisClosureResult = { reservation: AnalysisReservation; replayed: boolean };
export interface AnalysisClosureRepository {
  listAnalysisClosures(limit?: number, now?: Date): Promise<AnalysisClosureCandidate[]>;
  /** Close only terminal/deleted or old-day unowned work. No provider calls or new reservations. */
  closeAnalysisReservation(guideId: string, runId: string, now?: Date, beforeCommit?: () => void): Promise<AnalysisClosureResult | null>;
}

export function analysisClosureDue(reservation: AnalysisReservation, run: AnalysisRun | undefined, now: Date): boolean {
  if (reservation.closedAt) return false;
  if (!reservation.details) return true;
  if (!run) return false;
  const available = workAvailableAt(run);
  return available === null || (reservation.day < fundingDay(now) && Date.parse(available) <= now.valueOf());
}

/** Caller holds control -> original global-day -> guide-day -> guide; commit every result together. */
export function prepareAnalysisClosure(options: { reservation: AnalysisReservation; analysis: AnalysisState | null;
  batches: AnalysisStoredBatch[]; attempts: AnalysisRequestAttempt[]; windows: AnalysisBudgetWindow[]; now: Date }) {
  const now = workTime(options.now); const timestamp = now.toISOString();
  const reservation = parseReservation(options.reservation);
  let analysis = options.analysis === null ? null : parseAnalysisState(options.analysis);
  const attempts = options.attempts.map(parseRequestAttempt);
  validateBatchSettlements(options.batches, attempts);
  const before = reservationAccounted(reservation, attempts);
  if (reservation.details) {
    if (!analysis) accountingInvalid();
    validateFundingAnalysis(analysis, reservation, options.batches);
  } else if (options.batches.length) accountingInvalid();
  if (reservation.closedAt) return { reservation, analysis, attempts, windows: [], replayed: true };
  const run = analysis?.runs.find((r) => r.id === reservation.runId);
  if (!analysisClosureDue(reservation, run, now) || reservation.day > fundingDay(now) ||
      (run && run.updatedAt > timestamp) || attempts.some((a) => (a.finishedAt ?? a.sentAt ?? a.createdAt) > timestamp)) return null;
  // Yesterday's consent/budget never silently becomes today's spending authority.
  // A valid in-flight lease is left alone; only queued/expired old-day work reaches here.
  if (reservation.details && run && ["queued", "running"].includes(run.status)) {
    analysis = parseAnalysisState({ ...analysis, runs: analysis!.runs.map((r) => r.id !== run.id ? r : {
      ...r, status: "failed", errorCode: "AI_TIMEOUT", leaseExpiresAt: null, updatedAt: timestamp,
    }) });
  }
  const nextAttempts = attempts.map((a) => a.status === "reserved"
    ? parseRequestAttempt({ ...a, status: "released", charged: zeroBudgetUnits(), finishedAt: timestamp })
    : a.status === "sending" ? parseRequestAttempt({ ...a, status: "uncertain", usage: { status: "unknown" }, finishedAt: timestamp }) : a);
  const released = zeroBudgetUnits();
  for (const field of budgetUnitFields) released[field] = Number(BigInt(reservation.maximum[field]) -
    attempts.reduce((sum, a) => sum + BigInt(a.maximum[field]), 0n));
  const next = parseReservation({ ...reservation, released, closedAt: timestamp });
  const after = reservationAccounted(next, nextAttempts);
  if (next.details) validateFundingAnalysis(analysis!, next, options.batches);
  const windows = ["global", `guide:${reservation.guideId}`].map((scope) => {
    const window = parseBudgetWindow(options.windows.find((w) => w.day === reservation.day && w.scope === scope));
    const used = { ...window.used };
    for (const field of budgetUnitFields) {
      if (after[field] > before[field] || used[field] < before[field] || used[field] > window.limit[field]) accountingInvalid();
      used[field] -= before[field] - after[field];
    }
    return { ...window, used };
  });
  return { reservation: next, analysis, attempts: nextAttempts, windows, replayed: false };
}
