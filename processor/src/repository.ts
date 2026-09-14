import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { and, asc, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

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
  analysisBatchesTable,
  analysisBudgetWindows,
  analysisReservations,
  analysisRequestAttempts,
  analysisRuns,
  guideDrafts,
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
  reservationAccounted, upgradeFundingLedgerV2,
  type AnalysisFundingCommand, type AnalysisFundingLedger, type AnalysisFundingPolicy, type AnalysisFundingResult,
} from "./analysis-funding.js";
import {
  parseAccountingCommand, parseAccountingControl, parseRequestAttempt,
  type AnalysisAccountingCommand, type AnalysisAccountingResult, type AnalysisRequestAttempt,
} from "./analysis-accounting-contract.js";
import { prepareAnalysisAccounting } from "./analysis-accounting.js";

const JSON_REPOSITORY_VERSION = 3 as const;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;

type JsonRepositoryState = {
  version: typeof JSON_REPOSITORY_VERSION;
  guides: Guide[];
  steps: GuideStep[];
  analysis: Array<{ guideId: string; state: AnalysisState }>;
  funding: AnalysisFundingLedger;
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
  return { version: JSON_REPOSITORY_VERSION, guides: [], steps: [], analysis: [], funding: emptyFundingLedger() };
}

function clone<T>(value: T): T {
  return structuredClone(value);
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
    ![1, 2, JSON_REPOSITORY_VERSION].includes((parsed as { version: number }).version) ||
    !Array.isArray((parsed as { guides?: unknown }).guides) ||
    !Array.isArray((parsed as { steps?: unknown }).steps)
  ) {
    throw new RepositoryDataError(`Unsupported JSON repository shape at ${filePath}.`);
  }

  const state = parsed as JsonRepositoryState;
  const legacyVersion = (parsed as { version: number }).version === 1;
  const fundingV2 = (parsed as { version: number }).version === 2;
  // Older binaries must reject v3 rather than silently discard settlements.
  if (legacyVersion) {
    if (state.funding !== undefined) throw new RepositoryDataError("Invalid legacy funding state.");
    state.funding = emptyFundingLedger();
  }
  if (fundingV2) state.funding = upgradeFundingLedgerV2(state.funding);
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

