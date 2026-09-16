import { rm } from "node:fs/promises";

import type { DeleteGuideOptions, Guide, GuideRepository, GuideWithSteps } from "./domain.js";
import type { Storage } from "./storage.js";

export const DELETION_PENDING = "DELETION_PENDING";
export const DELETION_PENDING_ACTIVE = "DELETION_PENDING_ACTIVE";
export const UPLOAD_CANCELLATION_TOMBSTONE = "UPLOAD_CANCELLATION_TOMBSTONE";
const MAX_DURABLE_ATTEMPT_STEPS = 100;
const STORAGE_DELETE_BATCH_SIZE = 20;
const DEFAULT_PRIVATE_STORAGE_TIMEOUT_MS = 30_000;
const inFlightDeletes = new WeakMap<Storage, Map<string, Promise<void>>>();
const inFlightMaterializations = new WeakMap<Storage, Set<string>>();

export class PrivateAssetWriteInterruptedError extends Error {
  override name = "PrivateAssetWriteInterruptedError";
  lateCleanup?: Promise<void>;
}

export class PrivateAssetReadInterruptedError extends Error {
  override name = "PrivateAssetReadInterruptedError";
  lateCleanup?: Promise<void>;
}

export class PrivateAssetDeleteInterruptedError extends Error {
  override name = "PrivateAssetDeleteInterruptedError";
}

type InterruptibleOperationOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

async function waitForPrivateOperation<T>(
  operation: Promise<T>,
  options: InterruptibleOperationOptions,
  createAbortError: () => Error,
  createTimeoutError: (timeoutMs: number) => Error,
): Promise<T> {
  if (options.signal?.aborted) throw createAbortError();
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw createTimeoutError(options.timeoutMs);
  }
  if (!options.signal && options.timeoutMs === undefined) return operation;

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    if (options.signal) {
      onAbort = () => reject(createAbortError());
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => reject(createTimeoutError(options.timeoutMs!)), options.timeoutMs);
    }
  });

  try {
    return await Promise.race([operation, interruption]);
  } finally {
    if (timer) clearTimeout(timer);
    if (options.signal && onAbort) options.signal.removeEventListener("abort", onAbort);
  }
}

export async function putPrivateAsset(
  storage: Storage,
  key: string,
  sourcePath: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  if (options.signal?.aborted) {
    throw new PrivateAssetWriteInterruptedError("Private asset write was aborted before it started.");
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new PrivateAssetWriteInterruptedError(`Private asset write timed out after ${options.timeoutMs}ms.`);
  }
  const operation = Promise.resolve().then(() => {
    if (options.signal?.aborted) {
      throw new PrivateAssetWriteInterruptedError("Private asset write was aborted before it started.");
    }
    return storage.putFile(key, sourcePath);
  });

  try {
    await waitForPrivateOperation(
      operation,
      options,
      () => new PrivateAssetWriteInterruptedError("Private asset write was aborted."),
      (timeoutMs) => new PrivateAssetWriteInterruptedError(`Private asset write timed out after ${timeoutMs}ms.`),
    );
  } catch (error) {
    if (error instanceof PrivateAssetWriteInterruptedError) {
      // The storage SDK has no cancellation primitive. If it commits after the
      // caller has moved on, delete this deterministic private key once more.
      error.lateCleanup = operation.then(
        () => cleanupStorageKeys(storage, [key]),
        () => undefined,
      );
      void error.lateCleanup.catch((lateError: unknown) => {
        console.error(JSON.stringify({
          event: "late_private_asset_cleanup_failed",
          key,
          message: lateError instanceof Error ? lateError.message : String(lateError),
        }));
      });
    }
    throw error;
  }
}

