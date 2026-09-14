import { createHash, timingSafeEqual } from "node:crypto";
import type { AnalysisCommand, AnalysisState } from "./analysis-state.js";
import type { AnalysisFundingRepository } from "./analysis-funding.js";
import type { AnalysisAccountingRepository } from "./analysis-accounting-contract.js";
import type { AnalysisWorkRepository } from "./analysis-work.js";
import type { AnalysisBatchCompletionRepository } from "./analysis-batch-completion.js";

export const GUIDE_STATUSES = [
  "uploading",
  "queued",
  "probing",
  "extracting",
  "ready",
  "failed",
] as const;

export type GuideStatus = (typeof GUIDE_STATUSES)[number];

export const DEFAULT_GUIDE_STATUS_MESSAGES = {
  uploading: "영상을 업로드하고 있어요.",
  queued: "영상 처리 순서를 기다리고 있어요.",
  probing: "영상 정보를 확인하고 있어요.",
  extracting: "중요 장면을 추출하고 있어요.",
  ready: "가이드가 준비됐어요.",
  failed: "영상 처리에 실패했어요.",
} as const satisfies Record<GuideStatus, string>;

export const RECOVERABLE_GUIDE_STATUSES = [
  "queued",
  "probing",
  "extracting",
] as const satisfies readonly GuideStatus[];

declare const percentBrand: unique symbol;

/** A finite coordinate in the inclusive 0–100 range. */
export type Percent = number & { readonly [percentBrand]: "Percent" };

