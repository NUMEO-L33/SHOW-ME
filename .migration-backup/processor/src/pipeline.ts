import { extname, join } from "node:path";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  attemptAssetKeys,
  attemptFrameObjectKey,
  cleanupStorageKeys,
  DELETION_PENDING_ACTIVE,
  deferActiveGuideDeletion,
  durableAttemptAssetKeys,
  finalizeGuideDeletion,
  isDeletionPending,
  materializePrivateAsset,
  PrivateAssetWriteInterruptedError,
  putPrivateAsset,
} from "./asset-lifecycle.js";
import type { ProcessorConfig } from "./config.js";
import {
  toPercent,
  type CreateGuideStepInput,
  type Guide,
  type GuideRepository,
  type GuideStatus,
} from "./domain.js";
import {
  MediaProcessError,
  detectSceneCuts,
  extractRepresentativeFrames,
  probeVideo,
  type VideoMetadata,
} from "./media/ffmpeg.js";
import type { Storage } from "./storage.js";

export type GuidePipeline = {
  process(guideId: string): Promise<void>;
  processClaimed(guideId: string, attemptId: string, attemptCount: number): Promise<void>;
};

type PipelineDependencies = {
  config: ProcessorConfig;
  repository: GuideRepository;
  storage: Storage;
};

function safeGuideId(guideId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(guideId)) throw new Error("Invalid guide id");
  return guideId;
}

function safeAttemptId(attemptId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(attemptId)) throw new Error("Invalid processing attempt id");
  return attemptId;
}

function safeAttemptCount(attemptCount: number) {
  if (!Number.isSafeInteger(attemptCount) || attemptCount <= 0) {
    throw new Error("Invalid processing attempt count");
  }
  return attemptCount;
}

function fallbackCuts(durationMs: number, detectedCuts: readonly number[], maxSteps: number) {
  const sorted = [...detectedCuts].sort((left, right) => left - right).slice(0, Math.max(0, maxSteps - 1));
  if (sorted.length > 0 || durationMs <= 8_000) return sorted;

  const targetSegmentMs = 6_000;
  const count = Math.min(maxSteps, Math.max(1, Math.ceil(durationMs / targetSegmentMs)));
  return Array.from({ length: count - 1 }, (_, index) => Math.round(((index + 1) * durationMs) / count));
}

function sourceExtension(filename: string) {
  const extension = extname(filename).toLowerCase();
  return [".mp4", ".mov", ".webm"].includes(extension) ? extension : ".video";
}

class VideoPolicyError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    message: string,
  ) {
    super(message);
    this.name = "VideoPolicyError";
  }
}

class StaleProcessingAttemptError extends Error {
  override name = "StaleProcessingAttemptError";
}

function publicError(error: unknown, stage: "probing" | "extracting") {
  if (error instanceof VideoPolicyError) {
    return { code: error.code, message: error.publicMessage };
  }
  if (error instanceof MediaProcessError) {
    if (error.timedOut) return { code: "MEDIA_TIMEOUT", message: "영상 분석 시간이 초과됐어요. 더 짧은 녹화로 다시 시도해 주세요." };
    if (stage === "probing" || /video stream|container|format|duration|width|height/i.test(error.message)) {
      return { code: "INVALID_VIDEO", message: "재생 가능한 화면 녹화 영상인지 확인한 뒤 다시 시도해 주세요." };
    }
  }
  return { code: "PROCESSING_FAILED", message: "영상 처리 중 문제가 생겼어요. 원본으로 다시 시도할 수 있습니다." };
}

