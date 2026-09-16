import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

const MEBIBYTE = 1024 * 1024;

export const MAX_UPLOAD_BYTES = 500 * MEBIBYTE;

export const VIDEO_FORMATS = Object.freeze({
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
} as const);

export const SUPPORTED_VIDEO_EXTENSIONS = Object.freeze(
  Object.keys(VIDEO_FORMATS) as Array<keyof typeof VIDEO_FORMATS>,
);

export const SUPPORTED_VIDEO_MIME_TYPES = Object.freeze(
  Object.values(VIDEO_FORMATS),
);

export type StorageDriver = "local" | "replit";
export type ProcessorEnvironment = "development" | "test" | "production";

export type ProcessorConfig = Readonly<{
  nodeEnv: ProcessorEnvironment;
  isReplitDeployment: boolean;
  isReplitRuntime: boolean;
  port: number;
  corsOrigins: readonly string[];
  dataDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  expectedMediaVersion?: string;
  databaseUrl?: string;
  storageDriver: StorageDriver;
  replitBucketId?: string;
  replitObjectPrefix: string;
  assetTicketSecret?: string;
  maxUploadBytes: number;
  supportedVideoExtensions: readonly (keyof typeof VIDEO_FORMATS)[];
  supportedVideoMimeTypes: readonly (typeof VIDEO_FORMATS)[keyof typeof VIDEO_FORMATS][];
  sceneThreshold: number;
  maxSteps: number;
  portraitFrameWidth: number;
  landscapeFrameWidth: number;
  requestTimeoutMs: number;
  ffprobeTimeoutMs: number;
  ffmpegTimeoutMs: number;
  jobTimeoutMs: number;
  maxVideoDurationMs: number;
  maxVideoDimension: number;
  maxVideoPixels: number;
  maxVideoFrameRate: number;
  maxProcessingAttempts: number;
  queueCapacity: number;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      ["ShowMe processor configuration is invalid:", ...issues.map((issue) => `- ${issue}`)].join(
        "\n",
      ),
    );
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

function optionalString(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function integerSetting(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  issues: string[],
): number {
  const raw = optionalString(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    issues.push(`${name} must be an integer between ${minimum} and ${maximum}.`);
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    issues.push(`${name} must be an integer between ${minimum} and ${maximum}.`);
    return fallback;
  }
  return value;
}

function numberSetting(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  issues: string[],
): number {
  const raw = optionalString(env, name);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    issues.push(`${name} must be a number between ${minimum} and ${maximum}.`);
    return fallback;
  }
  return value;
}

function deploymentFlag(env: Environment, issues: string[]): boolean {
  const raw = optionalString(env, "REPLIT_DEPLOYMENT");
  if (raw === undefined || raw === "0" || raw.toLowerCase() === "false") return false;
  if (raw === "1" || raw.toLowerCase() === "true") return true;

  issues.push("REPLIT_DEPLOYMENT must be 1/true or 0/false when it is set.");
  return false;
}

function nodeEnvironment(env: Environment, issues: string[]): ProcessorEnvironment {
  const value = optionalString(env, "NODE_ENV") ?? "development";
  if (value === "development" || value === "test" || value === "production") return value;

  issues.push("NODE_ENV must be development, test, or production.");
  return "development";
}

function storageDriver(env: Environment, issues: string[]): StorageDriver {
  const value = (optionalString(env, "SHOWME_STORAGE") ?? "local").toLowerCase();
  if (value === "local" || value === "replit") return value;

  issues.push("SHOWME_STORAGE must be local or replit.");
  return "local";
}