export function isPercent(value: unknown): value is Percent {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function toPercent(value: number, name = "percent"): Percent {
  if (!isPercent(value)) {
    throw new RangeError(`${name} must be a finite number between 0 and 100.`);
  }
  return value;
}

export type PercentPoint = {
  x: Percent;
  y: Percent;
};

export type PercentRect = PercentPoint & {
  width: Percent;
  height: Percent;
};

export type SceneGraphElementBase = {
  id: string;
  zIndex: number;
  visible: boolean;
};

export type TapElement = SceneGraphElementBase & {
  type: "tap";
  center: PercentPoint;
  radius: Percent;
};

export type PrivacyMaskElement = SceneGraphElementBase & {
  type: "privacy-mask";
  bounds: PercentRect;
  enabled: boolean;
};

export type ArrowElement = SceneGraphElementBase & {
  type: "arrow";
  from: PercentPoint;
  to: PercentPoint;
};

export type TextElement = SceneGraphElementBase & {
  type: "text";
  anchor: PercentPoint;
  text: string;
  maxWidth?: Percent;
};

export type SceneGraphElement =
  | TapElement
  | PrivacyMaskElement
  | ArrowElement
  | TextElement;

export type SceneGraph = {
  version: 1;
  coordinateSpace: "percent";
  elements: SceneGraphElement[];
};

export type Guide = {
  id: string;
  ownerId: string | null;
  slug: string;
  editTokenHash: string;
  title: string;
  status: GuideStatus;
  statusMessage: string;
  progress: number;
  originalObjectKey: string;
  sourceFilename: string;
  sourceMimeType: string;
  sourceSizeBytes: number;
  durationMs: number | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  displayWidth: number | null;
  displayHeight: number | null;
  rotationDegrees: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Opaque id of the attempt currently allowed to mutate processing state. */
  processingAttemptId: string | null;
  /** Monotonic count of processing attempts claimed for this guide. */
  processingAttemptCount: number;
  createdAt: string;
  updatedAt: string;
};

export type GuideStep = {
  id: string;
  guideId: string;
  position: number;
  shortLabel: string;
  instruction: string;
  startMs: number;
  endMs: number;
  representativeTimestampMs: number | null;
  representativeFrameKey: string | null;
  thumbnailFrameKey: string | null;
  frameWidth: number | null;
  frameHeight: number | null;
  elements: SceneGraphElement[];
  createdAt: string;
  updatedAt: string;
};

export type GuideWithSteps = Guide & {
  steps: GuideStep[];
};

export type CreateGuideInput = {
  id?: string;
  ownerId?: string | null;
  slug: string;
  editToken: string;
  title: string;
  status?: GuideStatus;
  statusMessage?: string;
  progress?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  originalObjectKey: string;
  sourceFilename: string;
  sourceMimeType: string;
  sourceSizeBytes: number;
  createdAt?: string;
};

export type ClaimUploadLeaseOptions = {
  expectedProcessingAttemptId: string | null;
  expectedUpdatedAt: string;
};

export type CreateGuideStepInput = {
  id?: string;
  position?: number;
  shortLabel: string;
  instruction: string;
  startMs: number;
  endMs: number;
  representativeTimestampMs?: number | null;
  representativeFrameKey?: string | null;
  thumbnailFrameKey?: string | null;
  frameWidth?: number | null;
  frameHeight?: number | null;
  elements?: SceneGraphElement[];
};

export type GuideStatusUpdate = {
  expectedStatuses?: readonly GuideStatus[];
  /** Reject a lifecycle decision if a heartbeat renewed its snapshot. */
  expectedUpdatedAt?: string;
  expectedProcessingAttemptId?: string | null;
  expectedProcessingAttemptCount?: number;
  /** Optional compare-and-set guard used by deletion/retry races. */
  expectedErrorCode?: string | null;
  progress?: number;
  statusMessage?: string;
  durationMs?: number | null;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  displayWidth?: number | null;
  displayHeight?: number | null;
  rotationDegrees?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type DeleteGuideOptions = {
  expectedStatuses?: readonly GuideStatus[];
  expectedUpdatedAt?: string;
  expectedProcessingAttemptId?: string | null;
  expectedProcessingAttemptCount?: number;
  expectedErrorCode?: string | null;
};

export type ClaimProcessingAttemptOptions = {
  expectedStatuses?: readonly GuideStatus[];
  expectedProcessingAttemptId?: string | null;
  expectedProcessingAttemptCount?: number;
  /** The number of successfully claimed attempts allowed for a guide. */
  maxAttempts?: number;
  progress?: number;
  statusMessage?: string;
  exhaustedStatusMessage?: string;
  exhaustedErrorCode?: string;
  exhaustedErrorMessage?: string;
};

export type CompleteProcessingAttemptInput = {
  attemptId: string;
  attemptCount: number;
  steps: readonly CreateGuideStepInput[];
  statusMessage?: string;
};

export interface GuideRepository extends AnalysisFundingRepository, AnalysisAccountingRepository, AnalysisWorkRepository, AnalysisBatchCompletionRepository {
  /** Internal-only Gate 3A commands; callers must authenticate before exposing an API. */
  executeAnalysisCommand(guideId: string, command: AnalysisCommand): Promise<AnalysisState | null>;
  getAnalysisState(guideId: string): Promise<AnalysisState | null>;
  createGuide(input: CreateGuideInput): Promise<Guide>;
  getGuideById(id: string): Promise<GuideWithSteps | null>;
  getGuideBySlug(slug: string): Promise<GuideWithSteps | null>;
  verifyEditToken(guideId: string, token: string): Promise<boolean>;
  updateStatus(
    guideId: string,
    status: GuideStatus,
    update?: GuideStatusUpdate,
  ): Promise<Guide | null>;
  /** Claims an uploading row using its exact durable snapshot. */
  claimUploadLease(
    guideId: string,
    leaseId: string,
    options: ClaimUploadLeaseOptions,
  ): Promise<Guide | null>;
  /** Refreshes an upload lease only while that exact lease still owns the row. */
  renewUploadLease(guideId: string, leaseId: string): Promise<Guide | null>;
  /**
   * Atomically claims a processing attempt and advances the guide to probing.
   * A returned failed guide means the attempt limit was exhausted; null means
   * the guide was missing or a compare-and-set precondition did not match.
   */
  claimProcessingAttempt(
    guideId: string,
    attemptId: string,
    options?: ClaimProcessingAttemptOptions,
  ): Promise<Guide | null>;
  /** Atomically replaces steps and publishes ready only for the active attempt. */
  completeProcessingAttempt(
    guideId: string,
    input: CompleteProcessingAttemptInput,
  ): Promise<GuideWithSteps | null>;
  /** Atomically removes a guide and its step rows when all CAS guards match. */
  deleteGuide(guideId: string, options?: DeleteGuideOptions): Promise<boolean>;
  listByStatuses(statuses: readonly GuideStatus[], limit?: number): Promise<Guide[]>;
  /** Lists failed rows matching error codes, filtering before applying the limit. */
  listFailedByErrorCodes(errorCodes: readonly string[], limit?: number): Promise<Guide[]>;
  /** Lists ordinary failed rows while excluding lifecycle-control error codes. */
  listFailedExcludingErrorCodes(errorCodes: readonly string[], limit?: number): Promise<Guide[]>;
  listRecoverable(limit?: number): Promise<Guide[]>;
  listSteps(guideId: string): Promise<GuideStep[]>;
  replaceSteps(guideId: string, steps: readonly CreateGuideStepInput[]): Promise<GuideStep[]>;
  close?(): Promise<void>;
}

export function isGuideStatus(value: unknown): value is GuideStatus {
  return typeof value === "string" && (GUIDE_STATUSES as readonly string[]).includes(value);
}

export function normalizeProgress(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("progress must be finite.");
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function hashEditToken(token: string): string {
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("edit token must be a non-empty string.");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifyEditTokenHash(token: string, expectedHash: string): boolean {
  if (typeof token !== "string" || token.length === 0 || !/^[a-f\d]{64}$/i.test(expectedHash)) {
    return false;
  }

  const actual = Buffer.from(hashEditToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Convenience alias for callers that do not already have a repository instance. */
export const verifyEditToken = verifyEditTokenHash;
