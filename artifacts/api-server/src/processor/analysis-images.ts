import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";

import { ANALYSIS_LIMITS, analysisManifest } from "./analysis-contract.js";
import { ANALYSIS_IMAGE_BUDGET } from "./analysis-image-policy.js";
import { attemptFrameObjectKey } from "./asset-lifecycle.js";
import type { GuideRepository } from "./domain.js";
import type { Storage } from "./storage.js";

const guideIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const stepIdSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const approvalSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), scope: z.literal("approved_synthetic"),
  guideId: guideIdSchema, inputFingerprint: digest,
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  images: z.array(z.object({ stepId: stepIdSchema, sha256: digest }).strict()).min(1).max(ANALYSIS_LIMITS.maxFrames),
}).strict();
export type ApprovedSyntheticImages = z.infer<typeof approvalSchema>;

export class AnalysisImageError extends Error {
  override name = "AnalysisImageError";
  constructor() { super("ANALYSIS_IMAGE_UNAVAILABLE"); }
}
function invalid(): never { throw new AnalysisImageError(); }

/** Only the pipeline's single-scan baseline JPEG profile; no EXIF, extra images or trailing payload. */
export function checkJpeg(bytes: Buffer, width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > 4096 || height > 4096 || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  let offset = 2; let frame = false; let quantization = false; let huffman = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (![0xe0, 0xfe, 0xdb, 0xc4, 0xdd, 0xc0, 0xda].includes(marker) || offset + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) invalid();
    if (marker === 0xdb) quantization = true;
    if (marker === 0xc4) huffman = true;
    if (marker === 0xc0) {
      if (frame || length < 8 || bytes[offset + 2] !== 8 ||
          bytes.readUInt16BE(offset + 3) !== height || bytes.readUInt16BE(offset + 5) !== width ||
          ![1, 3].includes(bytes[offset + 7]) || length !== 8 + 3 * bytes[offset + 7]) invalid();
      frame = true;
    }
    offset += length;
    if (marker !== 0xda) continue;
    if (!frame || !quantization || !huffman) invalid();
    // Entropy bytes may escape FF or contain restart markers. EOI must end the file.
    for (; offset < bytes.length; offset += 1) {
      if (bytes[offset] !== 0xff) continue;
      while (bytes[offset + 1] === 0xff) offset += 1;
      const next = bytes[++offset];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) continue;
      if (next === 0xd9 && offset === bytes.length - 1) return;
      invalid();
    }
    invalid();
  }
  invalid();
}

// One decoder per Node process, no implicit queue or retry. A timed-out OS child
// keeps its slot until close, even when SIGKILL was successfully requested.
let decoderActive = false;

/** Decode locally and count exactly one RGB frame; discard pixels without buffering them. */
function decodeJpeg(bytes: Buffer, width: number, height: number, binary: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || decoderActive) return Promise.reject(new AnalysisImageError());
  decoderActive = true;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(binary, [
      "-hide_banner", "-loglevel", "error", "-xerror", "-max_alloc", "67108864",
      "-protocol_whitelist", "pipe", "-f", "mjpeg", "-err_detect", "explode", "-threads", "1", "-i", "pipe:0",
      "-map", "0:v:0", "-frames:v", "1", "-threads", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }); }
    catch { decoderActive = false; reject(new AnalysisImageError()); return; }
    let failed = false; let closed = false; let size = 0;
    const fail = () => {
      if (failed) return;
      failed = true;
      signal.removeEventListener("abort", fail);
      child.stdin?.destroy(); child.stdout?.destroy();
      if (!closed && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* Keep the occupied slot until close. */ }
      }
      reject(new AnalysisImageError());
    };
    child.on("error", fail);
    child.stdin!.on("error", fail);
    child.stdout!.on("error", fail);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > width * height * 3) fail();
    });
    child.once("close", (code) => {
      closed = true; decoderActive = false;
      signal.removeEventListener("abort", fail);
      if (failed) return;
      if (signal.aborted || code !== 0 || size !== width * height * 3) { fail(); return; }
      resolve();
    });
    signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted) { fail(); return; }
    child.stdin!.end(bytes);
  });
}

/**
 * Server-only, explicitly supplied approval. No HTTP/env registration or network AI call.
 * Approval issuance/revocation is a separate trusted workflow, NOT inferred from a hash.
 * Both target and context frames must belong to this fully approved manifest.
 */