function validateVideoMetadata(metadata: VideoMetadata, config: ProcessorConfig): void {
  const allowedCodecs = new Set(["h264", "hevc", "vp8", "vp9", "av1"]);
  if (!allowedCodecs.has(metadata.codecName.toLowerCase())) {
    throw new VideoPolicyError(
      "UNSUPPORTED_VIDEO_CODEC",
      "지원되는 코덱(H.264, HEVC, VP8, VP9, AV1)의 영상으로 다시 시도해 주세요.",
      `Unsupported video codec: ${metadata.codecName}`,
    );
  }
  if (metadata.durationMs > config.maxVideoDurationMs) {
    throw new VideoPolicyError(
      "VIDEO_DURATION_LIMIT",
      "영상이 너무 길어요. 더 짧은 화면 녹화로 다시 시도해 주세요.",
      `Video duration ${metadata.durationMs}ms exceeds ${config.maxVideoDurationMs}ms`,
    );
  }
  if (
    metadata.codedWidth > config.maxVideoDimension ||
    metadata.codedHeight > config.maxVideoDimension
  ) {
    throw new VideoPolicyError(
      "VIDEO_DIMENSION_LIMIT",
      "영상 해상도가 너무 커요. 더 낮은 해상도로 다시 녹화해 주세요.",
      `Video dimensions ${metadata.codedWidth}x${metadata.codedHeight} exceed ${config.maxVideoDimension}`,
    );
  }
  const pixels = metadata.codedWidth * metadata.codedHeight;
  if (pixels > config.maxVideoPixels) {
    throw new VideoPolicyError(
      "VIDEO_PIXEL_LIMIT",
      "영상 해상도가 너무 커요. 더 낮은 해상도로 다시 녹화해 주세요.",
      `Video pixel count ${pixels} exceeds ${config.maxVideoPixels}`,
    );
  }
  if (metadata.frameRate > config.maxVideoFrameRate) {
    throw new VideoPolicyError(
      "VIDEO_FRAME_RATE_LIMIT",
      "영상 프레임 속도가 너무 높아요. 더 낮은 프레임 속도로 다시 녹화해 주세요.",
      `Video frame rate ${metadata.frameRate} exceeds ${config.maxVideoFrameRate}`,
    );
  }
}

function statusMessage(status: GuideStatus) {
  const messages: Record<GuideStatus, string> = {
    uploading: "영상을 올리고 있어요.",
    queued: "처리 순서를 기다리고 있어요.",
    probing: "영상 방향과 길이를 확인하고 있어요.",
    extracting: "장면을 나누고 대표 화면을 저장하고 있어요.",
    ready: "단계별 화면 추출을 마쳤어요.",
    failed: "영상 처리에 실패했어요.",
  };
  return messages[status];
}

