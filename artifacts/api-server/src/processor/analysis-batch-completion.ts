import { z } from "zod";

import { analysisWorkOwnerSchema, type AnalysisAccountingResult } from "./analysis-accounting-contract.js";
import { prepareAnalysisAccounting, type AccountingTransition } from "./analysis-accounting.js";
import { AnalysisContractError, analysisManifest, parseAnalysisOutput } from "./analysis-contract.js";
import { parseStoredBatch, reservationAccounted, validateBatchSettlements, validateFundingAnalysis, type AnalysisStoredBatch } from "./analysis-funding.js";
import { parseAnalysisState, transitionAnalysis, type AnalysisState } from "./analysis-state.js";
import { ownsAnalysisWork } from "./analysis-work.js";

const counter = z.number().int().nonnegative().safe();
const commandSchema = z.object({
  runId: z.string().min(1).max(128), batchIndex: counter.max(5), ordinal: z.union([z.literal(0), z.literal(1)]),
  dispatchId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), owner: analysisWorkOwnerSchema,
  expectedInputFingerprint: z.string().regex(/^[a-f0-9]{64}$/), output: z.unknown(),
  inputTokens: counter, outputTokens: counter,
}).strict();
export type AnalysisBatchCompletion = z.infer<typeof commandSchema>;
export type AnalysisBatchCompletionResult = {
  outcome: "saved" | "invalid-output" | "overrun";
  analysis: AnalysisState; batch: AnalysisStoredBatch; accounting: AnalysisAccountingResult; replayed: boolean;
};
export interface AnalysisBatchCompletionRepository {
  completeAnalysisBatch(guideId: string, command: AnalysisBatchCompletion, now?: Date,
    beforeCommit?: () => void): Promise<AnalysisBatchCompletionResult | null>;
}
export function parseBatchCompletion(raw: unknown): AnalysisBatchCompletion {
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success || parsed.data.output === undefined) throw new AnalysisContractError();
  // Copy unknown output too; a queued writer must not see caller mutations.
  try { return structuredClone(parsed.data); } catch { throw new AnalysisContractError(); }
}

/** Atomic successful-batch/result/accounting boundary; no provider, image load or automatic dispatch. */
export function prepareBatchCompletion(options: Omit<Parameters<typeof prepareAnalysisAccounting>[0], "command"> & {
  command: AnalysisBatchCompletion;
}): { result: AnalysisBatchCompletionResult; accounting: AccountingTransition; batches: AnalysisStoredBatch[] } | null {
  const command = parseBatchCompletion(options.command);
  const analysis = parseAnalysisState(options.analysis);
  const { guide, reservation, now } = options;
  if (!reservation.details || reservation.guideId !== guide.id || reservation.runId !== command.runId ||
      guide.status !== "ready" || guide.errorCode !== null) return null;
  const batches = options.batches.map(parseStoredBatch);
  validateFundingAnalysis(analysis, reservation, batches);
  reservationAccounted(reservation, options.attempts);
  validateBatchSettlements(batches, options.attempts);
  const run = analysis.runs.find((r) => r.id === command.runId)!;
  if (command.expectedInputFingerprint !== run.manifest.fingerprint ||
      analysisManifest(guide).fingerprint !== run.manifest.fingerprint) return null;
  const batch = batches.find((b) => b.index === command.batchIndex);
  const attempt = options.attempts.find((a) => a.batchIndex === command.batchIndex && a.ordinal === command.ordinal && a.dispatchId === command.dispatchId);
  if (!batch || !attempt) return null;
  let output;
  try { output = parseAnalysisOutput(command.output, batch.targetIds, run.manifest.frames.at(-1)?.stepId); }
  catch (error) { if (!(error instanceof AnalysisContractError)) throw error; }
  if (batch.status === "succeeded") {
    const { completedAt: _completedAt, ...receipt } = batch.completion;
    void _completedAt;
    if (!output || JSON.stringify(receipt) !== JSON.stringify({ inputFingerprint: command.expectedInputFingerprint,
      dispatchId: command.dispatchId, ordinal: command.ordinal, owner: command.owner, output,
      inputTokens: command.inputTokens, outputTokens: command.outputTokens })) return null;
    // Immutable receipt replay is a read; it never re-applies a draft or revives an old worker.
    const accounting: AccountingTransition = { attempt, replayed: true, halted: options.control.halted,
      windows: [], control: options.control };
    return { result: { outcome: "saved", analysis, batch, accounting: { attempt, replayed: true, halted: options.control.halted }, replayed: true }, accounting, batches };
  }
  if (!ownsAnalysisWork(run, command.owner, now) || !attempt.sentAt || Date.parse(attempt.sentAt) < Date.parse(run.updatedAt) ||
      options.attempts.some((a) => a.batchIndex === batch.index && a.ordinal > command.ordinal)) return null;
  const accounting = prepareAnalysisAccounting({ ...options, analysis, batches, command: {
    type: "settle", runId: command.runId, batchIndex: command.batchIndex, ordinal: command.ordinal, dispatchId: command.dispatchId,
    usage: { status: "known", inputTokens: command.inputTokens, outputTokens: command.outputTokens },
  } });
  if (!accounting) return null;
  const outcome = accounting.attempt.status === "overrun" ? "overrun" : output ? "saved" : "invalid-output";
  let next = analysis;
  let saved: AnalysisStoredBatch = batch;
  if (outcome !== "saved") {
    next = transitionAnalysis(guide, analysis, { type: "fail", runId: run.id, ...command.owner,
      errorCode: outcome === "overrun" ? "AI_PROVIDER_FAILED" : "AI_INVALID_OUTPUT" }, now)!;
  } else {
    saved = parseStoredBatch({ ...batch, status: "succeeded", completion: { inputFingerprint: command.expectedInputFingerprint,
      dispatchId: command.dispatchId, ordinal: command.ordinal, owner: command.owner, output: output!,
      inputTokens: command.inputTokens, outputTokens: command.outputTokens, completedAt: now.toISOString() } });
    batches[batches.findIndex((b) => b.index === batch.index)] = saved;
    if (batches.every((b) => b.status === "succeeded")) {
      const inputTokens = batches.reduce((sum, b) => sum + b.completion.inputTokens, 0);
      const outputTokens = batches.reduce((sum, b) => sum + b.completion.outputTokens, 0);
      next = transitionAnalysis(guide, analysis, { type: "finish", runId: run.id, ...command.owner, inputTokens, outputTokens,
        output: { schemaVersion: 1, steps: batches.flatMap((b) => b.completion.output.steps) } }, now)!;
    }
    // A partial save deliberately does not change run.updatedAt (the lease's claim timestamp).
  }
  if (!next) return null;
  validateFundingAnalysis(next, reservation, batches);
  validateBatchSettlements(batches, [...options.attempts.filter((a) => a.batchIndex !== batch.index || a.ordinal !== command.ordinal), accounting.attempt]);
  const { windows: _windows, control: _control, ...numeric } = accounting;
  void _windows; void _control;
  return { result: { outcome, analysis: parseAnalysisState(next), batch: saved, accounting: numeric, replayed: false }, accounting, batches };
}
