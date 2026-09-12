import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import type { AnalysisInput } from "./request.js";

const WIDTH = 640;
const HEIGHT = 360;
// A tiny fixture font keeps test screens independent of installed system fonts.
const FONT: Record<string, string> = {
  A: "01110 10001 10001 11111 10001 10001 10001",
  D: "11110 10001 10001 10001 10001 10001 11110",
  E: "11111 10000 10000 11110 10000 10000 11111",
  H: "10001 10001 10001 11111 10001 10001 10001",
  M: "10001 11011 10101 10101 10001 10001 10001",
  N: "10001 11001 11001 10101 10011 10011 10001",
  O: "01110 10001 10001 10001 10001 10001 01110",
  P: "11110 10001 10001 11110 10000 10000 10000",
  R: "11110 10001 10001 11110 10100 10010 10001",
  S: "01111 10000 10000 01110 00001 00001 11110",
  T: "11111 00100 00100 00100 00100 00100 00100",
  U: "10001 10001 10001 10001 10001 10001 01110",
  W: "10001 10001 10001 10101 10101 10101 01010",
  X: "10001 10001 01010 00100 01010 10001 10001",
  Y: "10001 10001 01010 00100 00100 00100 00100",
};

function pixels(completed: boolean) {
  const bytes = Buffer.alloc(WIDTH * HEIGHT * 3);
  const box = (x: number, y: number, width: number, height: number, color: readonly number[]) => {
    for (let row = y; row < y + height; row += 1) {
      for (let column = x; column < x + width; column += 1) {
        const offset = (row * WIDTH + column) * 3;
        bytes[offset] = color[0]; bytes[offset + 1] = color[1]; bytes[offset + 2] = color[2];
      }
    }
  };
  const label = (text: string, x: number, y: number, scale: number, color: readonly number[]) => {
    [...text].forEach((letter, index) => {
      const rows = FONT[letter]?.split(" ") ?? [];
      rows.forEach((row, rowIndex) => [...row].forEach((bit, column) => {
        if (bit === "1") box(x + (index * 6 + column) * scale, y + rowIndex * scale, scale, scale, color);
      }));
    });
  };
  box(0, 0, WIDTH, HEIGHT, [241, 245, 249]);
  box(0, 0, WIDTH, 66, [23, 37, 64]);
  label("SHOWME TEST", 30, 22, 3, [255, 255, 255]);
  box(80, 95, 480, 230, [255, 255, 255]);
  label(completed ? "READY" : "SETUP", 245, 127, 4, [23, 37, 64]);
  box(205, 214, 230, 68, completed ? [21, 128, 61] : [37, 99, 235]);
  label(completed ? "DONE" : "NEXT", 273, 238, 4, [255, 255, 255]);
  return bytes;
}

function jpeg(raw: Buffer): Promise<Uint8Array> {
  const binary = createRequire(import.meta.url)("ffmpeg-static") as string | null;
  if (!binary) return Promise.reject(new Error("SYNTHETIC_IMAGE_FAILED"));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [
      "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "pipe",
      "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${WIDTH}x${HEIGHT}`,
      "-i", "pipe:0", "-frames:v", "1", "-threads", "1", "-c:v", "mjpeg", "-q:v", "2",
      "-f", "image2pipe", "pipe:1",
    ], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = () => {
      failed = true;
      child.kill("SIGKILL");
      clearTimeout(timer);
      reject(new Error("SYNTHETIC_IMAGE_FAILED"));
    };
    const timer = setTimeout(fail, 10_000);
    child.once("error", fail);
    child.stdin.once("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { fail(); return; }
      if (!failed) chunks.push(chunk);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0 || !size) { reject(new Error("SYNTHETIC_IMAGE_FAILED")); return; }
      resolve(Buffer.concat(chunks));
    });
    child.stdin.end(raw);
  });
}

/** No path, upload, screenshot or user data can be supplied to this fixture generator. */
export async function syntheticAnalysisInput(): Promise<AnalysisInput> {
  const targets = [0, 1].map((position) => ({
    stepId: `synthetic-${position}`, position, timestampMs: position * 1000 + 500,
    width: WIDTH, height: HEIGHT,
  }));
  const images = [];
  for (const target of targets) images.push({
    stepId: target.stepId, mimeType: "image/jpeg" as const, bytes: await jpeg(pixels(target.position === 1)),
  });
  return { targets, context: [], images };
}
