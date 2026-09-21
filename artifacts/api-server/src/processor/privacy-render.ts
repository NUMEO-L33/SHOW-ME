import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { checkJpeg } from "./analysis-images.js";

export type MaskBounds = { x: number; y: number; width: number; height: number };
export { PRIVACY_RENDER_VERSION } from "./privacy-render-version.js";
const MAX_PIXELS = 4_194_304;
const PALETTE = [[67, 49, 94], [115, 84, 151], [177, 152, 205], [231, 214, 243]] as const;
export class PrivacyRenderError extends Error {
  constructor() { super("PRIVACY_RENDER_UNAVAILABLE"); }
}
function check(condition: unknown): asserts condition { if (!condition) throw new PrivacyRenderError(); }
function dimensions(width: number, height: number) {
  check(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 &&
    width <= 4096 && height <= 4096 && width * height <= MAX_PIXELS);
}

/** Outward rounding plus eight source pixels of bleed protection. Never clamp invalid percentages into validity. */
export function maskPixels(bounds: MaskBounds, width: number, height: number) {
  dimensions(width, height);
  check(bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0 &&
    bounds.x + bounds.width <= 100 && bounds.y + bounds.height <= 100);
  return { left: Math.max(0, Math.floor(bounds.x * width / 100) - 8),
    top: Math.max(0, Math.floor(bounds.y * height / 100) - 8),
    right: Math.min(width, Math.ceil((bounds.x + bounds.width) * width / 100) + 8),
    bottom: Math.min(height, Math.ceil((bounds.y + bounds.height) * height / 100) + 8) };
}

/** Replaces, rather than blurs or samples, source RGB pixels. The source buffer is never mutated. */
export function redactRgb(source: Uint8Array, width: number, height: number, masks: readonly MaskBounds[]): Buffer {
  dimensions(width, height);
  check(source.byteLength === width * height * 3 && Array.isArray(masks) && masks.length <= 20);
  const boxes = masks.map(mask => maskPixels(mask, width, height));
  const output = Buffer.from(source);
  const tile = Math.max(6, Math.round(Math.min(width, height) / 35));
  for (const box of boxes) for (let y = box.top; y < box.bottom; y++) for (let x = box.left; x < box.right; x++) {
    // A global pattern makes overlap/order irrelevant and cannot encode source content.
    const color = PALETTE[(Math.floor(x / tile) + 3 * Math.floor(y / tile)) % PALETTE.length];
    const at = (y * width + x) * 3;
    output[at] = color[0]; output[at + 1] = color[1]; output[at + 2] = color[2];
  }
  return output;
}

/** Thumbnails sample only already-redacted pixels, never the original JPEG/thumbnail. */
export function thumbnailRgb(source: Uint8Array, width: number, height: number) {
  dimensions(width, height); check(source.byteLength === width * height * 3);
  const scale = Math.min(1, 320 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const pixels = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const from = (Math.min(height - 1, Math.floor(y * height / h)) * width + Math.min(width - 1, Math.floor(x * width / w))) * 3;
    pixels.set(source.subarray(from, from + 3), (y * w + x) * 3);
  }
  return { pixels, width: w, height: h };
}

function pngChunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, checksum]);
}

/** Lossless RGB PNG: only dimensions and pixels; no text, EXIF, original bytes or ancillary chunks. */
export function encodePrivacyPng(pixels: Uint8Array, width: number, height: number): Buffer {
  dimensions(width, height); check(pixels.byteLength === width * height * 3);
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}

// One OS decoder per process. Reject busy work instead of buffering an unbounded queue.
let decoding = false;
async function decode(bytes: Buffer, width: number, height: number, binary: string, signal: AbortSignal): Promise<Buffer> {
  check(!decoding && !signal.aborted); decoding = true;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(binary, ["-hide_banner", "-loglevel", "error", "-xerror", "-max_alloc", "67108864",
      "-protocol_whitelist", "pipe", "-f", "mjpeg", "-err_detect", "explode", "-threads", "1", "-i", "pipe:0",
      "-map", "0:v:0", "-frames:v", "1", "-threads", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
    { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }); }
    catch { decoding = false; reject(new PrivacyRenderError()); return; }
    let size = 0, failed = false;
    const chunks: Buffer[] = [];
    const fail = () => {
      if (failed) return; failed = true; chunks.length = 0;
      signal.removeEventListener("abort", fail);
      child.stdin?.destroy(); child.stdout?.destroy();
      try { child.kill("SIGKILL"); } catch { /* Keep slot until close, even if kill fails. */ }
      reject(new PrivacyRenderError());
    };
    child.on("error", fail); child.stdin!.on("error", fail); child.stdout!.on("error", fail);
    child.stdout!.on("data", (chunk: Buffer) => { if (!failed) {
      size += chunk.length; if (size > width * height * 3) fail(); else chunks.push(chunk);
    } });
    child.once("close", code => {
      decoding = false; signal.removeEventListener("abort", fail);
      if (failed) return;
      if (signal.aborted || code !== 0 || size !== width * height * 3) { fail(); return; }
      resolve(Buffer.concat(chunks, size));
    });
    signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted) fail(); else child.stdin!.end(bytes);
  });
}

export async function renderPrivateRedaction(input: {
  bytes: Buffer; width: number; height: number; masks: readonly MaskBounds[];
  variant: "frame" | "thumbnail"; ffmpegPath: string; signal: AbortSignal;
}): Promise<Buffer> {
  try {
    dimensions(input.width, input.height);
    check(input.bytes.length <= 2 * 1024 * 1024 && input.masks.length <= 20 && ["frame", "thumbnail"].includes(input.variant));
    input.masks.forEach(mask => maskPixels(mask, input.width, input.height));
    checkJpeg(input.bytes, input.width, input.height);
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
    const source = await decode(input.bytes, input.width, input.height, input.ffmpegPath, signal);
    signal.throwIfAborted();
    const pixels = redactRgb(source, input.width, input.height, input.masks);
    const output = input.variant === "thumbnail" ? thumbnailRgb(pixels, input.width, input.height)
      : { pixels, width: input.width, height: input.height };
    const png = encodePrivacyPng(output.pixels, output.width, output.height);
    signal.throwIfAborted(); return png;
  } catch { throw new PrivacyRenderError(); }
}
