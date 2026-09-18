import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  detectSceneCuts,
  extractRepresentativeFrames,
  MediaProcessError,
  probeVideo,
} from "../src/processor/media/ffmpeg.js";

import { testMediaPaths } from "./helpers/media-binaries.js";
const { ffmpegPath, ffprobePath } = testMediaPaths();

let fixtureDir = "";
let landscapePath = "";
let movPath = "";
let webmPath = "";
let hevcPath = "";
let av1Path = "";
let portraitPath = "";
let rotatedPath = "";
let hardCutsPath = "";

function runFixtureCommand(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const limit = 256 * 1024;
    child.stderr.on("data", (chunk: Buffer) => {
      if (size >= limit) return;
      const accepted = chunk.subarray(0, limit - size);
      chunks.push(accepted);
      size += accepted.length;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Fixture ffmpeg failed (${code}): ${Buffer.concat(chunks).toString("utf8")}`));
    });
  });
}

function fixtureArgs(...args: string[]): string[] {
  return ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", ...args];
}

before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "showme-media-test-"));
  landscapePath = join(fixtureDir, "landscape with audio.mp4");
  movPath = join(fixtureDir, "quicktime-screen.mov");
  webmPath = join(fixtureDir, "browser-screen.webm");
  hevcPath = join(fixtureDir, "hevc-screen.mp4");
  av1Path = join(fixtureDir, "av1-screen.mp4");
  portraitPath = join(fixtureDir, "세로 화면.mp4");
  rotatedPath = join(fixtureDir, "회전 90 & metadata.mp4");
  hardCutsPath = join(fixtureDir, "hard-cuts.mp4");

  await runFixtureCommand(fixtureArgs(
    "-f", "lavfi",
    "-i", "testsrc2=size=640x360:rate=24:duration=1.5",
    "-f", "lavfi",
    "-i", "sine=frequency=880:sample_rate=44100:duration=1.5",
    "-shortest",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-y",
    landscapePath,
  ));

  await runFixtureCommand(fixtureArgs(
    "-i", landscapePath,
    "-map", "0",
    "-c", "copy",
    "-y",
    movPath,
  ));

  await runFixtureCommand(fixtureArgs(
    "-f", "lavfi",
    "-i", "testsrc2=size=320x180:rate=12:duration=0.75",
    "-an",
    "-c:v", "libvpx",
    "-deadline", "realtime",
    "-cpu-used", "8",
    "-y",
    webmPath,
  ));

  await runFixtureCommand(fixtureArgs(
    "-f", "lavfi",
    "-i", "testsrc2=size=360x640:rate=24:duration=1.25",
    "-an",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-y",
    portraitPath,
  ));

  // Retain modern screen-video decoding when slimming Replit's dependency set.
  // Tiny local fixtures only; bound encoder pools rather than using host CPU count.
  await runFixtureCommand(fixtureArgs(
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=8:duration=0.25",
    "-an", "-c:v", "libx265", "-preset", "ultrafast",
    "-x265-params", "pools=1:frame-threads=1:log-level=error",
    "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-y", hevcPath,
  ));
  await runFixtureCommand(fixtureArgs(
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=8:duration=0.25",
    "-an", "-c:v", "libaom-av1", "-cpu-used", "8", "-threads", "1",
    "-crf", "40", "-b:v", "0", "-pix_fmt", "yuv420p", "-y", av1Path,
  ));

  await runFixtureCommand(fixtureArgs(
    "-display_rotation:v:0", "90",
    "-i", landscapePath,
    "-map", "0",
    "-c", "copy",
    "-y",
    rotatedPath,
  ));

  await runFixtureCommand(fixtureArgs(
    "-f", "lavfi",
    "-i", "color=c=black:s=360x640:r=24:d=1",
    "-f", "lavfi",
    "-i", "color=c=white:s=360x640:r=24:d=1",
    "-f", "lavfi",
    "-i", "color=c=black:s=360x640:r=24:d=1",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-y",
    hardCutsPath,
  ));
});

after(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("probeVideo reports landscape dimensions, duration, codec, and audio", async () => {
  const metadata = await probeVideo(landscapePath, { ffprobePath });
  assert.equal(metadata.codedWidth, 640);
  assert.equal(metadata.codedHeight, 360);
  assert.equal(metadata.displayWidth, 640);
  assert.equal(metadata.displayHeight, 360);
  assert.equal(metadata.rotation, 0);
  assert.equal(metadata.orientation, "landscape");
  assert.equal(metadata.codecName, "h264");
  assert.equal(metadata.hasAudio, true);
  assert.match(metadata.formatName, /mp4|mov/);
  assert.ok(metadata.durationMs >= 1_400 && metadata.durationMs <= 1_600);
});

test("probeVideo accepts the allow-listed MOV and WebM container families", async () => {
  const mov = await probeVideo(movPath, { ffprobePath });
  assert.match(mov.formatName, /(?:^|,)mov(?:,|$)/);
  assert.equal(mov.codecName, "h264");

  const webm = await probeVideo(webmPath, { ffprobePath });
  assert.match(webm.formatName, /(?:^|,)webm(?:,|$)/);
  assert.equal(webm.codecName, "vp8");

  const webmOutputDir = join(fixtureDir, "webm-frames");
  const frames = await extractRepresentativeFrames(webmPath, webmOutputDir, webm, [], {
    ffmpegPath,
    ffprobePath,
    frameWidth: 320,
    thumbnailWidth: 160,
  });
  assert.equal(frames.length, 1);
  await access(frames[0].framePath);
});

for (const codec of ["hevc", "av1"] as const) {
  test(`${codec} screen video retains metadata and real JPEG extraction`, async () => {
    const input = codec === "hevc" ? hevcPath : av1Path;
    const metadata = await probeVideo(input, { ffprobePath });
    assert.equal(metadata.codecName, codec);
    assert.equal(metadata.codedWidth, 320);
    assert.equal(metadata.codedHeight, 180);
    const frames = await extractRepresentativeFrames(input, join(fixtureDir, `${codec}-frames`), metadata, [], {
      ffmpegPath, ffprobePath, frameWidth: 320, thumbnailWidth: 160,
    });
    assert.equal(frames.length, 1);
    await access(frames[0].framePath);
    await access(frames[0].thumbnailPath);
  });
}

test("probeVideo recognizes a physically portrait stream without rotation metadata", async () => {
  const metadata = await probeVideo(portraitPath, { ffprobePath });
  assert.equal(metadata.codedWidth, 360);
  assert.equal(metadata.codedHeight, 640);
  assert.equal(metadata.displayWidth, 360);
  assert.equal(metadata.displayHeight, 640);
  assert.equal(metadata.rotation, 0);
  assert.equal(metadata.orientation, "portrait");
  assert.equal(metadata.hasAudio, false);
});

test("probeVideo gives display-matrix rotation precedence and swaps display dimensions", async () => {
  const metadata = await probeVideo(rotatedPath, { ffprobePath });
  assert.equal(metadata.codedWidth, 640);
  assert.equal(metadata.codedHeight, 360);
  assert.ok(metadata.rotation === 90 || metadata.rotation === 270);
  assert.equal(metadata.displayWidth, 360);
  assert.equal(metadata.displayHeight, 640);
  assert.equal(metadata.orientation, "portrait");
});

test("detectSceneCuts finds the two hard transitions in chronological milliseconds", async () => {
  const metadata = await probeVideo(hardCutsPath, { ffprobePath });
  const cuts = await detectSceneCuts(hardCutsPath, metadata, {
    ffmpegPath,
    sceneThreshold: 0.2,
    minSceneDurationMs: 250,
  });

  assert.equal(cuts.length, 2);
  assert.ok(Math.abs(cuts[0] - 1_000) <= 60, `first cut was ${cuts[0]}ms`);
  assert.ok(Math.abs(cuts[1] - 2_000) <= 60, `second cut was ${cuts[1]}ms`);
  assert.ok(cuts[0] < cuts[1]);
});

test("extractRepresentativeFrames applies autorotation once and creates thumbnails", async () => {
  const metadata = await probeVideo(rotatedPath, { ffprobePath });
  const outputDir = join(fixtureDir, "한글 frames & thumbs");
  await mkdir(outputDir, { recursive: true });
  const midpoint = Math.round(metadata.durationMs / 2);
  const frames = await extractRepresentativeFrames(
    rotatedPath,
    outputDir,
    metadata,
    [midpoint],
    {
      ffmpegPath,
      ffprobePath,
      frameWidth: 640,
      thumbnailWidth: 160,
    },
  );

  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((frame) => frame.index), [0, 1]);
  assert.equal(frames[0].startMs, 0);
  assert.equal(frames[0].endMs, midpoint);
  assert.equal(frames[1].startMs, midpoint);
  assert.equal(frames[1].endMs, metadata.durationMs);
  for (const frame of frames) {
    assert.equal(frame.width, 360);
    assert.equal(frame.height, 640);
    assert.ok(frame.height > frame.width, "a single autorotation should yield portrait pixels");
    await access(frame.framePath);
    await access(frame.thumbnailPath);
  }
});

test("probeVideo rejects an input without a readable video stream", async () => {
  await assert.rejects(
    probeVideo(join(fixtureDir, "missing.mp4"), { ffprobePath, timeoutMs: 5_000 }),
    /Media process exited with code/,
  );
});

test("a playlist disguised as MP4 cannot open a loopback URL", async () => {
  let loopbackRequests = 0;
  const trap = createServer((_request, response) => {
    loopbackRequests += 1;
    response.writeHead(200, { "Content-Type": "video/mp2t" });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    trap.once("error", reject);
    trap.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = trap.address();
    assert.ok(address && typeof address === "object");
    const disguisedPath = join(fixtureDir, "playlist-disguised-as-video.mp4");
    await writeFile(disguisedPath, [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:1",
      "#EXTINF:1.0,",
      `http://127.0.0.1:${address.port}/private-segment.ts`,
      "#EXT-X-ENDLIST",
      "",
    ].join("\n"));

    await assert.rejects(
      probeVideo(disguisedPath, { ffprobePath, timeoutMs: 5_000 }),
      MediaProcessError,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loopbackRequests, 0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      trap.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("media subprocesses time out and keep captured stderr bounded", async () => {
  await assert.rejects(
    detectSceneCuts(hardCutsPath, await probeVideo(hardCutsPath, { ffprobePath }), {
      ffmpegPath,
      timeoutMs: 1,
    }),
    (error: unknown) => error instanceof MediaProcessError && error.timedOut,
  );

  try {
    await probeVideo(join(fixtureDir, "still missing.mp4"), {
      ffprobePath,
      maxStderrBytes: 32,
    });
    assert.fail("probeVideo should reject a missing input");
  } catch (error) {
    assert.ok(error instanceof MediaProcessError);
    assert.ok(Buffer.byteLength(error.stderr) <= 32);
  }
});
