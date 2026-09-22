import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { privacyAssetBatchSchema, transitionPrivacyAsset, type PrivacyAssetBatch, type PrivacyAssetCommand } from "./privacy-assets.js";
import { publicationAvailableAt, publicationCommandSchema, publicationJobSchema, publicationTime, publicationWorkLimit,
  publicationRecoveryQuerySchema, type PublicationRecoveryQuery,
  transitionPublicationJob, type PublicationCommand, type PublicationJob, type PublicationJobRepository } from "./publication-jobs.js";
import { guidePublicationSchema, publicationHeadSchema, publicationCommitSchema, preparePublicationCommit,
  publicationProtectsAsset, validatePublicationState, type GuidePublication, type PublicationHead,
  type PublicationCommit, type PublicationState, type PublicationRepository } from "./publication-commit.js";
import { publicationAccessSchema, publicationStopSchema, publicationExpiryQuerySchema, preparePublicationStop,
  selectAccessiblePublication, selectPublicationOwnerStatus, publicationPreparationAllowed, publicationExpiryCandidate, comparePublicationExpiry,
  type PublicationAccess, type PublicationStop, type PublicationExpiryQuery, type PublicationLifecycleRepository } from "./publication-lifecycle.js";
import { PRIVATE_MEDIA_EXPIRED, privateMediaExpired, privateExpirySchema, privateCleanupSchema, privateCleanupQuerySchema,
  preparePrivateExpiry, retainedPublicationLive, type PrivateCleanup, type PrivateCleanupQuery, type PrivateExpiry } from "./private-retention.js";

import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { analysisActivationSchema, matchesAnalysisActivation, type AnalysisActivation } from "./analysis-activation.js";

import {
  DEFAULT_GUIDE_STATUS_MESSAGES,
  RECOVERABLE_GUIDE_STATUSES,
  hashEditToken,
  isGuideStatus,
  normalizeProgress,
  verifyEditTokenHash,
  type ClaimProcessingAttemptOptions,
  type ClaimUploadLeaseOptions,
  type CompleteProcessingAttemptInput,
  type CreateGuideInput,
  type CreateGuideStepInput,
  type DeleteGuideOptions,
  type Guide,
  type GuideRepository,
  type GuideStatus,
  type GuideStatusUpdate,
  type GuideStep,
  type GuideWithSteps,
} from "./domain.js";
import {
  analysisAccountingControls,
  analysisCountAttempts,
  analysisProviderQuotaCharges,
  analysisBatchesTable,
  analysisBudgetWindows,
  analysisReservations,
  analysisRequestAttempts,
  analysisRuns,
  guideDrafts,
  guideAssets,
  publicationJobs,
  guidePublications,
  publicationHeads,
  privateMediaCleanup,
  guideSteps,
  guides,
  type GuideRow,
  type GuideStepRow,
  type NewGuideRow,
  type NewGuideStepRow,
} from "./db/schema.js";
import * as processorSchema from "./db/schema.js";
import {
  emptyAnalysisState, parseAnalysisState, transitionAnalysis,
  type AnalysisCommand, type AnalysisState,
} from "./analysis-state.js";

import {
  emptyFundingLedger, fundingDay, fundingWindowIdentity, initialBudgetWindow, parseBudgetWindow,
  parseFundingCommand, parseFundingLedger, parseFundingPolicy, parseReservation, parseStoredBatch, prepareFundedAnalysis, validateFundingAnalysis,
  reservationAccounted, upgradeFundingLedgerV2, upgradeFundingLedgerV3, upgradeFundingLedgerV4, validateBatchSettlements,
  type AnalysisFundingCommand, type AnalysisFundingLedger, type AnalysisFundingPolicy, type AnalysisFundingResult,
} from "./analysis-funding.js";
import {
  AnalysisAccountingError, parseAccountingCommand, parseAccountingControl, parseRequestAttempt,
  type AnalysisAccountingCommand, type AnalysisAccountingResult, type AnalysisRequestAttempt,
} from "./analysis-accounting-contract.js";
import { prepareAnalysisAccounting } from "./analysis-accounting.js";
import {
  parseWorkClaim, prepareAnalysisWorkClaim, parseWorkFailure, prepareAnalysisWorkFailure, validateWorkProjection, workAvailableAt, workLimit, workTime,
  type AnalysisWorkCandidate, type AnalysisWorkClaim, type AnalysisWorkResult, type AnalysisWorkFailure,
  parseWorkCursor, compareWorkCursor, type AnalysisWorkCursor,
} from "./analysis-work.js";
import { parseBatchCompletion, prepareBatchCompletion, type AnalysisBatchCompletion, type AnalysisBatchCompletionResult } from "./analysis-batch-completion.js";
import { canLaunchAnalysisRequest, parseAnalysisSend, type AnalysisSendCommand } from "./analysis-send.js";
import { analysisClosureDue, prepareAnalysisClosure, type AnalysisClosureCandidate, type AnalysisClosureResult } from "./analysis-closure.js";
import { AnalysisCountError, countRequestKey, parseCountCommand, parseCountRecord, prepareCountAccounting,
  type AnalysisCountCommand, type AnalysisCountResult, type AnalysisCountLaunchCommand } from "./analysis-count-accounting.js";
import { assertQuotaPermit, parseQuotaReceipt, prepareQuotaCharge, quotaCoverageStart, type AnalysisQuotaReceipt } from "./analysis-quota-charge.js";

const JSON_REPOSITORY_VERSION = 9 as const;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;

type JsonRepositoryState = {
  version: typeof JSON_REPOSITORY_VERSION;
  guides: Guide[];
  steps: GuideStep[];
  analysis: Array<{ guideId: string; state: AnalysisState }>;
  funding: AnalysisFundingLedger;
  privacyAssets: PrivacyAssetBatch[];
  publicationJobs: PublicationJob[];
  publications: GuidePublication[];
  publicationHeads: PublicationHead[];
  privateCleanup: PrivateCleanup[];
};

export type ProcessorDatabase = NodePgDatabase<typeof processorSchema>;
type ProcessorTransaction = Parameters<Parameters<ProcessorDatabase["transaction"]>[0]>[0];

export type RepositoryFactoryOptions = {
  databaseUrl?: string | null;
  jsonFilePath?: string;
  pool?: Pool;
  poolConfig?: Omit<PoolConfig, "connectionString">;
};

export class RepositoryDataError extends Error {
  override name = "RepositoryDataError";
}

export class GuideNotFoundError extends Error {
  override name = "GuideNotFoundError";

  constructor(guideId: string) {
    super(`Guide ${guideId} was not found.`);
  }
}

function emptyJsonState(): JsonRepositoryState {
  return { version: JSON_REPOSITORY_VERSION, guides: [], steps: [], analysis: [], funding: emptyFundingLedger(), privacyAssets: [], publicationJobs: [], publications: [], publicationHeads: [], privateCleanup: [] };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validateFundingCommit(beforeCommit?: () => void): void {
  const result = beforeCommit?.();
  if (result !== undefined) {
    // Reject accidental async validators rather than commit before their checks.
    // Consume a rejected promise so its private error cannot escape via an unhandled rejection.
    void Promise.resolve(result).catch(() => undefined);
    throw new RepositoryDataError("Funding commit validation must be synchronous and return no value.");
  }
}

function normalizedLimit(limit = DEFAULT_LIST_LIMIT): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError("limit must be a positive integer.");
  }
  return Math.min(limit, MAX_LIST_LIMIT);
}

function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function optionalNonNegativeInteger(value: number | null | undefined, name: string) {
  if (value === undefined || value === null) return value;
  return requireNonNegativeInteger(value, name);
}


function optionalPositiveInteger(value: number | null | undefined, name: string) {
  if (value === undefined || value === null) return value;
  return requirePositiveInteger(value, name);
}

function normalizeIsoDate(value: string | undefined, name: string): string {
  if (value === undefined) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new TypeError(`${name} must be an ISO date.`);
  return parsed.toISOString();
}

