import { createHash } from "node:crypto";
import { z } from "zod";

import type { GuideWithSteps } from "./domain.js";

export const ANALYSIS_LIMITS = Object.freeze({
  maxFrames: 24,
  targetsPerBatch: 4,
  maxPrivacyRegions: 20,
  maxRuns: 12,
  maxAttempts: 3,
  maxImageBytes: 2 * 1024 * 1024,
  timeoutMs: 180_000,
});
export const ANALYSIS_CONSENT_VERSION = "screen-analysis-v1";
export const ANALYSIS_SCHEMA_VERSION = 1 as const;

export class AnalysisContractError extends Error {
  override name = "AnalysisContractError";
  constructor() { super("Invalid analysis contract."); }
}

/** A provider exposes only safe, persistable failure categories to the runner. */
export class AnalysisProviderFailure extends Error {
  constructor(readonly analysisCode: "AI_TIMEOUT" | "AI_INVALID_OUTPUT" | "AI_PROVIDER_FAILED", message: string) {
    super(message);
  }
}

const id = z.string().min(1).max(128);
const plainText = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value));
const percent = z.number().finite().min(0).max(100);
export const pointSchema = z.object({ x: percent, y: percent }).strict();
export const rectSchema = z.object({
  x: percent, y: percent,
  width: percent.refine((value) => value > 0),
  height: percent.refine((value) => value > 0),
}).strict().refine((rect) => rect.x + rect.width <= 100 && rect.y + rect.height <= 100);

const privacySchema = z.object({
  kind: z.enum(["phone", "account", "identity", "address", "email", "balance", "password", "other"]),
  bounds: rectSchema,
}).strict();
export const analysisStepSchema = z.object({
  stepId: id,
  shortLabel: plainText(60),
  instruction: plainText(500),
  action: z.enum(["tap", "wait", "observe", "unknown"]),
  target: pointSchema.nullable(),
  privacy: z.array(privacySchema).max(ANALYSIS_LIMITS.maxPrivacyRegions),
  reviewReasons: z.array(z.enum(["unclear_action", "small_text", "missing_context", "privacy_uncertain"]))
    .max(4),
  mergeWithNext: z.boolean(),
}).strict().superRefine((step, context) => {
  if (step.action !== "tap" && step.target !== null) {
    context.addIssue({ code: "custom", message: "Only a tap action may have a target." });
  }
  if ((step.action === "unknown" || (step.action === "tap" && step.target === null)) &&
      step.reviewReasons.length === 0) {
    context.addIssue({ code: "custom", message: "An uncertain action requires review." });
  }
});
export const analysisOutputSchema = z.object({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  steps: z.array(analysisStepSchema).min(1).max(ANALYSIS_LIMITS.maxFrames),
}).strict();
export type AnalysisOutput = z.infer<typeof analysisOutputSchema>;

export type FrameDescriptor = {
  stepId: string;
  position: number;
  timestampMs: number;
  width: number;
  height: number;
};
export type AnalysisManifest = {
  fingerprint: string;
  mediaAttemptId: string;
  mediaAttemptCount: number;
  frames: FrameDescriptor[];
};

/** Construct identity only from server-owned media facts, never from client URLs. */
export function analysisManifest(guide: GuideWithSteps): AnalysisManifest {
  if (guide.status !== "ready" || guide.errorCode !== null || !guide.processingAttemptId ||
      guide.processingAttemptCount < 1 || guide.steps.length < 1 ||
      guide.steps.length > ANALYSIS_LIMITS.maxFrames) throw new AnalysisContractError();
  const steps = [...guide.steps].sort((a, b) => a.position - b.position);
  const frames = steps.map((step, position) => {
    if (step.guideId !== guide.id || step.position !== position || !step.representativeFrameKey ||
        !Number.isSafeInteger(step.frameWidth) || (step.frameWidth ?? 0) <= 0 ||
        !Number.isSafeInteger(step.frameHeight) || (step.frameHeight ?? 0) <= 0 ||
        !Number.isSafeInteger(step.representativeTimestampMs) ||
        (step.representativeTimestampMs ?? -1) < step.startMs ||
        (step.representativeTimestampMs ?? Infinity) > step.endMs) throw new AnalysisContractError();
    return {
      stepId: id.parse(step.id), position,
      timestampMs: step.representativeTimestampMs!, width: step.frameWidth!, height: step.frameHeight!,
    };
  });
  if (new Set(frames.map((frame) => frame.stepId)).size !== frames.length) throw new AnalysisContractError();
  const fingerprint = createHash("sha256").update(JSON.stringify({
    guideId: guide.id, attemptId: guide.processingAttemptId, attemptCount: guide.processingAttemptCount,
    frames: steps.map((step, index) => ({
      ...frames[index], key: step.representativeFrameKey, startMs: step.startMs, endMs: step.endMs,
    })),
  })).digest("hex");
  return { fingerprint, mediaAttemptId: guide.processingAttemptId, mediaAttemptCount: guide.processingAttemptCount, frames };
}