export class JsonGuideRepository implements GuideRepository {
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
      await this.writeState(state);
      return clone(validated);
    });
  }

  async reserveAnalysisRequest(guideId: string, command: AnalysisFundingCommand, policy: AnalysisFundingPolicy, now = new Date()): Promise<AnalysisFundingResult | null> {
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

  async executeAnalysisAccounting(guideId: string, command: AnalysisAccountingCommand, now = new Date()): Promise<AnalysisAccountingResult | null> {
    command = parseAccountingCommand(command);
    fundingDay(now);
    now = new Date(now.valueOf());
    return this.serialize(async () => {
      const state = await this.readState();
      const guide = state.guides.find((g) => g.id === guideId);
      const reservation = state.funding.reservations.find((r) => r.guideId === guideId && r.runId === command.runId);
      if (!guide || !reservation?.details) return null;
      const prepared = prepareAnalysisAccounting({ guide: { ...guide, steps: state.steps.filter((s) => s.guideId === guideId) },
        analysis: state.analysis.find((a) => a.guideId === guideId)?.state ?? emptyAnalysisState(), reservation,
        attempts: state.funding.attempts.filter((a) => a.guideId === guideId && a.runId === command.runId),
        batches: state.funding.batches.filter((b) => b.guideId === guideId && b.runId === command.runId).sort((a, b) => a.index - b.index),
        windows: state.funding.windows, control: state.funding.control, command, now });
      if (!prepared) return null;
      const { windows, control, ...result } = prepared;
      if (result.replayed) return clone(result);
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
      if (!options.expectedStatuses.includes(current.status)) return null;
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

      state.guides = state.guides.filter((candidate) => candidate.id !== guideId);
      state.steps = state.steps.filter((step) => step.guideId !== guideId);
      state.analysis = state.analysis.filter((entry) => entry.guideId !== guideId);
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
    await transaction.insert(analysisRuns).values({ guideId, id, status, payload })
      .onConflictDoUpdate({ target: [analysisRuns.guideId, analysisRuns.id], set: { status, payload } });
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

// Roll back even provisional zero-valued windows on conflict or racing replay.
class FundingRollback extends Error {
  constructor(readonly result: AnalysisFundingResult | null) { super("Analysis funding transaction not committed."); }
}

export class PostgresGuideRepository implements GuideRepository {
  constructor(
    readonly database: ProcessorDatabase,
    private readonly closeDatabase?: () => Promise<void>,
  ) {}

  static fromPool(pool: Pool, ownsPool = false): PostgresGuideRepository {
    return new PostgresGuideRepository(
      drizzle(pool, { schema: processorSchema }),
      ownsPool ? () => pool.end() : undefined,
    );
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
      return validated;
    });
  }

  getAnalysisState(guideId: string): Promise<AnalysisState | null> { return this.analysisTransaction(guideId); }
  executeAnalysisCommand(guideId: string, command: AnalysisCommand): Promise<AnalysisState | null> {
    return this.analysisTransaction(guideId, command);
  }

  async reserveAnalysisRequest(guideId: string, command: AnalysisFundingCommand, policy: AnalysisFundingPolicy, now = new Date()): Promise<AnalysisFundingResult | null> {
    command = parseFundingCommand(command);
    policy = parseFundingPolicy(policy);
    const day = fundingDay(now);
    now = new Date(now.valueOf());
    try {
      return await this.database.transaction(async (transaction) => {
        const control = await lockAccountingControl(transaction);
        const reservationWhere = and(eq(analysisReservations.guideId, guideId), eq(analysisReservations.runId, command.runId));
        const [initialReservation] = await transaction.select().from(analysisReservations).where(reservationWhere).limit(1);
        const windows = [];
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
          batches: batchRows.map((b) => parseStoredBatch({ ...b.payload, guideId: b.guideId, runId: b.runId, index: b.index })), windows, halted: control.halted });
        if (!prepared) throw new FundingRollback(null);
        const { windows: nextWindows, ...result } = prepared;
        if (result.replayed) {
          if (!initialReservation) throw new FundingRollback(result);
          return result;
        }
        await persistAnalysisRows(transaction, guideId, previous, result.analysis);
        for (const window of nextWindows) {
          const { day: windowDay, scope, ...payload } = window;
          await transaction.update(analysisBudgetWindows).set({ payload })
            .where(and(eq(analysisBudgetWindows.day, windowDay), eq(analysisBudgetWindows.scope, scope)));
        }
        await transaction.insert(analysisReservations).values(result.reservation);
        await transaction.insert(analysisBatchesTable).values(result.batches.map(({ guideId: batchGuideId, runId, index, ...payload }) => ({ guideId: batchGuideId, runId, index, payload })));
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
      const result = { reservation: parseReservation(row), batches: batches.map((b) => parseStoredBatch({ ...b.payload, guideId: b.guideId, runId: b.runId, index: b.index })) };
      validateFundingAnalysis(await loadAnalysisRows(transaction, guideId), result.reservation, result.batches);
      reservationAccounted(result.reservation, await loadRequestAttempts(transaction, guideId, runId));
      return result;
    });
  }

  async getAnalysisBudgetWindow(day: string, scope: string) {
    fundingWindowIdentity(day, scope);
    const [row] = await this.database.select().from(analysisBudgetWindows)
      .where(and(eq(analysisBudgetWindows.day, day), eq(analysisBudgetWindows.scope, scope))).limit(1);
    return row ? parseBudgetWindow({ ...row.payload, day: row.day, scope: row.scope }) : null;
  }

  async executeAnalysisAccounting(guideId: string, command: AnalysisAccountingCommand, now = new Date()): Promise<AnalysisAccountingResult | null> {
    command = parseAccountingCommand(command);
    fundingDay(now);
    now = new Date(now.valueOf());
    return this.database.transaction(async (transaction) => {
      const control = await lockAccountingControl(transaction);
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
        batches: batches.map((b) => parseStoredBatch({ ...b.payload, guideId: b.guideId, runId: b.runId, index: b.index })),
        windows, control, command, now });
      if (!prepared) return null;
      const { windows: nextWindows, control: nextControl, ...result } = prepared;
      if (result.replayed) return result;
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
    });
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
      if (!options.expectedStatuses.includes(current.status)) return null;
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
        .select({ id: guides.id })
        .from(guides)
        .where(eq(guides.id, guideId))
        .limit(1)
        .for("update");
      if (!guide) throw new GuideNotFoundError(guideId);

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
