import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function testMediaPaths(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const ffmpeg = env.SHOWME_TEST_FFMPEG_PATH?.trim();
  const ffprobe = env.SHOWME_TEST_FFPROBE_PATH?.trim();
  if (ffmpeg || ffprobe) {
    if (!ffmpeg || !ffprobe) throw new Error("Set both SHOWME_TEST_FFMPEG_PATH and SHOWME_TEST_FFPROBE_PATH.");
    return { ffmpegPath: ffmpeg, ffprobePath: ffprobe };
  }
  // Replit/Linux supplies host binaries; pnpm intentionally does not run the
  // ffmpeg-static download hook. Missing executables fail tests, never skip them.
  if (platform !== "win32") return { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" };
  const ffmpegPath: unknown = require("ffmpeg-static");
  const ffprobePath: unknown = require("ffprobe-static").path;
  if (typeof ffmpegPath !== "string" || !ffmpegPath || typeof ffprobePath !== "string" || !ffprobePath) {
    throw new Error("Local media test binaries are required.");
  }
  return { ffmpegPath, ffprobePath };
}