export function parseAnalysisOutput(
  raw: unknown,
  targetIds: readonly string[],
  lastStepId?: string,
): AnalysisOutput {
  const parsed = analysisOutputSchema.safeParse(raw);
  if (!parsed.success || targetIds.length === 0 || new Set(targetIds).size !== targetIds.length) {
    throw new AnalysisContractError();
  }
  const steps = new Map(parsed.data.steps.map((step) => [step.stepId, step]));
  if (steps.size !== targetIds.length || parsed.data.steps.length !== targetIds.length ||
      targetIds.some((target) => !steps.has(target)) ||
      (lastStepId && steps.get(lastStepId)?.mergeWithNext)) throw new AnalysisContractError();
  return { schemaVersion: 1, steps: targetIds.map((target) => steps.get(target)!) };
}

export function analysisBatches(frames: readonly FrameDescriptor[]) {
  const batches: Array<{ targets: FrameDescriptor[]; context: FrameDescriptor[] }> = [];
  for (let offset = 0; offset < frames.length; offset += ANALYSIS_LIMITS.targetsPerBatch) {
    const targets = frames.slice(offset, offset + ANALYSIS_LIMITS.targetsPerBatch);
    const context = [frames[offset - 1], frames[offset + targets.length]].filter(Boolean);
    batches.push({ targets, context });
  }
  return batches;
}

const elementBase = { id, zIndex: z.number().int().min(0).max(100), visible: z.boolean() };
const draftElementSchema = z.discriminatedUnion("type", [
  z.object({ ...elementBase, type: z.literal("tap"), center: pointSchema, radius: percent }).strict(),
  z.object({ ...elementBase, type: z.literal("privacy-mask"), bounds: rectSchema, enabled: z.boolean() }).strict(),
]);
export const draftDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  title: plainText(120),
  steps: z.array(z.object({
    id, activeFrameStepId: id, sourceStepIds: z.array(id).min(1).max(ANALYSIS_LIMITS.maxFrames),
    shortLabel: plainText(60), instruction: plainText(500),
    elements: z.array(draftElementSchema).max(ANALYSIS_LIMITS.maxPrivacyRegions + 1),
    // Gate 3A cannot approve privacy review or publish a draft.
    privacyReview: z.literal("pending"),
  }).strict()).min(1).max(ANALYSIS_LIMITS.maxFrames),
}).strict();
export type DraftDocument = z.infer<typeof draftDocumentSchema>;

export function parseDraftDocument(raw: unknown, frames: readonly FrameDescriptor[]): DraftDocument {
  const parsed = draftDocumentSchema.safeParse(raw);
  if (!parsed.success) throw new AnalysisContractError();
  const sourceIds = new Set(frames.map((frame) => frame.stepId));
  const usedSources = new Set<string>();
  const stepIds = new Set<string>();
  for (const step of parsed.data.steps) {
    if (stepIds.has(step.id) || !step.sourceStepIds.includes(step.activeFrameStepId) ||
        new Set(step.elements.map((element) => element.id)).size !== step.elements.length) throw new AnalysisContractError();
    stepIds.add(step.id);
    for (const sourceId of step.sourceStepIds) {
      if (!sourceIds.has(sourceId) || usedSources.has(sourceId)) throw new AnalysisContractError();
      usedSources.add(sourceId);
    }
  }
  return parsed.data;
}

export function initialDraft(manifest: AnalysisManifest): DraftDocument {
  return parseDraftDocument({
    schemaVersion: 1, title: "새 가이드",
    steps: manifest.frames.map((frame) => ({
      id: frame.stepId, activeFrameStepId: frame.stepId, sourceStepIds: [frame.stepId],
      shortLabel: `${frame.position + 1}단계 화면`, instruction: "이 화면에서 할 일을 확인해 주세요.",
      elements: [], privacyReview: "pending",
    })),
  }, manifest.frames);
}

export function draftFromAnalysis(document: DraftDocument, result: AnalysisOutput): DraftDocument {
  return {
    ...document,
    steps: document.steps.map((step) => {
      const suggestion = result.steps.find((candidate) => candidate.stepId === step.activeFrameStepId)!;
      const elementPrefix = createHash("sha256").update(step.id).digest("hex").slice(0, 32);
      return {
        ...step, shortLabel: suggestion.shortLabel, instruction: suggestion.instruction,
        privacyReview: "pending",
        elements: [
          ...(suggestion.target ? [{
            id: `${elementPrefix}:tap`, type: "tap" as const, center: suggestion.target,
            radius: 5, zIndex: 10, visible: true,
          }] : []),
          ...suggestion.privacy.map((region, index) => ({
            id: `${elementPrefix}:mask:${index}`, type: "privacy-mask" as const, bounds: region.bounds,
            enabled: true, zIndex: 20, visible: true,
          })),
        ],
      };
    }),
  };
}

/** Gemini is currently opt-in for synthetic smoke tests only; public APIs do not register it. */
export interface AnalysisProvider {
  readonly name: string;
  readonly model: string;
  analyzeFrames(input: {
    targets: FrameDescriptor[];
    context: FrameDescriptor[];
    images: Array<{ stepId: string; mimeType: "image/jpeg"; bytes: Uint8Array }>;
  }, signal: AbortSignal): Promise<
    | { status: "completed"; output: unknown; inputTokens: number; outputTokens: number }
    | { status: "refused" | "incomplete" }
  >;
}
