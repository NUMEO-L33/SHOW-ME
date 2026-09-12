import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join } from "node:path";

const localRequire = createRequire(import.meta.url);
const bundledFfmpegPath = localRequire("ffmpeg-static") as string | null;
const bundledFfprobe = localRequire("ffprobe-static") as { path?: unknown };

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_SCENE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STDERR_BYTES = 512 * 1024;
const DEFAULT_MAX_STDOUT_BYTES = 4 * 1024 * 1024;

export type VideoOrientation = "portrait" | "landscape" | "square";

export interface VideoMetadata {
  durationMs: number;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  orientation: VideoOrientation;
  formatName: string;
  codecName: string;
  frameRate: number;
  hasAudio: boolean;
}

interface BaseMediaOptions {
  timeoutMs?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
}

export interface ProbeVideoOptions extends BaseMediaOptions {
  ffprobePath?: string;
}

export interface DetectSceneCutsOptions extends BaseMediaOptions {
  ffmpegPath?: string;
  sceneThreshold?: number;
  minSceneDurationMs?: number;
  maxCuts?: number;
}

export interface ExtractRepresentativeFramesOptions extends BaseMediaOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  frameWidth?: number;
  thumbnailWidth?: number;
  jpegQuality?: number;
  thumbnailJpegQuality?: number;
  maxFrames?: number;
}

