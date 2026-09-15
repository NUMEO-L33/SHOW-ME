import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { AnalysisAccountingError, type AnalysisAccountingCommand } from "./analysis-accounting-contract.js";
import { AnalysisAdmissionError, verifyAnalysisReadiness, type AnalysisAdmissionReadiness } from "./analysis-admission.js";
import { ANALYSIS_LIMITS, AnalysisContractError, analysisBatches, analysisManifest, type AnalysisProvider } from "./analysis-contract.js";
import { fundingDay, type AnalysisFundingPolicy } from "./analysis-funding.js";
import type { AnalysisErrorCode, AnalysisRun } from "./analysis-state.js";
import { ownsAnalysisWork, workTime, type AnalysisWorkCandidate } from "./analysis-work.js";
import type { GuideRepository } from "./domain.js";
import { GeminiError, type DispatchSendPermit } from "./gemini/provider.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "./gemini/request.js";

/** Trusted adapter contract: exactly one external attempt per invocation, never nested retries. */
export type AnalysisDispatchProvider = Pick<AnalysisProvider, "name" | "model"> & {
  readonly transientRetries: number; readonly maxOutputTokens: number; readonly dispatchContract: "single-send-v1";
  analyzeFrames(input: Parameters<AnalysisProvider["analyzeFrames"]>[0], signal: AbortSignal,
    authorizeSend: DispatchSendPermit): ReturnType<AnalysisProvider["analyzeFrames"]>;
};
export type AnalysisDispatchOutcome = "disabled" | "idle" | "completed" | "failed" | "interrupted" | "unavailable" | "degraded" | "stopped";
type Options = {
  repository: GuideRepository; provider?: AnalysisDispatchProvider; readiness?: AnalysisAdmissionReadiness;
  loadImage?: (guideId: string, stepId: string, signal: AbortSignal) => Promise<Uint8Array>;
  pollMs?: number; statusPollMs?: number; retryDelayMs?: number; leaseMs?: number; requestTimeoutMs?: number; ioTimeoutMs?: number;
  /** Test clock only. Omit in production so repository ownership uses its own DB clock. */
  clock?: () => Date;
};
class DispatchStop extends Error {
  constructor(readonly reason: "timeout" | "lost" | "shutdown") { super("ANALYSIS_DISPATCH_STOPPED"); }
}
class WorkFailure extends Error {
  constructor(readonly code: AnalysisErrorCode) { super(code); }
}

/** Observe late failures without letting uncooperative I/O continue the orchestration. */
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, ms: number,
  timeoutReason: Error = new DispatchStop("timeout")): Promise<T> {
  parent.throwIfAborted();
  const timeout = new AbortController();
  const signal = AbortSignal.any([parent, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(timeoutReason), ms);
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await Promise.race([operation(signal), stopped]);
    signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    // Also invalidate delayed repository beforeCommit checks after a lost acknowledgement.
    timeout.abort(new DispatchStop("lost"));
  }
}

/**
 * Explicitly started internal worker. NO startup/HTTP/env registration or live readiness adapter.
 * Free-only permission is rechecked per batch; a stored reservation/claim is never permission.
 */
export class DurableAnalysisDispatcher {
  private readonly options: Options;
  private readonly pollMs: number;
  private readonly statusPollMs: number;
  private readonly retryDelayMs: number;
  private readonly leaseMs: number;
  private readonly requestTimeoutMs: number;
  private readonly ioTimeoutMs: number;
  private shutdown = new AbortController();
  private flight?: Promise<AnalysisDispatchOutcome>;
  private loop?: Promise<void>;
  private outcome: AnalysisDispatchOutcome = "idle";
  private failures = 0;

  constructor(options: Options) {
    this.options = { ...options };
    const duration = (value: number, max: number) => {
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new AnalysisContractError();
      return value;
    };
    this.pollMs = duration(options.pollMs ?? 1000, 30_000);
    this.statusPollMs = duration(options.statusPollMs ?? 1000, 5000);
    this.retryDelayMs = duration(options.retryDelayMs ?? 500, 5000);
    this.leaseMs = duration(options.leaseMs ?? ANALYSIS_LIMITS.timeoutMs, ANALYSIS_LIMITS.timeoutMs);
    this.requestTimeoutMs = duration(options.requestTimeoutMs ?? 60_000, 60_000);
    this.ioTimeoutMs = duration(options.ioTimeoutMs ?? 5000, 5000);
  }

