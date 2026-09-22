import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { GuideRepository } from "./domain.js";
import type { Storage } from "./storage.js";
import type { ProcessorConfig } from "./config.js";
import type { PublicationAdmission } from "./publication-api.js";
import { PublicationHttpError } from "./publication-http.js";
import { publicationRequestSchema, type PublicationJob, type PublicationRequest } from "./publication-jobs.js";
import { preparePublicationAssets, cleanupPublicationPreparation, type PublicationPreparationOptions } from "./publication-preparation.js";
import { privateAssetWriterBusy } from "./privacy-asset-session.js";
import { PublicationRecoveryWorker } from "./publication-recovery.js";

export type ProcessorPublicationContext = { repository: GuideRepository; storage: Storage; config: ProcessorConfig };
export type ProcessorPublicationRuntime = Pick<ProcessorPublicationContext, "repository" | "storage"> & {
  admission: PublicationAdmission; start(): void; stop(): Promise<{ pendingIO: boolean }>;
};
export type ProcessorPublicationFactory = (context: ProcessorPublicationContext) => ProcessorPublicationRuntime | Promise<ProcessorPublicationRuntime>;
type Options = {
  pollMs?: number; timeoutMs?: number; preparationTimeoutMs?: number; admissionTimeoutMs?: number; shutdownTimeoutMs?: number;
  /** Trusted tests only. Production uses the real private PNG renderer. */
  render?: PublicationPreparationOptions["render"];
};
type Report = { status: "idle" | "progress" | "degraded" | "busy" | "stopped"; scanned: number; published: number; failed: number };
const report = (status: Report["status"] = "idle"): Report => ({ status, scanned: 0, published: 0, failed: 0 });
const bounded = (n: number, max: number) => {
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new RangeError("Invalid publication runtime bounds");
  return n;
};
const unavailable = () => new PublicationHttpError("PUBLICATION_UNAVAILABLE");

/** Explicit composition only: no construction/import side effects, external AI,
 * raw-video sharing, reconstructed writer leases, or automatic request creation. */
export class DurablePublicationRuntime implements ProcessorPublicationRuntime {
  readonly repository: GuideRepository;
  readonly storage: Storage;
  readonly admission: PublicationAdmission;
  private readonly recovery: PublicationRecoveryWorker;
  private readonly shutdown = new AbortController();
  private readonly options: Options;
  private readonly ffmpegPath: string;
  private readonly workDir: string;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly preparationTimeoutMs: number;
  private readonly admissionTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly requests = new Set<Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private flight?: Promise<Report>;
  private workPending = false;
  private started = false;
  private healthy = true;
  private queuedAfter?: string;
  private failures = 0;
  private last = report();
  private closing?: Promise<{ pendingIO: boolean }>;