export interface RepresentativeFrame {
  /** Zero-based position in the returned array. */
  index: number;
  startMs: number;
  endMs: number;
  timestampMs: number;
  framePath: string;
  thumbnailPath: string;
  width: number;
  height: number;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

interface ProcessRunOptions {
  timeoutMs: number;
  maxStderrBytes: number;
  maxStdoutBytes?: number;
  signal?: AbortSignal;
}

interface BoundedOutput {
  chunks: Buffer[];
  size: number;
  truncated: boolean;
  readonly limit: number;
}

type JsonRecord = Record<string, unknown>;

type VideoInputPolicy = Readonly<{
  formatWhitelist: string;
  allowedFormatNames: ReadonlySet<string>;
}>;

const MOV_FAMILY_FORMATS = Object.freeze(["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]);
const MATROSKA_FAMILY_FORMATS = Object.freeze(["matroska", "webm"]);
const MOV_INPUT_POLICY: VideoInputPolicy = {
  formatWhitelist: MOV_FAMILY_FORMATS.join(","),
  allowedFormatNames: new Set(MOV_FAMILY_FORMATS),
};
const WEBM_INPUT_POLICY: VideoInputPolicy = {
  formatWhitelist: MATROSKA_FAMILY_FORMATS.join(","),
  allowedFormatNames: new Set(MATROSKA_FAMILY_FORMATS),
};

export class MediaProcessError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(
    message: string,
    details: {
      cause?: unknown;
      exitCode?: number | null;
      stderr?: string;
      timedOut?: boolean;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "MediaProcessError";
    this.exitCode = details.exitCode ?? null;
    this.stderr = details.stderr ?? "";
    this.timedOut = details.timedOut ?? false;
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = finiteNumber(value);
  if (parsed === undefined || !Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeNumber(value: unknown, name: string): number {
  const parsed = finiteNumber(value);
  if (parsed === undefined || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative number`);
  }
  return parsed;
}

function executablePath(explicitPath: string | undefined, fallbackPath: unknown, name: string): string {
  const candidate = explicitPath ?? fallbackPath;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new MediaProcessError(`${name} executable is unavailable on this platform`);
  }
  return candidate;
}

function videoInputPolicy(inputPath: string): VideoInputPolicy {
  switch (extname(inputPath).toLowerCase()) {
    case ".mp4":
    case ".mov":
      return MOV_INPUT_POLICY;
    case ".webm":
      return WEBM_INPUT_POLICY;
    default:
      throw new MediaProcessError("Input does not use a supported video stream container extension");
  }
}

function videoInputOptions(policy: VideoInputPolicy): string[] {
  // Both options are input-scoped. Restricting protocols before probing is
  // essential: validating format_name afterwards would be too late to prevent
  // a disguised playlist from opening a nested network URL.
  return [
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    policy.formatWhitelist,
  ];
}

function assertAllowedFormatName(value: unknown, policy: VideoInputPolicy): string {
  if (typeof value !== "string") {
    throw new MediaProcessError("ffprobe did not report a video container format");
  }
  const names = value
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0 || names.some((name) => !policy.allowedFormatNames.has(name))) {
    throw new MediaProcessError(`Input video container format is not allowed: ${value || "unknown"}`);
  }
  return names.join(",");
}

function createBoundedOutput(limit: number): BoundedOutput {
  return { chunks: [], size: 0, truncated: false, limit };
}

function appendBounded(output: BoundedOutput, value: Buffer): void {
  const remaining = output.limit - output.size;
  if (remaining <= 0) {
    output.truncated = true;
    return;
  }

  const accepted = value.length <= remaining ? value : value.subarray(0, remaining);
  output.chunks.push(accepted);
  output.size += accepted.length;
  if (accepted.length !== value.length) output.truncated = true;
}

function outputText(output: BoundedOutput): string {
  return Buffer.concat(output.chunks, output.size).toString("utf8");
}

function abortError(): Error {
  const error = new Error("Media process was aborted");
  error.name = "AbortError";
  return error;
}

function runProcess(
  executable: string,
  args: readonly string[],
  options: ProcessRunOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.reject(abortError());

  return new Promise<ProcessResult>((resolve, reject) => {
    const stdout = createBoundedOutput(options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES);
    const stderr = createBoundedOutput(options.maxStderrBytes);
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stdoutExceeded = false;

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const terminate = () => {
      if (!child.killed) child.kill("SIGKILL");
    };

    const onAbort = () => {
      aborted = true;
      terminate();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref();

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      appendBounded(stdout, chunk);
      if (stdout.truncated && !stdoutExceeded) {
        stdoutExceeded = true;
        terminate();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => appendBounded(stderr, chunk));

    child.once("error", (cause) => {
      settle(() => reject(new MediaProcessError("Unable to start media process", { cause })));
    });

    child.once("close", (exitCode) => {
      const capturedStderr = outputText(stderr).trim();
      settle(() => {
        if (aborted) {
          reject(abortError());
          return;
        }
        if (timedOut) {
          reject(new MediaProcessError(`Media process timed out after ${options.timeoutMs}ms`, {
            exitCode,
            stderr: capturedStderr,
            timedOut: true,
          }));
          return;
        }
        if (stdoutExceeded) {
          reject(new MediaProcessError("Media process output exceeded the safety limit", {
            exitCode,
            stderr: capturedStderr,
          }));
          return;
        }
        if (exitCode !== 0) {
          reject(new MediaProcessError(`Media process exited with code ${exitCode ?? "unknown"}`, {
            exitCode,
            stderr: capturedStderr,
          }));
          return;
        }
        resolve({ stdout: outputText(stdout), stderr: capturedStderr });
      });
    });
  });
}

function commandOptions(options: BaseMediaOptions | undefined, defaultTimeoutMs: number): Pick<ProcessRunOptions, "timeoutMs" | "maxStderrBytes" | "signal"> {
  return {
    timeoutMs: positiveInteger(options?.timeoutMs ?? defaultTimeoutMs, "timeoutMs"),
    maxStderrBytes: positiveInteger(options?.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES, "maxStderrBytes"),
    signal: options?.signal,
  };
}

function normalizedRotation(value: number): number {
  const normalized = ((value % 360) + 360) % 360;
  const quarterTurn = Math.round(normalized / 90) * 90;
  if (Math.abs(normalized - quarterTurn) <= 0.5) return quarterTurn % 360;
  return Number(normalized.toFixed(3));
}

function rotationFromStream(stream: JsonRecord): number {
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  for (const entry of sideData) {
    const rotation = finiteNumber(asRecord(entry)?.rotation);
    if (rotation !== undefined) return normalizedRotation(rotation);
  }

  const tags = asRecord(stream.tags);
  if (tags) {
    const rotateEntry = Object.entries(tags).find(([key]) => key.toLowerCase() === "rotate");
    const rotation = finiteNumber(rotateEntry?.[1]);
    if (rotation !== undefined) return normalizedRotation(rotation);
  }
  return 0;
}

function durationSeconds(format: JsonRecord, videoStream: JsonRecord): number | undefined {
  const direct = finiteNumber(format.duration) ?? finiteNumber(videoStream.duration);
  if (direct !== undefined && direct > 0) return direct;

  const durationTicks = finiteNumber(videoStream.duration_ts);
  const timeBase = typeof videoStream.time_base === "string" ? videoStream.time_base : undefined;
  if (durationTicks === undefined || !timeBase) return undefined;
  const [numeratorText, denominatorText] = timeBase.split("/");
  const numerator = finiteNumber(numeratorText);
  const denominator = finiteNumber(denominatorText);
  if (numerator === undefined || denominator === undefined || denominator === 0) return undefined;
  const calculated = durationTicks * (numerator / denominator);
  return calculated > 0 && Number.isFinite(calculated) ? calculated : undefined;
}

function rationalNumber(value: unknown): number | undefined {
  if (typeof value !== "string") return finiteNumber(value);
  const [numeratorText, denominatorText, extra] = value.split("/");
  if (extra !== undefined) return undefined;
  if (denominatorText === undefined) return finiteNumber(numeratorText);
  const numerator = finiteNumber(numeratorText);
  const denominator = finiteNumber(denominatorText);
  if (numerator === undefined || denominator === undefined || denominator <= 0) return undefined;
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function isQuarterTurn(rotation: number): boolean {
  return Math.abs(rotation - 90) <= 0.5 || Math.abs(rotation - 270) <= 0.5;
}

function orientationFor(width: number, height: number): VideoOrientation {
  if (height > width) return "portrait";
  if (width > height) return "landscape";
  return "square";
}

export async function probeVideo(inputPath: string, options: ProbeVideoOptions = {}): Promise<VideoMetadata> {
  if (inputPath.trim() === "") throw new TypeError("inputPath must not be empty");
  const inputPolicy = videoInputPolicy(inputPath);
  const ffprobePath = executablePath(options.ffprobePath, bundledFfprobe.path, "ffprobe");
  const result = await runProcess(ffprobePath, [
    "-v",
    "error",
    ...videoInputOptions(inputPolicy),
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    inputPath,
  ], commandOptions(options, DEFAULT_TIMEOUT_MS));

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (cause) {
    throw new MediaProcessError("ffprobe returned invalid JSON", { cause, stderr: result.stderr });
  }

  const root = asRecord(parsed);
  const streams = Array.isArray(root?.streams)
    ? root.streams.map(asRecord).filter((stream): stream is JsonRecord => stream !== undefined)
    : [];
  const videoStream = streams.find((stream) => {
    if (stream.codec_type !== "video") return false;
    const disposition = asRecord(stream.disposition);
    return finiteNumber(disposition?.attached_pic) !== 1;
  });
  if (!videoStream) throw new MediaProcessError("Input does not contain a video stream");

  const codedWidth = positiveInteger(videoStream.width, "video width");
  const codedHeight = positiveInteger(videoStream.height, "video height");
  const format = asRecord(root?.format) ?? {};
  const formatName = assertAllowedFormatName(format.format_name, inputPolicy);
  const seconds = durationSeconds(format, videoStream);
  if (seconds === undefined) throw new MediaProcessError("Unable to determine video duration");

  const durationMs = Math.max(1, Math.round(seconds * 1000));
  const rotation = rotationFromStream(videoStream);
  const displayWidth = isQuarterTurn(rotation) ? codedHeight : codedWidth;
  const displayHeight = isQuarterTurn(rotation) ? codedWidth : codedHeight;
  const frameRate = rationalNumber(videoStream.avg_frame_rate)
    ?? rationalNumber(videoStream.r_frame_rate);
  if (frameRate === undefined) throw new MediaProcessError("Unable to determine video frame rate");

  return {
    durationMs,
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    rotation,
    orientation: orientationFor(displayWidth, displayHeight),
    formatName,
    codecName: typeof videoStream.codec_name === "string" ? videoStream.codec_name : "unknown",
    frameRate: Number(frameRate.toFixed(3)),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

export async function detectSceneCuts(
  inputPath: string,
  metadata: VideoMetadata,
  options: DetectSceneCutsOptions = {},
): Promise<number[]> {
  if (inputPath.trim() === "") throw new TypeError("inputPath must not be empty");
  positiveInteger(metadata.durationMs, "metadata.durationMs");
  const threshold = finiteNumber(options.sceneThreshold ?? 0.3);
  if (threshold === undefined || threshold <= 0 || threshold >= 1) {
    throw new TypeError("sceneThreshold must be greater than 0 and less than 1");
  }
  const minSceneDurationMs = nonNegativeNumber(options.minSceneDurationMs ?? 350, "minSceneDurationMs");
  const maxCuts = positiveInteger(options.maxCuts ?? 100, "maxCuts");
  const inputPolicy = videoInputPolicy(inputPath);
  const ffmpegPath = executablePath(options.ffmpegPath, bundledFfmpegPath, "ffmpeg");

  // FFmpeg's default input autorotation stays enabled. There is deliberately no
  // transpose/rotate filter here, so display metadata is applied exactly once.
  const filter = `select='gt(scene,${threshold.toFixed(6)})',showinfo`;
  const result = await runProcess(ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-loglevel",
    "info",
    ...videoInputOptions(inputPolicy),
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-vf",
    filter,
    "-an",
    "-sn",
    "-dn",
    "-f",
    "null",
    "-",
  ], commandOptions(options, DEFAULT_SCENE_TIMEOUT_MS));

  const candidates: number[] = [];
  const pattern = /\bpts_time:([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g;
  for (const match of result.stderr.matchAll(pattern)) {
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds)) candidates.push(Math.round(seconds * 1000));
  }

  const cuts: number[] = [];
  for (const candidate of candidates.sort((left, right) => left - right)) {
    if (candidate <= 0 || candidate >= metadata.durationMs) continue;
    const previousBoundary = cuts.at(-1) ?? 0;
    if (candidate - previousBoundary < minSceneDurationMs) continue;
    if (metadata.durationMs - candidate < minSceneDurationMs) continue;
    if (cuts.at(-1) === candidate) continue;
    cuts.push(candidate);
    if (cuts.length >= maxCuts) break;
  }
  return cuts;
}

function sanitizedCuts(cuts: readonly number[] | undefined, durationMs: number): number[] {
  if (!cuts) return [];
  const normalized = cuts
    .map((cut) => Math.round(cut))
    .filter((cut) => Number.isFinite(cut) && cut > 0 && cut < durationMs)
    .sort((left, right) => left - right);
  return normalized.filter((cut, index) => index === 0 || cut !== normalized[index - 1]);
}

function millisecondsForFfmpeg(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3);
}

async function probeFrameDimensions(
  framePath: string,
  options: Pick<ExtractRepresentativeFramesOptions, "ffprobePath" | "timeoutMs" | "maxStderrBytes" | "signal">,
): Promise<{ width: number; height: number }> {
  const ffprobePath = executablePath(options.ffprobePath, bundledFfprobe.path, "ffprobe");
  const result = await runProcess(ffprobePath, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    framePath,
  ], commandOptions(options, DEFAULT_TIMEOUT_MS));

  const root = asRecord(JSON.parse(result.stdout));
  const firstStream = Array.isArray(root?.streams) ? asRecord(root.streams[0]) : undefined;
  return {
    width: positiveInteger(firstStream?.width, "frame width"),
    height: positiveInteger(firstStream?.height, "frame height"),
  };
}

export async function extractRepresentativeFrames(
  inputPath: string,
  outputDir: string,
  metadata: VideoMetadata,
  cuts: readonly number[] = [],
  options: ExtractRepresentativeFramesOptions = {},
): Promise<RepresentativeFrame[]> {
  if (inputPath.trim() === "") throw new TypeError("inputPath must not be empty");
  if (outputDir.trim() === "") throw new TypeError("outputDir must not be empty");
  const durationMs = positiveInteger(metadata.durationMs, "metadata.durationMs");
  const frameWidth = positiveInteger(options.frameWidth ?? 1280, "frameWidth");
  const thumbnailWidth = positiveInteger(options.thumbnailWidth ?? 360, "thumbnailWidth");
  const jpegQuality = positiveInteger(options.jpegQuality ?? 2, "jpegQuality");
  const thumbnailJpegQuality = positiveInteger(options.thumbnailJpegQuality ?? 4, "thumbnailJpegQuality");
  if (jpegQuality > 31 || thumbnailJpegQuality > 31) {
    throw new TypeError("JPEG quality values must be between 1 and 31");
  }
  const maxFrames = positiveInteger(options.maxFrames ?? 100, "maxFrames");
  const ffmpegPath = executablePath(options.ffmpegPath, bundledFfmpegPath, "ffmpeg");
  const inputPolicy = videoInputPolicy(inputPath);
  const boundaries = [0, ...sanitizedCuts(cuts, durationMs), durationMs];
  if (boundaries.length - 1 > maxFrames) {
    throw new MediaProcessError(`Frame count exceeds the configured maximum of ${maxFrames}`);
  }

  await mkdir(outputDir, { recursive: true });
  const frames: RepresentativeFrame[] = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startMs = boundaries[index];
    const endMs = boundaries[index + 1];
    const timestampMs = Math.min(endMs - 1, Math.max(startMs, Math.round(startMs + (endMs - startMs) / 2)));
    const sequence = String(index + 1).padStart(3, "0");
    const framePath = join(outputDir, `frame-${sequence}.jpg`);
    const thumbnailPath = join(outputDir, `frame-${sequence}-thumb.jpg`);
    const filter = [
      "[0:v:0]split=2[frame_source][thumb_source]",
      `[frame_source]scale=w='min(${frameWidth},iw)':h=-2:flags=lanczos,setsar=1[frame]`,
      `[thumb_source]scale=w='min(${thumbnailWidth},iw)':h=-2:flags=lanczos,setsar=1[thumb]`,
    ].join(";");

    // Input autorotation is enabled by default. No manual rotation filter is
    // added, preventing the common iPhone double-rotation failure.
    await runProcess(ffmpegPath, [
      "-hide_banner",
      "-nostdin",
      "-nostats",
      "-loglevel",
      "error",
      "-ss",
      millisecondsForFfmpeg(timestampMs),
      ...videoInputOptions(inputPolicy),
      "-i",
      inputPath,
      "-filter_complex",
      filter,
      "-map",
      "[frame]",
      "-frames:v",
      "1",
      "-q:v",
      String(jpegQuality),
      "-update",
      "1",
      "-y",
      framePath,
      "-map",
      "[thumb]",
      "-frames:v",
      "1",
      "-q:v",
      String(thumbnailJpegQuality),
      "-update",
      "1",
      "-y",
      thumbnailPath,
    ], commandOptions(options, DEFAULT_TIMEOUT_MS));

    const dimensions = await probeFrameDimensions(framePath, options);
    frames.push({
      index,
      startMs,
      endMs,
      timestampMs,
      framePath,
      thumbnailPath,
      width: dimensions.width,
      height: dimensions.height,
    });
  }

  return frames;
}
