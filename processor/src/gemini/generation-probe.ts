import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AnalysisContractError, parseAnalysisOutput, type AnalysisOutput } from "../analysis-contract.js";
import { providerQuotaDay } from "../analysis-provider-quota.js";
import { GeminiAnalysisProvider, GeminiError } from "./provider.js";
import { GEMINI_TEST_MODEL } from "./request.js";
import { prepareSyntheticTokenProbe, reserveTokenProbeAttempt, tokenProbeMode } from "./token-probe.js";

// Historical experiment reference, NOT an input-bound or billing authorization source.
export const SYNTHETIC_COUNT_REFERENCE = Object.freeze({
  measuredOn: "2026-09-15", model: "gemini-3.5-flash-lite",
  requestFingerprint: "520a4dcd1bd453584265c015d85a9fa9211e07ab9ad09a929be70fe4467545fc",
  countedInputTokens: 7199,
});
const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../../.data/gemini-generation-probe");

export function generationProbeMode(args: string[], env: NodeJS.ProcessEnv) {
  if (args.length === 0) return "dry-run" as const;
  // A count-only approval must never authorize generation.
  if (!args.includes("--approve-synthetic-generation") || args.includes("--approve-synthetic-images")) {
    throw new GeminiError("GEMINI_DISABLED");
  }
  return tokenProbeMode(args.map((arg) => arg === "--approve-synthetic-generation" ? "--approve-synthetic-images" : arg), env);
}

export function matchesCountReference(report: { model: string; requestFingerprint: string }) {
  return report.model === SYNTHETIC_COUNT_REFERENCE.model && report.requestFingerprint === SYNTHETIC_COUNT_REFERENCE.requestFingerprint;
}

/** Fixture-specific indicators for review, never a general privacy or semantic quality guarantee. */
export function reviewSyntheticGeneration(output: AnalysisOutput) {
  const steps = output.steps;
  return {
    koreanLabelsAndInstructions: steps.every((step) => /[가-힣]/.test(step.shortLabel) && /[가-힣]/.test(step.instruction)),
    tapCoordinatesInsideSyntheticButton: steps.filter((step) => step.action === "tap").every((step) =>
      step.target !== null && step.target.x >= 205 / 640 * 100 && step.target.x <= 435 / 640 * 100 &&
      step.target.y >= 214 / 360 * 100 && step.target.y <= 282 / 360 * 100),
    tapSteps: steps.filter((step) => step.action === "tap").length,
    privacyCandidateCount: steps.reduce((sum, step) => sum + step.privacy.length, 0),
    stepsFlaggedForReview: steps.filter((step) => step.reviewReasons.length > 0).length,
    containsNoPersonalDataFixture: true,
    privacyRecallTested: false,
    humanReviewRequired: true,
  };
}

/** One developer-only generateContent call using precisely the previously counted fixture. */
export async function runGenerationProbe(args: string[], env: NodeJS.ProcessEnv, dependencies: {
  fetch?: typeof fetch; reserve?: typeof reserveTokenProbeAttempt; signal?: AbortSignal; timeoutMs?: number;
} = {}) {
  const mode = generationProbeMode(args, env);
  const signal = dependencies.signal ?? new AbortController().signal;
  if (signal.aborted) throw new GeminiError("GEMINI_CANCELLED");
  const { input, report: audit } = await prepareSyntheticTokenProbe();
  const sameRequest = matchesCountReference(audit);
  const report = {
    model: GEMINI_TEST_MODEL, api: "generateContent", requestFingerprint: audit.requestFingerprint,
    syntheticOnly: true, targetCount: audit.targetCount, contextCount: audit.contextCount,
    sameRequestAsCountProbe: sameRequest, countedInputTokens: SYNTHETIC_COUNT_REFERENCE.countedInputTokens,
    verifiedInputTokenUpperBound: null, enablesAnalysis: false, projectVerifiedAutomatically: false,
  };
  if (mode === "dry-run") return { ...report, status: "prepared-not-sent" as const, networkCalls: 0 };
  if (!sameRequest) throw new GeminiError("GEMINI_DISABLED");
  const provider = new GeminiAnalysisProvider({
    apiKey: env.GEMINI_API_KEY!, allowExternalProcessing: true, model: GEMINI_TEST_MODEL,
    transientRetries: 0, timeoutMs: dependencies.timeoutMs ?? 60_000, fetch: dependencies.fetch,
    reserveRequest: (requestSignal) => (dependencies.reserve ?? reserveTokenProbeAttempt)(directory, audit.requestFingerprint, requestSignal),
  });
  const result = await provider.analyzeFrames(input, signal);
  if (result.status !== "completed") return { ...report, status: result.status, networkCalls: 1 };
  const output = parseAnalysisOutput(result.output, input.targets.map((frame) => frame.stepId));
  return {
    ...report, status: "generated-synthetic-only" as const, networkCalls: 1,
    generatedInputTokens: result.inputTokens, differenceFromCountTokens: result.inputTokens - report.countedInputTokens,
    outputTokensIncludingThinking: result.outputTokens,
    review: reviewSyntheticGeneration(output), output,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runGenerationProbe(process.argv.slice(2), process.env).then(async (report) => {
    // Only validated synthetic output and aggregate counts; no raw body, images, key or thoughts.
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "prepared-not-sent") return;
    try {
      const path = join(directory, providerQuotaDay(new Date()), "result.json");
      await writeFile(path, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ resultSaved: true, path }));
    } catch {
      console.error(JSON.stringify({ resultSaved: false, doNotRetryGeneration: true }));
      process.exitCode = 1;
    }
  }).catch((error: unknown) => {
    console.error(JSON.stringify({ status: "failed-no-automatic-retry", code: error instanceof GeminiError ? error.code :
      error instanceof AnalysisContractError ? "AI_INVALID_OUTPUT" : "GEMINI_GENERATION_PROBE_FAILED",
    httpStatus: error instanceof GeminiError ? error.httpStatus : undefined }));
    process.exitCode = 1;
  });
}