  constructor(context: ProcessorPublicationContext, options: Options = {}) {
    this.repository = context.repository; this.storage = context.storage; this.options = { ...options };
    this.ffmpegPath = context.config.ffmpegPath; this.workDir = path.join(context.config.dataDir, "work");
    this.pollMs = bounded(options.pollMs ?? 5000, 60_000);
    this.timeoutMs = bounded(options.timeoutMs ?? 120_000, 120_000);
    this.preparationTimeoutMs = bounded(options.preparationTimeoutMs ?? Math.min(100_000, this.timeoutMs), this.timeoutMs);
    this.admissionTimeoutMs = bounded(options.admissionTimeoutMs ?? 5000, 5000);
    this.shutdownTimeoutMs = bounded(options.shutdownTimeoutMs ?? 1000, 5000);
    this.recovery = new PublicationRecoveryWorker({ repository: this.repository, storage: this.storage,
      timeoutMs: Math.min(30_000, this.timeoutMs) });
    this.admission = { isAccepting: () => this.isAccepting(), request: (...args) => this.request(...args) };
  }
  private isAccepting() {
    const recovery = this.recovery.getStatus();
    return this.started && !this.shutdown.signal.aborted && this.healthy && this.requests.size < 16 &&
      !(this.workPending && !this.flight) && !(recovery.pendingIO && !recovery.processing) &&
      !(privateAssetWriterBusy() && !this.flight);
  }
  getStatus() {
    return { ...this.last, running: this.started && !this.shutdown.signal.aborted, accepting: this.isAccepting(),
      processing: Boolean(this.flight), pendingIO: this.workPending || this.requests.size > 0 ||
        privateAssetWriterBusy() || this.recovery.getStatus().pendingIO, pendingAdmissions: this.requests.size,
      recovery: this.recovery.getStatus() };
  }
  private async request(guideId: string, raw: PublicationRequest, parent: AbortSignal) {
    const command = publicationRequestSchema.parse(raw); // Copy before any asynchronous boundary.
    parent.throwIfAborted(); if (!this.isAccepting()) throw unavailable();
    const deadline = new AbortController(), signal = AbortSignal.any([parent, this.shutdown.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), this.admissionTimeoutMs);
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => { abort = () => reject(unavailable()); signal.addEventListener("abort", abort, { once: true }); });
    const operation = Promise.resolve().then(() => {
      signal.throwIfAborted(); return this.repository.executePublicationCommand(guideId, command);
    });
    this.requests.add(operation);
    void operation.finally(() => { this.requests.delete(operation); }).catch(() => undefined);
    try { const job = await Promise.race([operation, interrupted]); signal.throwIfAborted(); return job; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); deadline.abort(); }
  }
  start() {
    if (this.started || this.shutdown.signal.aborted) return;
    this.started = true; this.schedule(0);
  }
  private schedule(ms: number) {
    if (!this.started || this.shutdown.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().then(result => this.schedule(result.status === "progress" ? 0 :
        Math.min(60_000, this.pollMs * 2 ** Math.min(this.failures, 10))));
    }, ms);
    this.timer.unref();
  }
  /** Bounded explicit pass; coalesces callers and never queues a second writer. */
  tick(): Promise<Report> {
    if (this.shutdown.signal.aborted) return Promise.resolve(report("stopped"));
    if (this.flight) return this.flight;
    if (this.workPending || privateAssetWriterBusy() || this.recovery.getStatus().pendingIO) return Promise.resolve(report("busy"));
    const deadline = new AbortController(), signal = AbortSignal.any([this.shutdown.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs); this.workPending = true;
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => { abort = () => reject(unavailable()); signal.addEventListener("abort", abort, { once: true }); });
    const work = Promise.resolve().then(() => this.pass(signal)).finally(() => { this.workPending = false; });
    this.flight = Promise.race([work, interrupted]).catch(() => {
      this.healthy = false; return report(this.shutdown.signal.aborted ? "stopped" : "degraded");
    }).then(result => {
      this.last = result; this.failures = result.status === "degraded" ? Math.min(10, this.failures + 1) : 0;
      return { ...result };
    }).finally(() => { clearTimeout(timer); signal.removeEventListener("abort", abort); deadline.abort(); this.flight = undefined; });
    return this.flight;
  }
  private async pass(signal: AbortSignal): Promise<Report> {
    signal.throwIfAborted(); const maintenance = await this.recovery.tick(); signal.throwIfAborted();
    if (this.recovery.getStatus().pendingIO) return report("busy");
    const rows = await this.repository.listPublicationRecovery({ kind: "queued", limit: 1, after: this.queuedAfter });
    signal.throwIfAborted(); this.healthy = true;
    const result = report(maintenance.failed ? "degraded" : "idle");
    if (!rows.length) { this.queuedAfter = undefined; return result; }
    const row = rows[0]; this.queuedAfter = row.batchId; result.scanned = 1;
    let ready: PublicationJob | undefined;
    try {
      ready = await preparePublicationAssets({ repository: this.repository, storage: this.storage,
        guideId: row.guideId, jobId: row.id, expectedVersion: row.version, ffmpegPath: this.ffmpegPath,
        workDir: this.workDir, signal, timeoutMs: this.preparationTimeoutMs, render: this.options.render });
      signal.throwIfAborted();
      // Only the invocation that just produced this private lease may commit.
      // No read of a recovered running/assets-ready row can grant that authority.
      const committed = await this.repository.commitPublication(row.guideId,
        { id: ready.id, leaseId: ready.leaseId!, expectedVersion: ready.version });
      if (!committed) throw unavailable();
      result.published = 1; result.status = "progress";
    } catch {
      if (ready) {
        // A lost commit acknowledgement is a read-only reconciliation, not a
        // second render, put or commit. A concurrent withdrawal stays withdrawn.
        const latest = await this.repository.getPublicationJob(row.guideId, ready.id).catch(() => null);
        if (latest?.status === "succeeded" && latest.leaseId === ready.leaseId) {
          result.published = 1; result.status = "progress";
        } else if (latest) {
          await this.repository.executePublicationCommand(row.guideId, { type: "abandon", id: ready.id, leaseId: ready.leaseId! }).catch(() => undefined);
          await cleanupPublicationPreparation(this.repository, this.storage, row.guideId, ready.id, signal, 5000).catch(() => undefined);
        }
      }
      if (!result.published) { result.failed++; result.status = "degraded"; }
    }
    signal.throwIfAborted(); return result;
  }
  stop(): Promise<{ pendingIO: boolean }> {
    if (this.closing) return this.closing;
    this.started = false; this.shutdown.abort(); if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    const recovery = this.recovery.stop();
    this.closing = (async () => {
      await Promise.all([this.flight, recovery]);
      // Let cooperative cancellation finish cleanup before the caller closes DB
      // resources. This bounded grace does not pretend a hung remote put ended.
      const deadline = performance.now() + this.shutdownTimeoutMs;
      while (this.getStatus().pendingIO && performance.now() < deadline) await delay(10);
      this.last = { ...this.last, status: "stopped" };
      return { pendingIO: this.getStatus().pendingIO };
    })();
    return this.closing;
  }
}

/** API and runtime must share the exact DB/storage objects. The factory remains
 * optional until UI and Replit operational acceptance; no environment switch. */
export async function createPublicationLifecycle(context: ProcessorPublicationContext, factory?: ProcessorPublicationFactory) {
  if (!factory) return undefined;
  const runtime = await factory({ ...context });
  if (runtime.repository !== context.repository || runtime.storage !== context.storage) {
    await runtime.stop().catch(() => undefined); throw unavailable();
  }
  let active = false, stopped = false; let closing: Promise<void> | undefined;
  const admission: PublicationAdmission = { isAccepting: () => active && !stopped && runtime.admission.isAccepting(),
    request: (...args) => { if (!active || stopped) return Promise.reject(unavailable()); return runtime.admission.request(...args); } };
  return { admission,
    start() { if (active || stopped) return; runtime.start(); active = true; },
    stop() {
      active = false; stopped = true;
      if (!closing) closing = (async () => { if ((await runtime.stop()).pendingIO) throw new Error("PUBLICATION_STOP_PENDING"); })();
      return closing;
    },
  };
}