export function createPrivateAnalysisImageLoader(options: {
  repository: Pick<GuideRepository, "getGuideById">; storage: Pick<Storage, "openRead">;
  approval: ApprovedSyntheticImages; isApprovalCurrent: (approvalId: string) => boolean;
  ffmpegPath: string;
  /** Cumulative repository/storage/validation time, excluding the decoder. */
  ioTimeoutMs?: number;
  /** Includes OS launch and decoding; no claim of a separate decoder-ready signal. */
  decodeTimeoutMs?: number;
  clock?: () => Date;
}) {
  const parsed = approvalSchema.safeParse(options.approval);
  if (!parsed.success || typeof options.ffmpegPath !== "string" || !options.ffmpegPath.trim()) invalid();
  const approval = parsed.data; // Zod clones the caller's mutable approval.
  const hashes = new Map(approval.images.map((image) => [image.stepId, image.sha256]));
  if (hashes.size !== approval.images.length || Date.parse(approval.expiresAt) <= Date.parse(approval.createdAt)) invalid();
  const { repository, storage, isApprovalCurrent, ffmpegPath } = options;
  const clock = options.clock ?? (() => new Date());
  const ioTimeoutMs = options.ioTimeoutMs ?? ANALYSIS_IMAGE_BUDGET.ioMs;
  const decodeTimeoutMs = options.decodeTimeoutMs ?? ANALYSIS_IMAGE_BUDGET.decodeMs;
  if (!Number.isSafeInteger(ioTimeoutMs) || ioTimeoutMs < 1 || ioTimeoutMs > ANALYSIS_IMAGE_BUDGET.maxIoMs ||
      !Number.isSafeInteger(decodeTimeoutMs) || decodeTimeoutMs < 1 || decodeTimeoutMs > ANALYSIS_IMAGE_BUDGET.decodeMs) invalid();

  return async (guideId: string, stepId: string, parent: AbortSignal, inputFingerprint: string): Promise<Uint8Array> => {
    const controller = new AbortController();
    let stream: Readable | undefined;
    let lastTime = -Infinity;
    const stop = () => controller.abort();
    let rejectStopped!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
    controller.signal.addEventListener("abort", () => {
      stream?.destroy();
      rejectStopped(new AnalysisImageError());
    }, { once: true });
    parent.addEventListener("abort", stop, { once: true });
    const started = performance.now();
    const totalDeadline = started + ioTimeoutMs + decodeTimeoutMs;
    let phaseDeadline = started + ioTimeoutMs;
    let phaseTimer = setTimeout(stop, ioTimeoutMs);
    const timer = setTimeout(stop, ioTimeoutMs + decodeTimeoutMs);
    const phase = (ms: number) => {
      clearTimeout(phaseTimer);
      phaseDeadline = performance.now() + ms;
      if (ms <= 0) stop();
      else phaseTimer = setTimeout(stop, ms);
    };
    if (parent.aborted) stop();
    const guard = () => {
      if (performance.now() >= Math.min(phaseDeadline, totalDeadline)) stop();
      if (controller.signal.aborted) invalid();
      const at = clock().valueOf();
      if (!Number.isFinite(at) || at < lastTime || at < Date.parse(approval.createdAt) || at >= Date.parse(approval.expiresAt)) invalid();
      lastTime = at;
      const current: unknown = isApprovalCurrent(approval.id);
      if (current !== true) { void Promise.resolve(current).catch(() => undefined); invalid(); }
    };
    const frame = async () => {
      guard();
      const guide = await repository.getGuideById(guideId);
      guard();
      if (!guide || guide.id !== guideId || guide.status !== "ready" || guide.errorCode !== null ||
          !Number.isSafeInteger(guide.processingAttemptCount) || guide.processingAttemptCount < 1) invalid();
      const manifest = analysisManifest(guide);
      if (manifest.fingerprint !== inputFingerprint || manifest.frames.length !== hashes.size ||
          manifest.frames.some((candidate) => !hashes.has(candidate.stepId))) invalid();
      const step = guide.steps.find((candidate) => candidate.id === stepId);
      if (!step) invalid();
      const key = attemptFrameObjectKey(guideId, guide.processingAttemptCount, step.position + 1, "frame");
      if (key !== step.representativeFrameKey) invalid();
      return { key, width: step.frameWidth!, height: step.frameHeight! };
    };
    const read = async () => {
      guard();
      if (!guideIdSchema.safeParse(guideId).success || !stepIdSchema.safeParse(stepId).success ||
          guideId !== approval.guideId || inputFingerprint !== approval.inputFingerprint || !hashes.has(stepId)) invalid();
      const selected = await frame();
      guard();
      const openedStream = await storage.openRead(selected.key).then((opened) => {
        if (!(opened instanceof Readable)) invalid();
        // Some SDKs cannot cancel openRead. Close any stream that arrives after our deadline.
        opened.on("error", () => undefined);
        if (controller.signal.aborted) opened.destroy();
        return opened;
      });
      stream = openedStream;
      guard();
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of openedStream) {
        guard();
        if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunks.length >= 4096 ||
            chunk.byteLength > ANALYSIS_LIMITS.maxImageBytes - size) invalid();
        size += chunk.byteLength;
        chunks.push(Buffer.from(chunk));
      }
      guard();
      const bytes = Buffer.concat(chunks, size);
      if (createHash("sha256").update(bytes).digest("hex") !== hashes.get(stepId)) invalid();
      checkJpeg(bytes, selected.width, selected.height);
      guard();
      const remainingIoMs = phaseDeadline - performance.now();
      if (remainingIoMs <= 0) invalid();
      phase(decodeTimeoutMs);
      await decodeJpeg(bytes, selected.width, selected.height, ffmpegPath, controller.signal);
      guard();
      // The final ownership check gets only the unused I/O budget, not a fresh one.
      phase(remainingIoMs);
      const latest = await frame();
      if (latest.key !== selected.key) invalid();
      guard();
      return bytes;
    };
    try { return await Promise.race([read(), stopped]); }
    catch { throw new AnalysisImageError(); } // No key, path, storage detail or arbitrary abort reason escapes.
    finally {
      clearTimeout(timer); clearTimeout(phaseTimer); parent.removeEventListener("abort", stop);
      stop(); // Invalidates every late continuation, including a delayed repository lookup.
    }
  };
}
