import type { GuideRepository } from "./domain.js";
import type { Storage } from "./storage.js";
import type { PublicationJobRepository, PublicationRecoveryQuery } from "./publication-jobs.js";
import type { PublicationLifecycleRepository, PublicationExpiryQuery } from "./publication-lifecycle.js";
import { cleanupPublicationPreparation } from "./publication-preparation.js";
import { privateStorageDeletesPending } from "./asset-lifecycle.js";

type Options = {
  repository: GuideRepository & PublicationJobRepository & PublicationLifecycleRepository; storage: Storage;
  batchSize?: number; pollMs?: number; timeoutMs?: number; deleteTimeoutMs?: number;
  /** Trusted test clock only. Production recovery always uses the DB clock. */
  clock?: () => Date;
};
export type PublicationRecoveryReport = {
  status: "idle" | "progress" | "pending" | "degraded" | "busy" | "stopped";
  expiredScanned: number; cleanupScanned: number; recovered: number; cleaned: number; pending: number; failed: number;
  publicationsScanned: number; publicationsExpired: number;
};
const report = (status: PublicationRecoveryReport["status"] = "idle"): PublicationRecoveryReport => ({
  status, expiredScanned: 0, cleanupScanned: 0, recovered: 0, cleaned: 0, pending: 0, failed: 0,
  publicationsScanned: 0, publicationsExpired: 0,
});
const integer = (value: number, maximum: number) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError("Invalid publication recovery bounds");
  return value;
};

/** Explicit internal maintenance loop; importing/constructing does NOT start it.
 * Never renders, retries puts, publishes, settles unknown writers or deletes a guide.
 * The opt-in publication runtime owns its passes; default product startup is off. */
export class PublicationRecoveryWorker {
  private readonly options: Options;
  private readonly batchSize: number;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly deleteTimeoutMs: number;
  private readonly shutdown = new AbortController();
  private timer?: NodeJS.Timeout;
  private flight?: Promise<PublicationRecoveryReport>;
  private pendingIO = false;
  private started = false;
  private failures = 0;
  private expiredAfter?: string;
  private cleanupAfter?: string;
  private publicationAfter?: PublicationExpiryQuery["after"];
  private last = report();

  constructor(options: Options) {
    this.options = { ...options };
    this.batchSize = integer(options.batchSize ?? 20, 20);
    this.pollMs = integer(options.pollMs ?? 5000, 60_000);
    this.timeoutMs = integer(options.timeoutMs ?? 30_000, 30_000);
    this.deleteTimeoutMs = integer(options.deleteTimeoutMs ?? 5000, 30_000);
  }
  getStatus() {
    return { ...this.last, running: this.started && !this.shutdown.signal.aborted,
      processing: Boolean(this.flight), pendingIO: this.hasPendingIO(), consecutiveFailures: this.failures,
      nextPollMs: Math.min(60_000, Math.max(this.last.pending ? 30_000 : 0, this.pollMs * 2 ** Math.min(this.failures, 10))) };
  }
  private hasPendingIO() { return this.pendingIO || privateStorageDeletesPending(this.options.storage); }
  start(): void {
    if (this.started || this.shutdown.signal.aborted) return;
    this.started = true; this.schedule(0);
  }
  private schedule(ms: number) {
    if (!this.started || this.shutdown.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().then(() => this.schedule(this.getStatus().nextPollMs));
    }, ms);
    this.timer.unref();
  }
  /** Stops admission promptly. pendingIO reports an already issued operation;
   * it is NOT evidence that a remote SDK stopped or an asset was deleted. */
  async stop(): Promise<{ pendingIO: boolean }> {
    this.started = false; this.shutdown.abort();
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    await this.flight;
    this.last = { ...this.last, status: "stopped" };
    return { pendingIO: this.hasPendingIO() };
  }
  tick(): Promise<PublicationRecoveryReport> {
    if (this.shutdown.signal.aborted) return Promise.resolve(report("stopped"));
    if (this.flight) return this.flight;
    // A timed-out repository promise keeps this lane occupied until it settles.
    // Repeated ticks must not accumulate unbounded queries behind that promise.
    if (this.hasPendingIO()) return Promise.resolve(report("busy"));
    this.pendingIO = true;
    const deadline = new AbortController(), signal = AbortSignal.any([this.shutdown.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    let abort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("PUBLICATION_RECOVERY_INTERRUPTED"));
      signal.addEventListener("abort", abort, { once: true });
    });
    const work = Promise.resolve().then(() => this.pass(signal)).finally(() => { this.pendingIO = false; });
    this.flight = Promise.race([work, interrupted]).catch(() => report(this.shutdown.signal.aborted ? "stopped" : "degraded"))
      .then(result => {
        this.last = { ...result };
        this.failures = result.status === "degraded" ? Math.min(10, this.failures + 1) : 0;
        return { ...result };
      }).finally(() => {
        clearTimeout(timer); signal.removeEventListener("abort", abort); deadline.abort(); this.flight = undefined;
      });
    return this.flight;
  }
  private async pass(signal: AbortSignal): Promise<PublicationRecoveryReport> {
    const { repository, storage } = this.options, result = report();
    signal.throwIfAborted();
    const publications = await repository.listExpiredPublications({ limit: this.batchSize, after: this.publicationAfter }, this.options.clock?.());
    signal.throwIfAborted();
    if (!publications.length) this.publicationAfter = undefined;
    for (const row of publications) {
      signal.throwIfAborted(); this.publicationAfter = { expiresAt: row.expiresAt, publicSlug: row.publicSlug }; result.publicationsScanned++;
      try {
        const stopped = await repository.stopPublication(row.guideId, { type: "expire", expectedHeadVersion: row.version }, this.options.clock?.());
        signal.throwIfAborted(); if (stopped?.changed) result.publicationsExpired++;
      } catch { signal.throwIfAborted(); result.failed++; }
    }
    const scan = async (kind: PublicationRecoveryQuery["kind"], after?: string) => {
      signal.throwIfAborted();
      const rows = await repository.listPublicationRecovery({ kind, limit: this.batchSize, after }, this.options.clock?.());
      signal.throwIfAborted(); return rows;
    };
    const expired = await scan("expired", this.expiredAfter);
    if (!expired.length) this.expiredAfter = undefined;
    for (const row of expired) {
      signal.throwIfAborted(); this.expiredAfter = row.batchId; result.expiredScanned++;
      try {
        // Rechecked under the parent lock using a fresh DB clock. No lease reuse.
        const job = await repository.executePublicationCommand(row.guideId,
          { type: "recover", id: row.id, expectedVersion: row.version }, this.options.clock?.());
        signal.throwIfAborted(); if (job?.status === "failed") result.recovered++;
      } catch { signal.throwIfAborted(); result.failed++; }
    }
    const cleanup = await scan("cleanup", this.cleanupAfter);
    if (!cleanup.length) this.cleanupAfter = undefined;
    for (const row of cleanup) {
      if (privateStorageDeletesPending(storage)) break;
      signal.throwIfAborted(); this.cleanupAfter = row.batchId; result.cleanupScanned++;
      try {
        const done = await cleanupPublicationPreparation(repository, storage, row.guideId, row.id, signal, this.deleteTimeoutMs);
        signal.throwIfAborted(); if (done) result.cleaned++; else result.pending++;
      } catch { signal.throwIfAborted(); result.failed++; }
    }
    result.status = result.failed ? "degraded" : result.pending ? "pending" : result.cleaned || result.recovered || result.publicationsExpired ? "progress" : "idle";
    return result;
  }
}
