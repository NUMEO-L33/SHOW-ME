import { randomUUID } from "node:crypto";
import type { PrivacyAssetBatch } from "./privacy-assets.js";
import { cleanupPrivateRedactions } from "./privacy-asset-cleanup.js";
import { privateAssetSession, renderOwnedPrivateAssets, PrivacyAssetWriteError, type PrivateAssetRenderOptions } from "./privacy-asset-session.js";
export { PrivacyAssetWriteError } from "./privacy-asset-session.js";

/** Standalone internal E2 primitive. Publication jobs use their pre-reserved
 * batch through preparePublicationAssets instead. Neither is registered in HTTP. */
export async function writePrivateRedactions(options: PrivateAssetRenderOptions & {
  revision: number; inputFingerprint: string; reviewFingerprint: string; signal: AbortSignal; timeoutMs?: number;
}): Promise<PrivacyAssetBatch> {
  options = { ...options };
  return privateAssetSession(options.signal, options.timeoutMs ?? 120_000, async signal => {
    const { repository, storage, guideId } = options;
    const writerId = randomUUID(), batchId = randomUUID(); let claimed = false, reserved = false;
    const writes = { unconfirmed: false };
    try {
      signal.throwIfAborted();
      const batch = await repository.executePrivacyAssetCommand(guideId, { type: "reserve", id: batchId,
        revision: options.revision, inputFingerprint: options.inputFingerprint, reviewFingerprint: options.reviewFingerprint });
      if (!batch) throw new PrivacyAssetWriteError(); reserved = true;
      signal.throwIfAborted();
      if (!await repository.executePrivacyAssetCommand(guideId, { type: "claim", id: batch.id, version: batch.version, writerId }))
        throw new PrivacyAssetWriteError();
      claimed = true; signal.throwIfAborted();
      const receipts = await renderOwnedPrivateAssets(options, batch, writerId, signal, writes);
      signal.throwIfAborted();
      const ready = await repository.executePrivacyAssetCommand(guideId, { type: "settle", id: batch.id, writerId, receipts });
      if (ready?.status !== "ready") throw new PrivacyAssetWriteError();
      signal.throwIfAborted(); return ready;
    } catch {
      // A successful delete now cannot rule out an unconfirmed put committing
      // later. Keep its durable owner/keys and let cleanup retry, never re-put.
      if (claimed && !writes.unconfirmed) await repository.executePrivacyAssetCommand(guideId,
        { type: "settle", id: batchId, writerId, receipts: null }).catch(() => undefined);
      if (reserved) await cleanupPrivateRedactions(repository, storage, guideId, { batchId }).catch(() => undefined);
      throw new PrivacyAssetWriteError();
    }
  });
}