export async function materializePrivateAsset(
  storage: Storage,
  key: string,
  destinationPath: string,
  options: InterruptibleOperationOptions = {},
): Promise<string> {
  if (options.signal?.aborted) {
    throw new PrivateAssetReadInterruptedError("Private asset materialization was aborted before it started.");
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new PrivateAssetReadInterruptedError(`Private asset materialization timed out after ${options.timeoutMs}ms.`);
  }
  let activeKeys = inFlightMaterializations.get(storage);
  if (!activeKeys) {
    activeKeys = new Set();
    inFlightMaterializations.set(storage, activeKeys);
  }
  if (activeKeys.has(key)) {
    throw new PrivateAssetReadInterruptedError("A previous materialization of this private asset is still active.");
  }
  activeKeys.add(key);
  const operation = Promise.resolve().then(() => storage.materialize(key, destinationPath, {
    signal: options.signal,
  }));
  void operation.finally(() => { activeKeys?.delete(key); }).catch(() => undefined);
  try {
    return await waitForPrivateOperation(
      operation,
      options,
      () => new PrivateAssetReadInterruptedError("Private asset materialization was aborted."),
      (timeoutMs) => new PrivateAssetReadInterruptedError(`Private asset materialization timed out after ${timeoutMs}ms.`),
    );
  } catch (error) {
    if (error instanceof PrivateAssetReadInterruptedError) {
      // The worker must be released at its deadline even if the SDK ignores
      // cancellation. Remove a local copy again if that raw read settles late.
      error.lateCleanup = operation.then(
        () => rm(destinationPath, { force: true }),
        () => rm(destinationPath, { force: true }),
      );
      void error.lateCleanup.catch((lateError: unknown) => {
        console.error(JSON.stringify({
          event: "late_private_materialization_cleanup_failed",
          key,
          message: lateError instanceof Error ? lateError.message : String(lateError),
        }));
      });
    }
    throw error;
  }
}

export function sourceObjectKey(guideId: string, extension: string, sha256: string): string {
  return `guides/${guideId}/source/${sha256}${extension}`;
}

export function attemptFrameObjectKey(
  guideId: string,
  attemptCount: number,
  sequence: number,
  variant: "frame" | "thumbnail",
): string {
  const padded = String(sequence).padStart(3, "0");
  const suffix = variant === "thumbnail" ? "-thumb" : "";
  return `guides/${guideId}/attempts/${attemptCount}/frames/frame-${padded}${suffix}.jpg`;
}

export function attemptAssetKeys(guideId: string, attemptCount: number, maxSteps: number): string[] {
  const keys: string[] = [];
  for (let sequence = 1; sequence <= maxSteps; sequence += 1) {
    keys.push(attemptFrameObjectKey(guideId, attemptCount, sequence, "frame"));
    keys.push(attemptFrameObjectKey(guideId, attemptCount, sequence, "thumbnail"));
  }
  return keys;
}

export function durableAttemptAssetKeys(guideId: string, attemptCount: number): string[] {
  return attemptAssetKeys(guideId, attemptCount, MAX_DURABLE_ATTEMPT_STEPS);
}

export function guideAssetKeys(guide: GuideWithSteps, maxSteps: number): string[] {
  const keys = new Set<string>([guide.originalObjectKey]);
  for (const step of guide.steps) {
    if (step.representativeFrameKey) keys.add(step.representativeFrameKey);
    if (step.thumbnailFrameKey) keys.add(step.thumbnailFrameKey);
  }
  for (let attempt = 1; attempt <= guide.processingAttemptCount; attempt += 1) {
    // MAX_STEPS can decrease between deployments. Durable cleanup must still
    // cover every key an earlier supported configuration could have created.
    const durableLimit = Math.max(maxSteps, MAX_DURABLE_ATTEMPT_STEPS);
    for (const key of attemptAssetKeys(guide.id, attempt, durableLimit)) keys.add(key);
  }
  return [...keys];
}

function coalescedStorageDelete(storage: Storage, key: string): Promise<void> {
  let operations = inFlightDeletes.get(storage);
  if (!operations) {
    operations = new Map();
    inFlightDeletes.set(storage, operations);
  }
  const existing = operations.get(key);
  if (existing) return existing;

  const operation = Promise.resolve().then(() => storage.delete(key));
  operations.set(key, operation);
  void operation.finally(() => {
    if (operations?.get(key) === operation) operations.delete(key);
  }).catch(() => undefined);
  return operation;
}