  getStatus() {
    return { outcome: this.outcome, processing: Boolean(this.flight), running: Boolean(this.loop), consecutiveFailures: this.failures,
      nextPollMs: Math.min(30_000, this.pollMs * 2 ** Math.min(this.failures, 10)) };
  }
  start(): void {
    if (this.loop) return;
    if (this.shutdown.signal.aborted) this.shutdown = new AbortController();
    const signal = this.shutdown.signal;
    this.loop = (async () => {
      while (!signal.aborted) {
        await this.tick();
        if (!signal.aborted) await delay(this.getStatus().nextPollMs, undefined, { signal }).catch(() => undefined);
      }
    })().finally(() => { this.loop = undefined; });
  }
  async stop(): Promise<void> {
    this.shutdown.abort(new DispatchStop("shutdown"));
    await Promise.all([this.loop, this.flight]);
    this.outcome = "stopped";
  }
  /** Concurrent local ticks coalesce. Cross-process exclusion comes from repository claims. */
  tick(): Promise<AnalysisDispatchOutcome> {
    if (this.flight) return this.flight;
    if (this.shutdown.signal.aborted) return Promise.resolve("stopped");
    this.flight = this.pass().catch(() => "degraded" as const).then((outcome) => {
      this.outcome = outcome;
      this.failures = outcome === "degraded" || outcome === "unavailable" ? Math.min(10, this.failures + 1) : 0;
      return outcome;
    }).finally(() => { this.flight = undefined; });
    return this.flight;
  }

