import { privateLogError } from "./private-log.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";

import { CONFIG, loadConfig, type ProcessorConfig } from "./config.js";
import {
  DELETION_PENDING,
  DELETION_PENDING_ACTIVE,
  finalizeGuideDeletion,
  UPLOAD_CANCELLATION_TOMBSTONE,
} from "./asset-lifecycle.js";
import { runDatabaseMigrations, verifyDatabaseMigrations } from "./database-migrations.js";
import { DurableProcessingDispatcher } from "./dispatcher.js";
import { GUIDE_STATUSES, type GuideRepository } from "./domain.js";
import { verifyMediaBinaryVersions } from "./media/binary-version.js";
import { createGuidePipeline } from "./pipeline.js";
import { ProcessingQueue } from "./queue.js";
import { createGuideRepository, PostgresGuideRepository, analysisPoolForRepository } from "./repository.js";
import { createProcessorApp } from "./server.js";
import { createStorage, type Storage } from "./storage.js";
import { createAnalysisLifecycle, type ProcessorAnalysisFactory } from "./analysis-lifecycle.js";
import { analysisBootstrapSettings, configuredAnalysisFactory, verifyAnalysisRuntimeRole } from "./analysis-bootstrap.js";

const STORAGE_PROBE_PAYLOAD = Buffer.from("showme-storage-ready", "utf8");
const STARTUP_CHECK_TIMEOUT_MS = 15_000;
const LIFECYCLE_SWEEP_INTERVAL_MS = 60_000;
const LIFECYCLE_SWEEP_BATCH_LIMIT = 20;
const LIFECYCLE_SWEEP_BUDGET_MS = 20_000;
const LIFECYCLE_STORAGE_OPERATION_TIMEOUT_MS = 5_000;
const UPLOAD_CANCELLATION_RETENTION_MS = 24 * 60 * 60_000;
const UNPUBLISHED_DRAFT_RETENTION_MS = 7 * 24 * 60 * 60_000;

