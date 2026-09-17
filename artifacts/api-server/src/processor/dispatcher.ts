import { privateLogError } from "./private-log.js";
import { randomUUID } from "node:crypto";

import type { Guide, GuideRepository } from "./domain.js";
import type { GuidePipeline } from "./pipeline.js";
import { ProcessingQueue, QueueCapacityError } from "./queue.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

type DurableDispatcherDependencies = {
  repository: GuideRepository;
  queue: ProcessingQueue;
  pipeline: GuidePipeline;
  maxProcessingAttempts: number;
  queueCapacity: number;
  activeStaleAfterMs: number;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  createAttemptId?: () => string;
};

/**
 * Reconciles durable guide state with the bounded in-memory media queue.
 *
 * HTTP handlers enqueue eagerly for low latency, but that enqueue is not the
 * durable source of truth. This dispatcher keeps looking for persisted work so
 * a transient repository/worker error cannot strand a guide until a restart.
 */
export class DurableProcessingDispatcher {
  private readonly repository: GuideRepository;
  private readonly queue: ProcessingQueue;
  private readonly pipeline: GuidePipeline;
  private readonly maxProcessingAttempts: number;
  private readonly queueCapacity: number;
  private readonly activeStaleAfterMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly createAttemptId: () => string;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private consecutiveFailures = 0;
  private started = false;
  private stopped = false;

  constructor({
    repository,
    queue,
    pipeline,
    maxProcessingAttempts,
    queueCapacity,
    activeStaleAfterMs,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    now = Date.now,
    createAttemptId = randomUUID,
  }: DurableDispatcherDependencies) {
    if (!Number.isSafeInteger(maxProcessingAttempts) || maxProcessingAttempts < 1) {
      throw new RangeError("maxProcessingAttempts must be a positive integer");
    }
    if (!Number.isSafeInteger(queueCapacity) || queueCapacity < 1) {
      throw new RangeError("queueCapacity must be a positive integer");
    }
    if (!Number.isFinite(activeStaleAfterMs) || activeStaleAfterMs < 0) {
      throw new RangeError("activeStaleAfterMs must be a non-negative number");
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) {
      throw new RangeError("pollIntervalMs must be a positive number");
    }
    if (!Number.isFinite(maxBackoffMs) || maxBackoffMs < pollIntervalMs) {
      throw new RangeError("maxBackoffMs must be greater than or equal to pollIntervalMs");
    }

    this.repository = repository;
    this.queue = queue;
    this.pipeline = pipeline;
    this.maxProcessingAttempts = maxProcessingAttempts;
    this.queueCapacity = queueCapacity;
    this.activeStaleAfterMs = activeStaleAfterMs;
    this.pollIntervalMs = pollIntervalMs;
    this.maxBackoffMs = maxBackoffMs;
    this.now = now;
    this.createAttemptId = createAttemptId;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(0);
  }

  /** Stops future scans and waits for a scan already touching the repository. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // tick() already records scan failures and durable work will remain for the
    // next process. A transient database error must not turn shutdown itself
    // into a failure after the timer has been stopped.
    await this.inFlight?.catch(() => undefined);
  }

  /** Exposed for startup checks and deterministic tests; concurrent calls coalesce. */
  dispatchOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;

    const work = this.scan();
    this.inFlight = work;
    void work.finally(() => {
      if (this.inFlight === work) this.inFlight = undefined;
    }).catch(() => undefined);
    return work;
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      await this.dispatchOnce();
      this.consecutiveFailures = 0;
      this.schedule(this.pollIntervalMs);
    } catch (error) {
      this.consecutiveFailures += 1;
      const delayMs = Math.min(
        this.maxBackoffMs,
        this.pollIntervalMs * (2 ** Math.min(this.consecutiveFailures - 1, 20)),
      );
      console.error(JSON.stringify({
        event: "durable_dispatch_failed",
        consecutiveFailures: this.consecutiveFailures,
        retryInMs: delayMs,
        message: privateLogError(error),
      }));
      this.schedule(delayMs);
    }
  }

  private async scan(): Promise<void> {
    // Recover crashed, already-started work first. Filling every slot from a
    // fresh queued backlog would otherwise starve stale active jobs forever.
    const active = await this.repository.listByStatuses(
      ["probing", "extracting"],
      this.queueCapacity,
    );
    for (const guide of active) {
      if (this.stopped || !this.queue.canAcceptNew()) return;
      if (this.queue.has(guide.id) || !this.isStale(guide)) continue;
      if (!this.enqueue(guide.id, () => this.recoverStaleAttempt(guide))) return;
    }

    if (this.stopped || !this.queue.canAcceptNew()) return;
    const queued = await this.repository.listByStatuses(["queued"], this.queueCapacity);
    for (const guide of queued) {
      if (this.stopped || !this.queue.canAcceptNew()) return;
      if (this.queue.has(guide.id)) continue;
      if (!this.enqueue(guide.id, () => this.pipeline.process(guide.id))) return;
    }
  }

  private enqueue(guideId: string, task: () => Promise<void>): boolean {
    try {
      this.queue.enqueue(guideId, task);
      return true;
    } catch (error) {
      // Capacity is expected to race with uploads. Durable state remains in the
      // repository and the next scan will pick it up.
      if (error instanceof QueueCapacityError) return false;
      throw error;
    }
  }

  private isStale(guide: Guide): boolean {
    const updatedAt = Date.parse(guide.updatedAt);
    return !Number.isFinite(updatedAt) || this.now() - updatedAt >= this.activeStaleAfterMs;
  }

  private async recoverStaleAttempt(snapshot: Guide): Promise<void> {
    const attemptId = this.createAttemptId();
    const claimed = await this.repository.claimProcessingAttempt(snapshot.id, attemptId, {
      expectedStatuses: [snapshot.status],
      expectedProcessingAttemptId: snapshot.processingAttemptId,
      expectedProcessingAttemptCount: snapshot.processingAttemptCount,
      maxAttempts: this.maxProcessingAttempts,
      progress: Math.min(snapshot.progress, 22),
      statusMessage: "중단된 작업을 이어서 처리하고 있어요.",
      exhaustedStatusMessage: "영상 처리에 실패했어요.",
    });
    if (
      !claimed ||
      claimed.status !== "probing" ||
      claimed.processingAttemptId !== attemptId
    ) return;

    await this.pipeline.processClaimed(
      claimed.id,
      attemptId,
      claimed.processingAttemptCount,
    );
  }
}
