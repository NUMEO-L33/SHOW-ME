import { cleanupStorageKeys } from "./asset-lifecycle.js";
import { privacyAssetKeys, type PrivacyAssetRepository } from "./privacy-assets.js";
import type { Storage } from "./storage.js";

/** Cancel first, then delete, then drop the ledger only after every writer settles.
 * An uncertain/crashed upload never becomes 'deleted' merely because a timer expired. */
export async function cleanupPrivateRedactions(repository: PrivacyAssetRepository, storage: Storage, guideId: string,
  options: { batchId?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<boolean> {
  let complete = true;
  for (const batch of await repository.listPrivacyAssetBatches(guideId)) {
    if (options.batchId && batch.id !== options.batchId) continue;
    const cancelled = await repository.executePrivacyAssetCommand(guideId, { type: "cancel", id: batch.id });
    if (!cancelled) { complete = false; continue; }
    await cleanupStorageKeys(storage, privacyAssetKeys(cancelled), options);
    if (!cancelled.writerSettled || !await repository.executePrivacyAssetCommand(guideId,
      { type: "cleaned", id: batch.id, version: cancelled.version })) complete = false;
  }
  return complete;
}
