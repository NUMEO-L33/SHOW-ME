import { spawn } from "node:child_process";

import type { ProcessorConfig } from "../config.js";

export type MediaBinaryVersion = Readonly<{
  product: "ffmpeg" | "ffprobe";
  raw: string;
  major: number;
  minor: number;
  patch: number;
}>;

// This is deliberately an allow-list by release branch, not a generic major
// version floor. A future or sibling branch must be reviewed before uploads
// can reach it. The entries track FFmpeg's published security backports.
const REVIEWED_RELEASE_FLOORS = new Map<string, readonly [number, number, number]>([
  ["8.0", [8, 0, 3]],
  ["8.1", [8, 1, 2]],
  ["9.0", [9, 0, 1]],
]);

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function parseMediaBinaryVersion(
  product: "ffmpeg" | "ffprobe",
  output: string,
): MediaBinaryVersion {
  const firstLine = output.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const escapedProduct = product === "ffmpeg" ? "ffmpeg" : "ffprobe";
  const match = firstLine.match(new RegExp(`^${escapedProduct} version (?:n)?(\\d+)\\.(\\d+)(?:\\.(\\d+))?`, "i"));
  if (!match) throw new Error(`Unable to parse ${product} version from: ${firstLine || "(empty output)"}`);
  return {
    product,
    raw: firstLine,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

function runVersionCommand(
  product: "ffmpeg" | "ffprobe",
  executable: string,
  timeoutMs = 5_000,
): Promise<MediaBinaryVersion> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-version"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    const outputLimit = 64 * 1024;
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const collect = (chunk: Buffer) => {
      if (outputBytes >= outputLimit) return;
      const accepted = chunk.subarray(0, outputLimit - outputBytes);
      output.push(accepted);
      outputBytes += accepted.length;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => {
      if (code !== 0) {
        reject(new Error(`${product} -version exited with code ${code ?? "unknown"}.`));
        return;
      }
      try {
        resolve(parseMediaBinaryVersion(product, Buffer.concat(output).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    }));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`${product} -version timed out.`)));
    }, timeoutMs);
    timeout.unref();
  });
}

export function assertReviewedMediaBinaryVersion(version: MediaBinaryVersion) {
  const current: readonly [number, number, number] = [version.major, version.minor, version.patch];
  const branch = `${version.major}.${version.minor}`;
  const floor = REVIEWED_RELEASE_FLOORS.get(branch);
  if (!floor) {
    throw new Error(
      `${version.product} ${version.major}.${version.minor}.${version.patch} is not on a reviewed production release branch.`,
    );
  }
  if (compareVersion(current, floor) < 0) {
    throw new Error(
      `${version.product} ${version.major}.${version.minor}.${version.patch} is below the production security floor (${floor.join(".")}).`,
    );
  }
}

export function assertReviewedMediaBinaryPair(
  ffmpeg: MediaBinaryVersion,
  ffprobe: MediaBinaryVersion,
  expectedVersion?: string,
) {
  if (ffmpeg.major !== ffprobe.major || ffmpeg.minor !== ffprobe.minor) {
    throw new Error(
      `ffmpeg ${ffmpeg.major}.${ffmpeg.minor} and ffprobe ${ffprobe.major}.${ffprobe.minor} must come from the same release family.`,
    );
  }
  assertReviewedMediaBinaryVersion(ffmpeg);
  assertReviewedMediaBinaryVersion(ffprobe);
  if (!expectedVersion) return;

  const actualFfmpeg = `${ffmpeg.major}.${ffmpeg.minor}.${ffmpeg.patch}`;
  const actualFfprobe = `${ffprobe.major}.${ffprobe.minor}.${ffprobe.patch}`;
  if (actualFfmpeg !== expectedVersion || actualFfprobe !== expectedVersion) {
    throw new Error(
      `Media binaries must exactly match EXPECTED_MEDIA_VERSION=${expectedVersion}; received ffmpeg ${actualFfmpeg} and ffprobe ${actualFfprobe}.`,
    );
  }
}

export async function verifyMediaBinaryVersions(config: ProcessorConfig) {
  const [ffmpeg, ffprobe] = await Promise.all([
    runVersionCommand("ffmpeg", config.ffmpegPath),
    runVersionCommand("ffprobe", config.ffprobePath),
  ]);
  // Development Replit runtimes should remain usable with the host tools
  // supplied by the workspace. Published deployments and production always
  // enforce the reviewed release branch and optional exact pin.
  const securityFloorEnforced = config.nodeEnv === "production" || config.isReplitDeployment;
  if (securityFloorEnforced) {
    assertReviewedMediaBinaryPair(ffmpeg, ffprobe, config.expectedMediaVersion);
  }
  console.info(JSON.stringify({
    event: "media_binaries_verified",
    ffmpeg: `${ffmpeg.major}.${ffmpeg.minor}.${ffmpeg.patch}`,
    ffprobe: `${ffprobe.major}.${ffprobe.minor}.${ffprobe.patch}`,
    securityFloorEnforced,
  }));
  return { ffmpeg, ffprobe } as const;
}
