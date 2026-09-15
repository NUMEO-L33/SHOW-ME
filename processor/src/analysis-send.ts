import { z } from "zod";
import { analysisWorkOwnerSchema, type AnalysisRequestAttempt } from "./analysis-accounting-contract.js";
import { AnalysisContractError, analysisManifest } from "./analysis-contract.js";
import { fundingDay, reservationAccounted, validateBatchSettlements, validateFundingAnalysis,
  type AnalysisReservation, type AnalysisStoredBatch } from "./analysis-funding.js";
import type { AnalysisState } from "./analysis-state.js";
import { ownsAnalysisWork } from "./analysis-work.js";
import type { GuideWithSteps } from "./domain.js";

const schema = z.object({ runId: z.string().min(1).max(128), batchIndex: z.number().int().min(0).max(5),
  ordinal: z.union([z.literal(0), z.literal(1)]), dispatchId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  owner: analysisWorkOwnerSchema, inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type AnalysisSendCommand = z.infer<typeof schema>;
export function parseAnalysisSend(raw: unknown): AnalysisSendCommand {
  const result = schema.safeParse(raw);
  if (!result.success) throw new AnalysisContractError();
  return result.data;
}
export interface AnalysisSendRepository {
  /**
   * Read-only locked boundary. launch MUST synchronously start (not await) one request.
   * Never retry this operation after an ambiguous acknowledgement: external work cannot roll back.
   */
  launchAnalysisRequest(guideId: string, command: AnalysisSendCommand, launch: () => void,
    now?: Date, beforeLaunch?: () => void): Promise<boolean>;
}
export function canLaunchAnalysisRequest(options: { guide: GuideWithSteps; analysis: AnalysisState;
  reservation: AnalysisReservation; batches: AnalysisStoredBatch[]; attempts: AnalysisRequestAttempt[];
  halted: boolean; command: AnalysisSendCommand; now: Date }): boolean {
  const { guide, analysis, reservation, batches, attempts, halted, now } = options;
  const command = parseAnalysisSend(options.command);
  if (halted || !reservation.details || reservation.guideId !== guide.id || reservation.runId !== command.runId ||
      guide.status !== "ready" || guide.errorCode !== null) return false;
  validateFundingAnalysis(analysis, reservation, batches);
  reservationAccounted(reservation, attempts);
  validateBatchSettlements(batches, attempts);
  const run = analysis.runs.find((r) => r.id === command.runId)!;
  const attempt = attempts.find((a) => a.batchIndex === command.batchIndex && a.ordinal === command.ordinal && a.dispatchId === command.dispatchId);
  if (command.ordinal === 1 && !attempts.some((a) => a.batchIndex === command.batchIndex && a.ordinal === 0 &&
      a.retryableHttpStatus !== undefined && ["uncertain", "settled"].includes(a.status))) return false;
  return ownsAnalysisWork(run, command.owner, now) && fundingDay(now) === reservation.day &&
    run.manifest.fingerprint === command.inputFingerprint && analysisManifest(guide).fingerprint === command.inputFingerprint &&
    batches.some((b) => b.index === command.batchIndex && b.status === "queued") &&
    Boolean(attempt?.status === "sending" && attempt.sentAt && Date.parse(attempt.sentAt) >= Date.parse(run.updatedAt) &&
      Date.parse(attempt.sentAt) <= now.valueOf()) &&
    !attempts.some((a) => a.batchIndex === command.batchIndex && a.ordinal > command.ordinal);
}