export async function cleanupStorageKeys(
  storage: Storage,
  keys: readonly string[],
  options: InterruptibleOperationOptions = {},
): Promise<void> {
  const failures: unknown[] = [];
  const uniqueKeys = [...new Set(keys)];
  const timeoutMs = options.timeoutMs ?? DEFAULT_PRIVATE_STORAGE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (let offset = 0; offset < uniqueKeys.length; offset += STORAGE_DELETE_BATCH_SIZE) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      failures.push(new PrivateAssetDeleteInterruptedError(`Private asset deletion timed out after ${timeoutMs}ms.`));
      break;
    }
    await Promise.all(uniqueKeys.slice(offset, offset + STORAGE_DELETE_BATCH_SIZE).map(async (key) => {
      try {
        await waitForPrivateOperation(
          coalescedStorageDelete(storage, key),
          { signal: options.signal, timeoutMs: remainingMs },
          () => new PrivateAssetDeleteInterruptedError("Private asset deletion was aborted."),
          () => new PrivateAssetDeleteInterruptedError(`Private asset deletion timed out after ${timeoutMs}ms.`),
        );
      } catch (error) {
        failures.push(new Error(`Failed to delete private object ${key}`, { cause: error }));
      }
    }));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to delete ${failures.length} private object(s).`);
  }
}

export function isDeletionPending(guide: Pick<Guide, "status" | "errorCode">): boolean {
  return guide.status === "failed" && (
    guide.errorCode === DELETION_PENDING ||
    guide.errorCode === DELETION_PENDING_ACTIVE ||
    guide.errorCode === UPLOAD_CANCELLATION_TOMBSTONE
  );
}

export function deferActiveGuideDeletion(
  repository: GuideRepository,
  storage: Storage,
  guide: Guide,
  maxSteps: number,
  writeSettlement: Promise<void>,
): void {
  let stopped = false;
  let heartbeatInFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (stopped || heartbeatInFlight) return;
    heartbeatInFlight = repository.updateStatus(guide.id, "failed", {
      expectedStatuses: ["failed"],
      expectedProcessingAttemptId: guide.processingAttemptId,
      expectedProcessingAttemptCount: guide.processingAttemptCount,
      expectedErrorCode: DELETION_PENDING_ACTIVE,
      progress: 100,
      statusMessage: "진행 중인 저장을 멈추고 개인 영상을 삭제하고 있어요.",
      errorCode: DELETION_PENDING_ACTIVE,
      errorMessage: "진행 중인 비공개 파일 저장이 끝나면 삭제됩니다.",
    }).then((renewed) => {
      if (!renewed) stopped = true;
    }).catch((error: unknown) => {
      console.error(JSON.stringify({
        event: "active_deletion_heartbeat_failed",
        guideId: guide.id,
        message: error instanceof Error ? error.message : String(error),
      }));
    }).finally(() => { heartbeatInFlight = undefined; });
  }, 10_000);
  timer.unref();

  void writeSettlement.then(async () => {
    stopped = true;
    clearInterval(timer);
    await heartbeatInFlight;
    await finalizeGuideDeletion(repository, storage, guide.id, maxSteps, {
      expectedProcessingAttemptId: guide.processingAttemptId,
      expectedProcessingAttemptCount: guide.processingAttemptCount,
    });
  }).catch((error: unknown) => {
    stopped = true;
    clearInterval(timer);
    console.error(JSON.stringify({
      event: "deferred_private_guide_deletion_failed",
      guideId: guide.id,
      message: error instanceof Error ? error.message : String(error),
    }));
    // Keep the durable ACTIVE row. The lifecycle sweeper retries after grace.
  });
}

export async function finalizeGuideDeletion(
  repository: GuideRepository,
  storage: Storage,
  guideId: string,
  maxSteps: number,
  options: InterruptibleOperationOptions & DeleteGuideOptions = {},
): Promise<boolean> {
  const guide = await repository.getGuideById(guideId);
  if (!guide) return true;
  if (!isDeletionPending(guide)) return false;
  if (options.expectedUpdatedAt !== undefined && guide.updatedAt !== options.expectedUpdatedAt) return false;
  if (options.expectedProcessingAttemptId !== undefined && guide.processingAttemptId !== options.expectedProcessingAttemptId) return false;
  if (options.expectedProcessingAttemptCount !== undefined && guide.processingAttemptCount !== options.expectedProcessingAttemptCount) return false;

  await cleanupStorageKeys(storage, guideAssetKeys(guide, maxSteps), options);
  return repository.deleteGuide(guide.id, {
    expectedUpdatedAt: options.expectedUpdatedAt,
    expectedStatuses: ["failed"],
    expectedProcessingAttemptId: guide.processingAttemptId,
    expectedProcessingAttemptCount: guide.processingAttemptCount,
    expectedErrorCode: guide.errorCode,
  });
}
