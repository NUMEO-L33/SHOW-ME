import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { spawn } from "node:child_process";
import { maskPixels, redactRgb, thumbnailRgb, encodePrivacyPng, renderPrivateRedaction } from "../src/processor/privacy-render.js";
import { syntheticAnalysisInput } from "../src/processor/gemini/synthetic.js";
import { testMediaPaths } from "./helpers/media-binaries.js";

test("privacy coordinates round outwards, pad edges and reject invalid/oversized input", () => {
  assert.deepEqual(maskPixels({ x: 10.1, y: 20.1, width: 10.1, height: 10.1 }, 101, 203), { left: 2, top: 32, right: 29, bottom: 70 });
  assert.deepEqual(maskPixels({ x: 0, y: 0, width: 100, height: 100 }, 20, 40), { left: 0, top: 0, right: 20, bottom: 40 });
  for (const bounds of [{ x: -1, y: 0, width: 10, height: 10 }, { x: 90, y: 90, width: 11, height: 10 },
    { x: 0, y: 0, width: 0, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }]) assert.throws(() => maskPixels(bounds, 100, 100));
  assert.throws(() => redactRgb(Buffer.alloc(3), 1, 1, Array(21).fill({ x: 0, y: 0, width: 100, height: 100 })));
  assert.throws(() => encodePrivacyPng(Buffer.alloc(3), 4096, 4096));
});

test("masked pixels and encoded thumbnails cannot depend on replaced source pixels; no source mutation", () => {
  const width = 400, height = 200, source = Buffer.alloc(width * height * 3, 40), other = Buffer.from(source);
  const mask = { x: 30, y: 20, width: 20, height: 30 }, box = maskPixels(mask, width, height);
  for (let y = box.top; y < box.bottom; y++) for (let x = box.left; x < box.right; x++) other.fill(230, (y * width + x) * 3, (y * width + x) * 3 + 3);
  const before = Buffer.from(other), a = redactRgb(source, width, height, [mask]), b = redactRgb(other, width, height, [mask]);
  assert.deepEqual(a, b); assert.deepEqual(other, before);
  assert.deepEqual(a.subarray(0, 3), source.subarray(0, 3));
  assert.deepEqual(thumbnailRgb(a, width, height), thumbnailRgb(b, width, height));
  const full = { x: 0, y: 0, width: 100, height: 100 };
  assert.deepEqual(redactRgb(other, width, height, [mask, full]), redactRgb(other, width, height, [full, mask]));
});

test("PNG contains only RGB IHDR/IDAT/IEND, round-trips exact pixels through real FFmpeg", async () => {
  const pixels = redactRgb(Buffer.alloc(90 * 160 * 3, 220), 90, 160, [{ x: 0, y: 0, width: 100, height: 100 }]);
  const png = encodePrivacyPng(pixels, 90, 160), chunks: string[] = [];
  let compressed: Buffer = Buffer.alloc(0);
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset), name = png.toString("ascii", offset + 4, offset + 8); chunks.push(name);
    if (name === "IDAT") compressed = png.subarray(offset + 8, offset + 8 + size);
    offset += size + 12;
  }
  assert.deepEqual(chunks, ["IHDR", "IDAT", "IEND"]);
  assert.equal(inflateSync(compressed).length, (90 * 3 + 1) * 160);
  const decoded = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(testMediaPaths().ffmpegPath, ["-v", "error", "-protocol_whitelist", "pipe", "-f", "image2pipe", "-c:v", "png", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], signal: AbortSignal.timeout(15_000) });
    const output: Buffer[] = []; child.stdout.on("data", chunk => output.push(chunk));
    child.on("error", reject); child.stdin.on("error", reject);
    child.on("close", code => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error("PNG_DECODE_FAILED")));
    child.stdin.end(png);
  });
  assert.deepEqual(decoded, pixels);
});

test("different real synthetic JPEGs become identical when fully covered, including thumbnails", async () => {
  const input = await syntheticAnalysisInput(), ffmpegPath = testMediaPaths().ffmpegPath;
  for (const variant of ["frame", "thumbnail"] as const) {
    const outputs: Buffer[] = [];
    for (const image of input.images) outputs.push(await renderPrivateRedaction({ bytes: Buffer.from(image.bytes), width: 640, height: 360,
      masks: [{ x: 0, y: 0, width: 100, height: 100 }], variant, ffmpegPath, signal: new AbortController().signal }));
    assert.deepEqual(outputs[0], outputs[1]);
  }
});

test("trailing payload, wrong dimensions and cancellation never yield an unredacted fallback", async () => {
  const input = await syntheticAnalysisInput();
  const base = { bytes: Buffer.from(input.images[0].bytes), width: 640, height: 360, masks: [], variant: "frame" as const,
    ffmpegPath: testMediaPaths().ffmpegPath, signal: new AbortController().signal };
  for (const override of [{ bytes: Buffer.concat([base.bytes, Buffer.from("private metadata")]) }, { width: 639 }, { signal: AbortSignal.abort("secret") }]) {
    await assert.rejects(renderPrivateRedaction({ ...base, ...override }), error => error instanceof Error && error.message === "PRIVACY_RENDER_UNAVAILABLE" && error.cause === undefined);
  }
});
