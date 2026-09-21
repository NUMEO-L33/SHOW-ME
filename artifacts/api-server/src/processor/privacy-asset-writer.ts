import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GuideRepository } from "./domain.js";
import type { Storage } from "./storage.js";
import { privacyAssetKeys, privacyAssetDigest, type PrivacyAssetBatch, type PrivacyAssetReceipt } from "./privacy-assets.js";
import { renderPrivateRedaction } from "./privacy-render.js";
import { cleanupPrivateRedactions } from "./privacy-asset-cleanup.js";

export class PrivacyAssetWriteError extends Error {
  constructor() { super("PRIVACY_ASSET_WRITE_UNAVAILABLE"); }
}
let active = false;
async function readBounded(storage: Storage, key: string, maximum: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const stream = await storage.openRead(key);
  stream.on("error", () => undefined);
  const abort = () => stream.destroy();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of stream) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array) || chunks.length >= 4096 || size + chunk.byteLength > maximum) throw new PrivacyAssetWriteError();
      size += chunk.byteLength; chunks.push(Buffer.from(chunk));
    }
    signal.throwIfAborted(); return Buffer.concat(chunks, size);
  } finally { signal.removeEventListener("abort", abort); stream.destroy(); }
}

/** Internal E2 worker primitive, NOT registered as a publication/HTTP endpoint.
 * One non-replayable claim, unique keys, read-back receipts; no raw-copy fallback.
 * A timeout releases the caller but holds the slot/ledger until the SDK settles. */
export async function writePrivateRedactions(options: {
  repository: GuideRepository; storage: Storage; guideId: string; revision: number;
  inputFingerprint: string; reviewFingerprint: string; ffmpegPath: string; signal: AbortSignal;
  /** Trusted processor disposable work directory (config.dataDir/work), never HTTP input. */
  workDir: string;
  timeoutMs?: number; render?: typeof renderPrivateRedaction;
}): Promise<PrivacyAssetBatch> {
  if (active || options.signal.aborted) throw new PrivacyAssetWriteError();
  const timeout = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000) throw new PrivacyAssetWriteError();
  active = true;
  const controller = new AbortController(), signal = AbortSignal.any([options.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), timeout);
  let stop!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new PrivacyAssetWriteError()); signal.addEventListener("abort", stop, { once: true });
  });
  const { repository, storage, guideId } = options;
  const writerId = randomUUID(), batchId = randomUUID();
  let claimed = false, reserved = false, directory: string | undefined;
  const operation = (async () => {
    try {
      signal.throwIfAborted();
      const batch = await repository.executePrivacyAssetCommand(guideId, { type: "reserve", id: batchId,
        revision: options.revision, inputFingerprint: options.inputFingerprint, reviewFingerprint: options.reviewFingerprint });
      if (!batch) throw new PrivacyAssetWriteError(); reserved = true;
      signal.throwIfAborted();
      if (!await repository.executePrivacyAssetCommand(guideId, { type: "claim", id: batch.id, version: batch.version, writerId })) {
        throw new PrivacyAssetWriteError();
      }
      claimed = true; signal.throwIfAborted();
      await mkdir(options.workDir, { recursive: true });
      directory = await mkdtemp(join(options.workDir, "privacy-redactions-"));
      const receipts: PrivacyAssetReceipt[] = [], keys = privacyAssetKeys(batch);
      for (const [index, frame] of batch.frames.entries()) {
        const jpeg = await readBounded(storage, frame.sourceKey, 2 * 1024 * 1024, signal);
        for (const [offset, variant] of (["frame", "thumbnail"] as const).entries()) {
          signal.throwIfAborted();
          const current = (await repository.listPrivacyAssetBatches(guideId)).find(b => b.id === batch.id);
          const guide = await repository.getGuideById(guideId);
          if (!guide || guide.status !== "ready" || current?.status !== "writing" || current.writerId !== writerId) throw new PrivacyAssetWriteError();
          const png = await (options.render ?? renderPrivateRedaction)({ bytes: jpeg, width: frame.width, height: frame.height,
            masks: frame.masks, variant, signal, ffmpegPath: options.ffmpegPath });
          signal.throwIfAborted();
          if (png.length > 13 * 1024 * 1024 || png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
            throw new PrivacyAssetWriteError();
          }
          const key = keys[index * 2 + offset], file = join(directory, "render.png");
          await writeFile(file, png, { mode: 0o600 }); signal.throwIfAborted();
          // No replay after this call, even when its acknowledgement is lost.
          await storage.putFile(key, file); signal.throwIfAborted();
          const stored = await readBounded(storage, key, png.length, signal);
          if (stored.length !== png.length || privacyAssetDigest(stored) !== privacyAssetDigest(png)) throw new PrivacyAssetWriteError();
          receipts.push({ key, size: png.length, sha256: privacyAssetDigest(png) });
        }
      }
      signal.throwIfAborted();
      const ready = await repository.executePrivacyAssetCommand(guideId, { type: "settle", id: batch.id, writerId, receipts });
      if (ready?.status !== "ready") throw new PrivacyAssetWriteError();
      signal.throwIfAborted(); return ready;
    } catch {
      // Called only after the actual storage promise settles, not at caller timeout.
      if (claimed) await repository.executePrivacyAssetCommand(guideId,
        { type: "settle", id: batchId, writerId, receipts: null }).catch(() => undefined);
      if (reserved) await cleanupPrivateRedactions(repository, storage, guideId, { batchId }).catch(() => undefined);
      throw new PrivacyAssetWriteError();
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  })().finally(() => { active = false; clearTimeout(timer); signal.removeEventListener("abort", stop); });
  try { return await Promise.race([operation, stopped]); }
  catch { throw new PrivacyAssetWriteError(); }
}