function corsOrigins(env: Environment, issues: string[]): readonly string[] {
  const raw =
    optionalString(env, "CORS_ORIGINS") ??
    optionalString(env, "CORS_ORIGIN") ??
    "http://localhost:5173";
  const origins = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    issues.push("CORS_ORIGINS must contain at least one HTTP(S) origin.");
    return Object.freeze(["http://localhost:5173"]);
  }

  const normalized: string[] = [];
  for (const origin of origins) {
    if (origin === "*") {
      normalized.push(origin);
      continue;
    }

    try {
      const url = new URL(origin);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
        throw new Error("invalid origin");
      }
      if (url.pathname !== "/" || url.search || url.hash) {
        throw new Error("origin must not include a path, query, or fragment");
      }
      normalized.push(url.origin);
    } catch {
      issues.push(`${origin} in CORS_ORIGINS is not a valid HTTP(S) origin.`);
    }
  }

  return Object.freeze([...new Set(normalized)]);
}

function executableSetting(
  env: Environment,
  name: string,
  fallback: () => string,
  issues: string[],
): string {
  const value = optionalString(env, name) ?? fallback();
  if (value.includes("\0")) {
    issues.push(`${name} must not contain a null byte.`);
    return fallback();
  }
  return value;
}

function mediaExecutableSetting(
  env: Environment,
  name: "FFMPEG_PATH" | "FFPROBE_PATH",
  bundledFallback: () => string,
  commandFallback: string,
  nodeEnv: ProcessorEnvironment,
  isReplitRuntime: boolean,
  issues: string[],
): string {
  const explicit = optionalString(env, name);
  if (explicit) return executableSetting(env, name, bundledFallback, issues);

  // Prefer the host binaries in Replit, but keep development self-contained
  // when the managed runtime does not provide them.
  if (isReplitRuntime) {
    const probe = spawnSync(commandFallback, ["-version"], { stdio: "ignore" });
    if (probe.status === 0) return commandFallback;
    return bundledFallback();
  }
  if (nodeEnv === "production") {
    issues.push(`${name} is required outside Replit when NODE_ENV=production.`);
  }
  return bundledFallback();
}