export async function startProcessor(config: ProcessorConfig = CONFIG, options: { createAnalysis?: ProcessorAnalysisFactory } = {}) {
  await mkdir(config.dataDir, { recursive: true });
  const repository = createGuideRepository({
    databaseUrl: config.databaseUrl,
    jsonFilePath: path.join(config.dataDir, "guides.json"),
    poolConfig: {
      connectionTimeoutMillis: 10_000,
      query_timeout: STARTUP_CHECK_TIMEOUT_MS,
      statement_timeout: STARTUP_CHECK_TIMEOUT_MS,
    },
  });
  let server: Server | undefined;
  let startupQueue: ProcessingQueue | undefined;
  let startupDispatcher: DurableProcessingDispatcher | undefined;
  let lifecycleTimer: NodeJS.Timeout | undefined;
  let lifecycleSweepPromise: Promise<void> | undefined;
  let analysis: Awaited<ReturnType<typeof createAnalysisLifecycle>>;

  try {
    const storage = createStorage(config);
    analysis = await createAnalysisLifecycle({ repository, storage }, options.createAnalysis);
    const pipeline = createGuidePipeline({ config, repository, storage });
    const queue = new ProcessingQueue(1, config.queueCapacity);
    startupQueue = queue;
    const readiness = { ready: false };
    const app = createProcessorApp({
      config,
      repository,
      storage,
      pipeline,
      queue,
      readiness,
      analysisAdmission: analysis?.admission,
    });

    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(config.port, "0.0.0.0", () => resolve(listening));
      listening.once("error", reject);
    });
    const activeServer = server;
    await cleanupLocalProcessingResidue(config.dataDir);
    await withStartupTimeout(
      "database migration",
      STARTUP_CHECK_TIMEOUT_MS,
      async () => {
        if (config.databaseMigrationMode !== "verify-only") return runDatabaseMigrations(config.databaseUrl);
        if (!(repository instanceof PostgresGuideRepository)) throw new Error("DATABASE_MIGRATION_CHECK_FAILED");
        const pool = analysisPoolForRepository(repository);
        if (!pool) throw new Error("DATABASE_MIGRATION_CHECK_FAILED");
        await verifyAnalysisRuntimeRole(pool, AbortSignal.timeout(10_000));
        return verifyDatabaseMigrations(repository.database);
      },
    );
    await withStartupTimeout(
      "database",
      STARTUP_CHECK_TIMEOUT_MS,
      () => repository.listByStatuses(GUIDE_STATUSES, 1),
    );
    await withStartupTimeout(
      "storage",
      STARTUP_CHECK_TIMEOUT_MS,
      () => verifyStorage(config, storage),
    );
    await verifyMediaBinaryVersions(config);
    const dispatcher = new DurableProcessingDispatcher({
      repository,
      queue,
      pipeline,
      maxProcessingAttempts: config.maxProcessingAttempts,
      queueCapacity: config.queueCapacity,
      // A live worker is aborted at jobTimeoutMs. The extra margin prevents a
      // rolling deployment from stealing an attempt that is still winding down.
      activeStaleAfterMs: config.jobTimeoutMs + 30_000,
    });
    startupDispatcher = dispatcher;
    await dispatcher.dispatchOnce();
    dispatcher.start();
    const runLifecycleSweep = (): Promise<void> => {
      if (lifecycleSweepPromise) return lifecycleSweepPromise;
      const sweep = cleanupPrivateAssetLifecycle(repository, storage, {
        maxSteps: config.maxSteps,
        activeGraceMs: Math.max(config.requestTimeoutMs, config.jobTimeoutMs) + 60_000,
        cancellationGraceMs: UPLOAD_CANCELLATION_RETENTION_MS,
        abandonedDraftGraceMs: UNPUBLISHED_DRAFT_RETENTION_MS,
        batchLimit: LIFECYCLE_SWEEP_BATCH_LIMIT,
        sweepBudgetMs: LIFECYCLE_SWEEP_BUDGET_MS,
        storageOperationTimeoutMs: LIFECYCLE_STORAGE_OPERATION_TIMEOUT_MS,
      }).catch((error: unknown) => {
        console.error(JSON.stringify({
          event: "private_asset_lifecycle_sweep_failed",
          message: privateLogError(error),
        }));
      }).finally(() => {
        if (lifecycleSweepPromise === sweep) lifecycleSweepPromise = undefined;
      });
      lifecycleSweepPromise = sweep;
      return sweep;
    };
    lifecycleTimer = setInterval(() => { void runLifecycleSweep(); }, LIFECYCLE_SWEEP_INTERVAL_MS);
    lifecycleTimer.unref();
    analysis?.start();
    readiness.ready = true;
    // Durable cleanup starts immediately, but it is intentionally outside the
    // readiness critical path and bounded so a large backlog cannot block boot.
    void runLifecycleSweep();
    console.info(JSON.stringify({
      event: "processor_started",
      port: config.port,
      storage: config.storageDriver,
      repository: config.databaseUrl ? "postgres" : "json",
    }));

    let closing: Promise<void> | undefined;
    const close = () => {
      if (!closing) {
        readiness.ready = false;
        if (lifecycleTimer) clearInterval(lifecycleTimer);
        closing = closeResources(activeServer, repository, queue, dispatcher, lifecycleSweepPromise, analysis);
      }
      return closing;
    };
    return { app, server: activeServer, repository, queue, dispatcher, close };
  } catch (error) {
    if (lifecycleTimer) clearInterval(lifecycleTimer);
    await closeResources(
      server,
      repository,
      startupQueue,
      startupDispatcher,
      lifecycleSweepPromise,
      analysis,
    ).catch(() => undefined);
    throw error;
  }
}