  private time() { return workTime(this.options.clock?.() ?? new Date()); }
  private repositoryTime() { return this.options.clock ? this.time() : undefined; }
  private io<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) {
    return bounded(operation, signal, this.ioTimeoutMs, new Error("ANALYSIS_IO_TIMEOUT"));
  }
  private providerMatches(run: AnalysisRun, policy: AnalysisFundingPolicy): boolean {
    const provider = this.options.provider;
    return Boolean(provider && provider.dispatchContract === "single-send-v1" && provider.transientRetries === 0 && provider.name === run.provider && provider.model === run.model &&
      Number.isSafeInteger(provider.maxOutputTokens) && provider.maxOutputTokens > 0 && provider.maxOutputTokens <= policy.maxOutputTokensPerRequest &&
      run.model === GEMINI_TEST_MODEL && run.promptVersion === GEMINI_PROMPT_VERSION);
  }
  private async permission(guideId: string, run: AnalysisRun, policy: AnalysisFundingPolicy, signal: AbortSignal) {
    const readiness = this.options.readiness!;
    if (!this.providerMatches(run, policy)) throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE");
    const input = { guideId, inputFingerprint: run.manifest.fingerprint, frameCount: run.manifest.frames.length,
      model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION } as const;
    const raw = await this.io((s) => readiness.inspect({ ...input }, s), signal);
    const checked = verifyAnalysisReadiness({ raw, input, readiness, spending: { mode: "free_only" }, clock: () => this.time(), signal });
    // Never reinterpret an already reserved run with a different price, quota or retry policy.
    if (JSON.stringify(checked.snapshot.policy) !== JSON.stringify(policy)) throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE");
    return checked.assertCurrent;
  }
  private async current(guideId: string, claimed: AnalysisRun, signal: AbortSignal, sending: boolean, watchTerminal = false) {
    const repository = this.options.repository;
    const state = await this.io(() => repository.getAnalysisState(guideId), signal);
    const run = state?.runs.find((r) => r.id === claimed.id);
    const owner = { attemptId: claimed.attemptId!, attemptCount: claimed.attemptCount };
    if (watchTerminal && run && ["succeeded", "failed"].includes(run.status) &&
        run.attemptId === owner.attemptId && run.attemptCount === owner.attemptCount) return run;
    if (!run || !ownsAnalysisWork(run, owner, this.time())) throw new DispatchStop("lost");
    const guide = await this.io(() => repository.getGuideById(guideId), signal);
    if (!guide || guide.status !== "ready" || guide.errorCode !== null || analysisManifest(guide).fingerprint !== claimed.manifest.fingerprint) {
      throw new DispatchStop("lost");
    }
    if (sending && (await this.io(() => repository.getAnalysisAccountingControl(), signal)).halted) {
      throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE");
    }
    signal.throwIfAborted();
    return run;
  }

  private async pass(): Promise<AnalysisDispatchOutcome> {
    if (!this.options.provider || !this.options.readiness || !this.options.loadImage) return "disabled";
    const repository = this.options.repository;
    let active: { guideId: string; run: AnalysisRun } | undefined;
    const deadline = new AbortController();
    const signal = AbortSignal.any([this.shutdown.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new DispatchStop("timeout")), this.leaseMs);
    try {
      const candidates = await this.io(() => repository.listAnalysisWork(20, this.repositoryTime()), signal);
      for (const candidate of candidates) {
        const funded = await this.io(() => repository.getAnalysisFunding(candidate.guideId, candidate.runId), signal);
        const state = await this.io(() => repository.getAnalysisState(candidate.guideId), signal);
        const run = state?.runs.find((r) => r.id === candidate.runId);
        if (!funded?.reservation.details || !run) continue;
        // Do not churn lease attempts just because entitlement is unavailable or yesterday's work is still queued.
        if (fundingDay(this.time()) !== funded.reservation.day) continue;
        const assertCurrent = await this.permission(candidate.guideId, run, funded.reservation.details.policy, signal);
        const claim = await this.io((s) => repository.claimAnalysisWork(candidate.guideId, {
          runId: candidate.runId, attemptId: randomUUID(), expectedAttemptCount: candidate.expectedAttemptCount, leaseMs: this.leaseMs,
        }, this.repositoryTime(), () => { s.throwIfAborted(); assertCurrent(); }), signal);
        if (!claim || claim.replayed || claim.outcome !== "claimed") continue;
        active = { guideId: candidate.guideId, run: claim.run };
        // Await bounded orchestration cleanup too; stop must not leave an unobserved worker tail.
        return await this.process(candidate, claim.run, signal);
      }
      return "idle";
    } catch (error) {
      if (this.shutdown.signal.aborted) return "stopped";
      const unavailable = error instanceof AnalysisAdmissionError || error instanceof AnalysisAccountingError;
      const timeout = error instanceof DispatchStop && error.reason === "timeout";
      if (active && (error instanceof WorkFailure || unavailable || timeout)) {
        const cleanup = new AbortController();
        await this.io((s) => repository.failAnalysisWork(active!.guideId, { type: "fail", runId: active!.run.id,
          attemptId: active!.run.attemptId!, attemptCount: active!.run.attemptCount,
          errorCode: error instanceof WorkFailure ? error.code : timeout ? "AI_TIMEOUT" : "AI_PROVIDER_FAILED",
        }, this.repositoryTime(), () => s.throwIfAborted()), cleanup.signal);
      }
      if (unavailable) return "unavailable";
      if (error instanceof WorkFailure || timeout) return "failed";
      if (error instanceof DispatchStop) return "interrupted";
      // Storage ambiguity is NOT a reason to send again or refund. A later lease discovers durable state.
      return "degraded";
    } finally {
      clearTimeout(timer);
      deadline.abort(new DispatchStop("lost"));
    }
  }

  private async process(candidate: AnalysisWorkCandidate, run: AnalysisRun, parent: AbortSignal): Promise<AnalysisDispatchOutcome> {
    const { guideId, runId } = candidate;
    const repository = this.options.repository;
    const controller = new AbortController();
    const signal = AbortSignal.any([parent, controller.signal]);
    let assertPermission: (() => void) | undefined;
    const watchdog = (async () => {
      try {
        while (!signal.aborted) {
          await delay(this.statusPollMs, undefined, { signal });
          const latest = await this.current(guideId, run, signal, true, true);
          if (latest.status !== "running") break;
          assertPermission?.();
        }
      } catch (error) { if (!signal.aborted) controller.abort(error); }
    })();
    const owner = { attemptId: run.attemptId!, attemptCount: run.attemptCount };
    try {
      for (const [batchIndex, batch] of analysisBatches(run.manifest.frames).entries()) {
        let retryAllowed = false;
        for (;;) {
          await this.current(guideId, run, signal, true);
          const funding = await this.io(() => repository.getAnalysisFunding(guideId, runId), signal);
          const attempts = await this.io(() => repository.getAnalysisRequestAttempts(guideId, runId), signal);
          if (!funding?.reservation.details || !attempts) throw new DispatchStop("lost");
          if (funding.batches[batchIndex]?.status === "succeeded") break;
          if (fundingDay(this.time()) !== funding.reservation.day) throw new AnalysisAccountingError("ANALYSIS_DAY_ROLLOVER");
          const policy = funding.reservation.details.policy;
          assertPermission = await this.permission(guideId, run, policy, signal);
          const previous = attempts.filter((a) => a.batchIndex === batchIndex).sort((a, b) => b.ordinal - a.ordinal)[0];
          let ordinal: 0 | 1 = 0;
          let dispatchId = randomUUID() as string;
          if (previous?.status === "reserved") { ordinal = previous.ordinal; dispatchId = previous.dispatchId; }
          else if (previous) {
            // Recovered unknown sends have no durable failure classification: never retry them blindly.
            if (!retryAllowed || previous.ordinal !== 0 || previous.status !== "uncertain" || policy.transientRetries !== 1) {
              throw new WorkFailure("AI_PROVIDER_FAILED");
            }
            ordinal = 1;
          }
          const identity = { runId, batchIndex, ordinal, dispatchId };
          const guard = (s: AbortSignal) => {
            s.throwIfAborted(); assertPermission!();
            if (!this.providerMatches(run, policy) || !ownsAnalysisWork(run, owner, this.time()) ||
                fundingDay(this.time()) !== funding.reservation.day) throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE");
          };
          const allocated = await this.io((s) => repository.executeAnalysisAccounting(guideId,
            { type: "allocate", ...identity, owner }, this.repositoryTime(), () => guard(s)), signal);
          if (!allocated || allocated.attempt.status !== "reserved") throw new DispatchStop("lost");
          const images: Parameters<AnalysisProvider["analyzeFrames"]>[0]["images"] = [];
          try {
            for (const frame of [...batch.targets, ...batch.context]) {
              guard(signal);
              const bytes = await this.io((s) => this.options.loadImage!(guideId, frame.stepId, s), signal);
              if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > ANALYSIS_LIMITS.maxImageBytes) {
                throw new AnalysisContractError();
              }
              images.push({ stepId: frame.stepId, mimeType: "image/jpeg", bytes: new Uint8Array(bytes) });
            }
          } catch (error) {
            if (error instanceof AnalysisContractError) throw new WorkFailure("AI_INVALID_OUTPUT");
            throw error;
          }
          await this.current(guideId, run, signal, true);
          const sent = await this.io((s) => repository.executeAnalysisAccounting(guideId,
            { type: "sending", ...identity, owner }, this.repositoryTime(), () => guard(s)), signal);
          if (!sent || sent.replayed || sent.attempt.status !== "sending") throw new DispatchStop("lost");
          let response: Awaited<ReturnType<AnalysisProvider["analyzeFrames"]>>;
          let sendPermits = 0;
          try {
            await this.current(guideId, run, signal, true);
            guard(signal);
            response = await bounded((s) => {
              guard(s); // No await between the last guard and the single provider invocation.
              return this.options.provider!.analyzeFrames({ ...batch, images }, s, async (providerSignal) => {
                if (++sendPermits !== 1) throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE");
                const sendSignal = AbortSignal.any([s, providerSignal]);
                await this.current(guideId, run, sendSignal, true);
                return () => guard(sendSignal);
              });
            }, signal, this.requestTimeoutMs);
          } catch (error) {
            await this.settleAfterStop(guideId, { type: "settle", ...identity, usage: { status: "unknown" } });
            signal.throwIfAborted();
            if (sendPermits === 1 && error instanceof GeminiError && error.code === "GEMINI_HTTP_FAILED" &&
                [500, 502, 503, 504].includes(error.httpStatus ?? 0) && ordinal === 0 && policy.transientRetries === 1) {
              retryAllowed = true;
              await delay(this.retryDelayMs, undefined, { signal });
              continue;
            }
            if (error instanceof AnalysisAdmissionError) throw error;
            throw new WorkFailure(error instanceof DispatchStop || (error instanceof GeminiError && error.code === "GEMINI_TIMEOUT") ? "AI_TIMEOUT"
              : error instanceof AnalysisContractError || (error instanceof GeminiError && error.code === "GEMINI_RESPONSE_INVALID") ? "AI_INVALID_OUTPUT" : "AI_PROVIDER_FAILED");
          } finally { images.length = 0; }
          if (sendPermits !== 1 || !response || typeof response !== "object") {
            await this.settleAfterStop(guideId, { type: "settle", ...identity, usage: { status: "unknown" } });
            throw new WorkFailure("AI_PROVIDER_FAILED");
          }
          if (response.status !== "completed" || ![response.inputTokens, response.outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0)) {
            await this.settleAfterStop(guideId, { type: "settle", ...identity, usage: { status: "unknown" } });
            throw new WorkFailure(response.status === "refused" ? "AI_REFUSED" : response.status === "incomplete" ? "AI_INCOMPLETE" : "AI_INVALID_OUTPUT");
          }
          const result = await this.io((s) => repository.completeAnalysisBatch(guideId, { ...identity, owner,
            expectedInputFingerprint: run.manifest.fingerprint, output: response.output ?? null,
            inputTokens: response.inputTokens, outputTokens: response.outputTokens,
          }, this.repositoryTime(), () => s.throwIfAborted()), signal);
          if (!result) {
            await this.settleAfterStop(guideId, { type: "settle", ...identity, usage: { status: "known",
              inputTokens: response.inputTokens, outputTokens: response.outputTokens } });
            throw new DispatchStop("lost");
          }
          if (result.outcome !== "saved") return "failed";
          if (result.analysis.runs.find((r) => r.id === runId)?.status === "succeeded") return "completed";
          break;
        }
      }
      return "completed";
    } finally {
      controller.abort(new DispatchStop("lost"));
      await watchdog;
    }
  }

  private async settleAfterStop(guideId: string, command: AnalysisAccountingCommand) {
    // Numeric-only cleanup can outlive cancel/shutdown, but cannot resurrect the guide or apply output.
    const cleanup = new AbortController();
    return this.io((s) => this.options.repository.executeAnalysisAccounting(guideId, command,
      this.repositoryTime(), () => s.throwIfAborted()), cleanup.signal);
  }
}