function bundledExecutable(value: unknown, packageName: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${packageName} did not provide a binary for this platform.`);
}

function defaultFfmpegPath(): string {
  return bundledExecutable(require("ffmpeg-static") as unknown, "ffmpeg-static");
}

function defaultFfprobePath(): string {
  const packageExport = require("ffprobe-static") as { path?: unknown };
  return bundledExecutable(packageExport.path, "ffprobe-static");
}

function databaseUrl(env: Environment, issues: string[]): string | undefined {
  const value = optionalString(env, "DATABASE_URL");
  if (!value) return undefined;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    issues.push("DATABASE_URL must be a valid postgres:// or postgresql:// URL.");
  }
  return value;
}

function objectPrefix(env: Environment, issues: string[]): string {
  const raw = optionalString(env, "REPLIT_OBJECT_STORAGE_PREFIX") ?? "showme";
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/");

  if (
    !normalized ||
    normalized.includes("\0") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    issues.push(
      "REPLIT_OBJECT_STORAGE_PREFIX must be a non-empty, relative object prefix without . or .. segments.",
    );
    return "showme";
  }
  return normalized;
}

function evenFrameWidth(
  env: Environment,
  name: string,
  fallback: number,
  issues: string[],
): number {
  const width = integerSetting(env, name, fallback, 320, 4096, issues);
  if (width % 2 !== 0) {
    issues.push(`${name} must be even so ffmpeg can encode common pixel formats.`);
    return fallback;
  }
  return width;
}

/**
 * Parses and validates every processor setting in one place. Importing CONFIG
 * makes invalid production configuration fail before the HTTP server starts.
 */
export function loadConfig(env: Environment = process.env): ProcessorConfig {
  const issues: string[] = [];
  const resolvedNodeEnv = nodeEnvironment(env, issues);
  const isReplitDeployment = deploymentFlag(env, issues);
  const isReplitRuntime = isReplitDeployment || optionalString(env, "REPL_ID") !== undefined;
  const resolvedStorageDriver = storageDriver(env, issues);
  const resolvedCorsOrigins = corsOrigins(env, issues);
  const resolvedDatabaseUrl = databaseUrl(env, issues);
  const assetTicketSecret = optionalString(env, "ASSET_TICKET_SECRET");
  const expectedMediaVersion = optionalString(env, "EXPECTED_MEDIA_VERSION");

  if (expectedMediaVersion && !/^\d+\.\d+\.\d+$/.test(expectedMediaVersion)) {
    issues.push("EXPECTED_MEDIA_VERSION must use the exact major.minor.patch form, for example 8.1.2.");
  }

  if (assetTicketSecret && (!/^[A-Za-z0-9_-]+$/.test(assetTicketSecret) || Buffer.from(assetTicketSecret, "base64url").length < 32)) {
    issues.push("ASSET_TICKET_SECRET must be a base64url value containing at least 32 random bytes.");
  }

  const requestTimeoutMs = integerSetting(
    env,
    "REQUEST_TIMEOUT_MS",
    15 * 60_000,
    1_000,
    60 * 60_000,
    issues,
  );
  const ffprobeTimeoutMs = integerSetting(
    env,
    "FFPROBE_TIMEOUT_MS",
    30_000,
    1_000,
    5 * 60_000,
    issues,
  );
  const ffmpegTimeoutMs = integerSetting(
    env,
    "FFMPEG_TIMEOUT_MS",
    10 * 60_000,
    10_000,
    60 * 60_000,
    issues,
  );
  const jobTimeoutMs = integerSetting(
    env,
    "JOB_TIMEOUT_MS",
    15 * 60_000,
    10_000,
    2 * 60 * 60_000,
    issues,
  );

  if (jobTimeoutMs < ffprobeTimeoutMs || jobTimeoutMs < ffmpegTimeoutMs) {
    issues.push("JOB_TIMEOUT_MS must be greater than or equal to the ffprobe and ffmpeg timeouts.");
  }

  if (isReplitDeployment) {
    if (resolvedStorageDriver === "local") {
      issues.push(
        "SHOWME_STORAGE=local is unsafe in a Replit deployment; set SHOWME_STORAGE=replit because deployment filesystems are not durable.",
      );
    }
    if (!resolvedDatabaseUrl) {
      issues.push(
        "DATABASE_URL is required in a Replit deployment; attach Replit Database before starting the service.",
      );
    }
    if (!optionalString(env, "CORS_ORIGINS") && !optionalString(env, "CORS_ORIGIN")) {
      issues.push("CORS_ORIGINS is required in a Replit deployment and must name the published Sites origin.");
    }
    if (resolvedCorsOrigins.includes("*")) {
      issues.push("CORS_ORIGINS must not contain * in a Replit deployment.");
    }
    if (!assetTicketSecret) {
      issues.push("ASSET_TICKET_SECRET is required in a Replit deployment so asset URLs survive restarts.");
    }
    if (!expectedMediaVersion) {
      issues.push(
        "EXPECTED_MEDIA_VERSION is required in a Replit deployment so a mutable system package cannot silently change the reviewed FFmpeg release.",
      );
    }
  }

  const config: ProcessorConfig = {
    nodeEnv: resolvedNodeEnv,
    isReplitDeployment,
    isReplitRuntime,
    port: integerSetting(env, "PORT", 8788, 1, 65_535, issues),
    corsOrigins: resolvedCorsOrigins,
    dataDir: path.resolve(optionalString(env, "DATA_DIR") ?? "./processor/.data"),
    ffmpegPath: mediaExecutableSetting(
      env,
      "FFMPEG_PATH",
      defaultFfmpegPath,
      "ffmpeg",
      resolvedNodeEnv,
      isReplitRuntime,
      issues,
    ),
    ffprobePath: mediaExecutableSetting(
      env,
      "FFPROBE_PATH",
      defaultFfprobePath,
      "ffprobe",
      resolvedNodeEnv,
      isReplitRuntime,
      issues,
    ),
    expectedMediaVersion,
    databaseUrl: resolvedDatabaseUrl,
    storageDriver: resolvedStorageDriver,
    replitBucketId: optionalString(env, "REPLIT_OBJECT_STORAGE_BUCKET_ID"),
    replitObjectPrefix: objectPrefix(env, issues),
    assetTicketSecret,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    supportedVideoExtensions: SUPPORTED_VIDEO_EXTENSIONS,
    supportedVideoMimeTypes: SUPPORTED_VIDEO_MIME_TYPES,
    sceneThreshold: numberSetting(env, "SCENE_THRESHOLD", 0.3, 0.01, 1, issues),
    maxSteps: integerSetting(env, "MAX_STEPS", 24, 1, 100, issues),
    portraitFrameWidth: evenFrameWidth(env, "PORTRAIT_FRAME_WIDTH", 720, issues),
    landscapeFrameWidth: evenFrameWidth(env, "LANDSCAPE_FRAME_WIDTH", 1280, issues),
    requestTimeoutMs,
    ffprobeTimeoutMs,
    ffmpegTimeoutMs,
    jobTimeoutMs,
    maxVideoDurationMs: integerSetting(
      env,
      "MAX_VIDEO_DURATION_MS",
      20 * 60_000,
      1_000,
      2 * 60 * 60_000,
      issues,
    ),
    maxVideoDimension: integerSetting(env, "MAX_VIDEO_DIMENSION", 4_096, 320, 16_384, issues),
    maxVideoPixels: integerSetting(env, "MAX_VIDEO_PIXELS", 9_000_000, 100_000, 268_435_456, issues),
    maxVideoFrameRate: integerSetting(env, "MAX_VIDEO_FRAME_RATE", 60, 1, 240, issues),
    maxProcessingAttempts: integerSetting(env, "MAX_PROCESSING_ATTEMPTS", 3, 1, 10, issues),
    queueCapacity: integerSetting(env, "QUEUE_CAPACITY", 25, 1, 1_000, issues),
  };

  if (issues.length > 0) throw new ConfigurationError(Object.freeze(issues));
  return Object.freeze(config);
}

export type ValidatedVideoUpload = Readonly<{
  extension: keyof typeof VIDEO_FORMATS;
  mimeType: (typeof VIDEO_FORMATS)[keyof typeof VIDEO_FORMATS];
  sizeBytes: number;
}>;

export class VideoUploadValidationError extends Error {
  constructor(
    readonly code: "UNSUPPORTED_VIDEO" | "EMPTY_VIDEO" | "FILE_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "VideoUploadValidationError";
  }
}

/** Validates upload metadata before a request body is accepted or persisted. */
export function assertSupportedVideo(input: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}): ValidatedVideoUpload {
  const extension = path.extname(input.fileName).toLowerCase() as keyof typeof VIDEO_FORMATS;
  const mimeType = input.mimeType.split(";", 1)[0]?.trim().toLowerCase();

  if (!Object.prototype.hasOwnProperty.call(VIDEO_FORMATS, extension)) {
    throw new VideoUploadValidationError("UNSUPPORTED_VIDEO", `Unsupported video extension: ${extension || "(none)"}. Use mp4, mov, or webm.`);
  }
  if (mimeType && mimeType !== "application/octet-stream" && mimeType !== VIDEO_FORMATS[extension]) {
    throw new VideoUploadValidationError("UNSUPPORTED_VIDEO", `MIME type ${mimeType} does not match ${extension}.`);
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new VideoUploadValidationError("EMPTY_VIDEO", "Video size must be a positive integer number of bytes.");
  }
  if (input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new VideoUploadValidationError("FILE_TOO_LARGE", `Video exceeds the ${MAX_UPLOAD_BYTES / MEBIBYTE} MiB upload limit.`);
  }

  return Object.freeze({
    extension,
    mimeType: VIDEO_FORMATS[extension],
    sizeBytes: input.sizeBytes,
  });
}

export const CONFIG = loadConfig();