export async function cleanupPrivateAssetLifecycle(
  repository: GuideRepository,
  storage: Storage,
  options: {
    maxSteps: number;
    activeGraceMs: number;
    cancellationGraceMs?: number;
    abandonedDraftGraceMs?: number;
    batchLimit?: number;
    sweepBudgetMs?: number;
    storageOperationTimeoutMs?: number;
    now?: number;
  },
): Promise<void> {
  const now = options.now ?? Date.now();
  const staleBefore = now - options.activeGraceMs;
  const cancellationStaleBefore = now - (options.cancellationGraceMs ?? options.activeGraceMs);
  const batchLimit = options.batchLimit ?? 1_000;
  const sweepBudgetMs = options.sweepBudgetMs ?? Number.POSITIVE_INFINITY;
  const storageOperationTimeoutMs = options.storageOperationTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1) {
    throw new RangeError("Private asset lifecycle batchLimit must be a positive integer.");
  }
  if (!(sweepBudgetMs > 0) || !(storageOperationTimeoutMs > 0)) {
    throw new RangeError("Private asset lifecycle timeouts must be positive.");
  }
  const sweepDeadline = Number.isFinite(sweepBudgetMs)
    ? Date.now() + sweepBudgetMs
    : Number.POSITIVE_INFINITY;
  const failures: unknown[] = [];

  const uploadingGuides = await repository.listByStatuses(["uploading"], batchLimit);
  for (const guide of uploadingGuides) {
    if (Date.parse(guide.updatedAt) > staleBefore) continue;
    try {
      await repository.updateStatus(guide.id, "failed", {
        expectedStatuses: ["uploading"],
        expectedUpdatedAt: guide.updatedAt,
        expectedProcessingAttemptId: guide.processingAttemptId,
        expectedProcessingAttemptCount: guide.processingAttemptCount,
        expectedErrorCode: guide.errorCode,
        progress: 100,
        statusMessage: "중단된 업로드를 안전하게 정리하고 있어요.",
        errorCode: DELETION_PENDING,
        errorMessage: "원본 영상을 다시 올려 주세요.",
      });
    } catch (error) {
      failures.push(error);
    }
  }

  if (options.abandonedDraftGraceMs !== undefined) {
    const abandonedBefore = now - options.abandonedDraftGraceMs;
    const lifecycleErrorCodes = [
      DELETION_PENDING,
      DELETION_PENDING_ACTIVE,
      UPLOAD_CANCELLATION_TOMBSTONE,
    ];
    const expiredDrafts = await repository.listExpiredDrafts(
      new Date(abandonedBefore).toISOString(), lifecycleErrorCodes, batchLimit,
    );
    for (const guide of expiredDrafts) {
      try {
        await repository.updateStatus(guide.id, "failed", {
          expectedStatuses: [guide.status],
          expectedUpdatedAt: guide.updatedAt,
          expectedProcessingAttemptId: guide.processingAttemptId,
          expectedProcessingAttemptCount: guide.processingAttemptCount,
          expectedErrorCode: guide.errorCode,
          progress: 100,
          statusMessage: "보관 기간이 지난 미공개 초안을 삭제하고 있어요.",
          errorCode: DELETION_PENDING,
          errorMessage: "미공개 초안의 보관 기간이 끝났어요.",
        });
      } catch (error) {
        failures.push(error);
      }
    }
  }

  // Query each lifecycle class independently so a large set of fresh,
  // deferred tombstones can never starve source-bearing immediate cleanup.
  const immediate = await repository.listFailedByErrorCodes([DELETION_PENDING], batchLimit);
  const activePending = (await repository.listFailedByErrorCodes([DELETION_PENDING_ACTIVE], batchLimit))
    .filter((guide) => Date.parse(guide.updatedAt) <= staleBefore);
  const expiredTombstones = (await repository.listFailedByErrorCodes([UPLOAD_CANCELLATION_TOMBSTONE], batchLimit))
    .filter((guide) => Date.parse(guide.updatedAt) <= cancellationStaleBefore);
  const pending = Array.from({ length: batchLimit }).flatMap((_unused, index) => (
    [immediate[index], activePending[index], expiredTombstones[index]]
      .filter((guide) => guide !== undefined)
  ));
  for (const guide of pending) {
    const remainingMs = sweepDeadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      await finalizeGuideDeletion(repository, storage, guide.id, options.maxSteps, {
        timeoutMs: Math.max(1, Math.min(storageOperationTimeoutMs, remainingMs)),
        expectedUpdatedAt: guide.updatedAt,
        expectedProcessingAttemptId: guide.processingAttemptId,
        expectedProcessingAttemptCount: guide.processingAttemptCount,
      });
    } catch (error) {
      failures.push(error);
      console.error(JSON.stringify({
        event: "private_guide_deletion_failed",
        guideId: guide.id,
        message: privateLogError(error),
      }));
      try {
        // Move a repeatedly failing row to the tail of its lifecycle class.
        // This keeps one hung object-store request from starving later guides.
        await repository.updateStatus(guide.id, "failed", {
          expectedStatuses: ["failed"],
          expectedUpdatedAt: guide.updatedAt,
          expectedProcessingAttemptId: guide.processingAttemptId,
          expectedProcessingAttemptCount: guide.processingAttemptCount,
          expectedErrorCode: guide.errorCode,
          progress: guide.progress,
          statusMessage: guide.statusMessage,
          errorCode: guide.errorCode,
          errorMessage: guide.errorMessage,
        });
      } catch (rotationError) {
        failures.push(rotationError);
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Pending private guide cleanup failed.");
  }
}