function buildGuide(input: CreateGuideInput): Guide {
  const now = normalizeIsoDate(input.createdAt, "createdAt");
  const status = input.status ?? "uploading";
  if (!isGuideStatus(status)) throw new TypeError(`Unknown guide status: ${String(status)}`);
  return {
    id: input.id ? requireNonEmpty(input.id, "id") : randomUUID(),
    ownerId: input.ownerId ?? null,
    slug: requireNonEmpty(input.slug, "slug"),
    editTokenHash: hashEditToken(input.editToken),
    title: requireNonEmpty(input.title, "title"),
    status,
    statusMessage:
      input.statusMessage === undefined
        ? DEFAULT_GUIDE_STATUS_MESSAGES[status]
        : requireNonEmpty(input.statusMessage, "statusMessage"),
    progress: input.progress === undefined
      ? status === "ready" ? 100 : 0
      : normalizeProgress(input.progress),
    originalObjectKey: requireNonEmpty(input.originalObjectKey, "originalObjectKey"),
    sourceFilename: requireNonEmpty(input.sourceFilename, "sourceFilename"),
    sourceMimeType: requireNonEmpty(input.sourceMimeType, "sourceMimeType"),
    sourceSizeBytes: requireNonNegativeInteger(input.sourceSizeBytes, "sourceSizeBytes"),
    durationMs: null,
    sourceWidth: null,
    sourceHeight: null,
    displayWidth: null,
    displayHeight: null,
    rotationDegrees: null,
    errorCode: input.errorCode == null ? null : requireNonEmpty(input.errorCode, "errorCode"),
    errorMessage: input.errorMessage == null ? null : requireNonEmpty(input.errorMessage, "errorMessage"),
    processingAttemptId: null,
    processingAttemptCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function buildSteps(
  guideId: string,
  inputs: readonly CreateGuideStepInput[],
  now = new Date().toISOString(),
): GuideStep[] {
  const positions = new Set<number>();

  return inputs.map((input, index) => {
    const position = input.position ?? index;
    requireNonNegativeInteger(position, `steps[${index}].position`);
    if (positions.has(position)) throw new RangeError(`Duplicate step position ${position}.`);
    positions.add(position);

    const startMs = requireNonNegativeInteger(input.startMs, `steps[${index}].startMs`);
    const endMs = requireNonNegativeInteger(input.endMs, `steps[${index}].endMs`);
    if (endMs < startMs) {
      throw new RangeError(`steps[${index}].endMs must be greater than or equal to startMs.`);
    }

    const representativeTimestampMs = optionalNonNegativeInteger(
      input.representativeTimestampMs,
      `steps[${index}].representativeTimestampMs`,
    ) ?? null;
    if (
      representativeTimestampMs !== null &&
      (representativeTimestampMs < startMs || representativeTimestampMs > endMs)
    ) {
      throw new RangeError(
        `steps[${index}].representativeTimestampMs must be within the step interval.`,
      );
    }

    return {
      id: input.id ? requireNonEmpty(input.id, `steps[${index}].id`) : randomUUID(),
      guideId,
      position,
      shortLabel: requireNonEmpty(input.shortLabel, `steps[${index}].shortLabel`),
      instruction: requireNonEmpty(input.instruction, `steps[${index}].instruction`),
      startMs,
      endMs,
      representativeTimestampMs,
      representativeFrameKey:
        input.representativeFrameKey === undefined || input.representativeFrameKey === null
          ? null
          : requireNonEmpty(
              input.representativeFrameKey,
              `steps[${index}].representativeFrameKey`,
            ),
      thumbnailFrameKey:
        input.thumbnailFrameKey === undefined || input.thumbnailFrameKey === null
          ? null
          : requireNonEmpty(input.thumbnailFrameKey, `steps[${index}].thumbnailFrameKey`),
      frameWidth:
        optionalPositiveInteger(input.frameWidth, `steps[${index}].frameWidth`) ?? null,
      frameHeight:
        optionalPositiveInteger(input.frameHeight, `steps[${index}].frameHeight`) ?? null,
      elements: clone(input.elements ?? []),
      createdAt: now,
      updatedAt: now,
    };
  });
}

function applyStatusUpdate(
  guide: Guide,
  status: GuideStatus,
  update: GuideStatusUpdate | undefined,
): Guide {
  const next: Guide = {
    ...guide,
    status,
    statusMessage:
      update?.statusMessage === undefined
        ? DEFAULT_GUIDE_STATUS_MESSAGES[status]
        : requireNonEmpty(update.statusMessage, "statusMessage"),
    progress:
      update?.progress === undefined
        ? status === "ready"
          ? 100
          : guide.progress
        : normalizeProgress(update.progress),
    updatedAt: new Date().toISOString(),
  };

  const numericFields = [
    "durationMs",
    "sourceWidth",
    "sourceHeight",
    "displayWidth",
    "displayHeight",
    "rotationDegrees",
  ] as const;
  for (const field of numericFields) {
    if (update?.[field] !== undefined) {
      next[field] = optionalNonNegativeInteger(update[field], field) ?? null;
    }
  }

  if (update?.errorCode !== undefined) next.errorCode = update.errorCode;
  else if (status !== "failed") next.errorCode = null;
  if (update?.errorMessage !== undefined) next.errorMessage = update.errorMessage;
  else if (status !== "failed") next.errorMessage = null;

  if (status === "uploading" || status === "queued") {
    next.processingAttemptId = null;
  }

  return next;
}

function validateExpectedStatuses(statuses: readonly GuideStatus[] | undefined): void {
  if (statuses?.some((status) => !isGuideStatus(status))) {
    throw new TypeError("expectedStatuses contains an unknown guide status.");
  }
}

function validateExpectedAttempt(
  expectedAttemptId: string | null | undefined,
  expectedAttemptCount: number | undefined,
): void {
  if (expectedAttemptId !== undefined && expectedAttemptId !== null) {
    requireNonEmpty(expectedAttemptId, "expectedProcessingAttemptId");
  }
  if (expectedAttemptCount !== undefined) {
    requireNonNegativeInteger(expectedAttemptCount, "expectedProcessingAttemptCount");
  }
}

function matchesExpectedAttempt(
  guide: Guide,
  expectedAttemptId: string | null | undefined,
  expectedAttemptCount: number | undefined,
): boolean {
  return (
    (expectedAttemptId === undefined || guide.processingAttemptId === expectedAttemptId) &&
    (expectedAttemptCount === undefined || guide.processingAttemptCount === expectedAttemptCount)
  );
}

function validateUploadLease(
  leaseId: string,
  options: ClaimUploadLeaseOptions,
): { leaseId: string; expectedProcessingAttemptId: string | null; expectedUpdatedAt: string } {
  const normalizedUpdatedAt = normalizeIsoDate(options.expectedUpdatedAt, "expectedUpdatedAt");
  return {
    leaseId: requireNonEmpty(leaseId, "leaseId"),
    expectedProcessingAttemptId: options.expectedProcessingAttemptId === null
      ? null
      : requireNonEmpty(options.expectedProcessingAttemptId, "expectedProcessingAttemptId"),
    expectedUpdatedAt: normalizedUpdatedAt,
  };
}

function claimUploadLeaseFromSnapshot(
  guide: Guide,
  lease: ReturnType<typeof validateUploadLease>,
): Guide | null {
  if (
    guide.status !== "uploading" ||
    guide.processingAttemptId !== lease.expectedProcessingAttemptId ||
    guide.updatedAt !== lease.expectedUpdatedAt
  ) return null;
  return {
    ...guide,
    processingAttemptId: lease.leaseId,
    updatedAt: new Date().toISOString(),
  };
}

function matchesExpectedErrorCode(
  guide: Guide,
  expectedErrorCode: string | null | undefined,
): boolean {
  return expectedErrorCode === undefined || guide.errorCode === expectedErrorCode;
}

type ValidatedClaimOptions = {
  expectedStatuses: readonly GuideStatus[];
  expectedProcessingAttemptId: string | null | undefined;
  expectedProcessingAttemptCount: number | undefined;
  maxAttempts: number;
  progress: number;
  statusMessage: string;
  exhaustedStatusMessage: string;
  exhaustedErrorCode: string;
  exhaustedErrorMessage: string;
};

function validateClaimOptions(
  attemptId: string,
  options: ClaimProcessingAttemptOptions | undefined,
): ValidatedClaimOptions {
  requireNonEmpty(attemptId, "attemptId");
  validateExpectedStatuses(options?.expectedStatuses);
  validateExpectedAttempt(
    options?.expectedProcessingAttemptId,
    options?.expectedProcessingAttemptCount,
  );
  return {
    expectedStatuses: options?.expectedStatuses ?? ["queued"],
    expectedProcessingAttemptId: options?.expectedProcessingAttemptId,
    expectedProcessingAttemptCount: options?.expectedProcessingAttemptCount,
    maxAttempts: requirePositiveInteger(
      options?.maxAttempts ?? Number.MAX_SAFE_INTEGER,
      "maxAttempts",
    ),
    progress: normalizeProgress(options?.progress ?? 22),
    statusMessage:
      options?.statusMessage === undefined
        ? DEFAULT_GUIDE_STATUS_MESSAGES.probing
        : requireNonEmpty(options.statusMessage, "statusMessage"),
    exhaustedStatusMessage:
      options?.exhaustedStatusMessage === undefined
        ? DEFAULT_GUIDE_STATUS_MESSAGES.failed
        : requireNonEmpty(options.exhaustedStatusMessage, "exhaustedStatusMessage"),
    exhaustedErrorCode:
      options?.exhaustedErrorCode === undefined
        ? "PROCESSING_ATTEMPTS_EXHAUSTED"
        : requireNonEmpty(options.exhaustedErrorCode, "exhaustedErrorCode"),
    exhaustedErrorMessage:
      options?.exhaustedErrorMessage === undefined
        ? "영상 처리 시도 횟수를 초과했어요. 새 가이드를 만들어 주세요."
        : requireNonEmpty(options.exhaustedErrorMessage, "exhaustedErrorMessage"),
  };
}

function exhaustedGuide(guide: Guide, options: ValidatedClaimOptions): Guide {
  return {
    ...applyStatusUpdate(guide, "failed", {
      progress: 100,
      statusMessage: options.exhaustedStatusMessage,
      errorCode: options.exhaustedErrorCode,
      errorMessage: options.exhaustedErrorMessage,
    }),
    processingAttemptId: null,
  };
}

function claimedGuide(guide: Guide, attemptId: string, options: ValidatedClaimOptions): Guide {
  return {
    ...applyStatusUpdate(guide, "probing", {
      progress: options.progress,
      statusMessage: options.statusMessage,
      errorCode: null,
      errorMessage: null,
    }),
    processingAttemptId: attemptId,
    processingAttemptCount: guide.processingAttemptCount + 1,
  };
}

function parseJsonState(raw: string, filePath: string): JsonRepositoryState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RepositoryDataError(`Invalid JSON repository at ${filePath}: ${String(error)}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    ![1, 2, 3, 4, 5, 6, 7, 8, JSON_REPOSITORY_VERSION].includes((parsed as { version: number }).version) ||
    !Array.isArray((parsed as { guides?: unknown }).guides) ||
    !Array.isArray((parsed as { steps?: unknown }).steps)
  ) {
    throw new RepositoryDataError(`Unsupported JSON repository shape at ${filePath}.`);
  }

  const state = parsed as JsonRepositoryState;
  if ((state.version as number) < 6) {
    if (state.privacyAssets !== undefined) throw new RepositoryDataError("Invalid legacy asset state.");
    state.privacyAssets = [];
  }
  if (!Array.isArray(state.privacyAssets)) throw new RepositoryDataError("Missing private asset ledger.");
  state.privacyAssets = state.privacyAssets.map(batch => privacyAssetBatchSchema.parse(batch));
  if (new Set(state.privacyAssets.map(b => b.id)).size !== state.privacyAssets.length ||
      state.privacyAssets.some(b => !state.guides.some(g => g.id === b.guideId))) throw new RepositoryDataError("Orphaned private asset ledger.");
  if ((state.version as number) < 7) {
    if (state.publicationJobs !== undefined) throw new RepositoryDataError("Invalid legacy publication state.");
    state.publicationJobs = [];
  }
  if (!Array.isArray(state.publicationJobs)) throw new RepositoryDataError("Missing publication ledger.");
  state.publicationJobs = state.publicationJobs.map(job => publicationJobSchema.parse(job));
  if (new Set(state.publicationJobs.map(j => `${j.guideId}/${j.id}`)).size !== state.publicationJobs.length ||
      new Set(state.publicationJobs.map(j => j.batchId)).size !== state.publicationJobs.length ||
      state.publicationJobs.some(j => !state.guides.some(g => g.id === j.guideId))) throw new RepositoryDataError("Orphaned publication ledger.");
  if ((state.version as number) < 8) {
    if (state.publications !== undefined || state.publicationHeads !== undefined) throw new RepositoryDataError("Invalid legacy committed publications.");
    state.publications = []; state.publicationHeads = [];
  }
  if (!Array.isArray(state.publications) || !Array.isArray(state.publicationHeads)) throw new RepositoryDataError("Missing committed publication state.");
  state.publications = state.publications.map(p => guidePublicationSchema.parse(p));
  state.publicationHeads = state.publicationHeads.map(h => publicationHeadSchema.parse(h));
  if (new Set(state.publicationHeads.map(h => h.guideId)).size !== state.publicationHeads.length ||
    new Set(state.publicationHeads.map(h => h.publicSlug)).size !== state.publicationHeads.length ||
    new Set(state.publications.map(p => p.batchId)).size !== state.publications.length ||
    [...state.publicationHeads, ...state.publications].some(p => !state.guides.some(g => g.id === p.guideId)))
    throw new RepositoryDataError("Invalid committed publication identities.");
  for (const guide of state.guides) validatePublicationState({ head: state.publicationHeads.find(h => h.guideId === guide.id) ?? null,
    publications: state.publications.filter(p => p.guideId === guide.id) }, state.publicationJobs.filter(j => j.guideId === guide.id));
  if ((state.version as number) < 9) {
    if (state.privateCleanup !== undefined) throw new RepositoryDataError("Invalid legacy private cleanup state.");
    state.privateCleanup = [];
  }
  if (!Array.isArray(state.privateCleanup)) throw new RepositoryDataError("Missing private cleanup state.");
  state.privateCleanup = state.privateCleanup.map(row => privateCleanupSchema.parse(row));
  if (new Set(state.privateCleanup.map(r => r.id)).size !== state.privateCleanup.length ||
    new Set(state.privateCleanup.map(r => r.guideId)).size !== state.privateCleanup.length ||
    state.privateCleanup.some(r => !state.guides.some(g => g.id === r.guideId && g.status === "failed" &&
      [PRIVATE_MEDIA_EXPIRED, "DELETION_PENDING", "DELETION_PENDING_ACTIVE"].includes(g.errorCode ?? ""))))
    throw new RepositoryDataError("Orphaned private cleanup state.");
  const legacyVersion = (parsed as { version: number }).version === 1;
  const fundingV2 = (parsed as { version: number }).version === 2;
  const fundingV3 = (parsed as { version: number }).version === 3;
  // Older binaries must reject v5 rather than ignore completion/release accounting.
  if (legacyVersion) {
    if (state.funding !== undefined) throw new RepositoryDataError("Invalid legacy funding state.");
    state.funding = emptyFundingLedger();
  }
  if (fundingV2) state.funding = upgradeFundingLedgerV2(state.funding);
  if (fundingV3) state.funding = upgradeFundingLedgerV3(state.funding);
  if ((parsed as { version: number }).version === 4) state.funding = upgradeFundingLedgerV4(state.funding);
  state.version = JSON_REPOSITORY_VERSION;
  state.funding = parseFundingLedger(state.funding);
  // Additive upgrade of legacy analysis; never discard malformed state.
  if (legacyVersion && state.analysis === undefined) state.analysis = [];
  if (!Array.isArray(state.analysis) || state.analysis.some((entry) => !entry || typeof entry.guideId !== "string") ||
      new Set(state.analysis.map((entry) => entry.guideId)).size !== state.analysis.length) {
    throw new RepositoryDataError("Invalid persisted analysis state.");
  }
  state.analysis = state.analysis.map((entry) => {
    if (!state.guides.some((guide) => guide.id === entry.guideId)) throw new RepositoryDataError("Orphaned analysis state.");
    return { guideId: entry.guideId, state: parseAnalysisState(entry.state) };
  });
  for (const reservation of state.funding.reservations) {
    if (!reservation.details) continue;
    const analysis = state.analysis.find((entry) => entry.guideId === reservation.guideId)?.state;
    if (!analysis) throw new RepositoryDataError("Orphaned analysis reservation.");
    validateFundingAnalysis(analysis, reservation, state.funding.batches
      .filter((b) => b.guideId === reservation.guideId && b.runId === reservation.runId).sort((a, b) => a.index - b.index));
  }
  if (state.guides.some((guide) => !isGuideStatus(guide.status))) {
    throw new RepositoryDataError(`JSON repository at ${filePath} contains an invalid guide status.`);
  }
  state.guides = state.guides.map((guide) => {
    const attemptId = (guide as Partial<Guide>).processingAttemptId;
    const attemptCount = (guide as Partial<Guide>).processingAttemptCount;
    if (attemptId !== undefined && attemptId !== null && typeof attemptId !== "string") {
      throw new RepositoryDataError(
        `JSON repository at ${filePath} contains an invalid processing attempt id.`,
      );
    }
    if (
      attemptCount !== undefined &&
      (!Number.isSafeInteger(attemptCount) || (attemptCount as number) < 0)
    ) {
      throw new RepositoryDataError(
        `JSON repository at ${filePath} contains an invalid processing attempt count.`,
      );
    }
    return {
      ...guide,
      processingAttemptId: attemptId ?? null,
      processingAttemptCount: attemptCount ?? 0,
    };
  });
  return state;
}

export class JsonGuideRepository implements GuideRepository, PublicationJobRepository, PublicationRepository, PublicationLifecycleRepository {
  readonly filePath: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = path.resolve(requireNonEmpty(filePath, "filePath"));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readState(): Promise<JsonRepositoryState> {
    try {
      return parseJsonState(await readFile(this.filePath, "utf8"), this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyJsonState();
      throw error;
    }
  }

  private async writeState(state: JsonRepositoryState): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.filePath);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async getAnalysisState(guideId: string): Promise<AnalysisState | null> {
    return this.serialize(async () => {
      const state = await this.readState();
      if (!state.guides.some((guide) => guide.id === guideId)) return null;
      return clone(state.analysis.find((entry) => entry.guideId === guideId)?.state ?? emptyAnalysisState());
    });
  }

  async listPrivacyAssetBatches(guideId: string): Promise<PrivacyAssetBatch[]> {
    return this.serialize(async () => clone((await this.readState()).privacyAssets.filter(b => b.guideId === guideId)));
  }

  async expirePrivateDraft(guideId: string, raw: PrivateExpiry, now?: Date) {
    const command = privateExpirySchema.parse(raw), fixed = now === undefined ? undefined : publicationTime(now);
    return this.serialize(async () => {
      const state = await this.readState(), guide = state.guides.find(g => g.id === guideId);
      if (!guide) return null;
      const next = preparePrivateExpiry({ ...guide, steps: state.steps.filter(s => s.guideId === guideId) },
        state.analysis.find(a => a.guideId === guideId)?.state ?? emptyAnalysisState(), state.publicationHeads.find(h => h.guideId === guideId) ?? null,
        state.publicationJobs.filter(j => j.guideId === guideId), state.privacyAssets.filter(a => a.guideId === guideId), command, publicationTime(fixed), randomUUID());
      if (!next) return null;
      const { steps: _steps, ...updated } = next.guide;
      state.guides = state.guides.map(g => g.id === guideId ? updated : g);
      if (next.cleanup) {
        if (state.privateCleanup.some(r => r.guideId === guideId)) throw new RepositoryDataError("Private cleanup already exists.");
        state.privateCleanup.push(next.cleanup);
        state.steps = state.steps.filter(s => s.guideId !== guideId);
        state.analysis = state.analysis.filter(a => a.guideId !== guideId);
        state.funding.batches = state.funding.batches.filter(b => b.guideId !== guideId);
        state.funding.reservations = state.funding.reservations.map(r => r.guideId === guideId ? { ...r, details: null } : r);
        state.publicationJobs = state.publicationJobs.map(j => j.guideId === guideId ? next.jobs.find(n => n.id === j.id) ?? j : j);
        state.privacyAssets = state.privacyAssets.map(a => next.assets.find(n => n.id === a.id) ?? a);
      }
      await this.writeState(state); return clone(updated);
    });
  }

  async getPrivateCleanup(guideId: string) {
    return this.serialize(async () => clone((await this.readState()).privateCleanup.find(r => r.guideId === guideId) ?? null));
  }
  async listPrivateCleanup(raw: PrivateCleanupQuery) {
    const query = privateCleanupQuerySchema.parse(raw);
    return this.serialize(async () => clone((await this.readState()).privateCleanup.filter(r => !query.after || r.id > query.after)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, query.limit)));
  }
  async completePrivateCleanup(guideId: string, cleanupId: string) {
    return this.serialize(async () => {
      const state = await this.readState(), row = state.privateCleanup.find(r => r.guideId === guideId);
      if (!row) return true;
      if (row.id !== cleanupId) return false;
      state.privateCleanup = state.privateCleanup.filter(r => r.id !== cleanupId);
      await this.writeState(state); return true;
    });
  }
  async listExpiredRetainedGuides(limit?: number, now?: Date) {
    const safeLimit = normalizedLimit(limit), fixed = now === undefined ? undefined : publicationTime(now);
    return this.serialize(async () => {
      const state = await this.readState(), at = publicationTime(fixed);
      return clone(state.guides.filter(g => privateMediaExpired(g) &&
        !retainedPublicationLive(state.publicationHeads.find(h => h.guideId === g.id) ?? null, at))
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, safeLimit));
    });
  }

  async getPublicationJob(guideId: string, jobId: string): Promise<PublicationJob | null> {
    return this.serialize(async () => clone((await this.readState()).publicationJobs.find(j => j.guideId === guideId && j.id === jobId) ?? null));
  }

  async getPublicationOwnerStatus(guideId: string, jobId?: string, now?: Date) {
    if (jobId !== undefined) publicationCommitSchema.shape.id.parse(jobId);
    const fixed = now === undefined ? undefined : publicationTime(now);
    return this.serialize(async () => {
      const state = await this.readState(), guide = state.guides.find(g => g.id === guideId);
      if (!guide) return null;
      return clone(selectPublicationOwnerStatus({ ...guide, steps: [] }, {
        head: state.publicationHeads.find(h => h.guideId === guideId) ?? null, publications: state.publications.filter(p => p.guideId === guideId) },
      state.publicationJobs.filter(j => j.guideId === guideId), state.privacyAssets.filter(a => a.guideId === guideId), jobId, publicationTime(fixed)));
    });
  }

  async getPublicationState(guideId: string): Promise<PublicationState | null> {
    return this.serialize(async () => {
      const state = await this.readState();
      if (!state.guides.some(g => g.id === guideId)) return null;
      return clone({ head: state.publicationHeads.find(h => h.guideId === guideId) ?? null,
        publications: state.publications.filter(p => p.guideId === guideId) });
    });
  }

  async commitPublication(guideId: string, raw: PublicationCommit, now?: Date) {
    const command = publicationCommitSchema.parse(raw), fixed = now === undefined ? undefined : publicationTime(now);
    return this.serialize(async () => {
      const state = await this.readState(), guide = state.guides.find(g => g.id === guideId);
      if (!guide) return null;
      const next = preparePublicationCommit({ ...guide, steps: state.steps.filter(s => s.guideId === guideId) },
        state.analysis.find(a => a.guideId === guideId)?.state ?? emptyAnalysisState(), state.publicationJobs.filter(j => j.guideId === guideId),
        state.privacyAssets.filter(a => a.guideId === guideId), { head: state.publicationHeads.find(h => h.guideId === guideId) ?? null,
          publications: state.publications.filter(p => p.guideId === guideId) }, command, publicationTime(fixed), randomBytes(24).toString("base64url"));
      if (!next) return null;
      if (next.changed) {
        if (state.publicationHeads.some(h => h.guideId !== guideId && h.publicSlug === next.result.head.publicSlug))
          throw new RepositoryDataError("Publication identity conflict.");
        state.publications.push(next.result.publication);
        state.publicationHeads = [...state.publicationHeads.filter(h => h.guideId !== guideId), next.result.head];
        state.publicationJobs = state.publicationJobs.map(j => j.guideId === guideId && j.id === next.job.id ? next.job : j);
        if (next.oldAsset) state.privacyAssets = state.privacyAssets.map(a => a.id === next.oldAsset!.id ? next.oldAsset! : a);
        await this.writeState(state);
      }
      return clone(next.result);
    });
  }

  async stopPublication(guideId: string, raw: PublicationStop, now?: Date) {
    const command = publicationStopSchema.parse(raw), fixed = now === undefined ? undefined : publicationTime(now);
    return this.serialize(async () => {
      const state = await this.readState(), guide = state.guides.find(g => g.id === guideId);
      if (!guide) return null;
      const next = preparePublicationStop({ ...guide, steps: [] }, {
        head: state.publicationHeads.find(h => h.guideId === guideId) ?? null,
        publications: state.publications.filter(p => p.guideId === guideId),
      }, state.publicationJobs.filter(j => j.guideId === guideId), state.privacyAssets.filter(a => a.guideId === guideId), command, publicationTime(fixed));
      if (!next) return null;
      if (next.result.changed) {
        if (next.result.head) state.publicationHeads = state.publicationHeads.map(h => h.guideId === guideId ? next.result.head! : h);
        state.publicationJobs = state.publicationJobs.map(j => j.guideId === guideId ? next.jobs.find(n => n.id === j.id) ?? j : j);
        state.privacyAssets = state.privacyAssets.map(a => next.assets.find(n => n.id === a.id) ?? a);
        await this.writeState(state);
      }
      return clone(next.result);
    });
  }

  async getAccessiblePublication(raw: PublicationAccess, now?: Date) {
    const query = publicationAccessSchema.parse(raw), fixed = now === undefined ? undefined : publicationTime(now);
    return this.serialize(async () => {
      const state = await this.readState(), head = state.publicationHeads.find(h => h.publicSlug === query.slug);
      const guide = head && state.guides.find(g => g.id === head.guideId);
      if (!head || !guide) return null;
      return clone(selectAccessiblePublication({ ...guide, steps: [] }, { head,
        publications: state.publications.filter(p => p.guideId === guide.id) }, state.privacyAssets.filter(a => a.guideId === guide.id), query, publicationTime(fixed)));
    });
  }

  async listExpiredPublications(raw: PublicationExpiryQuery, now?: Date) {
    const query = publicationExpiryQuerySchema.parse(raw), fixed = now === undefined ? undefined : publicationTime(now);
    return this.serialize(async () => {
      const state = await this.readState(), at = publicationTime(fixed);
      return state.publicationHeads.filter(h => (!query.after || comparePublicationExpiry(h, query.after) > 0) &&
        publicationExpiryCandidate(h, state.publicationJobs, at)).sort(comparePublicationExpiry).slice(0, query.limit)
        .map(({ guideId, version, expiresAt, publicSlug }) => ({ guideId, version, expiresAt, publicSlug }));
    });
  }

  async listPublicationWork(limit = 20, now?: Date) {
    limit = publicationWorkLimit(limit); const fixed = now === undefined ? undefined : publicationTime(now);
    return this.serialize(async () => {
      const at = publicationTime(fixed), state = await this.readState();
      return state.publicationJobs.filter(j => {
        const available = publicationAvailableAt(j); return available !== null && Date.parse(available) <= at.getTime();
      }).sort((a, b) => publicationAvailableAt(a)!.localeCompare(publicationAvailableAt(b)!) ||
        a.guideId.localeCompare(b.guideId) || a.id.localeCompare(b.id))
        .slice(0, limit).map(({ guideId, id, version }) => ({ guideId, id, version }));
    });
  }

  async executePublicationCommand(guideId: string, command: PublicationCommand, now?: Date): Promise<PublicationJob | null> {
    command = publicationCommandSchema.parse(command);
    const fixed = now === undefined ? undefined : publicationTime(now);
    return this.serialize(async () => {
      const state = await this.readState(), guide = state.guides.find(g => g.id === guideId);
      if (!guide) return null;
      const at = publicationTime(fixed);
      if (!publicationPreparationAllowed(state.publicationHeads.find(h => h.guideId === guideId) ?? null,
        state.publicationJobs.filter(j => j.guideId === guideId), command, at)) return null;
      const next = transitionPublicationJob({ ...guide, steps: state.steps.filter(s => s.guideId === guideId) },
        state.analysis.find(e => e.guideId === guideId)?.state ?? emptyAnalysisState(),
        state.publicationJobs.filter(j => j.guideId === guideId), state.privacyAssets.filter(b => b.guideId === guideId),
        command, at, randomUUID());
      if (!next) return null;
      if (next.changed) {
        state.publicationJobs = state.publicationJobs.filter(j => j.guideId !== guideId || j.id !== next.job.id);
        state.publicationJobs.push(next.job);
        if (next.asset) {
          state.privacyAssets = state.privacyAssets.filter(b => b.id !== next.asset!.id);
          state.privacyAssets.push(next.asset);
        }
        await this.writeState(state);
      }
      return clone(next.job);
    });
  }

  async listPublicationRecovery(raw: PublicationRecoveryQuery, now?: Date) {
    const query = publicationRecoveryQuerySchema.parse(raw), fixed = now === undefined ? undefined : publicationTime(now);
    return this.serialize(async () => {
      const at = publicationTime(fixed), state = await this.readState();
      return state.publicationJobs.filter(j => (!query.after || j.batchId > query.after) && (query.kind === "queued" ? j.status === "queued" : query.kind === "expired"
        ? j.status === "running" && Date.parse(j.leaseExpiresAt!) <= at.getTime()
        : state.privacyAssets.some(b => b.guideId === j.guideId && b.id === j.batchId &&
          (["failed", "cancelled"].includes(j.status) || (j.status === "succeeded" && b.status === "cleanup")))))
        .sort((a, b) => a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0).slice(0, query.limit)
        .map(({ guideId, id, version, batchId }) => ({ guideId, id, version, batchId }));
    });
  }

  async executePrivacyAssetCommand(guideId: string, command: PrivacyAssetCommand): Promise<PrivacyAssetBatch | null> {
    command = structuredClone(command);
    return this.serialize(async () => {
      const state = await this.readState(), guide = state.guides.find(g => g.id === guideId);
      if (!guide) return null;
      const existing = state.privacyAssets.find(b => b.id === command.id);
      if (existing && existing.guideId !== guideId) return null;
      if (publicationProtectsAsset({ ...guide, steps: [] }, { head: state.publicationHeads.find(h => h.guideId === guideId) ?? null,
        publications: state.publications.filter(p => p.guideId === guideId) }, command.id)) return null;
      if (command.type === "reserve" && state.privacyAssets.filter(b => b.guideId === guideId).length >= 4) return null;
      const next = transitionPrivacyAsset({ ...guide, steps: state.steps.filter(s => s.guideId === guideId) },
        state.analysis.find(e => e.guideId === guideId)?.state ?? emptyAnalysisState(), existing, command, new Date());
      if (!next) return null;
      state.privacyAssets = state.privacyAssets.filter(b => b.id !== command.id);
      if (!next.remove) state.privacyAssets.push(next.batch);
      await this.writeState(state); return clone(next.batch);
    });
  }

  async executeAnalysisCommand(guideId: string, command: AnalysisCommand): Promise<AnalysisState | null> {
    return this.serialize(async () => {
      const state = await this.readState();
      const guide = state.guides.find((candidate) => candidate.id === guideId);
      if (!guide) return null;
      const previous = state.analysis.find((entry) => entry.guideId === guideId)?.state ?? emptyAnalysisState();
      // Budgeted runs cannot use the legacy unmetered runner before B4 exists.
      if (["claim", "finish", "fail"].includes(command.type) && "runId" in command &&
          state.funding.reservations.some((r) => r.guideId === guideId && r.runId === command.runId)) return null;
      const next = transitionAnalysis({ ...guide, steps: state.steps.filter((step) => step.guideId === guideId) }, previous, command);
      if (!next) return null;
      const validated = parseAnalysisState(next);
      state.analysis = [...state.analysis.filter((entry) => entry.guideId !== guideId), { guideId, state: validated }];
      // Commit the retention fence with the draft, never on reads/conflicts/replays.
      if ((command.type === "save-editor-draft" || command.type === "review-privacy") && validated.draft &&
          validated.draft.revision !== previous.draft?.revision) {
        guide.updatedAt = validated.draft.updatedAt;
      }
      await this.writeState(state);
      return clone(validated);
    });
  }

  async reserveAnalysisRequest(guideId: string, command: AnalysisFundingCommand, policy: AnalysisFundingPolicy, now = new Date(), beforeCommit?: () => void): Promise<AnalysisFundingResult | null> {
    command = parseFundingCommand(command);
    policy = parseFundingPolicy(policy);
    fundingDay(now);
    now = new Date(now.valueOf());
    return this.serialize(async () => {
      const state = await this.readState();
      const guide = state.guides.find((candidate) => candidate.id === guideId);
      if (!guide) return null;
      const prepared = prepareFundedAnalysis({ guide: { ...guide, steps: state.steps.filter((step) => step.guideId === guideId) },
        previous: state.analysis.find((entry) => entry.guideId === guideId)?.state ?? emptyAnalysisState(), command, policy, now,
        existing: state.funding.reservations.find((r) => r.guideId === guideId && r.runId === command.runId) ?? null,
        batches: state.funding.batches.filter((b) => b.guideId === guideId && b.runId === command.runId).sort((a, b) => a.index - b.index),
        windows: state.funding.windows, halted: state.funding.control.halted });
      if (!prepared) return null;
      const { windows, ...result } = prepared;
      if (result.replayed) return clone(result);
      validateFundingCommit(beforeCommit);
      state.analysis = [...state.analysis.filter((entry) => entry.guideId !== guideId), { guideId, state: result.analysis }];
      for (const window of windows) state.funding.windows = [...state.funding.windows.filter((w) => w.day !== window.day || w.scope !== window.scope), window];
      state.funding.reservations.push(result.reservation);
      state.funding.batches.push(...result.batches);
      state.funding = parseFundingLedger(state.funding);
      // One fsync + atomic rename for the draft, run, batches and all windows.
      await this.writeState(state);
      return clone(result);
    });
  }

  async getAnalysisFunding(guideId: string, runId: string) {
    return this.serialize(async () => {
      const state = await this.readState();
      if (!state.guides.some((guide) => guide.id === guideId)) return null;
      const reservation = state.funding.reservations.find((r) => r.guideId === guideId && r.runId === runId);
      return reservation?.details ? clone({ reservation,
        batches: state.funding.batches.filter((b) => b.guideId === guideId && b.runId === runId).sort((a, b) => a.index - b.index) }) : null;
    });
  }

  async getAnalysisBudgetWindow(day: string, scope: string) {
    fundingWindowIdentity(day, scope);
    return this.serialize(async () => clone((await this.readState()).funding.windows.find((w) => w.day === day && w.scope === scope) ?? null));
  }

  async executeAnalysisAccounting(guideId: string, command: AnalysisAccountingCommand, now?: Date, beforeCommit?: () => void): Promise<AnalysisAccountingResult | null> {
    command = parseAccountingCommand(command);
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.serialize(async () => {
      const state = await this.readState();
      const guide = state.guides.find((g) => g.id === guideId);
      const reservation = state.funding.reservations.find((r) => r.guideId === guideId && r.runId === command.runId);
      if (!guide || !reservation?.details) return null;
      const prepared = prepareAnalysisAccounting({ guide: { ...guide, steps: state.steps.filter((s) => s.guideId === guideId) },
        analysis: state.analysis.find((a) => a.guideId === guideId)?.state ?? emptyAnalysisState(), reservation,
        attempts: state.funding.attempts.filter((a) => a.guideId === guideId && a.runId === command.runId),
        batches: state.funding.batches.filter((b) => b.guideId === guideId && b.runId === command.runId).sort((a, b) => a.index - b.index),
        windows: state.funding.windows, control: state.funding.control, command, now: workTime(fixedTime) });
      if (!prepared) return null;
      const { windows, control, ...result } = prepared;
      if (result.replayed) return clone(result);
      validateFundingCommit(beforeCommit);
      state.funding.control = control;
      state.funding.attempts = [...state.funding.attempts.filter((a) => !(a.guideId === guideId && a.runId === command.runId &&
        a.batchIndex === command.batchIndex && a.ordinal === command.ordinal)), result.attempt];
      for (const window of windows) state.funding.windows = [...state.funding.windows.filter((w) => w.day !== window.day || w.scope !== window.scope), window];
      state.funding = parseFundingLedger(state.funding);
      await this.writeState(state);
      return clone(result);
    });
  }

  async getAnalysisRequestAttempts(guideId: string, runId: string) {
    return this.serialize(async () => {
      const state = await this.readState();
      if (!state.guides.some((g) => g.id === guideId) || !state.funding.reservations.some((r) => r.guideId === guideId && r.runId === runId && r.details)) return null;
      return clone(state.funding.attempts.filter((a) => a.guideId === guideId && a.runId === runId)
        .sort((a, b) => a.batchIndex - b.batchIndex || a.ordinal - b.ordinal));
    });
  }

  async getAnalysisAccountingControl() { return this.serialize(async () => clone((await this.readState()).funding.control)); }

  async listAnalysisClosures(limit = 20, now?: Date): Promise<AnalysisClosureCandidate[]> {
    limit = workLimit(limit);
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.serialize(async () => {
      const state = await this.readState(); const at = workTime(fixedTime);
      return state.funding.reservations.filter((r) => analysisClosureDue(r,
        state.analysis.find((a) => a.guideId === r.guideId)?.state.runs.find((run) => run.id === r.runId), at))
        .sort((a, b) => a.day.localeCompare(b.day) || a.guideId.localeCompare(b.guideId) || a.runId.localeCompare(b.runId))
        .slice(0, limit).map(({ guideId, runId }) => ({ guideId, runId }));
    });
  }

  async closeAnalysisReservation(guideId: string, runId: string, now?: Date, beforeCommit?: () => void): Promise<AnalysisClosureResult | null> {
    requireNonEmpty(guideId, "guideId"); requireNonEmpty(runId, "runId");
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.serialize(async () => {
      const state = await this.readState();
      const reservation = state.funding.reservations.find((r) => r.guideId === guideId && r.runId === runId);
      if (!reservation) return null;
      const prepared = prepareAnalysisClosure({ reservation,
        analysis: reservation.details ? state.analysis.find((a) => a.guideId === guideId)?.state ?? null : null,
        batches: state.funding.batches.filter((b) => b.guideId === guideId && b.runId === runId).sort((a, b) => a.index - b.index),
        attempts: state.funding.attempts.filter((a) => a.guideId === guideId && a.runId === runId),
        windows: state.funding.windows, now: workTime(fixedTime) });
      if (!prepared) return null;
      const result = { reservation: prepared.reservation, replayed: prepared.replayed };
      if (prepared.replayed) return clone(result);
      validateFundingCommit(beforeCommit);
      if (prepared.analysis) state.analysis = state.analysis.map((a) => a.guideId === guideId ? { guideId, state: prepared.analysis! } : a);
      state.funding.reservations = state.funding.reservations.map((r) => r === reservation ? prepared.reservation : r);
      state.funding.attempts = [...state.funding.attempts.filter((a) => a.guideId !== guideId || a.runId !== runId), ...prepared.attempts];
      for (const window of prepared.windows) state.funding.windows = state.funding.windows.map((w) => w.day === window.day && w.scope === window.scope ? window : w);
      state.funding = parseFundingLedger(state.funding);
      await this.writeState(state);
      return clone(result);
    });
  }

  async launchAnalysisRequest(guideId: string, command: AnalysisSendCommand, launch: (lockedClock: () => Date) => void, now?: Date, beforeLaunch?: (lockedAt: Date) => void): Promise<boolean> {
    command = parseAnalysisSend(command);
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.serialize(async () => {
      const state = await this.readState();
      const guide = state.guides.find((g) => g.id === guideId);
      const reservation = state.funding.reservations.find((r) => r.guideId === guideId && r.runId === command.runId);
      if (!guide || !reservation?.details) return false;
      const lockedAt = workTime(fixedTime);
      if (!canLaunchAnalysisRequest({ guide: { ...guide, steps: state.steps.filter((s) => s.guideId === guideId) },
        analysis: state.analysis.find((a) => a.guideId === guideId)?.state ?? emptyAnalysisState(), reservation,
        batches: state.funding.batches.filter((b) => b.guideId === guideId && b.runId === command.runId).sort((a, b) => a.index - b.index),
        attempts: state.funding.attempts.filter((a) => a.guideId === guideId && a.runId === command.runId),
        halted: state.funding.control.halted, command, now: lockedAt })) return false;
      validateFundingCommit(() => beforeLaunch?.(lockedAt));
      validateFundingCommit(() => launch(() => workTime(fixedTime))); // synchronous invocation while cancellation/deletion is excluded
      return true;
    });
  }

  async failAnalysisWork(guideId: string, command: AnalysisWorkFailure, now?: Date, beforeCommit?: () => void): Promise<AnalysisState | null> {
    command = parseWorkFailure(command);
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.serialize(async () => {
      const state = await this.readState();
      const guide = state.guides.find((g) => g.id === guideId);
      const reservation = state.funding.reservations.find((r) => r.guideId === guideId && r.runId === command.runId);
      if (!guide || !reservation?.details) return null;
      const prepared = prepareAnalysisWorkFailure({ guide: { ...guide, steps: state.steps.filter((s) => s.guideId === guideId) },
        analysis: state.analysis.find((a) => a.guideId === guideId)?.state ?? emptyAnalysisState(), reservation,
        batches: state.funding.batches.filter((b) => b.guideId === guideId && b.runId === command.runId).sort((a, b) => a.index - b.index),
        attempts: state.funding.attempts.filter((a) => a.guideId === guideId && a.runId === command.runId), command, now: workTime(fixedTime) });
      if (!prepared) return null;
      validateFundingCommit(beforeCommit);
      state.analysis = [...state.analysis.filter((a) => a.guideId !== guideId), { guideId, state: prepared.analysis }];
      state.funding.attempts = [...state.funding.attempts.filter((a) => a.guideId !== guideId || a.runId !== command.runId), ...prepared.attempts];
      state.funding = parseFundingLedger(state.funding);
      await this.writeState(state);
      return clone(prepared.analysis);
    });
  }

  async completeAnalysisBatch(guideId: string, command: AnalysisBatchCompletion, now?: Date, beforeCommit?: () => void): Promise<AnalysisBatchCompletionResult | null> {
    command = parseBatchCompletion(command);
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.serialize(async () => {
      const state = await this.readState();
      const guide = state.guides.find((g) => g.id === guideId);
      const reservation = state.funding.reservations.find((r) => r.guideId === guideId && r.runId === command.runId);
      if (!guide || !reservation?.details) return null;
      const prepared = prepareBatchCompletion({ guide: { ...guide, steps: state.steps.filter((s) => s.guideId === guideId) },
        analysis: state.analysis.find((a) => a.guideId === guideId)?.state ?? emptyAnalysisState(), reservation,
        batches: state.funding.batches.filter((b) => b.guideId === guideId && b.runId === command.runId).sort((a, b) => a.index - b.index),
        attempts: state.funding.attempts.filter((a) => a.guideId === guideId && a.runId === command.runId),
        windows: state.funding.windows, control: state.funding.control, command, now: workTime(fixedTime) });
      if (!prepared) return null;
      if (prepared.result.replayed) return clone(prepared.result);
      validateFundingCommit(beforeCommit);
      state.analysis = [...state.analysis.filter((a) => a.guideId !== guideId), { guideId, state: prepared.result.analysis }];
      state.funding.batches = state.funding.batches.map((b) => b.guideId === guideId && b.runId === command.runId
        ? prepared.batches.find((next) => next.index === b.index)! : b);
      const { attempt, windows, control } = prepared.accounting;
      state.funding.attempts = [...state.funding.attempts.filter((a) => !(a.guideId === guideId && a.runId === command.runId &&
        a.batchIndex === attempt.batchIndex && a.ordinal === attempt.ordinal)), attempt];
      for (const window of windows) state.funding.windows = state.funding.windows.map((w) => w.day === window.day && w.scope === window.scope ? window : w);
      state.funding.control = control;
      state.funding = parseFundingLedger(state.funding);
      await this.writeState(state);
      return clone(prepared.result);
    });
  }

  async listAnalysisWork(limit = 20, now?: Date, after?: AnalysisWorkCursor): Promise<AnalysisWorkCandidate[]> {
    limit = workLimit(limit);
    after = parseWorkCursor(after);
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.serialize(async () => {
      const state = await this.readState();
      const at = workTime(fixedTime);
      return state.analysis.flatMap(({ guideId, state: analysis }) => analysis.runs.map((run) => ({ guideId, run })))
        .filter(({ guideId, run }) => {
          const available = workAvailableAt(run);
          return available !== null && Date.parse(available) <= at.valueOf() &&
            (!after || compareWorkCursor({ availableAt: available, createdAt: run.createdAt, guideId, runId: run.id }, after) > 0) &&
            state.guides.some((g) => g.id === guideId && g.status === "ready" && g.errorCode === null) &&
            state.funding.reservations.some((r) => r.guideId === guideId && r.runId === run.id && r.details);
        })
        .sort((a, b) => Date.parse(workAvailableAt(a.run)!) - Date.parse(workAvailableAt(b.run)!) ||
          Date.parse(a.run.createdAt) - Date.parse(b.run.createdAt) || a.guideId.localeCompare(b.guideId) || a.run.id.localeCompare(b.run.id))
        .slice(0, limit).map(({ guideId, run }) => ({ guideId, runId: run.id, expectedAttemptCount: run.attemptCount }));
    });
  }

  async claimAnalysisWork(guideId: string, command: AnalysisWorkClaim, now?: Date, beforeCommit?: () => void): Promise<AnalysisWorkResult | null> {
    command = parseWorkClaim(command);
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.serialize(async () => {
      const state = await this.readState();
      const guide = state.guides.find((g) => g.id === guideId);
      const reservation = state.funding.reservations.find((r) => r.guideId === guideId && r.runId === command.runId);
      if (!guide || !reservation?.details) return null;
      const at = workTime(fixedTime);
      const occupied = state.analysis.some((a) => a.state.runs.some((run) => run.status === "running" &&
        run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) > at.valueOf() &&
        state.funding.reservations.some((r) => r.guideId === a.guideId && r.runId === run.id && r.details)));
      const prepared = prepareAnalysisWorkClaim({ guide: { ...guide, steps: state.steps.filter((s) => s.guideId === guideId) },
        analysis: state.analysis.find((a) => a.guideId === guideId)?.state ?? emptyAnalysisState(), reservation,
        batches: state.funding.batches.filter((b) => b.guideId === guideId && b.runId === command.runId).sort((a, b) => a.index - b.index),
        attempts: state.funding.attempts.filter((a) => a.guideId === guideId && a.runId === command.runId),
        occupied, halted: state.funding.control.halted, command, now: at });
      if (!prepared) return null;
      if (prepared.result.replayed) return clone(prepared.result);
      validateFundingCommit(beforeCommit);
      state.analysis = [...state.analysis.filter((a) => a.guideId !== guideId), { guideId, state: prepared.analysis }];
      state.funding.attempts = [...state.funding.attempts.filter((a) => a.guideId !== guideId || a.runId !== command.runId), ...prepared.attempts];
      state.funding = parseFundingLedger(state.funding);
      await this.writeState(state);
      return clone(prepared.result);
    });
  }

  async createGuide(input: CreateGuideInput): Promise<Guide> {
    return this.serialize(async () => {
      const state = await this.readState();
      const guide = buildGuide(input);
      if (state.guides.some((candidate) => candidate.id === guide.id)) {
        throw new RepositoryDataError(`Guide id ${guide.id} already exists.`);
      }
      if (state.guides.some((candidate) => candidate.slug === guide.slug)) {
        throw new RepositoryDataError(`Guide slug ${guide.slug} already exists.`);
      }
      state.guides.push(guide);
      await this.writeState(state);
      return clone(guide);
    });
  }

  async getGuideById(id: string): Promise<GuideWithSteps | null> {
    return this.serialize(async () => {
      const state = await this.readState();
      const guide = state.guides.find((candidate) => candidate.id === id);
      if (!guide) return null;
      return clone({
        ...guide,
        steps: state.steps
          .filter((step) => step.guideId === id)
          .sort((left, right) => left.position - right.position),
      });
    });
  }

  async getGuideBySlug(slug: string): Promise<GuideWithSteps | null> {
    return this.serialize(async () => {
      const state = await this.readState();
      const guide = state.guides.find((candidate) => candidate.slug === slug);
      if (!guide) return null;
      return clone({
        ...guide,
        steps: state.steps
          .filter((step) => step.guideId === guide.id)
          .sort((left, right) => left.position - right.position),
      });
    });
  }

  async verifyEditToken(guideId: string, token: string): Promise<boolean> {
    return this.serialize(async () => {
      const state = await this.readState();
      const guide = state.guides.find((candidate) => candidate.id === guideId);
      return guide ? verifyEditTokenHash(token, guide.editTokenHash) : false;
    });
  }

  async updateStatus(
    guideId: string,
    status: GuideStatus,
    update?: GuideStatusUpdate,
  ): Promise<Guide | null> {
    if (!isGuideStatus(status)) throw new TypeError(`Unknown guide status: ${String(status)}`);
    validateExpectedStatuses(update?.expectedStatuses);
    validateExpectedAttempt(
      update?.expectedProcessingAttemptId,
      update?.expectedProcessingAttemptCount,
    );
    return this.serialize(async () => {
      const state = await this.readState();
      const index = state.guides.findIndex((candidate) => candidate.id === guideId);
      if (index < 0) return null;
      const current = state.guides[index];
      if (privateMediaExpired(current) && !(status === "failed" && ["DELETION_PENDING", "DELETION_PENDING_ACTIVE"].includes(update?.errorCode ?? ""))) return null;
      if (update?.expectedStatuses && !update.expectedStatuses.includes(current.status)) return null;
      if (
        !matchesExpectedAttempt(
          current,
          update?.expectedProcessingAttemptId,
          update?.expectedProcessingAttemptCount,
        )
      ) return null;
      if (!matchesExpectedErrorCode(current, update?.expectedErrorCode)) return null;
      if (update?.expectedUpdatedAt !== undefined && current.updatedAt !== update.expectedUpdatedAt) return null;

      const next = applyStatusUpdate(current, status, update);
      state.guides[index] = next;
      await this.writeState(state);
      return clone(next);
    });
  }

  async claimUploadLease(
    guideId: string,
    leaseId: string,
    options: ClaimUploadLeaseOptions,
  ): Promise<Guide | null> {
    const lease = validateUploadLease(leaseId, options);
    return this.serialize(async () => {
      const state = await this.readState();
      const index = state.guides.findIndex((candidate) => candidate.id === guideId);
      if (index < 0) return null;
      const claimed = claimUploadLeaseFromSnapshot(state.guides[index], lease);
      if (!claimed) return null;
      state.guides[index] = claimed;
      await this.writeState(state);
      return clone(claimed);
    });
  }

  async renewUploadLease(guideId: string, leaseId: string): Promise<Guide | null> {
    requireNonEmpty(leaseId, "leaseId");
    return this.serialize(async () => {
      const state = await this.readState();
      const index = state.guides.findIndex((candidate) => candidate.id === guideId);
      if (index < 0) return null;
      const current = state.guides[index];
      if (current.status !== "uploading" || current.processingAttemptId !== leaseId) return null;
      const renewed = { ...current, updatedAt: new Date().toISOString() };
      state.guides[index] = renewed;
      await this.writeState(state);
      return clone(renewed);
    });
  }

  async claimProcessingAttempt(
    guideId: string,
    attemptId: string,
    rawOptions?: ClaimProcessingAttemptOptions,
  ): Promise<Guide | null> {
    const options = validateClaimOptions(attemptId, rawOptions);
    if (options.expectedStatuses.length === 0) return null;

    return this.serialize(async () => {
      const state = await this.readState();
      const index = state.guides.findIndex((candidate) => candidate.id === guideId);
      if (index < 0) return null;
      const current = state.guides[index];
      if (privateMediaExpired(current) || !options.expectedStatuses.includes(current.status)) return null;
      if (
        !matchesExpectedAttempt(
          current,
          options.expectedProcessingAttemptId,
          options.expectedProcessingAttemptCount,
        )
      ) return null;

      const next = current.processingAttemptCount >= options.maxAttempts
        ? exhaustedGuide(current, options)
        : claimedGuide(current, attemptId, options);
      state.guides[index] = next;
      await this.writeState(state);
      return clone(next);
    });
  }

  async completeProcessingAttempt(
    guideId: string,
    input: CompleteProcessingAttemptInput,
  ): Promise<GuideWithSteps | null> {
    const attemptId = requireNonEmpty(input.attemptId, "attemptId");
    const attemptCount = requirePositiveInteger(input.attemptCount, "attemptCount");
    const now = new Date().toISOString();
    const nextSteps = buildSteps(guideId, input.steps, now);

    return this.serialize(async () => {
      const state = await this.readState();
      const guideIndex = state.guides.findIndex((guide) => guide.id === guideId);
      if (guideIndex < 0) return null;
      const current = state.guides[guideIndex];
      if (
        current.status !== "extracting" ||
        current.processingAttemptId !== attemptId ||
        current.processingAttemptCount !== attemptCount
      ) return null;

      const nextGuide = applyStatusUpdate(current, "ready", {
        progress: 100,
        statusMessage: input.statusMessage,
      });
      state.steps = [
        ...state.steps.filter((step) => step.guideId !== guideId),
        ...nextSteps,
      ];
      state.guides[guideIndex] = nextGuide;
      await this.writeState(state);
      return clone({
        ...nextGuide,
        steps: [...nextSteps].sort((left, right) => left.position - right.position),
      });
    });
  }

  async deleteGuide(guideId: string, options?: DeleteGuideOptions): Promise<boolean> {
    validateExpectedStatuses(options?.expectedStatuses);
    validateExpectedAttempt(
      options?.expectedProcessingAttemptId,
      options?.expectedProcessingAttemptCount,
    );
    return this.serialize(async () => {
      const state = await this.readState();
      const guide = state.guides.find((candidate) => candidate.id === guideId);
      if (!guide) return false;
      if (options?.expectedStatuses && !options.expectedStatuses.includes(guide.status)) return false;
      if (!matchesExpectedAttempt(
        guide,
        options?.expectedProcessingAttemptId,
        options?.expectedProcessingAttemptCount,
      )) return false;
      if (!matchesExpectedErrorCode(guide, options?.expectedErrorCode)) return false;
      if (options?.expectedUpdatedAt !== undefined && guide.updatedAt !== options.expectedUpdatedAt) return false;

      if (state.privacyAssets.some(b => b.guideId === guideId) || state.privateCleanup.some(r => r.guideId === guideId)) return false;
      state.guides = state.guides.filter((candidate) => candidate.id !== guideId);
      state.steps = state.steps.filter((step) => step.guideId !== guideId);
      state.analysis = state.analysis.filter((entry) => entry.guideId !== guideId);
      state.publicationJobs = state.publicationJobs.filter(job => job.guideId !== guideId);
      state.publications = state.publications.filter(p => p.guideId !== guideId);
      state.publicationHeads = state.publicationHeads.filter(h => h.guideId !== guideId);
      state.funding.batches = state.funding.batches.filter((entry) => entry.guideId !== guideId);
      state.funding.reservations = state.funding.reservations.map((entry) => entry.guideId === guideId ? { ...entry, details: null } : entry);
      await this.writeState(state);
      return true;
    });
  }

  async listByStatuses(statuses: readonly GuideStatus[], limit?: number): Promise<Guide[]> {
    const safeLimit = normalizedLimit(limit);
    if (statuses.length === 0) return [];
    if (statuses.some((status) => !isGuideStatus(status))) {
      throw new TypeError("statuses contains an unknown guide status.");
    }
    return this.serialize(async () => {
      const wanted = new Set(statuses);
      const state = await this.readState();
      return clone(
        state.guides
          .filter((guide) => wanted.has(guide.status))
          .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
          .slice(0, safeLimit),
      );
    });
  }

  async listFailedByErrorCodes(errorCodes: readonly string[], limit?: number): Promise<Guide[]> {
    const safeLimit = normalizedLimit(limit);
    if (errorCodes.length === 0) return [];
    const wanted = new Set(errorCodes.map((code) => requireNonEmpty(code, "errorCode")));
    return this.serialize(async () => {
      const state = await this.readState();
      return clone(
        state.guides
          .filter((guide) => guide.status === "failed" && guide.errorCode !== null && wanted.has(guide.errorCode))
          .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
          .slice(0, safeLimit),
      );
    });
  }

  async listFailedExcludingErrorCodes(errorCodes: readonly string[], limit?: number): Promise<Guide[]> {
    const safeLimit = normalizedLimit(limit);
    const excluded = new Set(errorCodes.map((code) => requireNonEmpty(code, "errorCode")));
    return this.serialize(async () => {
      const state = await this.readState();
      return clone(
        state.guides
          .filter((guide) => guide.status === "failed" && (guide.errorCode === null || !excluded.has(guide.errorCode)))
          .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
          .slice(0, safeLimit),
      );
    });
  }

  async listExpiredDrafts(updatedBefore: string, excludedErrorCodes: readonly string[], limit?: number): Promise<Guide[]> {
    const cutoff = normalizeIsoDate(updatedBefore, "updatedBefore");
    const safeLimit = normalizedLimit(limit);
    const excluded = new Set(excludedErrorCodes.map((code) => requireNonEmpty(code, "errorCode")));
    return this.serialize(async () => {
      const state = await this.readState();
      const draftTimes = new Map(state.analysis.map((entry) => [entry.guideId, entry.state.draft?.updatedAt]));
      return clone(state.guides
        .filter((guide) => (guide.status === "ready" || guide.status === "failed") &&
          (guide.errorCode === null || !excluded.has(guide.errorCode)) && guide.updatedAt <= cutoff &&
          (draftTimes.get(guide.id) ?? guide.updatedAt) <= cutoff)
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .slice(0, safeLimit));
    });
  }

  listRecoverable(limit?: number): Promise<Guide[]> {
    return this.listByStatuses(RECOVERABLE_GUIDE_STATUSES, limit);
  }

  async listSteps(guideId: string): Promise<GuideStep[]> {
    return this.serialize(async () => {
      const state = await this.readState();
      return clone(
        state.steps
          .filter((step) => step.guideId === guideId)
          .sort((left, right) => left.position - right.position),
      );
    });
  }

  async replaceSteps(
    guideId: string,
    inputs: readonly CreateGuideStepInput[],
  ): Promise<GuideStep[]> {
    const nextSteps = buildSteps(guideId, inputs);
    return this.serialize(async () => {
      const state = await this.readState();
      const guideIndex = state.guides.findIndex((guide) => guide.id === guideId);
      if (guideIndex < 0) throw new GuideNotFoundError(guideId);
      if (privateMediaExpired(state.guides[guideIndex])) throw new GuideNotFoundError(guideId);

      state.steps = [
        ...state.steps.filter((step) => step.guideId !== guideId),
        ...nextSteps,
      ];
      state.guides[guideIndex] = {
        ...state.guides[guideIndex],
        updatedAt: new Date().toISOString(),
      };
      await this.writeState(state);
      return clone([...nextSteps].sort((left, right) => left.position - right.position));
    });
  }
}

function guideFromRow(row: GuideRow): Guide {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function stepFromRow(row: GuideStepRow): GuideStep {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function guideToInsert(guide: Guide): NewGuideRow {
  return {
    ...guide,
    createdAt: new Date(guide.createdAt),
    updatedAt: new Date(guide.updatedAt),
  };
}

function stepToInsert(step: GuideStep): NewGuideStepRow {
  return {
    ...step,
    createdAt: new Date(step.createdAt),
    updatedAt: new Date(step.updatedAt),
  };
}

async function loadAnalysisRows(transaction: ProcessorTransaction, guideId: string): Promise<AnalysisState> {
  const [draft] = await transaction.select().from(guideDrafts).where(eq(guideDrafts.guideId, guideId)).limit(1);
  const runs = await transaction.select().from(analysisRuns).where(eq(analysisRuns.guideId, guideId));
  for (const row of runs) validateWorkProjection(parseAnalysisState({ draft: null,
    runs: [{ ...row.payload, id: row.id, status: row.status }] }).runs[0], row);
  return parseAnalysisState({ draft: draft ? {
    revision: draft.revision, inputFingerprint: draft.inputFingerprint, document: draft.document,
    createdAt: draft.createdAt.toISOString(), updatedAt: draft.updatedAt.toISOString(),
  } : null, runs: runs.map((run) => ({ ...run.payload, id: run.id, status: run.status })) });
}

async function persistAnalysisRows(transaction: ProcessorTransaction, guideId: string, previous: AnalysisState, validated: AnalysisState) {
  if (validated.draft && JSON.stringify(validated.draft) !== JSON.stringify(previous.draft)) {
    const values = { ...validated.draft, guideId, createdAt: new Date(validated.draft.createdAt), updatedAt: new Date(validated.draft.updatedAt) };
    await transaction.insert(guideDrafts).values(values).onConflictDoUpdate({ target: guideDrafts.guideId, set: values });
  }
  for (const run of validated.runs) {
    if (JSON.stringify(run) === JSON.stringify(previous.runs.find((candidate) => candidate.id === run.id))) continue;
    const { id, status, ...payload } = run;
    const available = workAvailableAt(run);
    const values = { status, payload, createdAt: new Date(run.createdAt),
      availableAt: available === null ? null : new Date(available), attemptCount: run.attemptCount };
    await transaction.insert(analysisRuns).values({ guideId, id, ...values })
      .onConflictDoUpdate({ target: [analysisRuns.guideId, analysisRuns.id], set: values });
  }
}

async function lockAccountingControl(transaction: ProcessorTransaction) {
  const [row] = await transaction.select().from(analysisAccountingControls)
    .where(eq(analysisAccountingControls.id, "global")).limit(1).for("update");
  // A missing/corrupt singleton is an error, never an implicit reset to enabled.
  return parseAccountingControl(row?.payload);
}

async function loadRequestAttempts(transaction: ProcessorTransaction, guideId: string, runId: string): Promise<AnalysisRequestAttempt[]> {
  const rows = await transaction.select().from(analysisRequestAttempts)
    .where(and(eq(analysisRequestAttempts.guideId, guideId), eq(analysisRequestAttempts.runId, runId)))
    .orderBy(asc(analysisRequestAttempts.batchIndex), asc(analysisRequestAttempts.ordinal));
  return rows.map(({ payload, ...identity }) => parseRequestAttempt({ ...payload, ...identity }));
}

async function analysisWorkClock(transaction: ProcessorTransaction, fixed?: Date): Promise<Date> {
  if (fixed) return workTime(fixed); // Trusted deterministic fixture time only, never from an HTTP field.
  const result = await transaction.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  if (!result.rows[0]?.now) throw new RepositoryDataError("Analysis work clock is unavailable.");
  return workTime(new Date(result.rows[0].now));
}

function liveFundingCondition() {
  return sql`exists (select 1 from ${analysisReservations} where
    ${analysisReservations.guideId} = ${analysisRuns.guideId} and
    ${analysisReservations.runId} = ${analysisRuns.id} and ${analysisReservations.details} is not null)`;
}

async function persistRequestAttempt(transaction: ProcessorTransaction, attempt: AnalysisRequestAttempt) {
  const { guideId, runId, batchIndex, ordinal, dispatchId, status, ...payload } = attempt;
  await transaction.insert(analysisRequestAttempts).values({ guideId, runId, batchIndex, ordinal, dispatchId, status, payload })
    .onConflictDoUpdate({ target: [analysisRequestAttempts.guideId, analysisRequestAttempts.runId, analysisRequestAttempts.batchIndex, analysisRequestAttempts.ordinal],
      set: { dispatchId, status, payload } });
}

function batchFromRow(row: typeof analysisBatchesTable.$inferSelect) {
  const batch = parseStoredBatch({ ...row.payload, guideId: row.guideId, runId: row.runId, index: row.index });
  if (batch.status !== row.status) throw new RepositoryDataError("Analysis batch status projection is inconsistent.");
  return batch;
}

async function validateAnalysisFundingRows(transaction: ProcessorTransaction, guideId: string, analysis: AnalysisState) {
  const reservations = await transaction.select().from(analysisReservations).where(eq(analysisReservations.guideId, guideId));
  for (const row of reservations) {
    if (!row.details) continue;
    const reservation = parseReservation(row);
    const rows = await transaction.select().from(analysisBatchesTable).where(and(eq(analysisBatchesTable.guideId, guideId),
      eq(analysisBatchesTable.runId, row.runId))).orderBy(asc(analysisBatchesTable.index));
    const batches = rows.map(batchFromRow);
    const attempts = await loadRequestAttempts(transaction, guideId, row.runId);
    validateFundingAnalysis(analysis, reservation, batches);
    reservationAccounted(reservation, attempts);
    validateBatchSettlements(batches, attempts);
  }
}

// Roll back even provisional zero-valued windows on conflict or racing replay.
class FundingRollback extends Error {
  constructor(readonly result: AnalysisFundingResult | null) { super("Analysis funding transaction not committed."); }
}

const analysisPools = new WeakMap<PostgresGuideRepository, Pool>();
const analysisActivations = new WeakMap<PostgresGuideRepository, AnalysisActivation>();
/** Trusted, immutable process binding. Switching grants requires a new repository/runtime. */
export function bindAnalysisActivation(repository: PostgresGuideRepository, raw: AnalysisActivation) {
  const activation = analysisActivationSchema.parse(raw);
  const old = analysisActivations.get(repository);
  if (old && JSON.stringify(old) !== JSON.stringify(activation)) throw new AnalysisAccountingError("ANALYSIS_ACCOUNTING_HALTED");
  analysisActivations.set(repository, Object.freeze(activation));
}

function publicationJobFromRow(row: typeof publicationJobs.$inferSelect): PublicationJob {
  const job = publicationJobSchema.parse(row.payload);
  if (job.guideId !== row.guideId || job.id !== row.id || job.batchId !== row.batchId || job.status !== row.status ||
      publicationAvailableAt(job) !== (row.availableAt?.toISOString() ?? null)) {
    throw new RepositoryDataError("Invalid publication job projection.");
  }
  return job;
}
async function checkLockedActivation(transaction: ProcessorTransaction, repository: PostgresGuideRepository,
  control: ReturnType<typeof parseAccountingControl>, guideId: string) {
  const expected = analysisActivations.get(repository);
  if (!control.activation && !expected) return;
  if (!matchesAnalysisActivation(control.activation, expected, guideId, await analysisWorkClock(transaction))) {
    throw new AnalysisAccountingError("ANALYSIS_ACCOUNTING_HALTED");
  }
}
/** Trusted composition only: recover the exact pool used by a factory-created repository. */
export function analysisPoolForRepository(repository: PostgresGuideRepository): Pool | undefined { return analysisPools.get(repository); }

async function loadPublicationState(tx: ProcessorTransaction, guideId: string, jobs: PublicationJob[]): Promise<PublicationState> {
  const [row] = await tx.select().from(publicationHeads).where(eq(publicationHeads.guideId, guideId));
  const head = row ? publicationHeadSchema.parse({ ...row, firstPublishedAt: row.firstPublishedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(), updatedAt: row.updatedAt.toISOString() }) : null;
  const publications = (await tx.select().from(guidePublications).where(eq(guidePublications.guideId, guideId)))
    .map(row => {
      const publication = guidePublicationSchema.parse(row.payload);
      if (publication.guideId !== guideId || publication.id !== row.id || publication.batchId !== row.batchId)
        throw new RepositoryDataError("Invalid publication snapshot identity.");
      return publication;
    });
  return validatePublicationState({ head, publications }, jobs);
}

export class PostgresGuideRepository implements GuideRepository, PublicationJobRepository, PublicationRepository, PublicationLifecycleRepository {
  readonly countDispatchContract = "postgres-count-0010" as const;
  // Only a successfully acknowledged, irreversible claim creates a local capability.
  // Serialized/reconstructed tickets, another repository and a restart cannot reuse it.
  readonly #countLaunchTickets = new WeakMap<object, { guideId: string; command: AnalysisCountLaunchCommand }>();
  constructor(
    readonly database: ProcessorDatabase,
    private readonly closeDatabase?: () => Promise<void>,
  ) {}

  static fromPool(pool: Pool, ownsPool = false): PostgresGuideRepository {
    const repository = new PostgresGuideRepository(
      drizzle(pool, { schema: processorSchema }),
      ownsPool ? () => pool.end() : undefined,
    );
    analysisPools.set(repository, pool);
    return repository;
  }

  static connect(databaseUrl: string, poolConfig: Omit<PoolConfig, "connectionString"> = {}) {
    const pool = new Pool({ ...poolConfig, connectionString: requireNonEmpty(databaseUrl, "databaseUrl") });
    return PostgresGuideRepository.fromPool(pool, true);
  }

  async close(): Promise<void> {
    await this.closeDatabase?.();
  }

  private async analysisTransaction(guideId: string, command?: AnalysisCommand): Promise<AnalysisState | null> {
    return this.database.transaction(async (transaction) => {
      // Same parent lock as media completion and deletion: no check/write gap.
      const [guide] = await transaction.select().from(guides).where(eq(guides.id, guideId)).limit(1).for(command ? "update" : "share");
      if (!guide) return null;
      const previous = await loadAnalysisRows(transaction, guideId);
      await validateAnalysisFundingRows(transaction, guideId, previous);
      if (!command) return previous;
      if (["claim", "finish", "fail"].includes(command.type) && "runId" in command) {
        const [funded] = await transaction.select({ runId: analysisReservations.runId }).from(analysisReservations)
          .where(and(eq(analysisReservations.guideId, guideId), eq(analysisReservations.runId, command.runId))).limit(1);
        if (funded) return null;
      }
      const steps = await transaction.select().from(guideSteps).where(eq(guideSteps.guideId, guideId));
      const next = transitionAnalysis({ ...guideFromRow(guide), steps: steps.map(stepFromRow) }, previous, command);
      if (!next) return null;
      const validated = parseAnalysisState(next);
      await persistAnalysisRows(transaction, guideId, previous, validated);
      // Same parent lock and transaction as the draft: expiry cannot claim an old
      // snapshot after a new save, and a failed write cannot extend retention.
      if ((command.type === "save-editor-draft" || command.type === "review-privacy") && validated.draft &&
          validated.draft.revision !== previous.draft?.revision) {
        await transaction.update(guides).set({ updatedAt: new Date(validated.draft.updatedAt) })
          .where(eq(guides.id, guideId));
      }
      return validated;
    });
  }

  getAnalysisState(guideId: string): Promise<AnalysisState | null> { return this.analysisTransaction(guideId); }

  async expirePrivateDraft(guideId: string, raw: PrivateExpiry, now?: Date) {
    const command = privateExpirySchema.parse(raw), fixed = now === undefined ? undefined : publicationTime(now);
    return this.database.transaction(async tx => {
      const [row] = await tx.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
      if (!row) return null;
      const steps = (await tx.select().from(guideSteps).where(eq(guideSteps.guideId, guideId))).map(stepFromRow);
      const analysis = await loadAnalysisRows(tx, guideId);
      const jobs = (await tx.select().from(publicationJobs).where(eq(publicationJobs.guideId, guideId))).map(publicationJobFromRow);
      const state = await loadPublicationState(tx, guideId, jobs);
      const assets = (await tx.select().from(guideAssets).where(eq(guideAssets.guideId, guideId))).map(r => {
        const asset = privacyAssetBatchSchema.parse(r.payload);
        if (asset.id !== r.id || asset.guideId !== guideId) throw new RepositoryDataError("Invalid private asset identity.");
        return asset;
      });
      const next = preparePrivateExpiry({ ...guideFromRow(row), steps }, analysis, state.head, jobs, assets, command, await analysisWorkClock(tx, fixed), randomUUID());
      if (!next) return null;
      const acknowledged = (rows: unknown[], expected = 1) => { if (rows.length !== expected) throw new RepositoryDataError("Private expiry was not acknowledged."); };
      if (next.cleanup) {
        acknowledged(await tx.insert(privateMediaCleanup).values({ guideId, id: next.cleanup.id, payload: next.cleanup }).returning());
        const reservations = await tx.select({ id: analysisReservations.runId }).from(analysisReservations).where(eq(analysisReservations.guideId, guideId));
        acknowledged(await tx.update(analysisReservations).set({ details: null }).where(eq(analysisReservations.guideId, guideId)).returning(), reservations.length);
        acknowledged(await tx.delete(guideSteps).where(eq(guideSteps.guideId, guideId)).returning(), steps.length);
        acknowledged(await tx.delete(guideDrafts).where(eq(guideDrafts.guideId, guideId)).returning(), analysis.draft ? 1 : 0);
        acknowledged(await tx.delete(analysisRuns).where(eq(analysisRuns.guideId, guideId)).returning(), analysis.runs.length);
        for (const job of next.jobs) acknowledged(await tx.update(publicationJobs).set({ payload: job, status: job.status, availableAt: null })
          .where(and(eq(publicationJobs.guideId, guideId), eq(publicationJobs.id, job.id))).returning());
        for (const asset of next.assets) acknowledged(await tx.update(guideAssets).set({ payload: asset })
          .where(and(eq(guideAssets.guideId, guideId), eq(guideAssets.id, asset.id))).returning());
      }
      const { steps: _steps, ...guide } = next.guide;
      acknowledged(await tx.update(guides).set(guideToInsert(guide)).where(eq(guides.id, guideId)).returning());
      return guide;
    });
  }
  async getPrivateCleanup(guideId: string) {
    const [row] = await this.database.select().from(privateMediaCleanup).where(eq(privateMediaCleanup.guideId, guideId)).limit(1);
    if (!row) return null;
    const payload = privateCleanupSchema.parse(row.payload);
    if (payload.guideId !== guideId || payload.id !== row.id) throw new RepositoryDataError("Invalid private cleanup identity.");
    return payload;
  }
  async listPrivateCleanup(raw: PrivateCleanupQuery) {
    const query = privateCleanupQuerySchema.parse(raw);
    const rows = await this.database.select().from(privateMediaCleanup)
      .where(query.after ? gt(privateMediaCleanup.id, query.after) : undefined).orderBy(asc(privateMediaCleanup.id)).limit(query.limit);
    return rows.map(row => {
      const payload = privateCleanupSchema.parse(row.payload);
      if (payload.guideId !== row.guideId || payload.id !== row.id) throw new RepositoryDataError("Invalid private cleanup identity.");
      return payload;
    });
  }
  async completePrivateCleanup(guideId: string, cleanupId: string) {
    return this.database.transaction(async tx => {
      const [guide] = await tx.select({ id: guides.id }).from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
      if (!guide) return true;
      const [row] = await tx.select().from(privateMediaCleanup).where(eq(privateMediaCleanup.guideId, guideId));
      if (!row) return true;
      if (row.id !== cleanupId) return false;
      const removed = await tx.delete(privateMediaCleanup).where(and(eq(privateMediaCleanup.guideId, guideId), eq(privateMediaCleanup.id, cleanupId))).returning();
      if (removed.length !== 1) throw new RepositoryDataError("Private cleanup was not acknowledged.");
      return true;
    });
  }
  async listExpiredRetainedGuides(limit?: number, now?: Date) {
    const safeLimit = normalizedLimit(limit), fixed = now === undefined ? undefined : publicationTime(now);
    return this.database.transaction(async tx => {
      const at = await analysisWorkClock(tx, fixed);
      const rows = await tx.select().from(guides).where(and(eq(guides.status, "failed"), eq(guides.errorCode, PRIVATE_MEDIA_EXPIRED),
        sql`not exists (select 1 from ${publicationHeads} where ${publicationHeads.guideId} = ${guides.id}
          and ${publicationHeads.activePublicationId} is not null and ${publicationHeads.expiresAt} > ${at})`))
        .orderBy(asc(guides.updatedAt)).limit(safeLimit);
      return rows.map(guideFromRow);
    });
  }
  executeAnalysisCommand(guideId: string, command: AnalysisCommand): Promise<AnalysisState | null> {
    return this.analysisTransaction(guideId, command);
  }

  async getPublicationJob(guideId: string, jobId: string): Promise<PublicationJob | null> {
    const [row] = await this.database.select().from(publicationJobs)
      .where(and(eq(publicationJobs.guideId, guideId), eq(publicationJobs.id, jobId))).limit(1);
    return row ? publicationJobFromRow(row) : null;
  }

  async listPublicationWork(limit = 20, now?: Date) {
    limit = publicationWorkLimit(limit); const fixed = now === undefined ? undefined : publicationTime(now);
    return this.database.transaction(async tx => {
      const at = await analysisWorkClock(tx, fixed);
      const rows = await tx.select().from(publicationJobs).where(lte(publicationJobs.availableAt, at))
        .orderBy(asc(publicationJobs.availableAt), asc(publicationJobs.guideId), asc(publicationJobs.id)).limit(limit);
      return rows.map(row => { const { guideId, id, version } = publicationJobFromRow(row); return { guideId, id, version }; });
    });
  }

  async getPublicationState(guideId: string): Promise<PublicationState | null> {
    return this.database.transaction(async tx => {
      const [guide] = await tx.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("share");
      if (!guide) return null;
      const jobs = (await tx.select().from(publicationJobs).where(eq(publicationJobs.guideId, guideId))).map(publicationJobFromRow);
      return loadPublicationState(tx, guideId, jobs);
    });
  }

  async getPublicationOwnerStatus(guideId: string, jobId?: string, now?: Date) {
    if (jobId !== undefined) publicationCommitSchema.shape.id.parse(jobId);
    const fixed = now === undefined ? undefined : publicationTime(now);
    return this.database.transaction(async tx => {
      const [guide] = await tx.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("share");
      if (!guide) return null;
      const jobs = (await tx.select().from(publicationJobs).where(eq(publicationJobs.guideId, guideId))).map(publicationJobFromRow);
      const state = await loadPublicationState(tx, guideId, jobs);
      const assets = (await tx.select().from(guideAssets).where(eq(guideAssets.guideId, guideId))).map(row => {
        const batch = privacyAssetBatchSchema.parse(row.payload);
        if (batch.guideId !== guideId || batch.id !== row.id) throw new RepositoryDataError("Invalid private asset identity.");
        return batch;
      });
      return selectPublicationOwnerStatus({ ...guideFromRow(guide), steps: [] }, state, jobs, assets, jobId, await analysisWorkClock(tx, fixed));
    });
  }

  async commitPublication(guideId: string, raw: PublicationCommit, now?: Date) {
    const command = publicationCommitSchema.parse(raw), fixed = now === undefined ? undefined : publicationTime(now);
    return this.database.transaction(async tx => {
      const [guide] = await tx.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
      if (!guide) return null;
      const jobs = (await tx.select().from(publicationJobs).where(eq(publicationJobs.guideId, guideId))).map(publicationJobFromRow);
      const state = await loadPublicationState(tx, guideId, jobs);
      const assets = (await tx.select().from(guideAssets).where(eq(guideAssets.guideId, guideId))).map(row => {
        const asset = privacyAssetBatchSchema.parse(row.payload);
        if (asset.id !== row.id || asset.guideId !== guideId) throw new RepositoryDataError("Invalid private asset identity.");
        return asset;
      });
      const steps = (await tx.select().from(guideSteps).where(eq(guideSteps.guideId, guideId))).map(stepFromRow);
      const next = preparePublicationCommit({ ...guideFromRow(guide), steps }, await loadAnalysisRows(tx, guideId), jobs, assets, state,
        command, await analysisWorkClock(tx, fixed), randomBytes(24).toString("base64url"));
      if (!next) return null;
      if (next.changed) {
        const acknowledged = (rows: unknown[]) => { if (rows.length !== 1) throw new RepositoryDataError("Publication commit was not acknowledged."); };
        if (next.oldAsset) acknowledged(await tx.update(guideAssets).set({ payload: next.oldAsset })
          .where(and(eq(guideAssets.guideId, guideId), eq(guideAssets.id, next.oldAsset.id))).returning());
        const publication = next.result.publication;
        acknowledged(await tx.insert(guidePublications).values({ guideId, id: publication.id, batchId: publication.batchId, payload: publication }).returning());
        acknowledged(await tx.update(publicationJobs).set({ status: next.job.status, payload: next.job, availableAt: null })
          .where(and(eq(publicationJobs.guideId, guideId), eq(publicationJobs.id, next.job.id))).returning());
        const head = next.result.head, values = { ...head, firstPublishedAt: new Date(head.firstPublishedAt),
          expiresAt: new Date(head.expiresAt), updatedAt: new Date(head.updatedAt) };
        acknowledged(state.head ? await tx.update(publicationHeads).set(values).where(eq(publicationHeads.guideId, guideId)).returning()
          : await tx.insert(publicationHeads).values(values).returning());
      }
      return next.result;
    });
  }

  async executePublicationCommand(guideId: string, command: PublicationCommand, now?: Date): Promise<PublicationJob | null> {
    command = publicationCommandSchema.parse(command);
    const fixed = now === undefined ? undefined : publicationTime(now);
    return this.database.transaction(async tx => {
      const [guide] = await tx.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
      if (!guide) return null;
      const jobs = (await tx.select().from(publicationJobs).where(eq(publicationJobs.guideId, guideId))).map(publicationJobFromRow);
      const assets = (await tx.select().from(guideAssets).where(eq(guideAssets.guideId, guideId))).map(row => {
        const batch = privacyAssetBatchSchema.parse(row.payload);
        if (batch.guideId !== guideId || batch.id !== row.id) throw new RepositoryDataError("Invalid private asset identity.");
        return batch;
      });
      const steps = await tx.select().from(guideSteps).where(eq(guideSteps.guideId, guideId));
      const state = await loadPublicationState(tx, guideId, jobs), analysis = await loadAnalysisRows(tx, guideId);
      const at = await analysisWorkClock(tx, fixed);
      if (!publicationPreparationAllowed(state.head, jobs, command, at)) return null;
      const next = transitionPublicationJob({ ...guideFromRow(guide), steps: steps.map(stepFromRow) },
        analysis, jobs, assets, command, at, randomUUID());
      if (!next) return null;
      if (next.changed) {
        if (next.asset) {
          const asset = next.asset;
          const written = assets.some(b => b.id === asset.id)
            ? await tx.update(guideAssets).set({ payload: asset }).where(and(eq(guideAssets.guideId, guideId), eq(guideAssets.id, asset.id))).returning()
            : await tx.insert(guideAssets).values({ guideId, id: asset.id, payload: asset }).returning();
          if (written.length !== 1) throw new RepositoryDataError("Publication asset write was not acknowledged.");
        }
        const job = next.job, available = publicationAvailableAt(job);
        const values = { guideId, id: job.id, batchId: job.batchId, status: job.status, payload: job,
          availableAt: available === null ? null : new Date(available) };
        const written = jobs.some(j => j.id === job.id)
          ? await tx.update(publicationJobs).set(values).where(and(eq(publicationJobs.guideId, guideId), eq(publicationJobs.id, job.id))).returning()
          : await tx.insert(publicationJobs).values(values).returning();
        if (written.length !== 1) throw new RepositoryDataError("Publication job write was not acknowledged.");
      }
      return next.job;
    });
  }

  async stopPublication(guideId: string, raw: PublicationStop, now?: Date) {
    const command = publicationStopSchema.parse(raw), fixed = now === undefined ? undefined : publicationTime(now);
    return this.database.transaction(async tx => {
      const [guide] = await tx.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
      if (!guide) return null;
      const jobs = (await tx.select().from(publicationJobs).where(eq(publicationJobs.guideId, guideId))).map(publicationJobFromRow);
      const state = await loadPublicationState(tx, guideId, jobs);
      const assets = (await tx.select().from(guideAssets).where(eq(guideAssets.guideId, guideId))).map(row => {
        const batch = privacyAssetBatchSchema.parse(row.payload);
        if (batch.guideId !== guideId || batch.id !== row.id) throw new RepositoryDataError("Invalid private asset identity.");
        return batch;
      });
      const next = preparePublicationStop({ ...guideFromRow(guide), steps: [] }, state, jobs, assets, command, await analysisWorkClock(tx, fixed));
      if (!next) return null;
      if (next.result.changed) {
        const acknowledged = (rows: unknown[]) => { if (rows.length !== 1) throw new RepositoryDataError("Publication stop was not acknowledged."); };
        if (next.result.head) acknowledged(await tx.update(publicationHeads).set({ activePublicationId: null,
          version: next.result.head.version, updatedAt: new Date(next.result.head.updatedAt) }).where(eq(publicationHeads.guideId, guideId)).returning());
        for (const job of next.jobs) acknowledged(await tx.update(publicationJobs).set({ status: job.status, payload: job, availableAt: null })
          .where(and(eq(publicationJobs.guideId, guideId), eq(publicationJobs.id, job.id))).returning());
        for (const batch of next.assets) acknowledged(await tx.update(guideAssets).set({ payload: batch })
          .where(and(eq(guideAssets.guideId, guideId), eq(guideAssets.id, batch.id))).returning());
      }
      return next.result;
    });
  }

  async getAccessiblePublication(raw: PublicationAccess, now?: Date) {
    const query = publicationAccessSchema.parse(raw), fixed = now === undefined ? undefined : publicationTime(now);
    return this.database.transaction(async tx => {
      const [candidate] = await tx.select({ guideId: publicationHeads.guideId }).from(publicationHeads)
        .where(eq(publicationHeads.publicSlug, query.slug)).limit(1);
      if (!candidate) return null;
      const [guide] = await tx.select().from(guides).where(eq(guides.id, candidate.guideId)).limit(1).for("share");
      if (!guide) return null;
      // Re-read after the parent lock; a pre-lock head/image lookup is not authority.
      const jobs = (await tx.select().from(publicationJobs).where(eq(publicationJobs.guideId, guide.id))).map(publicationJobFromRow);
      const state = await loadPublicationState(tx, guide.id, jobs);
      const assets = (await tx.select().from(guideAssets).where(eq(guideAssets.guideId, guide.id))).map(row => {
        const batch = privacyAssetBatchSchema.parse(row.payload);
        if (batch.guideId !== guide.id || batch.id !== row.id) throw new RepositoryDataError("Invalid private asset identity.");
        return batch;
      });
      return selectAccessiblePublication({ ...guideFromRow(guide), steps: [] }, state, assets, query, await analysisWorkClock(tx, fixed));
    });
  }

  async listExpiredPublications(raw: PublicationExpiryQuery, now?: Date) {
    const query = publicationExpiryQuerySchema.parse(raw), fixed = now === undefined ? undefined : publicationTime(now);
    return this.database.transaction(async tx => {
      const at = await analysisWorkClock(tx, fixed);
      const rows = await tx.select().from(publicationHeads).where(and(lte(publicationHeads.expiresAt, at),
        or(isNotNull(publicationHeads.activePublicationId), sql`exists (select 1 from ${publicationJobs}
          where ${publicationJobs.guideId} = ${publicationHeads.guideId} and ${publicationJobs.status} in ('queued', 'running'))`),
        query.after ? or(gt(publicationHeads.expiresAt, new Date(query.after.expiresAt)),
          and(eq(publicationHeads.expiresAt, new Date(query.after.expiresAt)), sql`${publicationHeads.publicSlug} collate "C" > ${query.after.publicSlug}`)) : undefined))
        .orderBy(asc(publicationHeads.expiresAt), sql`${publicationHeads.publicSlug} collate "C"`).limit(query.limit);
      return rows.map(row => ({ guideId: row.guideId, version: row.version, expiresAt: row.expiresAt.toISOString(), publicSlug: row.publicSlug }));
    });
  }

  async listPrivacyAssetBatches(guideId: string): Promise<PrivacyAssetBatch[]> {
    const rows = await this.database.select().from(guideAssets).where(eq(guideAssets.guideId, guideId));
    return rows.map(row => {
      const batch = privacyAssetBatchSchema.parse(row.payload);
      if (batch.guideId !== row.guideId || batch.id !== row.id) throw new RepositoryDataError("Invalid private asset identity.");
      return batch;
    });
  }

  async listPublicationRecovery(raw: PublicationRecoveryQuery, now?: Date) {
    const query = publicationRecoveryQuerySchema.parse(raw), fixed = now === undefined ? undefined : publicationTime(now);
    return this.database.transaction(async tx => {
      const at = await analysisWorkClock(tx, fixed);
      const rows = await tx.select({ job: publicationJobs }).from(publicationJobs)
        .leftJoin(guideAssets, and(eq(guideAssets.id, publicationJobs.batchId), eq(guideAssets.guideId, publicationJobs.guideId)))
        .where(and(query.after ? gt(publicationJobs.batchId, query.after) : undefined, query.kind === "queued" ? eq(publicationJobs.status, "queued") : query.kind === "expired"
          ? and(eq(publicationJobs.status, "running"), lte(publicationJobs.availableAt, at))
          : and(or(inArray(publicationJobs.status, ["failed", "cancelled"]),
            and(eq(publicationJobs.status, "succeeded"), sql`${guideAssets.payload}->>'status' = 'cleanup'`)), isNotNull(guideAssets.id))))
        .orderBy(asc(publicationJobs.batchId)).limit(query.limit);
      return rows.map(row => { const { guideId, id, version, batchId } = publicationJobFromRow(row.job);
        return { guideId, id, version, batchId }; });
    });
  }

  async executePrivacyAssetCommand(guideId: string, command: PrivacyAssetCommand): Promise<PrivacyAssetBatch | null> {
    command = structuredClone(command);
    return this.database.transaction(async tx => {
      const [guide] = await tx.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
      if (!guide) return null;
      const rows = await tx.select().from(guideAssets).where(eq(guideAssets.guideId, guideId));
      const jobs = (await tx.select().from(publicationJobs).where(eq(publicationJobs.guideId, guideId))).map(publicationJobFromRow);
      if (publicationProtectsAsset({ ...guideFromRow(guide), steps: [] }, await loadPublicationState(tx, guideId, jobs), command.id)) return null;
      if (command.type === "reserve" && rows.length >= 4) return null;
      const existing = rows.find(row => row.id === command.id);
      if (existing && (existing.payload.id !== existing.id || existing.payload.guideId !== guideId)) {
        throw new RepositoryDataError("Invalid private asset identity.");
      }
      const steps = await tx.select().from(guideSteps).where(eq(guideSteps.guideId, guideId));
      const next = transitionPrivacyAsset({ ...guideFromRow(guide), steps: steps.map(stepFromRow) },
        await loadAnalysisRows(tx, guideId), existing?.payload, command, await analysisWorkClock(tx));
      if (!next) return null;
      const where = and(eq(guideAssets.guideId, guideId), eq(guideAssets.id, command.id));
      const written = next.remove ? await tx.delete(guideAssets).where(where).returning()
        : existing ? await tx.update(guideAssets).set({ payload: next.batch }).where(where).returning()
        : await tx.insert(guideAssets).values({ guideId, id: command.id, payload: next.batch }).returning();
      if (written.length !== 1) throw new RepositoryDataError("Private asset write was not acknowledged.");
      return next.batch;
    });
  }

  async listAnalysisClosures(limit = 20, now?: Date): Promise<AnalysisClosureCandidate[]> {
    limit = workLimit(limit);
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.database.transaction(async (transaction) => {
      const at = await analysisWorkClock(transaction, fixedTime);
      const rows = await transaction.select().from(analysisReservations).where(and(isNull(analysisReservations.closedAt),
        sql`(${analysisReservations.details} is null or exists (select 1 from ${analysisRuns}
          where ${analysisRuns.guideId} = ${analysisReservations.guideId} and ${analysisRuns.id} = ${analysisReservations.runId}
          and (${analysisRuns.status} in ('succeeded', 'failed', 'cancelled') or
            (${analysisReservations.day} < ${fundingDay(at)} and ${analysisRuns.availableAt} <= ${at.toISOString()}::timestamptz))))`))
        .orderBy(asc(analysisReservations.day), asc(analysisReservations.guideId), asc(analysisReservations.runId)).limit(limit);
      return rows.map((row) => { const r = parseReservation(row); return { guideId: r.guideId, runId: r.runId }; });
    });
  }

  async closeAnalysisReservation(guideId: string, runId: string, now?: Date, beforeCommit?: () => void): Promise<AnalysisClosureResult | null> {
    requireNonEmpty(guideId, "guideId"); requireNonEmpty(runId, "runId");
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.database.transaction(async (transaction) => {
      await lockAccountingControl(transaction); // Halting stops spending, not safe cleanup.
      const where = and(eq(analysisReservations.guideId, guideId), eq(analysisReservations.runId, runId));
      const [initial] = await transaction.select().from(analysisReservations).where(where).limit(1);
      if (!initial) return null;
      const windows = [];
      for (const scope of ["global", `guide:${guideId}`]) {
        const [row] = await transaction.select().from(analysisBudgetWindows).where(and(
          eq(analysisBudgetWindows.day, initial.day), eq(analysisBudgetWindows.scope, scope))).limit(1).for("update");
        windows.push(parseBudgetWindow(row ? { ...row.payload, day: row.day, scope: row.scope } : undefined));
      }
      const [guide] = await transaction.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
      // Re-read after deletion's parent lock. Numeric tombstones are retained and never rehydrated.
      const [row] = await transaction.select().from(analysisReservations).where(where).limit(1);
      const reservation = parseReservation(row);
      if (reservation.details && !guide) throw new RepositoryDataError("Orphaned analysis reservation.");
      const previous = reservation.details ? await loadAnalysisRows(transaction, guideId) : null;
      const batches = await transaction.select().from(analysisBatchesTable).where(and(
        eq(analysisBatchesTable.guideId, guideId), eq(analysisBatchesTable.runId, runId))).orderBy(asc(analysisBatchesTable.index));
      const attempts = await loadRequestAttempts(transaction, guideId, runId);
      const prepared = prepareAnalysisClosure({ reservation, analysis: previous, batches: batches.map(batchFromRow), attempts, windows,
        now: await analysisWorkClock(transaction, fixedTime) });
      if (!prepared) return null;
      const result = { reservation: prepared.reservation, replayed: prepared.replayed };
      if (prepared.replayed) return result;
      validateFundingCommit(beforeCommit);
      if (previous && prepared.analysis) await persistAnalysisRows(transaction, guideId, previous, prepared.analysis);
      for (const { day, scope, ...payload } of prepared.windows) await transaction.update(analysisBudgetWindows).set({ payload })
        .where(and(eq(analysisBudgetWindows.day, day), eq(analysisBudgetWindows.scope, scope)));
      for (const attempt of prepared.attempts) if (JSON.stringify(attempt) !== JSON.stringify(attempts.find((a) =>
        a.batchIndex === attempt.batchIndex && a.ordinal === attempt.ordinal))) await persistRequestAttempt(transaction, attempt);
      await transaction.update(analysisReservations).set({ released: prepared.reservation.released, closedAt: prepared.reservation.closedAt }).where(where);
      return result;
    }, { isolationLevel: "read committed" });
  }

  async listAnalysisWork(limit = 20, now?: Date, after?: AnalysisWorkCursor): Promise<AnalysisWorkCandidate[]> {
    limit = workLimit(limit);
    after = parseWorkCursor(after);
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.database.transaction(async (transaction) => {
      const at = await analysisWorkClock(transaction, fixedTime);
      const rows = await transaction.select().from(analysisRuns).where(and(
        inArray(analysisRuns.status, ["queued", "running"]), lte(analysisRuns.availableAt, at), liveFundingCondition(),
        sql`exists (select 1 from ${guides} where ${guides.id} = ${analysisRuns.guideId}
          and ${guides.status} = 'ready' and ${guides.errorCode} is null)`,
        after ? sql`(${analysisRuns.availableAt}, ${analysisRuns.createdAt}, ${analysisRuns.guideId}, ${analysisRuns.id}) >
          (${after.availableAt}::timestamptz, ${after.createdAt}::timestamptz, ${after.guideId}, ${after.runId})` : undefined))
        .orderBy(asc(analysisRuns.availableAt), asc(analysisRuns.createdAt), asc(analysisRuns.guideId), asc(analysisRuns.id)).limit(limit);
      return rows.map((row) => {
        const run = parseAnalysisState({ draft: null, runs: [{ ...row.payload, id: row.id, status: row.status }] }).runs[0];
        validateWorkProjection(run, row);
        return { guideId: row.guideId, runId: run.id, expectedAttemptCount: run.attemptCount };
      });
    });
  }

  async claimAnalysisWork(guideId: string, command: AnalysisWorkClaim, now?: Date, beforeCommit?: () => void): Promise<AnalysisWorkResult | null> {
    command = parseWorkClaim(command);
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.database.transaction(async (transaction) => {
      // All funded claimants share this mutex, including across different guides/replicas.
      // No budget window changes: global control -> guide is a subsequence of the accounting lock order.
      const control = await lockAccountingControl(transaction);
      await checkLockedActivation(transaction, this, control, guideId);
      const [guide] = await transaction.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
      if (!guide) return null;
      const [stored] = await transaction.select().from(analysisReservations).where(and(
        eq(analysisReservations.guideId, guideId), eq(analysisReservations.runId, command.runId), isNotNull(analysisReservations.details))).limit(1);
      if (!stored?.details) return null;
      const previous = await loadAnalysisRows(transaction, guideId);
      const batchRows = await transaction.select().from(analysisBatchesTable).where(and(
        eq(analysisBatchesTable.guideId, guideId), eq(analysisBatchesTable.runId, command.runId))).orderBy(asc(analysisBatchesTable.index));
      const attempts = await loadRequestAttempts(transaction, guideId, command.runId);
      const steps = await transaction.select().from(guideSteps).where(eq(guideSteps.guideId, guideId));
      const at = await analysisWorkClock(transaction, fixedTime);
      const active = await transaction.select().from(analysisRuns).where(and(
        eq(analysisRuns.status, "running"), gt(analysisRuns.availableAt, at), liveFundingCondition())).limit(1);
      for (const row of active) validateWorkProjection(parseAnalysisState({ draft: null,
        runs: [{ ...row.payload, id: row.id, status: row.status }] }).runs[0], row);
      const commitTime = await analysisWorkClock(transaction, fixedTime);
      if (commitTime.valueOf() < at.valueOf()) throw new RepositoryDataError("Analysis work clock moved backwards.");
      const prepared = prepareAnalysisWorkClaim({ guide: { ...guideFromRow(guide), steps: steps.map(stepFromRow) },
        analysis: previous, reservation: parseReservation(stored), batches: batchRows.map(batchFromRow),
        attempts, occupied: active.length > 0, halted: control.halted, command, now: commitTime });
      if (!prepared) return null;
      if (prepared.result.replayed) return clone(prepared.result);
      validateFundingCommit(beforeCommit);
      await persistAnalysisRows(transaction, guideId, previous, prepared.analysis);
      for (const attempt of prepared.attempts) {
        const before = attempts.find((a) => a.batchIndex === attempt.batchIndex && a.ordinal === attempt.ordinal);
        if (JSON.stringify(before) !== JSON.stringify(attempt)) await persistRequestAttempt(transaction, attempt);
      }
      return clone(prepared.result);
    }, { isolationLevel: "read committed" }); // A waiting claimant must see the preceding owner's commit.
  }

  async reserveAnalysisRequest(guideId: string, command: AnalysisFundingCommand, policy: AnalysisFundingPolicy, now = new Date(), beforeCommit?: () => void): Promise<AnalysisFundingResult | null> {
    command = parseFundingCommand(command);
    policy = parseFundingPolicy(policy);
    const day = fundingDay(now);
    now = new Date(now.valueOf());
    try {
      return await this.database.transaction(async (transaction) => {
        const control = await lockAccountingControl(transaction);
        await checkLockedActivation(transaction, this, control, guideId);
        const reservationWhere = and(eq(analysisReservations.guideId, guideId), eq(analysisReservations.runId, command.runId));
        const [initialReservation] = await transaction.select().from(analysisReservations).where(reservationWhere).limit(1);
        const windows: Array<ReturnType<typeof parseBudgetWindow>> = [];
        if (!initialReservation) {
          // All budget writers: global control, global-day, guide-day, guide.
          for (const scope of ["global", `guide:${guideId}`]) {
            const { day: windowDay, scope: windowScope, ...payload } = initialBudgetWindow(day, scope, policy);
            await transaction.insert(analysisBudgetWindows).values({ day: windowDay, scope: windowScope, payload }).onConflictDoNothing();
            const [row] = await transaction.select().from(analysisBudgetWindows)
              .where(and(eq(analysisBudgetWindows.day, day), eq(analysisBudgetWindows.scope, scope))).limit(1).for("update");
            windows.push(parseBudgetWindow({ ...row.payload, day: row.day, scope: row.scope }));
          }
        }
        const [guide] = await transaction.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
        if (!guide) throw new FundingRollback(null);
        const [stored] = await transaction.select().from(analysisReservations).where(reservationWhere).limit(1);
        if (stored) reservationAccounted(parseReservation(stored), await loadRequestAttempts(transaction, guideId, command.runId));
        const batchRows = await transaction.select().from(analysisBatchesTable)
          .where(and(eq(analysisBatchesTable.guideId, guideId), eq(analysisBatchesTable.runId, command.runId))).orderBy(asc(analysisBatchesTable.index));
        const previous = await loadAnalysisRows(transaction, guideId);
        const steps = await transaction.select().from(guideSteps).where(eq(guideSteps.guideId, guideId));
        const prepared = prepareFundedAnalysis({ guide: { ...guideFromRow(guide), steps: steps.map(stepFromRow) }, previous,
          command, policy, now, existing: stored ? parseReservation(stored) : null,
          batches: batchRows.map(batchFromRow), windows, halted: control.halted });
        if (!prepared) throw new FundingRollback(null);
        const { windows: nextWindows, ...result } = prepared;
        validateBatchSettlements(result.batches, await loadRequestAttempts(transaction, guideId, command.runId));
        if (result.replayed) {
          if (!initialReservation) throw new FundingRollback(result);
          return result;
        }
        validateFundingCommit(beforeCommit);
        await persistAnalysisRows(transaction, guideId, previous, result.analysis);
        for (const window of nextWindows) {
          const { day: windowDay, scope, ...payload } = window;
          await transaction.update(analysisBudgetWindows).set({ payload })
            .where(and(eq(analysisBudgetWindows.day, windowDay), eq(analysisBudgetWindows.scope, scope)));
        }
        await transaction.insert(analysisReservations).values(result.reservation);
        await transaction.insert(analysisBatchesTable).values(result.batches.map(({ guideId: batchGuideId, runId, index, ...payload }) => ({ guideId: batchGuideId, runId, index, status: payload.status, payload })));
        return result;
      });
    } catch (error) {
      if (error instanceof FundingRollback) return error.result;
      throw error;
    }
  }

  async getAnalysisFunding(guideId: string, runId: string) {
    return this.database.transaction(async (transaction) => {
      const [guide] = await transaction.select({ id: guides.id }).from(guides).where(eq(guides.id, guideId)).limit(1).for("share");
      if (!guide) return null;
      const [row] = await transaction.select().from(analysisReservations)
        .where(and(eq(analysisReservations.guideId, guideId), eq(analysisReservations.runId, runId))).limit(1);
      if (!row?.details) return null;
      const batches = await transaction.select().from(analysisBatchesTable)
        .where(and(eq(analysisBatchesTable.guideId, guideId), eq(analysisBatchesTable.runId, runId))).orderBy(asc(analysisBatchesTable.index));
      const result = { reservation: parseReservation(row), batches: batches.map(batchFromRow) };
      validateFundingAnalysis(await loadAnalysisRows(transaction, guideId), result.reservation, result.batches);
      const attempts = await loadRequestAttempts(transaction, guideId, runId);
      reservationAccounted(result.reservation, attempts);
      validateBatchSettlements(result.batches, attempts);
      return result;
    });
  }

  async getAnalysisBudgetWindow(day: string, scope: string) {
    fundingWindowIdentity(day, scope);
    const [row] = await this.database.select().from(analysisBudgetWindows)
      .where(and(eq(analysisBudgetWindows.day, day), eq(analysisBudgetWindows.scope, scope))).limit(1);
    return row ? parseBudgetWindow({ ...row.payload, day: row.day, scope: row.scope }) : null;
  }

  /** Bounded, cursor-based recovery discovery; no transition or provider permission. */
  async listPendingAnalysisCounts(limit = 20, after?: string) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (after !== undefined && !/^[a-f0-9]{64}$/.test(after))) throw new AnalysisCountError();
    try {
      const rows = await this.database.select().from(analysisCountAttempts).where(and(
        inArray(analysisCountAttempts.status, ["reserved", "sending", "launch_claimed"]),
        after === undefined ? undefined : gt(analysisCountAttempts.requestKey, after))).orderBy(asc(analysisCountAttempts.requestKey)).limit(limit);
      return rows.map((row) => parseCountRecord({ ...row.payload, requestKey: row.requestKey, guideId: row.guideId,
        runId: row.runId, batchIndex: row.batchIndex, generationOrdinal: row.generationOrdinal, status: row.status }));
    } catch { throw new AnalysisCountError("ANALYSIS_COUNT_UNAVAILABLE"); }
  }

  async claimAnalysisCountLaunch(guideId: string, raw: AnalysisCountLaunchCommand, now?: Date, beforeCommit?: () => void): Promise<object> {
    const command = parseCountCommand(raw);
    if (command.type !== "claim-launch") throw new AnalysisCountError();
    const result = await this.executeAnalysisCount(guideId, command, now, beforeCommit);
    if (result.replayed || result.record.status !== "launch_claimed" || !result.quotaReceipt) throw new AnalysisCountError();
    const ticket = Object.freeze({});
    this.#countLaunchTickets.set(ticket, { guideId, command: structuredClone(command) });
    return ticket;
  }

  /** Consumes a local capability BEFORE any await. Final transaction is read-only:
   * external work cannot roll back, so all durable writes precede this boundary.
   */
  async launchAnalysisCount(ticket: object, launch: (clock: () => Date) => void, now?: Date, beforeLaunch?: (clock: () => Date) => void): Promise<boolean> {
    const permission = this.#countLaunchTickets.get(ticket);
    this.#countLaunchTickets.delete(ticket);
    if (!permission) return false;
    try {
      const { guideId, command } = permission;
      const fixedTime = now === undefined ? undefined : workTime(now);
      return await this.database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL lock_timeout = '4s'`);
        await transaction.execute(sql`SET LOCAL statement_timeout = '4s'`);
        const control = await lockAccountingControl(transaction);
        await checkLockedActivation(transaction, this, control, guideId);
        const [guide] = await transaction.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
        if (!guide) return false;
        const [stored] = await transaction.select().from(analysisReservations).where(and(
          eq(analysisReservations.guideId, guideId), eq(analysisReservations.runId, command.runId))).limit(1);
        if (!stored?.details) return false;
        const reservation = parseReservation(stored);
        const [old] = await transaction.select().from(analysisCountAttempts)
          .where(eq(analysisCountAttempts.requestKey, countRequestKey(guideId, command))).limit(1);
        if (!old) return false;
        const record = parseCountRecord({ ...old.payload, requestKey: old.requestKey, guideId: old.guideId, runId: old.runId,
          batchIndex: old.batchIndex, generationOrdinal: old.generationOrdinal, status: old.status });
        if (record.status !== "launch_claimed") return false;
        const [quota] = await transaction.select().from(analysisProviderQuotaCharges)
          .where(eq(analysisProviderQuotaCharges.requestKey, record.requestKey)).limit(1);
        const receipt = parseQuotaReceipt(quota);
        const windows: Array<ReturnType<typeof parseBudgetWindow>> = [];
        for (const scope of ["global", `guide:${guideId}`]) {
          const [row] = await transaction.select().from(analysisBudgetWindows).where(and(
            eq(analysisBudgetWindows.day, reservation.day), eq(analysisBudgetWindows.scope, scope))).limit(1);
          windows.push(parseBudgetWindow(row ? { ...row.payload, day: row.day, scope: row.scope } : undefined));
        }
        const analysis = await loadAnalysisRows(transaction, guideId);
        const steps = await transaction.select().from(guideSteps).where(eq(guideSteps.guideId, guideId));
        const batches = await transaction.select().from(analysisBatchesTable).where(and(
          eq(analysisBatchesTable.guideId, guideId), eq(analysisBatchesTable.runId, command.runId))).orderBy(asc(analysisBatchesTable.index));
        const attempts = await loadRequestAttempts(transaction, guideId, command.runId);
        const started = performance.now(); const at = await analysisWorkClock(transaction, fixedTime);
        const clock = () => fixedTime ? workTime(fixedTime) : new Date(at.valueOf() + Math.ceil(performance.now() - started));
        const guard = () => {
          if (!matchesAnalysisActivation(control.activation, analysisActivations.get(this), guideId, clock())) throw new AnalysisCountError("ANALYSIS_COUNT_UNAVAILABLE");
          // Re-evaluate the full claim prerequisites without persisting/reissuing it.
          prepareCountAccounting({ guideId, guide: { ...guideFromRow(guide), steps: steps.map(stepFromRow) }, analysis,
            reservation, batches: batches.map(batchFromRow), attempts, windows, control,
            previous: { ...record, status: "sending" }, command, now: clock() });
          assertQuotaPermit(receipt, { requestKey: record.requestKey, projectRef: command.binding.projectRef, model: command.binding.model,
            inputTokenBound: record.maximum.inputTokens, limits: command.limits, notAfter: command.notAfter }, clock());
        };
        guard(); validateFundingCommit(() => beforeLaunch?.(clock)); guard();
        // No write or await between this check and the synchronous launch callback.
        validateFundingCommit(() => launch(clock));
        return true;
      }, { isolationLevel: "read committed" });
    } catch { throw new AnalysisCountError("ANALYSIS_COUNT_UNAVAILABLE"); }
  }

  /** PostgreSQL-only count accounting. Not exposed through HTTP or the automatic worker.
   * A sending transition commits its own provider quota charge atomically. It is NOT
   * the final locked, one-shot launch boundary; claimAnalysisCountLaunch and
   * launchAnalysisCount provide that boundary separately after the durable charge.
   */
  async executeAnalysisCount(guideId: string, raw: AnalysisCountCommand, now?: Date, beforeCommit?: () => void):
    Promise<AnalysisCountResult & { quotaReceipt: AnalysisQuotaReceipt | null }> {
    try {
      const command = parseCountCommand(raw); const fixedTime = now === undefined ? undefined : workTime(now);
      const guard = () => validateFundingCommit(beforeCommit);
      guard();
      return await this.database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL lock_timeout = '4s'`);
        await transaction.execute(sql`SET LOCAL statement_timeout = '4s'`);
        const control = await lockAccountingControl(transaction); guard();
        if (["reserve", "sending", "claim-launch"].includes(command.type)) await checkLockedActivation(transaction, this, control, guideId);
        const [stored] = await transaction.select().from(analysisReservations).where(and(
          eq(analysisReservations.guideId, guideId), eq(analysisReservations.runId, command.runId))).limit(1);
        if (!stored) throw new AnalysisCountError("ANALYSIS_COUNT_UNAVAILABLE");
        const reservation = parseReservation(stored);
        const windows = [];
        for (const scope of ["global", `guide:${guideId}`]) {
          const [row] = await transaction.select().from(analysisBudgetWindows).where(and(
            eq(analysisBudgetWindows.day, reservation.day), eq(analysisBudgetWindows.scope, scope))).limit(1).for("update");
          windows.push(parseBudgetWindow(row ? { ...row.payload, day: row.day, scope: row.scope } : undefined));
        }
        const [guide] = await transaction.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
        const steps = guide ? await transaction.select().from(guideSteps).where(eq(guideSteps.guideId, guideId)) : [];
        const batches = await transaction.select().from(analysisBatchesTable).where(and(
          eq(analysisBatchesTable.guideId, guideId), eq(analysisBatchesTable.runId, command.runId))).orderBy(asc(analysisBatchesTable.index));
        const [old] = await transaction.select().from(analysisCountAttempts)
          .where(eq(analysisCountAttempts.requestKey, countRequestKey(guideId, command))).limit(1);
        const previous = old ? parseCountRecord({ ...old.payload, requestKey: old.requestKey, guideId: old.guideId,
          runId: old.runId, batchIndex: old.batchIndex, generationOrdinal: old.generationOrdinal, status: old.status }) : null;
        const analysis = guide ? await loadAnalysisRows(transaction, guideId) : emptyAnalysisState();
        const attempts = await loadRequestAttempts(transaction, guideId, command.runId);
        const at = await analysisWorkClock(transaction, fixedTime);
        const prepared = prepareCountAccounting({ guideId, guide: guide ? { ...guideFromRow(guide), steps: steps.map(stepFromRow) } : null,
          analysis, reservation, batches: batches.map(batchFromRow), attempts, previous, windows, control, command, now: at });
        const { windows: nextWindows, control: nextControl, ...result } = prepared;
        guard();
        if (result.replayed) return { ...result, quotaReceipt: null };
        let quotaReceipt: AnalysisQuotaReceipt | null = null;
        if (command.type === "sending") {
          const rows = await transaction.select().from(analysisProviderQuotaCharges).where(and(
            eq(analysisProviderQuotaCharges.scopeKey, result.record.scopeKey),
            sql`${analysisProviderQuotaCharges.validUntil} >= ${quotaCoverageStart(at)}`)).limit(100_001);
          if (rows.length > 100_000) throw new AnalysisCountError("ANALYSIS_COUNT_UNAVAILABLE");
          // Conservative policy: count and generation share this model/project pool.
          // No assumption that Google's countTokens endpoint has identical published limits.
          quotaReceipt = prepareQuotaCharge({ requestKey: result.record.requestKey, projectRef: command.binding.projectRef,
            model: command.binding.model, inputTokenBound: result.record.maximum.inputTokens,
            limits: command.limits, notAfter: command.notAfter }, rows.map(parseQuotaReceipt), at);
          await transaction.insert(analysisProviderQuotaCharges).values(quotaReceipt);
        }
        if (command.type === "claim-launch") {
          const [row] = await transaction.select().from(analysisProviderQuotaCharges)
            .where(eq(analysisProviderQuotaCharges.requestKey, result.record.requestKey)).limit(1);
          quotaReceipt = parseQuotaReceipt(row);
          assertQuotaPermit(quotaReceipt, { requestKey: result.record.requestKey, projectRef: command.binding.projectRef,
            model: command.binding.model, inputTokenBound: result.record.maximum.inputTokens, limits: command.limits, notAfter: command.notAfter }, at);
        }
        for (const { day, scope, ...payload } of nextWindows) await transaction.update(analysisBudgetWindows).set({ payload })
          .where(and(eq(analysisBudgetWindows.day, day), eq(analysisBudgetWindows.scope, scope)));
        const { requestKey, guideId: g, runId, batchIndex, generationOrdinal, status, ...payload } = result.record;
        const values = { requestKey, guideId: g, runId, batchIndex, generationOrdinal, status, payload };
        if (previous) await transaction.update(analysisCountAttempts).set({ status, payload }).where(eq(analysisCountAttempts.requestKey, requestKey));
        else await transaction.insert(analysisCountAttempts).values(values);
        if (nextControl.halted !== control.halted) await transaction.update(analysisAccountingControls).set({ payload: nextControl })
          .where(eq(analysisAccountingControls.id, "global"));
        guard(); // Rolls back record + both windows + quota + halt together on failure/revocation.
        return { ...result, quotaReceipt };
      }, { isolationLevel: "read committed" });
    } catch (error) {
      if (error instanceof AnalysisCountError) throw error;
      throw new AnalysisCountError("ANALYSIS_COUNT_UNAVAILABLE");
    }
  }

  async executeAnalysisAccounting(guideId: string, command: AnalysisAccountingCommand, now?: Date, beforeCommit?: () => void): Promise<AnalysisAccountingResult | null> {
    command = parseAccountingCommand(command);
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.database.transaction(async (transaction) => {
      const control = await lockAccountingControl(transaction);
      if (command.type === "allocate" || command.type === "sending") await checkLockedActivation(transaction, this, control, guideId);
      const reservationWhere = and(eq(analysisReservations.guideId, guideId), eq(analysisReservations.runId, command.runId));
      const [initial] = await transaction.select().from(analysisReservations).where(reservationWhere).limit(1);
      if (!initial?.details) return null;
      const windows = [];
      for (const scope of ["global", `guide:${guideId}`]) {
        const [row] = await transaction.select().from(analysisBudgetWindows)
          .where(and(eq(analysisBudgetWindows.day, initial.day), eq(analysisBudgetWindows.scope, scope))).limit(1).for("update");
        windows.push(parseBudgetWindow(row ? { ...row.payload, day: row.day, scope: row.scope } : undefined));
      }
      const [guide] = await transaction.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
      if (!guide) return null;
      // Deletion could have committed before the parent lock; never recreate details.
      const [reservation] = await transaction.select().from(analysisReservations).where(reservationWhere).limit(1);
      if (!reservation?.details) return null;
      const batches = await transaction.select().from(analysisBatchesTable)
        .where(and(eq(analysisBatchesTable.guideId, guideId), eq(analysisBatchesTable.runId, command.runId))).orderBy(asc(analysisBatchesTable.index));
      const steps = await transaction.select().from(guideSteps).where(eq(guideSteps.guideId, guideId));
      const prepared = prepareAnalysisAccounting({ guide: { ...guideFromRow(guide), steps: steps.map(stepFromRow) },
        analysis: await loadAnalysisRows(transaction, guideId), reservation: parseReservation(reservation),
        attempts: await loadRequestAttempts(transaction, guideId, command.runId),
        batches: batches.map(batchFromRow),
        windows, control, command, now: await analysisWorkClock(transaction, fixedTime) });
      if (!prepared) return null;
      const { windows: nextWindows, control: nextControl, ...result } = prepared;
      if (result.replayed) return result;
      validateFundingCommit(beforeCommit);
      for (const { day, scope, ...payload } of nextWindows) {
        await transaction.update(analysisBudgetWindows).set({ payload })
          .where(and(eq(analysisBudgetWindows.day, day), eq(analysisBudgetWindows.scope, scope)));
      }
      const { guideId: attemptGuideId, runId, batchIndex, ordinal, dispatchId, status, ...payload } = result.attempt;
      await transaction.insert(analysisRequestAttempts).values({ guideId: attemptGuideId, runId, batchIndex, ordinal, dispatchId, status, payload })
        .onConflictDoUpdate({ target: [analysisRequestAttempts.guideId, analysisRequestAttempts.runId, analysisRequestAttempts.batchIndex, analysisRequestAttempts.ordinal],
          set: { status, payload } });
      if (nextControl.halted !== control.halted) await transaction.update(analysisAccountingControls).set({ payload: nextControl })
        .where(eq(analysisAccountingControls.id, "global"));
      return result;
    }, { isolationLevel: "read committed" }); // Recheck ownership from a fresh snapshot after the control lock.
  }

  async getAnalysisRequestAttempts(guideId: string, runId: string) {
    return this.database.transaction(async (transaction) => {
      const [guide] = await transaction.select({ id: guides.id }).from(guides).where(eq(guides.id, guideId)).limit(1).for("share");
      if (!guide) return null;
      const [reservation] = await transaction.select().from(analysisReservations)
        .where(and(eq(analysisReservations.guideId, guideId), eq(analysisReservations.runId, runId))).limit(1);
      if (!reservation?.details) return null;
      const attempts = await loadRequestAttempts(transaction, guideId, runId);
      reservationAccounted(parseReservation(reservation), attempts);
      return attempts;
    });
  }

  async getAnalysisAccountingControl() {
    const [row] = await this.database.select().from(analysisAccountingControls).where(eq(analysisAccountingControls.id, "global")).limit(1);
    return parseAccountingControl(row?.payload);
  }

  async launchAnalysisRequest(guideId: string, command: AnalysisSendCommand, launch: (lockedClock: () => Date) => void, now?: Date, beforeLaunch?: (lockedAt: Date) => void): Promise<boolean> {
    command = parseAnalysisSend(command);
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.database.transaction(async (transaction) => {
      const control = await lockAccountingControl(transaction);
      await checkLockedActivation(transaction, this, control, guideId);
      const [guide] = await transaction.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
      if (!guide) return false;
      const [stored] = await transaction.select().from(analysisReservations).where(and(
        eq(analysisReservations.guideId, guideId), eq(analysisReservations.runId, command.runId))).limit(1);
      if (!stored?.details) return false;
      const analysis = await loadAnalysisRows(transaction, guideId);
      const rows = await transaction.select().from(analysisBatchesTable).where(and(eq(analysisBatchesTable.guideId, guideId),
        eq(analysisBatchesTable.runId, command.runId))).orderBy(asc(analysisBatchesTable.index));
      const steps = await transaction.select().from(guideSteps).where(eq(guideSteps.guideId, guideId));
      const attempts = await loadRequestAttempts(transaction, guideId, command.runId);
      const clockStarted = performance.now();
      const lockedAt = await analysisWorkClock(transaction, fixedTime);
      // Charge permits must not use a stale DB timestamp after callback preparation.
      // Count the full query round trip conservatively; a test's explicit clock stays fixed.
      const lockedClock = () => fixedTime ? workTime(fixedTime) : new Date(lockedAt.valueOf() + Math.ceil(performance.now() - clockStarted));
      if (!canLaunchAnalysisRequest({ guide: { ...guideFromRow(guide), steps: steps.map(stepFromRow) }, analysis,
        reservation: parseReservation(stored), batches: rows.map(batchFromRow), attempts, halted: control.halted,
        command, now: lockedAt })) return false;
      validateFundingCommit(() => beforeLaunch?.(lockedAt));
      // Cancel/delete/media replacement need the guide lock; halt/takeover need the control lock.
      // Start the request now, but do NOT await its response or hold locks across network latency.
      validateFundingCommit(() => {
        if (!matchesAnalysisActivation(control.activation, analysisActivations.get(this), guideId, lockedClock())) throw new AnalysisAccountingError("ANALYSIS_ACCOUNTING_HALTED");
        launch(lockedClock);
      });
      return true;
    }, { isolationLevel: "read committed" });
  }

  async completeAnalysisBatch(guideId: string, command: AnalysisBatchCompletion, now?: Date, beforeCommit?: () => void): Promise<AnalysisBatchCompletionResult | null> {
    command = parseBatchCompletion(command);
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.database.transaction(async (transaction) => {
      const control = await lockAccountingControl(transaction);
      const reservationWhere = and(eq(analysisReservations.guideId, guideId), eq(analysisReservations.runId, command.runId));
      const [initial] = await transaction.select().from(analysisReservations).where(reservationWhere).limit(1);
      if (!initial?.details) return null;
      const windows = [];
      for (const scope of ["global", `guide:${guideId}`]) {
        const [row] = await transaction.select().from(analysisBudgetWindows).where(and(
          eq(analysisBudgetWindows.day, initial.day), eq(analysisBudgetWindows.scope, scope))).limit(1).for("update");
        windows.push(parseBudgetWindow(row ? { ...row.payload, day: row.day, scope: row.scope } : undefined));
      }
      const [guide] = await transaction.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
      if (!guide) return null;
      const [stored] = await transaction.select().from(analysisReservations).where(reservationWhere).limit(1);
      if (!stored?.details) return null;
      const batchRows = await transaction.select().from(analysisBatchesTable).where(and(
        eq(analysisBatchesTable.guideId, guideId), eq(analysisBatchesTable.runId, command.runId))).orderBy(asc(analysisBatchesTable.index));
      const previous = await loadAnalysisRows(transaction, guideId);
      const steps = await transaction.select().from(guideSteps).where(eq(guideSteps.guideId, guideId));
      const attempts = await loadRequestAttempts(transaction, guideId, command.runId);
      const batches = batchRows.map(batchFromRow);
      const prepared = prepareBatchCompletion({ guide: { ...guideFromRow(guide), steps: steps.map(stepFromRow) },
        analysis: previous, reservation: parseReservation(stored), batches, attempts, windows, control, command,
        now: await analysisWorkClock(transaction, fixedTime) });
      if (!prepared) return null;
      if (prepared.result.replayed) return clone(prepared.result);
      validateFundingCommit(beforeCommit);
      const { accounting, result } = prepared;
      for (const { day, scope, ...payload } of accounting.windows) {
        await transaction.update(analysisBudgetWindows).set({ payload }).where(and(
          eq(analysisBudgetWindows.day, day), eq(analysisBudgetWindows.scope, scope)));
      }
      if (!accounting.replayed) await persistRequestAttempt(transaction, accounting.attempt);
      for (const batch of prepared.batches) {
        if (JSON.stringify(batch) === JSON.stringify(batches.find((b) => b.index === batch.index))) continue;
        const { guideId: batchGuideId, runId, index, ...payload } = batch;
        await transaction.insert(analysisBatchesTable).values({ guideId: batchGuideId, runId, index, status: batch.status, payload })
          .onConflictDoUpdate({ target: [analysisBatchesTable.guideId, analysisBatchesTable.runId, analysisBatchesTable.index],
            set: { status: batch.status, payload } });
      }
      await persistAnalysisRows(transaction, guideId, previous, result.analysis);
      if (accounting.control.halted !== control.halted) await transaction.update(analysisAccountingControls).set({ payload: accounting.control })
        .where(eq(analysisAccountingControls.id, "global"));
      return clone(result);
    }, { isolationLevel: "read committed" });
  }

  async failAnalysisWork(guideId: string, command: AnalysisWorkFailure, now?: Date, beforeCommit?: () => void): Promise<AnalysisState | null> {
    command = parseWorkFailure(command);
    const fixedTime = now === undefined ? undefined : workTime(now);
    return this.database.transaction(async (transaction) => {
      await lockAccountingControl(transaction);
      const [guide] = await transaction.select().from(guides).where(eq(guides.id, guideId)).limit(1).for("update");
      if (!guide) return null;
      const [stored] = await transaction.select().from(analysisReservations).where(and(
        eq(analysisReservations.guideId, guideId), eq(analysisReservations.runId, command.runId))).limit(1);
      if (!stored?.details) return null;
      const previous = await loadAnalysisRows(transaction, guideId);
      const rows = await transaction.select().from(analysisBatchesTable).where(and(eq(analysisBatchesTable.guideId, guideId),
        eq(analysisBatchesTable.runId, command.runId))).orderBy(asc(analysisBatchesTable.index));
      const steps = await transaction.select().from(guideSteps).where(eq(guideSteps.guideId, guideId));
      const attempts = await loadRequestAttempts(transaction, guideId, command.runId);
      const prepared = prepareAnalysisWorkFailure({ guide: { ...guideFromRow(guide), steps: steps.map(stepFromRow) },
        analysis: previous, reservation: parseReservation(stored), batches: rows.map(batchFromRow), attempts, command,
        now: await analysisWorkClock(transaction, fixedTime) });
      if (!prepared) return null;
      validateFundingCommit(beforeCommit);
      await persistAnalysisRows(transaction, guideId, previous, prepared.analysis);
      for (const attempt of prepared.attempts) if (attempt.status !== attempts.find((a) =>
        a.batchIndex === attempt.batchIndex && a.ordinal === attempt.ordinal)?.status) await persistRequestAttempt(transaction, attempt);
      return clone(prepared.analysis);
    }, { isolationLevel: "read committed" });
  }

  async createGuide(input: CreateGuideInput): Promise<Guide> {
    const guide = buildGuide(input);
    const [created] = await this.database.insert(guides).values(guideToInsert(guide)).returning();
    return guideFromRow(created);
  }

  async getGuideById(id: string): Promise<GuideWithSteps | null> {
    const [row] = await this.database.select().from(guides).where(eq(guides.id, id)).limit(1);
    if (!row) return null;
    return { ...guideFromRow(row), steps: await this.listSteps(id) };
  }

  async getGuideBySlug(slug: string): Promise<GuideWithSteps | null> {
    const [row] = await this.database.select().from(guides).where(eq(guides.slug, slug)).limit(1);
    if (!row) return null;
    return { ...guideFromRow(row), steps: await this.listSteps(row.id) };
  }

  async verifyEditToken(guideId: string, token: string): Promise<boolean> {
    const [row] = await this.database
      .select({ editTokenHash: guides.editTokenHash })
      .from(guides)
      .where(eq(guides.id, guideId))
      .limit(1);
    return row ? verifyEditTokenHash(token, row.editTokenHash) : false;
  }

  async updateStatus(
    guideId: string,
    status: GuideStatus,
    update?: GuideStatusUpdate,
  ): Promise<Guide | null> {
    if (!isGuideStatus(status)) throw new TypeError(`Unknown guide status: ${String(status)}`);
    validateExpectedStatuses(update?.expectedStatuses);
    validateExpectedAttempt(
      update?.expectedProcessingAttemptId,
      update?.expectedProcessingAttemptCount,
    );
    if (update?.expectedStatuses?.length === 0) return null;

    const values: Partial<NewGuideRow> = {
      status,
      statusMessage:
        update?.statusMessage === undefined
          ? DEFAULT_GUIDE_STATUS_MESSAGES[status]
          : requireNonEmpty(update.statusMessage, "statusMessage"),
      updatedAt: new Date(),
      ...(update?.progress !== undefined
        ? { progress: normalizeProgress(update.progress) }
        : status === "ready"
          ? { progress: 100 }
          : {}),
      ...(update?.durationMs !== undefined
        ? { durationMs: optionalNonNegativeInteger(update.durationMs, "durationMs") ?? null }
        : {}),
      ...(update?.sourceWidth !== undefined
        ? { sourceWidth: optionalNonNegativeInteger(update.sourceWidth, "sourceWidth") ?? null }
        : {}),
      ...(update?.sourceHeight !== undefined
        ? { sourceHeight: optionalNonNegativeInteger(update.sourceHeight, "sourceHeight") ?? null }
        : {}),
      ...(update?.displayWidth !== undefined
        ? { displayWidth: optionalNonNegativeInteger(update.displayWidth, "displayWidth") ?? null }
        : {}),
      ...(update?.displayHeight !== undefined
        ? { displayHeight: optionalNonNegativeInteger(update.displayHeight, "displayHeight") ?? null }
        : {}),
      ...(update?.rotationDegrees !== undefined
        ? {
            rotationDegrees:
              optionalNonNegativeInteger(update.rotationDegrees, "rotationDegrees") ?? null,
          }
        : {}),
      ...(update?.errorCode !== undefined
        ? { errorCode: update.errorCode }
        : status !== "failed"
          ? { errorCode: null }
          : {}),
      ...(update?.errorMessage !== undefined
        ? { errorMessage: update.errorMessage }
        : status !== "failed"
          ? { errorMessage: null }
          : {}),
      ...(status === "uploading" || status === "queued"
        ? { processingAttemptId: null }
        : {}),
    };

    const expected = update?.expectedStatuses;
    const expectedAttemptId = update?.expectedProcessingAttemptId;
    const predicate = and(
      eq(guides.id, guideId),
      status === "failed" && ["DELETION_PENDING", "DELETION_PENDING_ACTIVE"].includes(update?.errorCode ?? "") ? undefined
        : or(isNull(guides.errorCode), sql`${guides.errorCode} <> ${PRIVATE_MEDIA_EXPIRED}`),
      update?.expectedUpdatedAt === undefined
        ? undefined
        : eq(guides.updatedAt, new Date(update.expectedUpdatedAt)),
      expected ? inArray(guides.status, [...expected]) : undefined,
      expectedAttemptId === undefined
        ? undefined
        : expectedAttemptId === null
          ? isNull(guides.processingAttemptId)
          : eq(guides.processingAttemptId, expectedAttemptId),
      update?.expectedProcessingAttemptCount === undefined
        ? undefined
        : eq(guides.processingAttemptCount, update.expectedProcessingAttemptCount),
      update?.expectedErrorCode === undefined
        ? undefined
        : update.expectedErrorCode === null
          ? isNull(guides.errorCode)
          : eq(guides.errorCode, update.expectedErrorCode),
    );
    const [updated] = await this.database
      .update(guides)
      .set(values)
      .where(predicate)
      .returning();
    return updated ? guideFromRow(updated) : null;
  }

  async claimUploadLease(
    guideId: string,
    leaseId: string,
    options: ClaimUploadLeaseOptions,
  ): Promise<Guide | null> {
    const lease = validateUploadLease(leaseId, options);
    const [claimed] = await this.database
      .update(guides)
      .set({ processingAttemptId: lease.leaseId, updatedAt: new Date() })
      .where(and(
        eq(guides.id, guideId),
        eq(guides.status, "uploading"),
        lease.expectedProcessingAttemptId === null
          ? isNull(guides.processingAttemptId)
          : eq(guides.processingAttemptId, lease.expectedProcessingAttemptId),
        eq(guides.updatedAt, new Date(lease.expectedUpdatedAt)),
      ))
      .returning();
    return claimed ? guideFromRow(claimed) : null;
  }

  async renewUploadLease(guideId: string, leaseId: string): Promise<Guide | null> {
    requireNonEmpty(leaseId, "leaseId");
    const [renewed] = await this.database
      .update(guides)
      .set({ updatedAt: new Date() })
      .where(and(
        eq(guides.id, guideId),
        eq(guides.status, "uploading"),
        eq(guides.processingAttemptId, leaseId),
      ))
      .returning();
    return renewed ? guideFromRow(renewed) : null;
  }

  async claimProcessingAttempt(
    guideId: string,
    attemptId: string,
    rawOptions?: ClaimProcessingAttemptOptions,
  ): Promise<Guide | null> {
    const options = validateClaimOptions(attemptId, rawOptions);
    if (options.expectedStatuses.length === 0) return null;

    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(guides)
        .where(eq(guides.id, guideId))
        .limit(1)
        .for("update");
      if (!row) return null;

      const current = guideFromRow(row);
      if (privateMediaExpired(current) || !options.expectedStatuses.includes(current.status)) return null;
      if (
        !matchesExpectedAttempt(
          current,
          options.expectedProcessingAttemptId,
          options.expectedProcessingAttemptCount,
        )
      ) return null;

      const next = current.processingAttemptCount >= options.maxAttempts
        ? exhaustedGuide(current, options)
        : claimedGuide(current, attemptId, options);
      const [updated] = await transaction
        .update(guides)
        .set({
          status: next.status,
          statusMessage: next.statusMessage,
          progress: next.progress,
          processingAttemptId: next.processingAttemptId,
          processingAttemptCount: next.processingAttemptCount,
          errorCode: next.errorCode,
          errorMessage: next.errorMessage,
          updatedAt: new Date(next.updatedAt),
        })
        .where(eq(guides.id, guideId))
        .returning();
      return updated ? guideFromRow(updated) : null;
    });
  }

  async completeProcessingAttempt(
    guideId: string,
    input: CompleteProcessingAttemptInput,
  ): Promise<GuideWithSteps | null> {
    const attemptId = requireNonEmpty(input.attemptId, "attemptId");
    const attemptCount = requirePositiveInteger(input.attemptCount, "attemptCount");
    const now = new Date().toISOString();
    const nextSteps = buildSteps(guideId, input.steps, now);

    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(guides)
        .where(eq(guides.id, guideId))
        .limit(1)
        .for("update");
      if (!row) return null;

      const current = guideFromRow(row);
      if (
        current.status !== "extracting" ||
        current.processingAttemptId !== attemptId ||
        current.processingAttemptCount !== attemptCount
      ) return null;

      const nextGuide = applyStatusUpdate(current, "ready", {
        progress: 100,
        statusMessage: input.statusMessage,
      });
      await transaction.delete(guideSteps).where(eq(guideSteps.guideId, guideId));
      const created = nextSteps.length
        ? await transaction
            .insert(guideSteps)
            .values(nextSteps.map(stepToInsert))
            .returning()
        : [];
      const [updated] = await transaction
        .update(guides)
        .set({
          status: nextGuide.status,
          statusMessage: nextGuide.statusMessage,
          progress: nextGuide.progress,
          errorCode: nextGuide.errorCode,
          errorMessage: nextGuide.errorMessage,
          updatedAt: new Date(nextGuide.updatedAt),
        })
        .where(and(
          eq(guides.id, guideId),
          eq(guides.status, "extracting"),
          eq(guides.processingAttemptId, attemptId),
          eq(guides.processingAttemptCount, attemptCount),
        ))
        .returning();
      if (!updated) {
        throw new RepositoryDataError(
          `Guide ${guideId} changed while its completion transaction held a row lock.`,
        );
      }
      return {
        ...guideFromRow(updated),
        steps: created.map(stepFromRow).sort((left, right) => left.position - right.position),
      };
    });
  }

  async deleteGuide(guideId: string, options?: DeleteGuideOptions): Promise<boolean> {
    validateExpectedStatuses(options?.expectedStatuses);
    validateExpectedAttempt(
      options?.expectedProcessingAttemptId,
      options?.expectedProcessingAttemptCount,
    );
    if (options?.expectedStatuses?.length === 0) return false;

    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(guides)
        .where(eq(guides.id, guideId))
        .limit(1)
        .for("update");
      if (!row) return false;
      const guide = guideFromRow(row);
      if (options?.expectedStatuses && !options.expectedStatuses.includes(guide.status)) return false;
      if (!matchesExpectedAttempt(
        guide,
        options?.expectedProcessingAttemptId,
        options?.expectedProcessingAttemptCount,
      )) return false;
      if (!matchesExpectedErrorCode(guide, options?.expectedErrorCode)) return false;
      if (options?.expectedUpdatedAt !== undefined && guide.updatedAt !== options.expectedUpdatedAt) return false;

      if ((await transaction.select({ id: guideAssets.id }).from(guideAssets).where(eq(guideAssets.guideId, guideId)).limit(1)).length ||
        (await transaction.select({ id: privateMediaCleanup.id }).from(privateMediaCleanup).where(eq(privateMediaCleanup.guideId, guideId)).limit(1)).length) return false;
      await transaction.delete(guideSteps).where(eq(guideSteps.guideId, guideId));
      // Preserve maximum accounting + opaque IDs, remove consent/media/policy details.
      await transaction.update(analysisReservations).set({ details: null }).where(eq(analysisReservations.guideId, guideId));
      const deleted = await transaction
        .delete(guides)
        .where(eq(guides.id, guideId))
        .returning({ id: guides.id });
      return deleted.length === 1;
    });
  }

  async listByStatuses(statuses: readonly GuideStatus[], limit?: number): Promise<Guide[]> {
    const safeLimit = normalizedLimit(limit);
    if (statuses.length === 0) return [];
    if (statuses.some((status) => !isGuideStatus(status))) {
      throw new TypeError("statuses contains an unknown guide status.");
    }
    const rows = await this.database
      .select()
      .from(guides)
      .where(inArray(guides.status, [...statuses]))
      .orderBy(asc(guides.updatedAt))
      .limit(safeLimit);
    return rows.map(guideFromRow);
  }

  async listFailedByErrorCodes(errorCodes: readonly string[], limit?: number): Promise<Guide[]> {
    const safeLimit = normalizedLimit(limit);
    if (errorCodes.length === 0) return [];
    const safeErrorCodes = errorCodes.map((code) => requireNonEmpty(code, "errorCode"));
    const rows = await this.database
      .select()
      .from(guides)
      .where(and(
        eq(guides.status, "failed"),
        inArray(guides.errorCode, safeErrorCodes),
      ))
      .orderBy(asc(guides.updatedAt))
      .limit(safeLimit);
    return rows.map(guideFromRow);
  }

  async listFailedExcludingErrorCodes(errorCodes: readonly string[], limit?: number): Promise<Guide[]> {
    const safeLimit = normalizedLimit(limit);
    const safeErrorCodes = errorCodes.map((code) => requireNonEmpty(code, "errorCode"));
    if (safeErrorCodes.length === 0) return this.listByStatuses(["failed"], safeLimit);
    const rows = await this.database
      .select()
      .from(guides)
      .where(and(
        eq(guides.status, "failed"),
        or(
          isNull(guides.errorCode),
          notInArray(guides.errorCode, safeErrorCodes),
        ),
      ))
      .orderBy(asc(guides.updatedAt))
      .limit(safeLimit);
    return rows.map(guideFromRow);
  }

  async listExpiredDrafts(updatedBefore: string, excludedErrorCodes: readonly string[], limit?: number): Promise<Guide[]> {
    const cutoff = normalizeIsoDate(updatedBefore, "updatedBefore");
    const safeLimit = normalizedLimit(limit);
    const excluded = excludedErrorCodes.map((code) => requireNonEmpty(code, "errorCode"));
    const rows = await this.database.select().from(guides).where(and(
      inArray(guides.status, ["ready", "failed"]),
      excluded.length ? or(isNull(guides.errorCode), notInArray(guides.errorCode, excluded)) : undefined,
      lte(guides.updatedAt, new Date(cutoff)),
      // Older deployments saved drafts without touching the parent timestamp.
      // Filter these here, before LIMIT, so recent legacy drafts cannot starve expiry.
      sql`not exists (select 1 from ${guideDrafts} where ${guideDrafts.guideId} = ${guides.id}
        and ${guideDrafts.updatedAt} > ${cutoff}::timestamptz)`,
    )).orderBy(asc(guides.updatedAt)).limit(safeLimit);
    return rows.map(guideFromRow);
  }

  listRecoverable(limit?: number): Promise<Guide[]> {
    return this.listByStatuses(RECOVERABLE_GUIDE_STATUSES, limit);
  }

  async listSteps(guideId: string): Promise<GuideStep[]> {
    const rows = await this.database
      .select()
      .from(guideSteps)
      .where(eq(guideSteps.guideId, guideId))
      .orderBy(asc(guideSteps.position));
    return rows.map(stepFromRow);
  }

  async replaceSteps(
    guideId: string,
    inputs: readonly CreateGuideStepInput[],
  ): Promise<GuideStep[]> {
    const now = new Date().toISOString();
    const nextSteps = buildSteps(guideId, inputs, now);

    return this.database.transaction(async (transaction) => {
      const [guide] = await transaction
        .select({ id: guides.id, status: guides.status, errorCode: guides.errorCode })
        .from(guides)
        .where(eq(guides.id, guideId))
        .limit(1)
        .for("update");
      if (!guide) throw new GuideNotFoundError(guideId);
      if (privateMediaExpired(guide)) throw new GuideNotFoundError(guideId);

      await transaction.delete(guideSteps).where(eq(guideSteps.guideId, guideId));
      const created = nextSteps.length
        ? await transaction
            .insert(guideSteps)
            .values(nextSteps.map(stepToInsert))
            .returning()
        : [];
      await transaction
        .update(guides)
        .set({ updatedAt: new Date(now) })
        .where(eq(guides.id, guideId));
      return created.map(stepFromRow).sort((left, right) => left.position - right.position);
    });
  }
}

export function createGuideRepository(options: RepositoryFactoryOptions = {}): GuideRepository {
  if (options.pool) return PostgresGuideRepository.fromPool(options.pool);

  const databaseUrl = options.databaseUrl === undefined
    ? process.env.DATABASE_URL?.trim()
    : options.databaseUrl?.trim();
  if (databaseUrl) return PostgresGuideRepository.connect(databaseUrl, options.poolConfig);

  const configuredFilePath =
    options.jsonFilePath ?? process.env.GUIDE_REPOSITORY_FILE?.trim();
  const filePath =
    configuredFilePath || path.resolve(process.cwd(), "processor", ".data", "guides.json");
  return new JsonGuideRepository(filePath);
}
