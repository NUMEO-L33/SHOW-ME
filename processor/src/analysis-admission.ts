import { z } from "zod";

import type { AnalysisAdmission, AnalysisRequestCommand } from "./analysis-api.js";
import { ANALYSIS_CONSENT_VERSION, analysisManifest } from "./analysis-contract.js";
import { analysisFundingPolicySchema, AnalysisFundingError, fundingDay, parseFundingCommand } from "./analysis-funding.js";
import type { GuideRepository } from "./domain.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "./gemini/request.js";

export class AnalysisAdmissionError extends Error {
  override name = "AnalysisAdmissionError";
  constructor(readonly code: "ANALYSIS_UNAVAILABLE" | "ANALYSIS_BUDGET_LIMIT" | "ANALYSIS_ADMISSION_TIMEOUT") { super(code); }
}

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const positive = z.number().int().positive().safe();
const quota = z.object({ requests: positive, inputTokens: positive, outputTokens: positive }).strict();
const spendingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("free_only") }).strict(),
  z.object({ mode: z.literal("paid_capped"), approvalId: id, projectRef: id, dailyCostMicrousd: positive }).strict(),
]);
export type AnalysisSpendingPolicy = z.infer<typeof spendingSchema>;
const snapshotSchema = z.object({
  id, checkedAt: z.string().datetime(), validUntil: z.string().datetime(),
  guideId: z.string().min(1).max(128), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  frameCount: positive.max(24), model: z.literal(GEMINI_TEST_MODEL), promptVersion: z.literal(GEMINI_PROMPT_VERSION),
  scope: z.literal("approved_synthetic"), inputApprovalId: id,
  // These are claims from a TRUSTED verifier, not proof derived from their spelling.
  runtime: z.object({ repository: z.literal("postgres-0007"), dispatcher: z.literal("durable-accounted-v1"),
    inputTokenBound: positive, boundIncludes: z.literal("prompt-schema-targets-context") }).strict(),
  policy: analysisFundingPolicySchema,
  entitlement: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("free_only"), projectRef: id, evidenceId: id, paidFallback: z.literal(false), dailyQuota: quota }).strict(),
    z.object({ mode: z.literal("paid_capped"), projectRef: id, evidenceId: id, approvalId: id }).strict(),
  ]),
}).strict();
export type AnalysisAdmissionSnapshot = z.infer<typeof snapshotSchema>;
export type AnalysisAdmissionInput = Pick<AnalysisAdmissionSnapshot, "guideId" | "inputFingerprint" | "frameCount" | "model" | "promptVersion">;

/**
 * Future trusted B4/B5 adapter. Must verify the configured DB/worker, approved
 * synthetic input, full token bound, provider project/free quota or spending
 * approval. Never source this object from HTTP or smoke-test env booleans.
 * This turn supplies NO live implementation. inspect must not transmit images.
 */
export interface AnalysisAdmissionReadiness {
  inspect(input: AnalysisAdmissionInput, signal: AbortSignal): Promise<unknown>;
  /** Synchronous no-I/O check: revoke the snapshot when any prerequisite changes. */
  isCurrent(snapshotId: string): boolean;
}