/** Removes only disposable, instance-local files left by an interrupted process. */
export async function cleanupLocalProcessingResidue(dataDir: string): Promise<void> {
  const incomingDirectory = path.join(dataDir, "incoming");
  const workDirectory = path.join(dataDir, "work");
  await Promise.all([
    rm(incomingDirectory, { recursive: true, force: true }),
    rm(workDirectory, { recursive: true, force: true }),
  ]);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function closeResources(
  server: Server | undefined,
  repository: GuideRepository,
  queue?: ProcessingQueue,
  dispatcher?: DurableProcessingDispatcher,
  lifecycleSweep?: Promise<void>,
  analysis?: Awaited<ReturnType<typeof createAnalysisLifecycle>>,
): Promise<void> {
  const failures: unknown[] = [];
  if (analysis) {
    try { await analysis.stop(); } catch (error) { failures.push(error); }
  }
  if (server) {
    try {
      await closeServer(server);
    } catch (error) {
      failures.push(error);
    }
  }
  if (dispatcher) {
    try {
      await dispatcher.stop();
    } catch (error) {
      failures.push(error);
    }
  }
  if (queue) {
    try {
      await queue.onIdle();
    } catch (error) {
      failures.push(error);
    }
  }
  if (lifecycleSweep) {
    try {
      await lifecycleSweep;
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await repository.close?.();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Processor shutdown failed.");
  }
}

export async function withStartupTimeout<T>(
  name: string,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${name} startup check timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function verifyStorage(
  config: Pick<ProcessorConfig, "dataDir">,
  storage: Storage,
) {
  const checkId = randomUUID();
  const key = `_health/${checkId}.txt`;
  const localPath = path.join(config.dataDir, `.storage-health-${checkId}.txt`);
  await writeFile(localPath, STORAGE_PROBE_PAYLOAD, { mode: 0o600 });
  const failures: unknown[] = [];
  try {
    await storage.putFile(key, localPath);
    const stream = await storage.openRead(key);
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += buffer.length;
      if (bytesRead > STORAGE_PROBE_PAYLOAD.length) {
        stream.destroy();
        throw new Error("Storage startup probe read back unexpected data.");
      }
      chunks.push(buffer);
    }
    if (!Buffer.concat(chunks, bytesRead).equals(STORAGE_PROBE_PAYLOAD)) {
      throw new Error("Storage startup probe read back unexpected data.");
    }
  } catch (error) {
    failures.push(error);
  }

  try {
    await storage.delete(key);
  } catch (error) {
    failures.push(error);
  }
  try {
    await rm(localPath, { force: true });
  } catch (error) {
    failures.push(error);
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Storage startup probe or cleanup failed.");
  }
}

/** Product entry: absence of an explicit scoped mode still starts the ordinary AI-disabled server. */
export async function startConfiguredProcessor(env: Readonly<Record<string, string | undefined>> = process.env) {
  const config = loadConfig(env);
  const settings = analysisBootstrapSettings(env, config);
  return startProcessor(config, { createAnalysis: settings ? configuredAnalysisFactory(settings, config) : undefined });
}

if (process.env.NODE_ENV !== "test") {
  startConfiguredProcessor().then(({ close }) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void close().then(() => process.exit(0)).catch((error: unknown) => {
        console.error(JSON.stringify({ event: "processor_shutdown_failed", message: privateLogError(error) }));
        process.exit(1);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch((error: unknown) => {
    console.error(JSON.stringify({ event: "processor_start_failed", message: privateLogError(error) }));
    process.exitCode = 1;
  });
}
