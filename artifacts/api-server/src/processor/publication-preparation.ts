import { randomUUID } from "node:crypto";
import type { GuideRepository } from "./domain.js";
import type { Storage } from "./storage.js";
import { publicationCommandSchema, type PublicationJob, type PublicationJobRepository } from "./publication-jobs.js";
import { privacyAssetBatchSchema } from "./privacy-assets.js";
import { cleanupPrivateRedactions } from "./privacy-asset-cleanup.js";
import { privateAssetSession, renderOwnedPrivateAssets, PrivacyAssetWriteError, type PrivateAssetRenderOptions } from "./privacy-asset-session.js";

type Repository = GuideRepository & PublicationJobRepository;
export type PublicationPreparationOptions = Omit<PrivateAssetRenderOptions, "repository"> & {
  repository: Repository; jobId: string; expectedVersion: number; signal: AbortSignal; timeoutMs?: number;
};
const terminal = (job: PublicationJob | null) => job?.status === "failed" || job?.status === "cancelled";

/** Retry only cleanup, never rendering. Unknown remote writers remain recorded.
 * Caller supplies an authenticated/internal job identity, not arbitrary keys. */
export async function cleanupPublicationPreparation(repository: Repository, storage: Storage,
  guideId: string, jobId: string, signal?: AbortSignal, timeoutMs?: number): Promise<boolean> {
  signal?.throwIfAborted();
  const job = await repository.getPublicationJob(guideId, jobId);
  signal?.throwIfAborted();
  if (!job) return true;
  if (!terminal(job)) {
    if (job.status !== "succeeded") return false;
    // Superseded immutable snapshots retain job history. Only a batch already
    // placed in cleanup by the atomic head swap is eligible; never the active one.
    const batch = (await repository.listPrivacyAssetBatches(guideId)).find(b => b.id === job.batchId);
    signal?.throwIfAborted();
    if (!batch) return true;
    if (batch.status !== "cleanup") return false;
  }
  return cleanupPrivateRedactions(repository, storage, guideId, { batchId: job.batchId, signal, timeoutMs });
}

/** Claims queued work itself exactly once. Never accepts a reconstructed
 * running job/lease as permission to write. Called by the explicit publication
 * runtime, never directly through an HTTP worker/lease command.
 * A returned assets-ready job is private preparation, NOT a publication. */
export async function preparePublicationAssets(raw: PublicationPreparationOptions): Promise<PublicationJob> {
  const options = { ...raw }, { repository, storage, guideId, jobId } = options;
  const cancelled = new AbortController(), parent = AbortSignal.any([options.signal, cancelled.signal]);
  return privateAssetSession(parent, options.timeoutMs ?? 120_000, async signal => {
    const leaseId = randomUUID();
    const writes = { unconfirmed: false };
    let observed: PublicationJob | null = null, claimed: PublicationJob | null = null, completionStarted = false;
    let monitor: NodeJS.Timeout | undefined, checking: Promise<void> | undefined, finishing = false;
    const stopMonitor = () => { if (monitor) clearInterval(monitor); monitor = undefined; };
    signal.addEventListener("abort", stopMonitor, { once: true });
    try {
      const claim = publicationCommandSchema.parse({ type: "claim", id: jobId, expectedVersion: options.expectedVersion, leaseId });
      observed = await repository.getPublicationJob(guideId, jobId); signal.throwIfAborted();
      if (!observed || observed.status !== "queued" || observed.version !== options.expectedVersion) throw new PrivacyAssetWriteError();
      const result = await repository.executePublicationCommand(guideId, claim);
      if (result?.status !== "running" || result.leaseId !== leaseId) throw new PrivacyAssetWriteError();
      claimed = result; signal.throwIfAborted();
      const owner = { id: jobId, leaseId, expectedVersion: claimed.version };
      const check = () => {
        if (checking) return checking;
        const pending = (async () => {
          signal.throwIfAborted();
          const current = await repository.executePublicationCommand(guideId, { type: "check-writer", ...owner });
          signal.throwIfAborted();
          if (current?.status !== "running" || current.phase !== "rendering" || current.leaseId !== leaseId)
            throw new PrivacyAssetWriteError();
        })();
        checking = pending;
        void pending.finally(() => { if (checking === pending) checking = undefined; }).catch(() => undefined);
        return pending;
      };
      monitor = setInterval(() => {
        if (!finishing) void check().catch(() => { if (!finishing) cancelled.abort(); });
      }, 250);
      monitor.unref();
      const rawBatch = (await repository.listPrivacyAssetBatches(guideId)).find(b => b.id === claimed!.batchId);
      signal.throwIfAborted();
      const batch = privacyAssetBatchSchema.parse(rawBatch);
      if (batch.guideId !== guideId || batch.writerId !== leaseId || batch.status !== "writing" || batch.writerSettled)
        throw new PrivacyAssetWriteError();
      const receipts = await renderOwnedPrivateAssets(options, batch, leaseId, signal, writes, check);
      // Drain a concurrent monitor check before the atomic final write. No late
      // read of the old version may abort an already completed preparation.
      finishing = true; stopMonitor(); await checking; signal.throwIfAborted();
      completionStarted = true;
      const ready = await repository.executePublicationCommand(guideId, { type: "complete-assets", ...owner, receipts });
      signal.throwIfAborted();
      if (ready?.status !== "running" || ready.phase !== "assets-ready" || ready.leaseId !== leaseId) throw new PrivacyAssetWriteError();
      return ready;
    } catch {
      finishing = true; stopMonitor();
      // An error in storage may race a still-running monitor query. Keep the
      // shared writer slot until that actual DB operation also settles.
      await checking?.catch(() => undefined);
      // Reconcile a lost acknowledgement, but never repeat storage writes or
      // recreate a claim. This invocation generated the private lease nonce.
      const latest = await repository.getPublicationJob(guideId, jobId).catch(() => null);
      if (completionStarted && !signal.aborted && latest?.leaseId === leaseId && latest.status === "running" && latest.phase === "assets-ready") {
        const ready = await repository.executePublicationCommand(guideId, { type: "assets-ready", id: jobId,
          leaseId, expectedVersion: latest.version }).catch(() => null);
        if (!signal.aborted && ready?.status === "running" && ready.phase === "assets-ready") return ready;
      }
      const owned = claimed ?? (latest?.leaseId === leaseId ? latest : null);
      if (owned) {
        await repository.executePublicationCommand(guideId, { type: "abandon", id: jobId, leaseId }).catch(() => undefined);
        // A rejected SDK promise is not evidence that remote writes ended.
        // Keep unknown writers durable even when deleting their keys succeeds.
        if (!writes.unconfirmed) await repository.executePrivacyAssetCommand(guideId, { type: "settle", id: owned.batchId, writerId: leaseId, receipts: null })
          .catch(() => undefined);
        await cleanupPublicationPreparation(repository, storage, guideId, jobId).catch(() => undefined);
      } else if (observed && terminal(latest)) {
        await cleanupPublicationPreparation(repository, storage, guideId, jobId).catch(() => undefined);
      }
      throw new PrivacyAssetWriteError();
    } finally { stopMonitor(); signal.removeEventListener("abort", stopMonitor); }
  });
}
