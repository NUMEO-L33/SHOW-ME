import { randomUUID } from "node:crypto";

import type { GuideRepository } from "./domain.js";
import {
  ANALYSIS_LIMITS, AnalysisContractError, AnalysisProviderFailure, analysisBatches, analysisManifest, parseAnalysisOutput,
  type AnalysisOutput, type AnalysisProvider,
} from "./analysis-contract.js";
import type { AnalysisErrorCode } from "./analysis-state.js";

class AnalysisRunFailure extends Error {
  constructor(readonly code: AnalysisErrorCode) { super(code); }
}

/**
 * Internal/test orchestration only. Not wired to HTTP, startup, or a paid provider.
 * A future dispatcher owns scheduling, budgets, cancellation polling and recovery.
 */
export async function executeAnalysisAttempt(options: {
  repository: GuideRepository;
  guideId: string;
  runId: string;
  expectedAttemptCount: number;
  provider: AnalysisProvider;
  loadImage: (stepId: string, signal: AbortSignal) => Promise<Uint8Array>;
  timeoutMs?: number;
}) {
  const { repository, guideId, runId, provider, loadImage } = options;
  const timeoutMs = options.timeoutMs ?? ANALYSIS_LIMITS.timeoutMs;
  const attemptId = randomUUID();
  const claimed = await repository.executeAnalysisCommand(guideId, {
    type: "claim", runId, attemptId, expectedAttemptCount: options.expectedAttemptCount, leaseMs: timeoutMs,
  });
  if (!claimed) return null;
  const run = claimed.runs.find((candidate) => candidate.id === runId)!;
  const identity = { runId, attemptId, attemptCount: run.attemptCount };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AnalysisRunFailure("AI_TIMEOUT"));
      }, timeoutMs);
    });
    const operation = async () => {
      if (provider.name !== run.provider || provider.model !== run.model) throw new AnalysisRunFailure("AI_PROVIDER_FAILED");
      const steps: AnalysisOutput["steps"] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      for (const batch of analysisBatches(run.manifest.frames)) {
        controller.signal.throwIfAborted();
        // Re-check cancellation/deletion before loading another batch.
        const current = await repository.getAnalysisState(guideId);
        const owner = current?.runs.find((candidate) => candidate.id === runId);
        if (owner?.status !== "running" || owner.attemptId !== attemptId || owner.attemptCount !== run.attemptCount) return null;
        const guide = await repository.getGuideById(guideId);
        if (!guide || guide.status !== "ready" || guide.errorCode || analysisManifest(guide).fingerprint !== run.manifest.fingerprint) return null;
        const images = [];
        for (const frame of [...batch.targets, ...batch.context]) {
          controller.signal.throwIfAborted();
          const bytes = await loadImage(frame.stepId, controller.signal);
          controller.signal.throwIfAborted();
          if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > ANALYSIS_LIMITS.maxImageBytes) {
            throw new AnalysisContractError();
          }
          images.push({ stepId: frame.stepId, mimeType: "image/jpeg" as const, bytes });
        }
        const stillCurrent = await repository.getAnalysisState(guideId);
        const stillOwner = stillCurrent?.runs.find((candidate) => candidate.id === runId);
        if (stillOwner?.status !== "running" || stillOwner.attemptId !== attemptId || stillOwner.attemptCount !== run.attemptCount) return null;
        const stillGuide = await repository.getGuideById(guideId);
        if (!stillGuide || stillGuide.status !== "ready" || stillGuide.errorCode || analysisManifest(stillGuide).fingerprint !== run.manifest.fingerprint) return null;
        controller.signal.throwIfAborted();
        const response = await provider.analyzeFrames({ ...batch, images }, controller.signal);
        controller.signal.throwIfAborted();
        if (response.status !== "completed") {
          throw new AnalysisRunFailure(response.status === "refused" ? "AI_REFUSED" : "AI_INCOMPLETE");
        }
        if (![response.inputTokens, response.outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0)) {
          throw new AnalysisContractError();
        }
        const output = parseAnalysisOutput(response.output, batch.targets.map((frame) => frame.stepId), run.manifest.frames.at(-1)?.stepId);
        steps.push(...output.steps);
        inputTokens += response.inputTokens;
        outputTokens += response.outputTokens;
        if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) throw new AnalysisContractError();
      }
      return { output: { schemaVersion: 1, steps }, inputTokens, outputTokens };
    };
    // The rejection handler installed by race also observes late provider failures.
    const completed = await Promise.race([operation(), deadline]);
    if (!completed) return null;
    controller.signal.throwIfAborted();
    return await repository.executeAnalysisCommand(guideId, { type: "finish", ...identity, ...completed });
  } catch (error) {
    const code = error instanceof AnalysisRunFailure ? error.code
      : error instanceof AnalysisContractError ? "AI_INVALID_OUTPUT"
      : error instanceof AnalysisProviderFailure ? error.analysisCode
      : controller.signal.aborted ? "AI_TIMEOUT" : "AI_PROVIDER_FAILED";
    return repository.executeAnalysisCommand(guideId, { type: "fail", ...identity, errorCode: code });
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