function unavailable(): never { throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE"); }
function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new AnalysisAdmissionError("ANALYSIS_ADMISSION_TIMEOUT");
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AnalysisAdmissionError("ANALYSIS_ADMISSION_TIMEOUT"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Shared admission/send-time checks. Only a trusted verifier may supply this report. */
export function verifyAnalysisReadiness(options: {
  raw: unknown; input: AnalysisAdmissionInput; readiness: AnalysisAdmissionReadiness;
  spending: AnalysisSpendingPolicy; clock: () => Date; signal: AbortSignal;
}) {
  const { input, readiness, spending, clock, signal } = options;
  const parsed = snapshotSchema.safeParse(options.raw);
  if (!parsed.success) unavailable();
  const snapshot = parsed.data;
  const time = () => {
    const date = new Date(clock().valueOf());
    if (!Number.isFinite(date.valueOf())) unavailable();
    return date;
  };
  const at = time();
  const assertCurrent = () => {
    checkAbort(signal);
    const current = time();
    const checked = Date.parse(snapshot.checkedAt);
    const expiry = Date.parse(snapshot.validUntil);
    if (checked > current.valueOf() || expiry <= current.valueOf() || expiry - checked > 30_000 || expiry <= checked ||
        current.valueOf() < at.valueOf() || fundingDay(current) !== fundingDay(at)) unavailable();
    const valid: unknown = readiness.isCurrent(snapshot.id);
    if (valid !== true) {
      void Promise.resolve(valid).catch(() => undefined);
      unavailable();
    }
  };
  if (Object.entries(input).some(([key, value]) => snapshot[key as keyof AnalysisAdmissionInput] !== value) ||
      snapshot.policy.price.model !== input.model || snapshot.policy.maxInputTokensPerRequest < snapshot.runtime.inputTokenBound) unavailable();
  const { policy, entitlement } = snapshot;
  if ([policy.globalLimit, policy.guideLimit].some((limit) => Object.values(limit).some((value) => value === 0))) unavailable();
  if (spending.mode === "free_only") {
    if (entitlement.mode !== "free_only" || ["requests", "inputTokens", "outputTokens"].some((key) =>
      policy.globalLimit[key as keyof typeof entitlement.dailyQuota] > entitlement.dailyQuota[key as keyof typeof entitlement.dailyQuota])) unavailable();
  } else if (entitlement.mode !== "paid_capped" || entitlement.approvalId !== spending.approvalId ||
      entitlement.projectRef !== spending.projectRef || policy.globalLimit.costMicrousd > spending.dailyCostMicrousd) unavailable();
  assertCurrent();
  return { snapshot, assertCurrent, at };
}

/** Durable admission, not a dispatcher. Safe default is unavailable; no env enable flag. */
export class DurableAnalysisAdmission implements AnalysisAdmission {
  private readonly repository: GuideRepository;
  private readonly readiness?: AnalysisAdmissionReadiness;
  private readonly spending: AnalysisSpendingPolicy;
  private readonly clock: () => Date;

  constructor(options: { repository: GuideRepository; readiness?: AnalysisAdmissionReadiness; spending?: AnalysisSpendingPolicy; clock?: () => Date }) {
    this.repository = options.repository;
    this.readiness = options.readiness;
    const parsed = spendingSchema.safeParse(options.spending ?? { mode: "free_only" });
    if (!parsed.success) unavailable();
    this.spending = parsed.data;
    this.clock = options.clock ?? (() => new Date());
  }

  async request(guideId: string, raw: AnalysisRequestCommand, signal: AbortSignal) {
    try {
      checkAbort(signal);
      const command = parseFundingCommand(raw);
      if (command.consentVersion !== ANALYSIS_CONSENT_VERSION || command.provider !== "gemini" ||
          command.model !== GEMINI_TEST_MODEL || command.promptVersion !== GEMINI_PROMPT_VERSION) unavailable();
      return await abortable(this.perform(guideId, command, signal), signal);
    } catch (error) {
      if (error instanceof AnalysisAdmissionError) throw error;
      if (error instanceof AnalysisFundingError && error.code === "ANALYSIS_BUDGET_LIMIT") throw new AnalysisAdmissionError("ANALYSIS_BUDGET_LIMIT");
      // Do not expose provider/account/DB messages or arbitrary abort reasons.
      unavailable();
    }
  }

  private time() {
    const date = new Date(this.clock().valueOf());
    if (!Number.isFinite(date.valueOf())) unavailable();
    return date;
  }

  private async perform(guideId: string, command: AnalysisRequestCommand, signal: AbortSignal) {
    const existing = await this.repository.getAnalysisFunding(guideId, command.runId);
    checkAbort(signal);
    if (existing?.reservation.details) {
      // A durable replay does not require fresh permission or reprice yesterday's reservation.
      return (await this.repository.reserveAnalysisRequest(guideId, command, existing.reservation.details.policy, this.time()))?.analysis ?? null;
    }
    const readiness = this.readiness;
    if (!readiness) unavailable();
    const guide = await this.repository.getGuideById(guideId);
    checkAbort(signal);
    if (!guide || guide.status !== "ready" || guide.errorCode !== null) return null;
    const manifest = analysisManifest(guide);
    if (manifest.fingerprint !== command.expectedInputFingerprint) return null;
    const input: AnalysisAdmissionInput = { guideId, inputFingerprint: manifest.fingerprint, frameCount: manifest.frames.length,
      model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION };
    const { snapshot, at, assertCurrent } = verifyAnalysisReadiness({ raw: await readiness.inspect({ ...input }, signal),
      input, readiness, spending: this.spending, clock: () => this.time(), signal });
    const result = await this.repository.reserveAnalysisRequest(guideId, command, snapshot.policy, at, assertCurrent);
    // No queue side-effect after commit: B4 discovers the durable queued run.
    return result?.analysis ?? null;
  }
}
