import {
  AnalysisBudgetError, quoteAnalysisBudget, settleAnalysisRequest,
} from "./analysis-budget.js";
import {
  accountingInvalid, AnalysisAccountingError, budgetUnitFields, parseAccountingCommand, parseAccountingControl,
  parseRequestAttempt, zeroBudgetUnits, type AnalysisAccountingCommand, type AnalysisAccountingControl,
  type AnalysisAccountingResult, type AnalysisRequestAttempt,
} from "./analysis-accounting-contract.js";
import { analysisManifest } from "./analysis-contract.js";
import {
  fundingDay, parseBudgetWindow, parseReservation, reservationAccounted, validateBatchSettlements, validateFundingAnalysis,
  type AnalysisBudgetWindow, type AnalysisReservation, type AnalysisStoredBatch,
} from "./analysis-funding.js";
import { parseAnalysisState, type AnalysisState } from "./analysis-state.js";
import type { GuideWithSteps } from "./domain.js";
import { ownsAnalysisWork } from "./analysis-work.js";

export type AccountingTransition = AnalysisAccountingResult & { windows: AnalysisBudgetWindow[]; control: AnalysisAccountingControl };

/** Storage transition only. B3/B4 must bind runtime consent, lease and dispatch eligibility separately. */
export function prepareAnalysisAccounting(options: {
  guide: GuideWithSteps; analysis: AnalysisState; reservation: AnalysisReservation; batches: AnalysisStoredBatch[];
  attempts: AnalysisRequestAttempt[]; windows: AnalysisBudgetWindow[]; control: AnalysisAccountingControl;
  command: AnalysisAccountingCommand; now: Date;
}): AccountingTransition | null {
  const command = parseAccountingCommand(options.command);
  const day = fundingDay(options.now);
  const timestamp = options.now.toISOString();
  const reservation = parseReservation(options.reservation);
  const control = parseAccountingControl(options.control);
  if (reservation.guideId !== options.guide.id || reservation.runId !== command.runId || !reservation.details) return null;
  const analysis = parseAnalysisState(options.analysis);
  validateFundingAnalysis(analysis, reservation, options.batches);
  const run = analysis.runs.find((r) => r.id === command.runId)!;
  // Once work has an owner, fresh dispatch writes AND their replays require that
  // exact, unexpired lease. Settlement remains numeric-only and may arrive late.
  if ((command.type === "allocate" || command.type === "sending") &&
      (run.attemptCount > 0 || command.owner) && !ownsAnalysisWork(run, command.owner, options.now)) return null;
  const attempts = options.attempts.map(parseRequestAttempt);
  validateBatchSettlements(options.batches, attempts);
  if ((command.type === "allocate" || command.type === "sending") &&
      options.batches.some((b) => b.index === command.batchIndex && b.status === "succeeded")) return null;
  const before = reservationAccounted(reservation, attempts);
  if (!control.halted && attempts.some((a) => a.status === "overrun")) accountingInvalid();
  const previous = attempts.find((a) => a.batchIndex === command.batchIndex && a.ordinal === command.ordinal);
  const identity = { guideId: reservation.guideId, runId: command.runId, batchIndex: command.batchIndex,
    ordinal: command.ordinal, dispatchId: command.dispatchId };
  if ((previous && previous.dispatchId !== command.dispatchId) ||
      attempts.some((a) => a.dispatchId === command.dispatchId && (a.batchIndex !== command.batchIndex || a.ordinal !== command.ordinal))) return null;

  function complete(attempt: AnalysisRequestAttempt, replayed: boolean): AccountingTransition {
    attempt = parseRequestAttempt(attempt);
    const nextControl = { halted: control.halted || attempt.status === "overrun" };
    if (replayed) return { attempt, replayed, halted: nextControl.halted, windows: [], control: nextControl };
    const after = reservationAccounted(reservation, [...attempts.filter((a) => a !== previous), attempt]);
    const windows = ["global", `guide:${reservation.guideId}`].map((scope) => {
      const window = parseBudgetWindow(options.windows.find((w) => w.day === reservation.day && w.scope === scope));
      const used = { ...window.used };
      for (const key of budgetUnitFields) {
        const release = before[key] - after[key];
        if (release < 0 || used[key] < before[key] || used[key] > window.limit[key]) accountingInvalid();
        used[key] -= release;
      }
      return { ...window, used };
    });
    return { attempt, replayed, halted: nextControl.halted, windows, control: nextControl };
  }

  // Replays never instruct a caller to transmit again. Sending itself is not provider authorization.
  if (command.type === "allocate" && previous) return complete(previous, true);
  if (command.type === "sending" && previous?.status === "sending") return complete(previous, true);
  if (command.type === "release" && previous?.status === "released") return complete(previous, true);
  if (command.type === "settle" && previous && ["settled", "uncertain", "overrun"].includes(previous.status) &&
      JSON.stringify(previous.usage) === JSON.stringify(command.usage)) return complete(previous, true);

  if (command.type === "allocate" || command.type === "sending") {
    if (control.halted) throw new AnalysisAccountingError("ANALYSIS_ACCOUNTING_HALTED");
    if (options.guide.status !== "ready" || options.guide.errorCode !== null ||
        !["queued", "running"].includes(run.status) || analysisManifest(options.guide).fingerprint !== run.manifest.fingerprint) return null;
    if (day !== reservation.day) throw new AnalysisAccountingError("ANALYSIS_DAY_ROLLOVER");
  }
  if (command.type === "allocate") {
    const { policy, frameCount, command: original } = reservation.details;
    const quote = quoteAnalysisBudget({ model: original.model, frameCount,
      maxInputTokensPerRequest: policy.maxInputTokensPerRequest, maxOutputTokensPerRequest: policy.maxOutputTokensPerRequest,
      transientRetries: policy.transientRetries }, policy.price);
    if (command.batchIndex >= quote.batchCount || command.ordinal > policy.transientRetries || timestamp < reservation.details.createdAt) return null;
    if (command.ordinal === 1 && !attempts.some((a) => a.batchIndex === command.batchIndex && a.ordinal === 0 &&
        ["settled", "uncertain"].includes(a.status))) return null;
    return complete({ ...identity, status: "reserved", maximum: quote.request.maximum, charged: quote.request.maximum,
      usage: null, createdAt: timestamp, sentAt: null, finishedAt: null }, false);
  }
  if (!previous || timestamp < (previous.finishedAt ?? previous.sentAt ?? previous.createdAt)) return null;
  if (command.type === "sending") {
    return previous.status === "reserved" ? complete({ ...previous, status: "sending", sentAt: timestamp }, false) : null;
  }
  if (command.type === "release") {
    // Cancellation/terminal state fences any later sending transition. Unallocated slots remain held.
    if (previous.status !== "reserved" || !["cancelled", "failed", "succeeded"].includes(run.status)) return null;
    return complete({ ...previous, status: "released", charged: zeroBudgetUnits(), finishedAt: timestamp }, false);
  }
  if (previous.status !== "sending" && previous.status !== "uncertain") return null;
  // Late accounting after cancellation is allowed; it cannot apply AI output or resurrect a run.
  try {
    const charged = settleAnalysisRequest({ price: reservation.details.policy.price, maximum: previous.maximum }, command.usage);
    return complete({ ...previous, charged, usage: command.usage,
      status: command.usage.status === "known" ? "settled" : "uncertain", finishedAt: timestamp }, false);
  } catch (error) {
    if (!(error instanceof AnalysisBudgetError) || error.code !== "ANALYSIS_BUDGET_EXCEEDED") throw error;
    // Persist the breach and global stop together; never roll the stop back by throwing after it.
    return complete({ ...previous, status: "overrun", usage: command.usage, finishedAt: timestamp }, false);
  }
}
