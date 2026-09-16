import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import request from "supertest";

import { loadConfig, type ProcessorConfig } from "../src/processor/config.js";
import { DELETION_PENDING_ACTIVE } from "../src/processor/asset-lifecycle.js";
import {
  isPercent,
  type CompleteProcessingAttemptInput,
  type GuideRepository,
} from "../src/processor/domain.js";
import { createGuidePipeline } from "../src/processor/pipeline.js";
import { createProcessorApp } from "../src/processor/server.js";
import { finalizeGuideDeletion } from "../src/processor/asset-lifecycle.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { LocalStorage, type Storage } from "../src/processor/storage.js";

import { testMediaPaths } from "./helpers/media-binaries.js";
const { ffmpegPath, ffprobePath } = testMediaPaths();

let fixtureRoot = "";
let threeSceneVideoPath = "";

function runFfmpeg(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    const stderrLimit = 256 * 1024;

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= stderrLimit) return;
      const accepted = chunk.subarray(0, stderrLimit - stderrBytes);
      stderr.push(accepted);
      stderrBytes += accepted.length;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `Fixture ffmpeg failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
      }
    });
  });
}

function fixtureArgs(...args: string[]): string[] {
  return ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", ...args];
}

function pipelineConfig(dataDir: string): ProcessorConfig {
  return loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    SHOWME_STORAGE: "local",
    CORS_ORIGINS: "http://localhost:5173",
    FFMPEG_PATH: ffmpegPath,
    FFPROBE_PATH: ffprobePath,
    SCENE_THRESHOLD: "0.2",
    MAX_STEPS: "6",
    PORTRAIT_FRAME_WIDTH: "360",
    LANDSCAPE_FRAME_WIDTH: "640",
    REQUEST_TIMEOUT_MS: "60000",
    FFPROBE_TIMEOUT_MS: "30000",
    FFMPEG_TIMEOUT_MS: "60000",
    JOB_TIMEOUT_MS: "90000",
  });
}

type Harness = {
  config: ProcessorConfig;
  repository: JsonGuideRepository;
  storage: LocalStorage;
  guideId: string;
};

async function createHarness(
  label: string,
  sourcePath: string,
  identity?: { id: string; editToken: string },
): Promise<Harness> {
  const root = join(fixtureRoot, label);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });

  const config = pipelineConfig(dataDir);
  const repository = new JsonGuideRepository(join(dataDir, "guides.json"));
  const storage = new LocalStorage(join(dataDir, "objects"));
  const guideId = identity?.id ?? `pipeline-${label}`;
  const originalObjectKey = `guides/${guideId}/source.mp4`;
  const sourceInfo = await stat(sourcePath);

  await storage.putFile(originalObjectKey, sourcePath);
  await repository.createGuide({
    id: guideId,
    ownerId: null,
    slug: guideId,
    editToken: identity?.editToken ?? `${guideId}-edit-token`,
    title: `${label} pipeline test`,
    status: "queued",
    originalObjectKey,
    sourceFilename: `${label}.mp4`,
    sourceMimeType: "video/mp4",
    sourceSizeBytes: sourceInfo.size,
  });

  return { config, repository, storage, guideId };
}

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "showme-pipeline-test-"));
  const unrotatedPath = join(fixtureRoot, "three-scenes-base.mp4");
  threeSceneVideoPath = join(fixtureRoot, "three-scenes-rotated.mp4");

  await runFfmpeg(
    fixtureArgs(
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=640x360:r=24:d=1",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=640x360:r=24:d=1",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=640x360:r=24:d=1",
      "-filter_complex",
      "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-y",
      unrotatedPath,
    ),
  );

  await runFfmpeg(
    fixtureArgs(
      "-display_rotation:v:0",
      "90",
      "-i",
      unrotatedPath,
      "-map",
      "0",
      "-c",
      "copy",
      "-y",
      threeSceneVideoPath,
    ),
  );
});

after(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

test("pipeline turns a queued rotated three-scene guide into persisted ready steps", async () => {
  const harness = await createHarness("success", threeSceneVideoPath);
  const pipeline = createGuidePipeline(harness);

  await pipeline.process(harness.guideId);

  const guide = await harness.repository.getGuideById(harness.guideId);
  assert.ok(guide);
  assert.equal(guide.status, "ready");
  assert.equal(guide.progress, 100);
  assert.equal(guide.errorCode, null);
  assert.equal(guide.errorMessage, null);
  assert.ok(guide.processingAttemptId);
  assert.equal(guide.processingAttemptCount, 1);
  assert.ok(guide.durationMs && guide.durationMs >= 2_900 && guide.durationMs <= 3_100);
  assert.equal(guide.sourceWidth, 640);
  assert.equal(guide.sourceHeight, 360);
  assert.equal(guide.displayWidth, 360);
  assert.equal(guide.displayHeight, 640);
  assert.ok(guide.rotationDegrees === 90 || guide.rotationDegrees === 270);

  assert.equal(guide.steps.length, 3);
  assert.deepEqual(
    guide.steps.map((step) => step.position),
    [0, 1, 2],
  );

  for (const [index, step] of guide.steps.entries()) {
    const sequence = String(index + 1).padStart(3, "0");
    assert.equal(
      step.representativeFrameKey,
      `guides/${harness.guideId}/attempts/1/frames/frame-${sequence}.jpg`,
    );
    assert.equal(
      step.thumbnailFrameKey,
      `guides/${harness.guideId}/attempts/1/frames/frame-${sequence}-thumb.jpg`,
    );
    assert.equal(step.frameWidth, 360);
    assert.equal(step.frameHeight, 640);
    assert.ok(step.representativeTimestampMs !== null);
    assert.ok(step.representativeTimestampMs >= step.startMs);
    assert.ok(step.representativeTimestampMs <= step.endMs);

    assert.ok(step.representativeFrameKey);
    assert.ok(step.thumbnailFrameKey);
    const frameInfo = await stat(join(harness.storage.root, step.representativeFrameKey));
    const thumbnailInfo = await stat(join(harness.storage.root, step.thumbnailFrameKey));
    assert.ok(frameInfo.isFile() && frameInfo.size > 0);
    assert.ok(thumbnailInfo.isFile() && thumbnailInfo.size > 0);

    const taps = step.elements.filter((element) => element.type === "tap");
    assert.equal(taps.length, 1);
    assert.ok(isPercent(taps[0].center.x));
    assert.ok(isPercent(taps[0].center.y));
    assert.ok(isPercent(taps[0].radius));
    assert.deepEqual(taps[0].center, { x: 50, y: 50 });
    assert.equal(taps[0].radius, 5);
  }

  await access(join(harness.config.dataDir, "guides.json"));
  await assert.rejects(access(join(harness.config.dataDir, "work", harness.guideId)));
});

test("pipeline persists a retryable failed state for a damaged video", async () => {
  const damagedVideoPath = join(fixtureRoot, "damaged-video.mp4");
  await writeFile(damagedVideoPath, Buffer.from("not a playable video", "utf8"));
  const harness = await createHarness("damaged", damagedVideoPath);
  const pipeline = createGuidePipeline(harness);

  await assert.rejects(pipeline.process(harness.guideId));

  const guide = await harness.repository.getGuideById(harness.guideId);
  assert.ok(guide);
  assert.equal(guide.status, "failed");
  assert.equal(guide.progress, 100);
  assert.equal(guide.statusMessage, "영상 처리에 실패했어요.");
  assert.equal(guide.errorCode, "INVALID_VIDEO");
  assert.match(guide.errorMessage ?? "", /다시 시도/);
  assert.ok(guide.processingAttemptId);
  assert.equal(guide.processingAttemptCount, 1);
  assert.equal(guide.steps.length, 0);
  assert.equal(
    await harness.repository.verifyEditToken(harness.guideId, `${harness.guideId}-edit-token`),
    true,
  );
  await assert.rejects(access(join(harness.config.dataDir, "work", harness.guideId)));
});

test("a stalled materialization releases the worker deadline and cannot leave a late work copy", async () => {
  const harness = await createHarness("stalled-materialize", threeSceneVideoPath);
  harness.config = Object.freeze({ ...harness.config, jobTimeoutMs: 30 });
  let releaseRead!: () => void;
  let confirmSettled!: () => void;
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
  const materializationSettled = new Promise<void>((resolve) => { confirmSettled = resolve; });
  const stalledStorage = new Proxy(harness.storage, {
    get(target, property) {
      if (property === "materialize") {
        return async (key: string, destinationPath: string, options?: { signal?: AbortSignal }) => {
          try {
            await readReleased;
            return await target.materialize(key, destinationPath, options);
          } finally {
            confirmSettled();
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Storage;
  const startedAt = Date.now();

  await assert.rejects(
    createGuidePipeline({ ...harness, storage: stalledStorage }).process(harness.guideId),
    /materialization was aborted/i,
  );
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal((await harness.repository.getGuideById(harness.guideId))?.status, "failed");

  releaseRead();
  await materializationSettled;
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  await assert.rejects(access(join(harness.config.dataDir, "work", harness.guideId)));
});

test("a worker finalizes deletion when cancellation wins just after the processing claim", async () => {
  const harness = await createHarness("delete-after-claim", threeSceneVideoPath);
  const attemptId = "claimed-before-delete";
  const claimed = await harness.repository.claimProcessingAttempt(harness.guideId, attemptId, {
    expectedStatuses: ["queued"],
    maxAttempts: 3,
  });
  assert.ok(claimed);
  const deletion = await harness.repository.updateStatus(harness.guideId, "failed", {
    expectedStatuses: ["probing"],
    expectedProcessingAttemptId: attemptId,
    expectedProcessingAttemptCount: claimed.processingAttemptCount,
    progress: 100,
    errorCode: DELETION_PENDING_ACTIVE,
    errorMessage: "deleting",
  });
  assert.ok(deletion);

  const pipeline = createGuidePipeline(harness);
  await pipeline.processClaimed(harness.guideId, attemptId, claimed.processingAttemptCount);

  assert.equal(await harness.repository.getGuideById(harness.guideId), null);
  await assert.rejects(access(join(harness.storage.root, claimed.originalObjectKey)));
});

test("a stale worker cannot finalize deletion owned by a newer active attempt", async () => {
  const harness = await createHarness("stale-delete-owner", threeSceneVideoPath);
  await harness.repository.claimProcessingAttempt(harness.guideId, "old-worker", {
    expectedStatuses: ["queued"],
  });
  const newer = await harness.repository.claimProcessingAttempt(harness.guideId, "new-worker", {
    expectedStatuses: ["probing"],
    expectedProcessingAttemptId: "old-worker",
    expectedProcessingAttemptCount: 1,
  });
  assert.ok(newer);
  await harness.repository.updateStatus(harness.guideId, "failed", {
    expectedStatuses: ["probing"],
    expectedProcessingAttemptId: "new-worker",
    errorCode: DELETION_PENDING_ACTIVE,
  });

  await createGuidePipeline(harness).processClaimed(harness.guideId, "old-worker", 1);

  assert.equal((await harness.repository.getGuideById(harness.guideId))?.errorCode, DELETION_PENDING_ACTIVE);
  await access(join(harness.storage.root, newer.originalObjectKey));
});

test("a timed-out frame write survives DELETE and a failed late cleanup as a durable marker", { timeout: 15_000 }, async () => {
  const editToken = "A".repeat(43);
  const harness = await createHarness("late-frame-delete", threeSceneVideoPath, {
    id: "b768c899-9985-4f98-a7f6-6e351eaa5ec9",
    editToken,
  });
  harness.config = Object.freeze({ ...harness.config, jobTimeoutMs: 4_000 });
  const committedFramePath = join(fixtureRoot, "late-frame-bytes.jpg");
  await writeFile(committedFramePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  let releaseWrite!: () => void;
  let confirmLateDelete!: () => void;
  const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const lateDeleteAttempted = new Promise<void>((resolve) => { confirmLateDelete = resolve; });
  let stalledKey: string | undefined;
  let committed = false;
  let failLateDelete = true;
  const storage = new Proxy(harness.storage, {
    get(target, property) {
      if (property === "putFile") {
        return async (key: string, sourcePath: string) => {
          if (!stalledKey && key.includes("/frames/")) {
            stalledKey = key;
            await writeReleased;
            await target.putFile(key, committedFramePath);
            committed = true;
            return;
          }
          await target.putFile(key, sourcePath);
        };
      }
      if (property === "delete") {
        return async (key: string) => {
          if (committed && key === stalledKey && failLateDelete) {
            failLateDelete = false;
            confirmLateDelete();
            throw new Error("late delete acknowledgement failed");
          }
          await target.delete(key);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Storage;
  const pipeline = createGuidePipeline({ ...harness, storage });
  const app = createProcessorApp({ ...harness, storage, pipeline });
  await pipeline.process(harness.guideId);
  assert.ok(stalledKey, "the fixture must reach a real frame write before timing out");
  assert.equal((await harness.repository.getGuideById(harness.guideId))?.errorCode, DELETION_PENDING_ACTIVE);

  await request(app).delete(`/api/guides/${harness.guideId}`)
    .set("Authorization", `Bearer ${editToken}`).expect(202);
  releaseWrite();
  await lateDeleteAttempted;
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal((await harness.repository.getGuideById(harness.guideId))?.errorCode, DELETION_PENDING_ACTIVE);
  await access(join(harness.storage.root, stalledKey));

  assert.equal(await finalizeGuideDeletion(harness.repository, storage, harness.guideId, 6), true);
  await assert.rejects(access(join(harness.storage.root, stalledKey)));
  assert.equal(await harness.repository.getGuideById(harness.guideId), null);
});

test("pipeline rejects a probed video that exceeds configured resource limits", async () => {
  const harness = await createHarness("duration-limit", threeSceneVideoPath);
  harness.config = Object.freeze({
    ...harness.config,
    maxVideoDurationMs: 1_000,
  });
  const pipeline = createGuidePipeline(harness);

  await assert.rejects(pipeline.process(harness.guideId), /duration/i);

  const guide = await harness.repository.getGuideById(harness.guideId);
  assert.ok(guide);
  assert.equal(guide.status, "failed");
  assert.equal(guide.errorCode, "VIDEO_DURATION_LIMIT");
  assert.match(guide.errorMessage ?? "", /짧은/);
  assert.equal(guide.steps.length, 0);
  await assert.rejects(access(join(harness.config.dataDir, "work", harness.guideId)));
});

test("a superseded pipeline deletes only its attempt assets and cannot replace the winner", async () => {
  const harness = await createHarness("superseded", threeSceneVideoPath);
  const winnerAttemptId = "winner-attempt";
  const winnerAssetSource = join(fixtureRoot, "winner-frame.jpg");
  await writeFile(winnerAssetSource, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const winnerFrameKey = `guides/${harness.guideId}/attempts/2/frames/frame-001.jpg`;
  const winnerThumbnailKey = `guides/${harness.guideId}/attempts/2/frames/frame-001-thumb.jpg`;
  const staleAssetKeys: string[] = [];

  const repository = new Proxy(harness.repository, {
    get(target, property) {
      if (property === "completeProcessingAttempt") {
        return async (guideId: string, input: CompleteProcessingAttemptInput) => {
          staleAssetKeys.push(...input.steps.flatMap((step) => [
            step.representativeFrameKey,
            step.thumbnailFrameKey,
          ].filter((key): key is string => typeof key === "string")));
          const winner = await target.claimProcessingAttempt(guideId, winnerAttemptId, {
            expectedStatuses: ["extracting"],
            expectedProcessingAttemptId: input.attemptId,
            expectedProcessingAttemptCount: input.attemptCount,
            maxAttempts: 3,
          });
          assert.equal(winner?.processingAttemptCount, 2);
          const extracting = await target.updateStatus(guideId, "extracting", {
            expectedStatuses: ["probing"],
            expectedProcessingAttemptId: winnerAttemptId,
            expectedProcessingAttemptCount: 2,
          });
          assert.ok(extracting);
          await Promise.all([
            harness.storage.putFile(winnerFrameKey, winnerAssetSource),
            harness.storage.putFile(winnerThumbnailKey, winnerAssetSource),
          ]);
          const completed = await target.completeProcessingAttempt(guideId, {
            attemptId: winnerAttemptId,
            attemptCount: 2,
            steps: [{
              shortLabel: "winner",
              instruction: "winner step",
              startMs: 0,
              endMs: 1_000,
              representativeFrameKey: winnerFrameKey,
              thumbnailFrameKey: winnerThumbnailKey,
            }],
          });
          assert.equal(completed?.status, "ready");
          return target.completeProcessingAttempt(guideId, input);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as GuideRepository;
  const pipeline = createGuidePipeline({ ...harness, repository });

  await pipeline.process(harness.guideId);

  const guide = await harness.repository.getGuideById(harness.guideId);
  assert.ok(guide);
  assert.equal(guide.status, "ready");
  assert.equal(guide.processingAttemptId, winnerAttemptId);
  assert.equal(guide.processingAttemptCount, 2);
  assert.equal(guide.errorCode, null);
  assert.equal(guide.steps.length, 1);
  assert.equal(guide.steps[0].shortLabel, "winner");
  assert.equal(staleAssetKeys.length, 6);
  for (const staleKey of staleAssetKeys) {
    await assert.rejects(access(join(harness.storage.root, staleKey)));
  }
  await access(join(harness.storage.root, winnerFrameKey));
  await access(join(harness.storage.root, winnerThumbnailKey));
});

test("a lost PostgreSQL commit acknowledgement cannot delete published frame assets", async () => {
  const harness = await createHarness("commit-ack-loss", threeSceneVideoPath);
  const repository = new Proxy(harness.repository, {
    get(target, property) {
      if (property === "completeProcessingAttempt") {
        return async (guideId: string, input: CompleteProcessingAttemptInput) => {
          const committed = await target.completeProcessingAttempt(guideId, input);
          assert.equal(committed?.status, "ready");
          throw new Error("connection lost after COMMIT");
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as GuideRepository;
  const pipeline = createGuidePipeline({ ...harness, repository });

  await pipeline.process(harness.guideId);

  const guide = await harness.repository.getGuideById(harness.guideId);
  assert.equal(guide?.status, "ready");
  assert.ok(guide?.steps.length);
  for (const step of guide.steps) {
    assert.ok(step.representativeFrameKey);
    assert.ok(step.thumbnailFrameKey);
    await access(join(harness.storage.root, step.representativeFrameKey));
    await access(join(harness.storage.root, step.thumbnailFrameKey));
  }
});

test("a recovered attempt removes hidden frames from every prior deployment-sized attempt", async () => {
  const harness = await createHarness("prior-attempt-cleanup", threeSceneVideoPath);
  const first = await harness.repository.claimProcessingAttempt(harness.guideId, "crashed-attempt", {
    expectedStatuses: ["queued"],
    maxAttempts: 3,
  });
  assert.ok(first);
  await harness.repository.updateStatus(harness.guideId, "failed", {
    expectedStatuses: ["probing"],
    expectedProcessingAttemptId: "crashed-attempt",
    expectedProcessingAttemptCount: 1,
    errorCode: "PROCESSING_FAILED",
  });
  await harness.repository.updateStatus(harness.guideId, "queued", {
    expectedStatuses: ["failed"],
    expectedProcessingAttemptId: "crashed-attempt",
    expectedProcessingAttemptCount: 1,
    expectedErrorCode: "PROCESSING_FAILED",
  });
  const hiddenFrame = `guides/${harness.guideId}/attempts/1/frames/frame-100.jpg`;
  const hiddenThumb = `guides/${harness.guideId}/attempts/1/frames/frame-100-thumb.jpg`;
  const hiddenSource = join(fixtureRoot, "hidden-prior-attempt.jpg");
  await writeFile(hiddenSource, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await Promise.all([
    harness.storage.putFile(hiddenFrame, hiddenSource),
    harness.storage.putFile(hiddenThumb, hiddenSource),
  ]);

  await createGuidePipeline(harness).process(harness.guideId);

  assert.equal((await harness.repository.getGuideById(harness.guideId))?.processingAttemptCount, 2);
  await assert.rejects(access(join(harness.storage.root, hiddenFrame)));
  await assert.rejects(access(join(harness.storage.root, hiddenThumb)));
});