export function createGuidePipeline({ config, repository, storage }: PipelineDependencies): GuidePipeline {
  async function processClaimed(
    guideId: string,
    rawAttemptId: string,
    rawAttemptCount: number,
  ): Promise<void> {
    const id = safeGuideId(guideId);
    const attemptId = safeAttemptId(rawAttemptId);
    const attemptCount = safeAttemptCount(rawAttemptCount);
    const deletionOwnership = {
      expectedProcessingAttemptId: attemptId,
      expectedProcessingAttemptCount: attemptCount,
    };
    const ownsAttempt = (guide: Guide | null): guide is Guide => Boolean(
      guide && guide.processingAttemptId === attemptId && guide.processingAttemptCount === attemptCount,
    );
    const initialGuide = await repository.getGuideById(id);
    if (ownsAttempt(initialGuide) && isDeletionPending(initialGuide)) {
      await finalizeGuideDeletion(repository, storage, id, config.maxSteps, deletionOwnership);
      return;
    }
    if (
      !initialGuide ||
      initialGuide.status !== "probing" ||
      initialGuide.processingAttemptId !== attemptId ||
      initialGuide.processingAttemptCount !== attemptCount
    ) return;

    let stage: "probing" | "extracting" = "probing";
    const workRoot = join(config.dataDir, "work", id, attemptId);
    const inputPath = join(
      workRoot,
      `source${sourceExtension(initialGuide.sourceFilename)}`,
    );
    const outputDir = join(workRoot, "frames");
    const timeoutAbort = new AbortController();
    const timeout = setTimeout(
      () => timeoutAbort.abort(new Error("Guide job timed out")),
      config.jobTimeoutMs,
    );
    timeout.unref();

    try {
      for (let previousAttempt = 1; previousAttempt < attemptCount; previousAttempt += 1) {
        await cleanupStorageKeys(storage, durableAttemptAssetKeys(id, previousAttempt));
      }
      await rm(workRoot, { recursive: true, force: true });
      await mkdir(workRoot, { recursive: true });
      await materializePrivateAsset(storage, initialGuide.originalObjectKey, inputPath, {
        signal: timeoutAbort.signal,
        timeoutMs: config.jobTimeoutMs,
      });

      const metadata = await probeVideo(inputPath, {
        ffprobePath: config.ffprobePath,
        timeoutMs: config.ffprobeTimeoutMs,
        signal: timeoutAbort.signal,
      });
      validateVideoMetadata(metadata, config);
      const extracting = await repository.updateStatus(id, "extracting", {
        expectedStatuses: ["probing"],
        expectedProcessingAttemptId: attemptId,
        expectedProcessingAttemptCount: attemptCount,
        progress: 42,
        statusMessage: statusMessage("extracting"),
        durationMs: metadata.durationMs,
        sourceWidth: metadata.codedWidth,
        sourceHeight: metadata.codedHeight,
        displayWidth: metadata.displayWidth,
        displayHeight: metadata.displayHeight,
        rotationDegrees: metadata.rotation,
      });
      if (!extracting) throw new StaleProcessingAttemptError();
      stage = "extracting";

      const detectedCuts = await detectSceneCuts(inputPath, metadata, {
        ffmpegPath: config.ffmpegPath,
        timeoutMs: config.ffmpegTimeoutMs,
        sceneThreshold: config.sceneThreshold,
        maxCuts: Math.max(1, config.maxSteps - 1),
        signal: timeoutAbort.signal,
      });
      const cuts = fallbackCuts(metadata.durationMs, detectedCuts, config.maxSteps);
      const frameWidth = metadata.orientation === "portrait"
        ? config.portraitFrameWidth
        : config.landscapeFrameWidth;
      const frames = await extractRepresentativeFrames(inputPath, outputDir, metadata, cuts, {
        ffmpegPath: config.ffmpegPath,
        ffprobePath: config.ffprobePath,
        timeoutMs: config.ffmpegTimeoutMs,
        frameWidth,
        thumbnailWidth: 320,
        maxFrames: config.maxSteps,
        signal: timeoutAbort.signal,
      });

      const stepInputs: CreateGuideStepInput[] = [];
      for (const frame of frames) {
        const frameKey = attemptFrameObjectKey(id, attemptCount, frame.index + 1, "frame");
        const thumbnailKey = attemptFrameObjectKey(id, attemptCount, frame.index + 1, "thumbnail");
        await putPrivateAsset(storage, frameKey, frame.framePath, { signal: timeoutAbort.signal });
        await putPrivateAsset(storage, thumbnailKey, frame.thumbnailPath, { signal: timeoutAbort.signal });
        const actionWord = metadata.orientation === "landscape" ? "클릭하세요" : "누르세요";
        stepInputs.push({
          id: randomUUID(),
          position: frame.index,
          shortLabel: `${frame.index + 1}단계 화면`,
          instruction: `이 화면에서 다음에 진행할 곳을 ${actionWord}.`,
          startMs: frame.startMs,
          endMs: frame.endMs,
          representativeTimestampMs: frame.timestampMs,
          representativeFrameKey: frameKey,
          thumbnailFrameKey: thumbnailKey,
          frameWidth: frame.width,
          frameHeight: frame.height,
          elements: [{
            id: randomUUID(),
            type: "tap",
            center: { x: toPercent(50), y: toPercent(50) },
            radius: toPercent(5),
            zIndex: 10,
            visible: true,
          }],
        });
      }

      const completed = await repository.completeProcessingAttempt(id, {
        attemptId,
        attemptCount,
        steps: stepInputs,
        statusMessage: statusMessage("ready"),
      });
      if (!completed) throw new StaleProcessingAttemptError();
      console.info(JSON.stringify({
        event: "guide_pipeline_ready",
        guideId: id,
        attemptId,
        attemptCount,
        durationMs: metadata.durationMs,
        rotation: metadata.rotation,
        orientation: metadata.orientation,
        sceneCuts: cuts.length,
        frames: frames.length,
      }));
    } catch (error) {
      let currentAfterFailure;
      try {
        currentAfterFailure = await repository.getGuideById(id);
      } catch (stateError) {
        console.error(JSON.stringify({
          event: "guide_pipeline_failure_state_unknown",
          guideId: id,
          attemptId,
          attemptCount,
          message: stateError instanceof Error ? stateError.message : String(stateError),
        }));
        // A successful COMMIT can lose its acknowledgement. Preserve assets
        // until a later dispatcher/deletion pass can establish durable state.
        throw error;
      }
      if (
        currentAfterFailure?.status === "ready" &&
        currentAfterFailure.processingAttemptId === attemptId &&
        currentAfterFailure.processingAttemptCount === attemptCount
      ) {
        console.info(JSON.stringify({
          event: "guide_pipeline_commit_ack_recovered",
          guideId: id,
          attemptId,
          attemptCount,
        }));
        return;
      }
      let cleanupError: unknown;
      try {
        await cleanupStorageKeys(storage, attemptAssetKeys(id, attemptCount, config.maxSteps));
      } catch (caught) {
        cleanupError = caught;
        console.error(JSON.stringify({
          event: "guide_pipeline_asset_cleanup_failed",
          guideId: id,
          attemptId,
          attemptCount,
          message: caught instanceof Error ? caught.message : String(caught),
        }));
      }
      if (
        error instanceof PrivateAssetWriteInterruptedError &&
        error.lateCleanup
      ) {
        let activeDeletion: Guide | null = currentAfterFailure;
        if (
          activeDeletion &&
          activeDeletion.errorCode !== DELETION_PENDING_ACTIVE &&
          (activeDeletion.status === "probing" || activeDeletion.status === "extracting")
        ) {
          activeDeletion = await repository.updateStatus(id, "failed", {
            expectedStatuses: [activeDeletion.status],
            expectedProcessingAttemptId: attemptId,
            expectedProcessingAttemptCount: attemptCount,
            expectedErrorCode: activeDeletion.errorCode,
            progress: 100,
            statusMessage: "중단된 비공개 파일 저장을 정리하고 있어요.",
            errorCode: DELETION_PENDING_ACTIVE,
            errorMessage: "임시 화면 저장이 끝나면 원본과 함께 안전하게 삭제됩니다.",
          }) ?? await repository.getGuideById(id);
        }
        if (ownsAttempt(activeDeletion) && activeDeletion.errorCode === DELETION_PENDING_ACTIVE) {
          // An SDK write can commit after the job deadline. Keep a durable
          // deletion marker until its exact-key cleanup settles, then remove
          // the whole draft so a concurrent DELETE can never create an orphan.
          deferActiveGuideDeletion(
            repository,
            storage,
            activeDeletion,
            config.maxSteps,
            error.lateCleanup,
          );
          return;
        }
      }
      if (error instanceof StaleProcessingAttemptError) {
        const current = currentAfterFailure;
        if (ownsAttempt(current) && isDeletionPending(current)) {
          try {
            await finalizeGuideDeletion(repository, storage, id, config.maxSteps, deletionOwnership);
            cleanupError = undefined;
          } catch (caught) {
            cleanupError = caught;
            console.error(JSON.stringify({
              event: "guide_deletion_finalize_failed",
              guideId: id,
              attemptId,
              attemptCount,
              message: caught instanceof Error ? caught.message : String(caught),
            }));
          }
        }
        console.info(JSON.stringify({
          event: "guide_pipeline_superseded",
          guideId: id,
          attemptId,
          attemptCount,
        }));
        if (cleanupError) throw cleanupError;
        return;
      }

      const failure = cleanupError
        ? { code: "ASSET_CLEANUP_FAILED", message: "임시 화면을 안전하게 정리하지 못했어요. 이 작업을 삭제한 뒤 다시 시작해 주세요." }
        : publicError(error, stage);
      const failed = await repository.updateStatus(id, "failed", {
        expectedStatuses: ["probing", "extracting"],
        expectedProcessingAttemptId: attemptId,
        expectedProcessingAttemptCount: attemptCount,
        progress: 100,
        statusMessage: statusMessage("failed"),
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      if (!failed) {
        const current = await repository.getGuideById(id);
        if (ownsAttempt(current) && isDeletionPending(current)) {
          try {
            await finalizeGuideDeletion(repository, storage, id, config.maxSteps, deletionOwnership);
          } catch (caught) {
            console.error(JSON.stringify({
              event: "guide_deletion_finalize_failed",
              guideId: id,
              attemptId,
              attemptCount,
              message: caught instanceof Error ? caught.message : String(caught),
            }));
            throw caught;
          }
        }
        console.info(JSON.stringify({
          event: "guide_pipeline_failure_superseded",
          guideId: id,
          attemptId,
          attemptCount,
          code: failure.code,
        }));
        return;
      }
      console.error(JSON.stringify({
        event: "guide_pipeline_failed",
        guideId: id,
        attemptId,
        attemptCount,
        code: failure.code,
        message: error instanceof Error ? error.message : String(error),
      }));
      throw cleanupError ?? error;
    } finally {
      clearTimeout(timeout);
      try {
        await rm(workRoot, { recursive: true, force: true });
      } catch (error) {
        console.error(JSON.stringify({
          event: "guide_workdir_cleanup_failed",
          guideId: id,
          attemptId,
          attemptCount,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
      try {
        await rmdir(join(config.dataDir, "work", id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
          console.error(JSON.stringify({
            event: "guide_work_parent_cleanup_failed",
            guideId: id,
            message: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    }
  }

  async function process(guideId: string): Promise<void> {
    const id = safeGuideId(guideId);
    const attemptId = randomUUID();
    const claimed = await repository.claimProcessingAttempt(id, attemptId, {
      expectedStatuses: ["queued"],
      maxAttempts: config.maxProcessingAttempts,
      progress: 22,
      statusMessage: statusMessage("probing"),
      exhaustedStatusMessage: statusMessage("failed"),
    });
    if (
      !claimed ||
      claimed.status !== "probing" ||
      claimed.processingAttemptId !== attemptId
    ) return;
    await processClaimed(id, attemptId, claimed.processingAttemptCount);
  }

  return { process, processClaimed };
}
