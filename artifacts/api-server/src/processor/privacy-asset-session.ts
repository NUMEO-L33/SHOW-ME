import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GuideRepository } from "./domain.js";
import type { Storage } from "./storage.js";
import { privacyAssetKeys, privacyAssetDigest, type PrivacyAssetBatch, type PrivacyAssetReceipt } from "./privacy-assets.js";
import { renderPrivateRedaction } from "./privacy-render.js";

export class PrivacyAssetWriteError extends Error {
  constructor() { super("PRIVACY_ASSET_WRITE_UNAVAILABLE"); }
}
export type PrivateAssetRenderOptions = {
  repository: GuideRepository; storage: Storage; guideId: string; ffmpegPath: string;
  /** Trusted config.dataDir/work, never supplied by HTTP. */
  workDir: string; render?: typeof renderPrivateRedaction;
};
let active = false;
export const privateAssetWriterBusy = () => active;

/** Shared by standalone E2 and publication preparation. Timeout releases only
 * the caller; the slot is held until actual I/O and its cleanup settle. */
export async function privateAssetSession<T>(parent: AbortSignal, timeout: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (active || parent.aborted || !Number.isInteger(timeout) || timeout < 1 || timeout > 120_000) throw new PrivacyAssetWriteError();
  active = true;
  const controller = new AbortController(), signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(() => controller.abort(), timeout);
  let stop!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new PrivacyAssetWriteError()); signal.addEventListener("abort", stop, { once: true });
  });
  const work = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }).finally(() => {
    active = false; clearTimeout(timer); signal.removeEventListener("abort", stop);
  });
  try { return await Promise.race([work, stopped]); }
  catch { throw new PrivacyAssetWriteError(); }
}

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

/** Internal only: caller must hold a freshly acknowledged, non-replayable
 * writer claim and the shared session. This neither reserves nor settles. */
export async function renderOwnedPrivateAssets(options: PrivateAssetRenderOptions, batch: PrivacyAssetBatch,
  writerId: string, signal: AbortSignal, checkOwner?: () => Promise<void>): Promise<PrivacyAssetReceipt[]> {
  const { repository, storage, guideId } = options;
  const guard = async () => {
    signal.throwIfAborted();
    if (checkOwner) await checkOwner();
    else {
      const current = (await repository.listPrivacyAssetBatches(guideId)).find(b => b.id === batch.id);
      const guide = await repository.getGuideById(guideId);
      if (!guide || guide.status !== "ready" || current?.status !== "writing" || current.writerId !== writerId || current.writerSettled)
        throw new PrivacyAssetWriteError();
    }
    signal.throwIfAborted();
  };
  await guard(); await mkdir(options.workDir, { recursive: true });
  signal.throwIfAborted(); const directory = await mkdtemp(join(options.workDir, "privacy-redactions-"));
  try {
    const receipts: PrivacyAssetReceipt[] = [], keys = privacyAssetKeys(batch);
    for (const [index, frame] of batch.frames.entries()) {
      await guard();
      const jpeg = await readBounded(storage, frame.sourceKey, 2 * 1024 * 1024, signal);
      for (const [offset, variant] of (["frame", "thumbnail"] as const).entries()) {
        await guard();
        const png = await (options.render ?? renderPrivateRedaction)({ bytes: jpeg, width: frame.width, height: frame.height,
          masks: frame.masks, variant, signal, ffmpegPath: options.ffmpegPath });
        await guard();
        if (png.length > 13 * 1024 * 1024 || png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
          throw new PrivacyAssetWriteError();
        const key = keys[index * 2 + offset], file = join(directory, "render.png");
        await writeFile(file, png, { mode: 0o600 }); await guard();
        // Never retry this call. Await the real SDK settlement even after abort.
        await storage.putFile(key, file); await guard();
        const stored = await readBounded(storage, key, png.length, signal);
        if (stored.length !== png.length || privacyAssetDigest(stored) !== privacyAssetDigest(png)) throw new PrivacyAssetWriteError();
        receipts.push({ key, size: png.length, sha256: privacyAssetDigest(png) });
      }
    }
    await guard(); return receipts;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
