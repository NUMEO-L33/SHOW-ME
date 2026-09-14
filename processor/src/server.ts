import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { pipeline as pipeStreams } from "node:stream/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import Busboy, { type FileInfo } from "busboy";
import cors from "cors";
import express, { type Application, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";

import { createAssetTicket, verifyAssetTicket } from "./asset-token.js";
import { AnalysisApiError, createAnalysisRouter, type AnalysisAdmission } from "./analysis-api.js";
import { DurableAnalysisAdmission } from "./analysis-admission.js";
import {
  cleanupStorageKeys,
  DELETION_PENDING,
  DELETION_PENDING_ACTIVE,
  deferActiveGuideDeletion,
  finalizeGuideDeletion,
  guideAssetKeys,
  isDeletionPending,
  putPrivateAsset,
  PrivateAssetWriteInterruptedError,
  sourceObjectKey,
  UPLOAD_CANCELLATION_TOMBSTONE,
} from "./asset-lifecycle.js";
import { assertSupportedVideo, VideoUploadValidationError, type ProcessorConfig } from "./config.js";
import type { Guide, GuideRepository, GuideStep, GuideWithSteps, PrivacyMaskElement, TapElement } from "./domain.js";
import type { GuidePipeline } from "./pipeline.js";
import { ProcessingQueue, QueueCapacityError } from "./queue.js";
import type { Storage } from "./storage.js";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

type ReceivedUpload = {
  tempPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  extension: ".mp4" | ".mov" | ".webm";
};

const UPLOAD_LEASE_STALE_MS = 30_000;
const UPLOAD_LEASE_HEARTBEAT_MS = 10_000;

export type ProcessorAppDependencies = {
  config: ProcessorConfig;
  repository: GuideRepository;
  storage: Storage;
  pipeline: GuidePipeline;
  queue?: ProcessingQueue;
  readiness?: { ready: boolean };
  /** Trusted composition override. Default admission has no readiness verifier and rejects new runs. */
  analysisAdmission?: AnalysisAdmission;
};

function cleanFilename(filename: string) {
  const leaf = filename.replace(/\\/g, "/").split("/").at(-1) ?? "screen-recording";
  return leaf.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180) || "screen-recording";
}

function titleFromFilename(filename: string) {
  const title = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return title.slice(0, 120) || "새 화면 안내서";
}

function extractEditToken(request: Request) {
  const authorization = request.header("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  return "";
}

function requireUploadIdentity(request: Request) {
  const guideId = request.header("x-showme-guide-id")?.trim() ?? "";
  const editToken = extractEditToken(request);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guideId)) {
    throw new HttpError(400, "업로드 식별자가 올바르지 않아요.", "INVALID_UPLOAD_IDENTITY");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(editToken)) {
    throw new HttpError(400, "업로드 편집 키가 올바르지 않아요.", "INVALID_UPLOAD_IDENTITY");
  }
  return { guideId, editToken };
}

function requireGuideIdentity(request: Request) {
  const rawGuideId = request.params.guideId;
  const guideId = Array.isArray(rawGuideId) ? rawGuideId[0] : rawGuideId;
  const editToken = extractEditToken(request);
  if (
    !guideId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guideId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(editToken)
  ) {
    throw new HttpError(404, "가이드를 찾을 수 없어요.", "GUIDE_NOT_FOUND");
  }
  return { guideId, editToken };
}

async function requireGuideAccess(request: Request, repository: GuideRepository) {
  const { guideId, editToken } = requireGuideIdentity(request);
  if (!(await repository.verifyEditToken(guideId, editToken))) {
    throw new HttpError(404, "가이드를 찾을 수 없어요.", "GUIDE_NOT_FOUND");
  }
  const guide = await repository.getGuideById(guideId);
  if (!guide) throw new HttpError(404, "가이드를 찾을 수 없어요.", "GUIDE_NOT_FOUND");
  return guide;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function startUploadLeaseHeartbeat(
  repository: GuideRepository,
  guideId: string,
  leaseId: string,
) {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = repository.renewUploadLease(guideId, leaseId).then((renewed) => {
      if (!renewed) stopped = true;
    }).catch((error: unknown) => {
      console.error(JSON.stringify({
        event: "upload_lease_renewal_failed",
        guideId,
        message: error instanceof Error ? error.message : String(error),
      }));
    }).finally(() => { inFlight = undefined; });
  }, UPLOAD_LEASE_HEARTBEAT_MS);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}

function receiveUpload(request: Request, config: ProcessorConfig): Promise<ReceivedUpload> {
  const contentLength = Number(request.header("content-length"));
  if (Number.isFinite(contentLength) && contentLength > config.maxUploadBytes + 1024 * 1024) {
    throw new HttpError(413, "영상은 500MB 이하만 올릴 수 있어요.", "FILE_TOO_LARGE");
  }

  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: request.headers,
        defParamCharset: "utf8",
        limits: { fileSize: config.maxUploadBytes, files: 1, fields: 3, parts: 4 },
      });
    } catch {
      reject(new HttpError(400, "영상 파일을 multipart/form-data로 보내 주세요.", "INVALID_MULTIPART"));
      return;
    }

    let fileTask: Promise<ReceivedUpload> | null = null;
    let parseError: Error | null = null;
    const rejectOnce = (error: Error) => {
      parseError ??= error;
    };

    parser.on("file", (fieldName: string, stream, info: FileInfo) => {
      if (fieldName !== "video" || fileTask) {
        stream.resume();
        rejectOnce(new HttpError(400, "video 파일은 한 개만 올릴 수 있어요.", "INVALID_FILE_FIELD"));
        return;
      }

      const filename = cleanFilename(info.filename);
      const extension = path.extname(filename).toLowerCase() as ReceivedUpload["extension"];
      if (![".mp4", ".mov", ".webm"].includes(extension)) {
        stream.resume();
        rejectOnce(new HttpError(415, "MP4, MOV, WebM 영상만 올릴 수 있어요.", "UNSUPPORTED_VIDEO"));
        return;
      }

      const tempPath = path.join(config.dataDir, "incoming", `${randomUUID()}${extension}`);
      let limited = false;
      stream.once("limit", () => { limited = true; });
      fileTask = (async () => {
        await mkdir(path.dirname(tempPath), { recursive: true });
        try {
          await pipeStreams(stream, createWriteStream(tempPath, { flags: "wx" }));
          if (limited) {
            throw new HttpError(413, "영상은 500MB 이하만 올릴 수 있어요.", "FILE_TOO_LARGE");
          }
          const details = await stat(tempPath);
          if (details.size <= 0) {
            throw new HttpError(400, "비어 있는 영상 파일은 올릴 수 없어요.", "EMPTY_VIDEO");
          }
          return { tempPath, filename, mimeType: info.mimeType, sizeBytes: details.size, extension };
        } catch (error) {
          await rm(tempPath, { force: true }).catch(() => undefined);
          throw error;
        }
      })();
    });

    parser.once("filesLimit", () => rejectOnce(new HttpError(400, "영상은 한 개만 올릴 수 있어요.", "TOO_MANY_FILES")));
    parser.once("partsLimit", () => rejectOnce(new HttpError(400, "업로드 항목이 너무 많아요.", "TOO_MANY_PARTS")));
    const cleanupReceivedFile = async () => {
      if (!fileTask) return;
      try {
        const upload = await fileTask;
        await rm(upload.tempPath, { force: true });
      } catch {
        // fileTask removes its own partial file on write failures.
      }
    };

    parser.once("error", (error: Error) => {
      void cleanupReceivedFile().finally(() => reject(error));
    });
    parser.once("close", async () => {
      if (parseError) {
        await cleanupReceivedFile();
        reject(parseError);
        return;
      }
      if (!fileTask) {
        reject(new HttpError(400, "올릴 영상 파일을 선택해 주세요.", "VIDEO_REQUIRED"));
        return;
      }
      try {
        resolve(await fileTask);
      } catch (error) {
        reject(error);
      }
    });
    request.once("aborted", () => {
      void cleanupReceivedFile().finally(() => reject(new HttpError(499, "업로드가 취소됐어요.", "UPLOAD_ABORTED")));
    });
    request.pipe(parser);
  });
}

function tapFromStep(step: GuideStep) {
  return step.elements.find((element): element is TapElement => element.type === "tap" && element.visible);
}

function masksFromStep(step: GuideStep) {
  return step.elements.filter((element): element is PrivacyMaskElement => element.type === "privacy-mask");
}

const RETRYABLE_PROCESSING_ERRORS = new Set([
  "MEDIA_TIMEOUT",
  "PROCESSING_FAILED",
  "QUEUE_FULL",
  "QUEUE_UNAVAILABLE",
]);

function isRetryableGuide(guide: Guide, maxAttempts: number) {
  return guide.status === "failed" &&
    guide.processingAttemptCount < maxAttempts &&
    (!guide.errorCode || RETRYABLE_PROCESSING_ERRORS.has(guide.errorCode));
}

function guideStatusMessage(guide: Guide) {
  if (guide.statusMessage) return guide.statusMessage;
  const fallback: Record<Guide["status"], string> = {
    uploading: "영상을 올리고 있어요.",
    queued: "처리 순서를 기다리고 있어요.",
    probing: "영상 방향과 길이를 확인하고 있어요.",
    extracting: "장면을 나누고 대표 화면을 저장하고 있어요.",
    ready: "단계별 화면 추출을 마쳤어요.",
    failed: "영상 처리에 실패했어요.",
  };
  return fallback[guide.status];
}

function serializeGuide(guide: GuideWithSteps, assetToken: string, maxAttempts: number) {
  return {
    id: guide.id,
    title: guide.title,
    status: guide.status,
    progress: guide.progress,
    statusMessage: guideStatusMessage(guide),
    errorMessage: guide.errorMessage,
    retryable: isRetryableGuide(guide, maxAttempts),
    media: guide.durationMs && guide.displayWidth && guide.displayHeight ? {
      durationMs: guide.durationMs,
      width: guide.displayWidth,
      height: guide.displayHeight,
      orientation: guide.displayWidth === guide.displayHeight
        ? "square"
        : guide.displayWidth > guide.displayHeight ? "landscape" : "portrait",
      rotation: guide.rotationDegrees ?? 0,
    } : null,
    steps: guide.steps.map((step) => {
      const tap = tapFromStep(step);
      const masks = masksFromStep(step);
      return {
        id: step.id,
        shortLabel: step.shortLabel,
        instruction: step.instruction,
        screen: "frame" as const,
        target: tap ? tap.center : { x: 50, y: 50 },
        privacyCount: masks.length,
        privacyEnabled: masks.every((mask) => mask.enabled),
        startMs: step.startMs,
        endMs: step.endMs,
        frameWidth: step.frameWidth ?? guide.displayWidth ?? undefined,
        frameHeight: step.frameHeight ?? guide.displayHeight ?? undefined,
        frameUrl: step.representativeFrameKey
          ? `/api/guides/${guide.id}/assets/${step.id}/frame?asset_token=${encodeURIComponent(assetToken)}`
          : undefined,
        thumbnailUrl: step.thumbnailFrameKey
          ? `/api/guides/${guide.id}/assets/${step.id}/thumbnail?asset_token=${encodeURIComponent(assetToken)}`
          : undefined,
      };
    }),
  };
}

async function streamAsset(response: Response, storage: Storage, key: string) {
  const stream = await storage.openRead(key);
  response.setHeader("Content-Type", "image/jpeg");
  response.setHeader("Cache-Control", "private, max-age=300");
  stream.once("error", () => {
    if (!response.headersSent) response.status(404).json({ error: "화면 이미지를 찾을 수 없어요.", code: "ASSET_NOT_FOUND" });
    else response.destroy();
  });
  stream.pipe(response);
}

export function createProcessorApp({
  config,
  repository,
  storage,
  pipeline,
  queue = new ProcessingQueue(1, config.queueCapacity),
  readiness = { ready: true },
  analysisAdmission,
}: ProcessorAppDependencies): Application {
  const app = express();
  const assetTicketSecret = config.assetTicketSecret
    ? Buffer.from(config.assetTicketSecret, "base64url")
    : randomBytes(32);
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes("*") || config.corsOrigins.includes(origin)) callback(null, true);
      else callback(new HttpError(403, "허용되지 않은 웹사이트예요.", "ORIGIN_NOT_ALLOWED"));
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-ShowMe-Guide-Id"],
  }));
  app.use((request, _response, next) => {
    request.setTimeout(config.requestTimeoutMs, () => {
      request.destroy();
    });
    next();
  });

  const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "잠시 뒤 다시 영상을 올려 주세요.", code: "UPLOAD_RATE_LIMIT" },
  });
  const deleteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "잠시 뒤 삭제를 다시 시도해 주세요.", code: "DELETE_RATE_LIMIT" },
  });

  app.get("/health", (_request, response) => {
    response
      .status(readiness.ready ? 200 : 503)
      .json({ status: readiness.ready ? "ok" : "starting", service: "showme-processor", queue: queue.snapshot() });
  });
  app.get("/", (_request, response) => {
    response
      .status(readiness.ready ? 200 : 503)
      .json({ status: readiness.ready ? "ok" : "starting", service: "showme-processor" });
  });

  app.use((_request, _response, next) => {
    if (!readiness.ready) {
      next(new HttpError(503, "영상 처리 서버가 준비 중이에요.", "SERVICE_STARTING"));
      return;
    }
    next();
  });

  app.use("/api/guides/:guideId/analysis", createAnalysisRouter({
    repository, admission: analysisAdmission ?? new DurableAnalysisAdmission({ repository }),
    authenticate: async (request) => {
      try { return await requireGuideAccess(request, repository); }
      catch (error) {
        if (error instanceof HttpError && error.code === "GUIDE_NOT_FOUND") throw new AnalysisApiError("GUIDE_NOT_FOUND");
        throw error;
      }
    },
  }));

  app.post("/api/guides", uploadLimiter, async (request, response, next) => {
    let upload: ReceivedUpload | undefined;
    let ownedGuideId: string | undefined;
    let durableUpload: Guide | undefined;
    let uploadLeaseId: string | undefined;
    let stopLeaseHeartbeat: (() => Promise<void>) | undefined;
    let uploadReceiveDeadline: NodeJS.Timeout | undefined;
    try {
      const identity = requireUploadIdentity(request);
      const existing = await repository.getGuideById(identity.guideId);
      if (existing) {
        if (!(await repository.verifyEditToken(existing.id, identity.editToken))) {
          request.resume();
          throw new HttpError(409, "이미 사용 중인 업로드 식별자예요.", "UPLOAD_IDENTITY_CONFLICT");
        }
        if (existing.status === "uploading") {
          // A prior process can die after its durable row is created but before
          // the content-addressed source object is committed. A durable lease
          // below decides which instance may resume it.
          durableUpload = existing;
        } else {
          request.resume();
          if (existing.status === "queued" && !queue.has(existing.id) && queue.canAcceptNew()) {
            queue.enqueue(existing.id, () => pipeline.process(existing.id));
          }
          response.status(202).json({ guideId: existing.id, status: existing.status });
          return;
        }
      }
      if (!durableUpload && !queue.canAcceptNew()) {
        request.resume();
        throw new HttpError(503, "처리 대기열이 가득 찼어요. 잠시 뒤 다시 시도해 주세요.", "QUEUE_FULL_BEFORE_UPLOAD");
      }

      uploadReceiveDeadline = setTimeout(() => {
        // Destroying without an Error emits the request's aborted event without
        // risking an unhandled stream error on slow or malicious request bodies.
        request.destroy();
      }, config.requestTimeoutMs);
      uploadReceiveDeadline.unref();
      upload = await receiveUpload(request, config);
      clearTimeout(uploadReceiveDeadline);
      uploadReceiveDeadline = undefined;
      const details = await stat(upload.tempPath);
      const validated = assertSupportedVideo({
        fileName: upload.filename,
        mimeType: upload.mimeType,
        sizeBytes: details.size,
      });
      const guideId = identity.guideId;
      const editToken = identity.editToken;
      const slug = randomBytes(7).toString("base64url").toLowerCase();
      const sourceDigest = await sha256File(upload.tempPath);
      const originalObjectKey = sourceObjectKey(guideId, validated.extension, sourceDigest);
      let createdByThisRequest = false;
      if (durableUpload) {
        if (
          durableUpload.originalObjectKey !== originalObjectKey ||
          durableUpload.sourceFilename !== upload.filename ||
          durableUpload.sourceMimeType !== validated.mimeType ||
          durableUpload.sourceSizeBytes !== validated.sizeBytes
        ) {
          throw new HttpError(409, "기존 업로드와 같은 원본 영상을 다시 선택해 주세요.", "UPLOAD_RESUME_MISMATCH");
        }
      } else {
        try {
          durableUpload = await repository.createGuide({
            id: guideId,
            ownerId: null,
            slug,
            editToken,
            title: titleFromFilename(upload.filename),
            status: "uploading",
            statusMessage: "원본 영상을 안전하게 저장하고 있어요.",
            originalObjectKey,
            sourceFilename: upload.filename,
            sourceMimeType: validated.mimeType,
            sourceSizeBytes: validated.sizeBytes,
          });
          createdByThisRequest = true;
        } catch (createError) {
          const racedGuide = await repository.getGuideById(guideId).catch(() => null);
          if (!racedGuide || !(await repository.verifyEditToken(guideId, editToken))) throw createError;
          if (racedGuide.status !== "uploading") {
            if (racedGuide.status === "queued" && !queue.has(guideId) && queue.canAcceptNew()) {
              queue.enqueue(guideId, () => pipeline.process(guideId));
            }
            response.status(202).json({ guideId, status: racedGuide.status });
            return;
          }
          if (
            racedGuide.originalObjectKey !== originalObjectKey ||
            racedGuide.sourceFilename !== upload.filename ||
            racedGuide.sourceMimeType !== validated.mimeType ||
            racedGuide.sourceSizeBytes !== validated.sizeBytes
          ) {
            throw new HttpError(409, "기존 업로드와 같은 원본 영상을 다시 선택해 주세요.", "UPLOAD_RESUME_MISMATCH");
          }
          durableUpload = racedGuide;
        }
      }

      if (!durableUpload) throw new Error(`Guide ${guideId} was not persisted before upload.`);
      uploadLeaseId = randomUUID();
      const leaseDeadline = Date.now() + config.requestTimeoutMs;
      while (durableUpload.status === "uploading") {
        const updatedAt = Date.parse(durableUpload.updatedAt);
        const stale = !Number.isFinite(updatedAt) || Date.now() - updatedAt >= UPLOAD_LEASE_STALE_MS;
        if (createdByThisRequest || stale) {
          const claimed = await repository.claimUploadLease(guideId, uploadLeaseId, {
            expectedProcessingAttemptId: durableUpload.processingAttemptId,
            expectedUpdatedAt: durableUpload.updatedAt,
          });
          if (claimed) {
            durableUpload = claimed;
            break;
          }
        }
        createdByThisRequest = false;
        if (request.aborted || Date.now() >= leaseDeadline) {
          throw new HttpError(503, "다른 업로드 요청을 마무리하고 있어요. 잠시 뒤 다시 확인해 주세요.", "UPLOAD_LEASE_BUSY");
        }
        await wait(1_000);
        const current = await repository.getGuideById(guideId);
        if (!current) throw new HttpError(409, "취소된 업로드예요.", "UPLOAD_CANCELLED");
        if (current.status !== "uploading") {
          if (current.status === "queued" && !queue.has(guideId) && queue.canAcceptNew()) {
            queue.enqueue(guideId, () => pipeline.process(guideId));
          }
          response.status(202).json({ guideId, status: current.status });
          return;
        }
        durableUpload = current;
      }

      ownedGuideId = guideId;
      stopLeaseHeartbeat = startUploadLeaseHeartbeat(repository, guideId, uploadLeaseId);
      await putPrivateAsset(storage, originalObjectKey, upload.tempPath, {
        timeoutMs: config.requestTimeoutMs,
      });
      await stopLeaseHeartbeat();
      stopLeaseHeartbeat = undefined;
      const queuedGuide = await repository.updateStatus(guideId, "queued", {
        expectedStatuses: ["uploading"],
        expectedProcessingAttemptId: uploadLeaseId,
        expectedProcessingAttemptCount: 0,
        expectedErrorCode: null,
        progress: 12,
        statusMessage: "처리 순서를 기다리고 있어요.",
      });
      if (!queuedGuide) {
        const current = await repository.getGuideById(guideId);
        if (current && isDeletionPending(current)) {
          await finalizeGuideDeletion(repository, storage, guideId, config.maxSteps, {
            expectedProcessingAttemptId: uploadLeaseId,
            expectedProcessingAttemptCount: 0,
          });
          throw new HttpError(409, "취소된 업로드예요.", "UPLOAD_CANCELLED");
        }
        if (!current) {
          await cleanupStorageKeys(storage, [originalObjectKey]);
          throw new HttpError(409, "취소된 업로드예요.", "UPLOAD_CANCELLED");
        }
        if (current && await repository.verifyEditToken(guideId, editToken)) {
          if (current.status === "queued" && !queue.has(guideId) && queue.canAcceptNew()) {
            queue.enqueue(guideId, () => pipeline.process(guideId));
          }
          // Another instance committed the same deterministic upload row first.
          // Its durable state is the winner; never delete or overwrite its source.
          response.status(202).json({ guideId, status: current.status });
          return;
        }
        throw new Error(`Guide ${guideId} changed before its source upload was committed.`);
      }
      try {
        queue.enqueue(guideId, () => pipeline.process(guideId));
      } catch (error) {
        if (!(error instanceof QueueCapacityError)) throw error;
        await repository.updateStatus(guideId, "failed", {
          expectedStatuses: ["queued"],
          expectedProcessingAttemptId: null,
          expectedProcessingAttemptCount: 0,
          progress: 100,
          statusMessage: "영상 처리 대기열이 가득 찼어요.",
          errorCode: "QUEUE_FULL",
          errorMessage: "잠시 뒤 원본 영상으로 다시 시도해 주세요.",
        });
        throw new HttpError(503, "처리 대기열이 가득 찼어요. 잠시 뒤 다시 시도해 주세요.", "QUEUE_FULL");
      }
      response.status(202).json({ guideId, status: "queued" });
    } catch (error) {
      if (stopLeaseHeartbeat) {
        await stopLeaseHeartbeat().catch(() => undefined);
        stopLeaseHeartbeat = undefined;
      }
      let cleanupError: unknown;
      if (ownedGuideId) {
        let current: Guide | null = await repository.getGuideById(ownedGuideId).catch(() => null);
        if (current?.status === "uploading") {
          const interruptedWrite = error instanceof PrivateAssetWriteInterruptedError && error.lateCleanup;
          const claimedDeletion = await repository.updateStatus(ownedGuideId, "failed", {
            expectedStatuses: ["uploading"],
            expectedProcessingAttemptId: uploadLeaseId,
            expectedProcessingAttemptCount: current.processingAttemptCount,
            expectedErrorCode: current.errorCode,
            progress: 100,
            statusMessage: "취소된 업로드를 정리하고 있어요.",
            errorCode: interruptedWrite ? DELETION_PENDING_ACTIVE : DELETION_PENDING,
            errorMessage: "원본 영상 정리가 끝나면 작업이 삭제됩니다.",
          }).catch((caught) => { cleanupError = caught; });
          current = claimedDeletion ?? await repository.getGuideById(ownedGuideId).catch(() => null);
        }
        const deferredWrite = error instanceof PrivateAssetWriteInterruptedError ? error.lateCleanup : undefined;
        if (
          deferredWrite && current?.errorCode === DELETION_PENDING_ACTIVE &&
          current.processingAttemptId === uploadLeaseId && current.processingAttemptCount === 0
        ) {
          deferActiveGuideDeletion(repository, storage, current, config.maxSteps, deferredWrite);
        } else {
          try {
            await finalizeGuideDeletion(repository, storage, ownedGuideId, config.maxSteps, {
              expectedProcessingAttemptId: uploadLeaseId,
              expectedProcessingAttemptCount: 0,
            });
          } catch (caught) {
            cleanupError = caught;
            console.error(JSON.stringify({
              event: "upload_asset_cleanup_failed",
              guideId: ownedGuideId,
              message: caught instanceof Error ? caught.message : String(caught),
            }));
          }
        }
      }
      if (upload) {
        try {
          await rm(upload.tempPath, { force: true });
        } catch (caught) {
          console.error(JSON.stringify({
            event: "upload_temp_cleanup_failed",
            guideId: ownedGuideId,
            message: caught instanceof Error ? caught.message : String(caught),
          }));
        }
        upload = undefined;
      }
      if (cleanupError) {
        next(new HttpError(503, "취소된 영상 정리를 마치지 못했어요. 잠시 뒤 다시 시도해 주세요.", "PRIVATE_ASSET_CLEANUP_FAILED"));
      } else if (error instanceof VideoUploadValidationError) {
        const status = error.code === "FILE_TOO_LARGE" ? 413 : error.code === "EMPTY_VIDEO" ? 400 : 415;
        const message = error.code === "FILE_TOO_LARGE"
          ? "영상은 500MB 이하만 올릴 수 있어요."
          : error.code === "EMPTY_VIDEO" ? "비어 있는 영상 파일은 올릴 수 없어요." : "MP4, MOV, WebM 화면 녹화만 올릴 수 있어요.";
        next(new HttpError(status, message, error.code));
      } else {
        next(error);
      }
    } finally {
      if (uploadReceiveDeadline) clearTimeout(uploadReceiveDeadline);
      if (stopLeaseHeartbeat) await stopLeaseHeartbeat().catch(() => undefined);
      if (upload) {
        try {
          await rm(upload.tempPath, { force: true });
        } catch (error) {
          console.error(JSON.stringify({
            event: "upload_temp_cleanup_failed",
            guideId: ownedGuideId,
            message: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    }
  });

  app.get("/api/guides/:guideId", async (request, response, next) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      const guide = await requireGuideAccess(request, repository);
      const ticket = createAssetTicket(assetTicketSecret, guide.id);
      response.json({ guide: serializeGuide(guide, ticket.token, config.maxProcessingAttempts), assetExpiresAt: ticket.expiresAt });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/guides/:guideId", deleteLimiter, async (request, response, next) => {
    try {
      const identity = requireGuideIdentity(request);
      let guide = await repository.getGuideById(identity.guideId);
      if (!guide) {
        try {
          await repository.createGuide({
            id: identity.guideId,
            ownerId: null,
            slug: randomBytes(7).toString("base64url").toLowerCase(),
            editToken: identity.editToken,
            title: "취소된 업로드",
            status: "failed",
            statusMessage: "업로드 취소 요청을 보관하고 있어요.",
            progress: 100,
            errorCode: UPLOAD_CANCELLATION_TOMBSTONE,
            errorMessage: "이 업로드는 취소됐어요.",
            originalObjectKey: `guides/${identity.guideId}/cancelled/no-source`,
            sourceFilename: "cancelled-upload.webm",
            sourceMimeType: "video/webm",
            sourceSizeBytes: 0,
          });
          response.status(204).end();
          return;
        } catch (createError) {
          guide = await repository.getGuideById(identity.guideId);
          if (!guide) throw createError;
        }
      }
      if (!(await repository.verifyEditToken(identity.guideId, identity.editToken))) {
        throw new HttpError(404, "가이드를 찾을 수 없어요.", "GUIDE_NOT_FOUND");
      }
      if (guide.errorCode === UPLOAD_CANCELLATION_TOMBSTONE) {
        response.status(204).end();
        return;
      }
      if (!isDeletionPending(guide)) {
        const preUpload = guide.status === "uploading" && guide.processingAttemptId === null;
        const active = (
          (guide.status === "uploading" && guide.processingAttemptId !== null) ||
          guide.status === "probing" ||
          guide.status === "extracting"
        );
        const errorCode = preUpload
          ? UPLOAD_CANCELLATION_TOMBSTONE
          : active ? DELETION_PENDING_ACTIVE : DELETION_PENDING;
        const claimed = await repository.updateStatus(guide.id, "failed", {
          expectedStatuses: [guide.status],
          expectedProcessingAttemptId: guide.processingAttemptId,
          expectedProcessingAttemptCount: guide.processingAttemptCount,
          expectedErrorCode: guide.errorCode,
          progress: 100,
          statusMessage: "개인 영상을 안전하게 삭제하고 있어요.",
          errorCode,
          errorMessage: "원본 영상과 추출 화면을 삭제하고 있어요.",
        });
        if (!claimed) {
          response.status(409).json({ error: "작업 상태가 바뀌었어요. 삭제를 다시 시도해 주세요.", code: "GUIDE_STATE_CHANGED" });
          return;
        }
        const claimedWithSteps = await repository.getGuideById(guide.id);
        if (!claimedWithSteps) {
          response.status(204).end();
          return;
        }
        guide = claimedWithSteps;
      }

      if (guide.errorCode === UPLOAD_CANCELLATION_TOMBSTONE) {
        response.status(204).end();
        return;
      }

      try {
        await cleanupStorageKeys(storage, guideAssetKeys(guide, config.maxSteps));
      } catch (error) {
        console.error(JSON.stringify({
          event: "guide_delete_asset_cleanup_failed",
          guideId: guide.id,
          message: error instanceof Error ? error.message : String(error),
        }));
        throw new HttpError(503, "개인 영상 삭제를 마치지 못했어요. 잠시 뒤 다시 시도해 주세요.", "PRIVATE_ASSET_CLEANUP_FAILED");
      }

      if (guide.errorCode === DELETION_PENDING_ACTIVE) {
        response.status(202).json({ status: "deleting" });
        return;
      }

      const deleted = await repository.deleteGuide(guide.id, {
        expectedStatuses: ["failed"],
        expectedProcessingAttemptId: guide.processingAttemptId,
        expectedProcessingAttemptCount: guide.processingAttemptCount,
        expectedErrorCode: DELETION_PENDING,
      });
      if (!deleted) {
        response.status(409).json({ error: "작업 상태가 바뀌었어요. 삭제를 다시 시도해 주세요.", code: "GUIDE_STATE_CHANGED" });
        return;
      }
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/guides/:guideId/assets/:stepId/:variant", async (request, response, next) => {
    try {
      const rawGuideId = request.params.guideId;
      const guideId = Array.isArray(rawGuideId) ? rawGuideId[0] : rawGuideId;
      if (!guideId) throw new HttpError(404, "화면 이미지를 찾을 수 없어요.", "ASSET_NOT_FOUND");
      const assetToken = typeof request.query.asset_token === "string" ? request.query.asset_token : "";
      const hasAssetTicket = assetToken && verifyAssetTicket(assetTicketSecret, assetToken, guideId);
      const guide = hasAssetTicket
        ? await repository.getGuideById(guideId)
        : await requireGuideAccess(request, repository);
      if (!guide) throw new HttpError(404, "화면 이미지를 찾을 수 없어요.", "ASSET_NOT_FOUND");
      const rawStepId = request.params.stepId;
      const stepId = Array.isArray(rawStepId) ? rawStepId[0] : rawStepId;
      const step = guide.steps.find((candidate) => candidate.id === stepId);
      if (!step) throw new HttpError(404, "화면 이미지를 찾을 수 없어요.", "ASSET_NOT_FOUND");
      const key = request.params.variant === "thumbnail"
        ? step.thumbnailFrameKey
        : request.params.variant === "frame" ? step.representativeFrameKey : null;
      if (!key) throw new HttpError(404, "화면 이미지를 찾을 수 없어요.", "ASSET_NOT_FOUND");
      await streamAsset(response, storage, key);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/guides/:guideId/retry", async (request, response, next) => {
    try {
      const guide = await requireGuideAccess(request, repository);
      if (guide.status !== "failed") {
        response.status(409).json({ error: "실패한 작업만 다시 시도할 수 있어요.", code: "GUIDE_NOT_FAILED" });
        return;
      }
      if (!isRetryableGuide(guide, config.maxProcessingAttempts)) {
        response.status(409).json({ error: "이 원본은 다시 처리할 수 없어요. 새 화면 녹화로 시작해 주세요.", code: "GUIDE_NOT_RETRYABLE" });
        return;
      }
      if (!queue.has(guide.id) && !queue.canAcceptNew()) {
        throw new HttpError(503, "처리 대기열이 가득 찼어요. 잠시 뒤 다시 시도해 주세요.", "QUEUE_FULL");
      }
      const queued = await repository.updateStatus(guide.id, "queued", {
        expectedStatuses: ["failed"],
        expectedProcessingAttemptId: guide.processingAttemptId,
        expectedProcessingAttemptCount: guide.processingAttemptCount,
        expectedErrorCode: guide.errorCode,
        progress: 15,
        statusMessage: "다시 처리할 준비를 마쳤어요.",
        errorCode: null,
        errorMessage: null,
      });
      if (!queued) {
        response.status(409).json({ error: "작업 상태가 이미 바뀌었어요. 잠시 뒤 다시 확인해 주세요.", code: "GUIDE_STATE_CHANGED" });
        return;
      }
      try {
        queue.enqueue(guide.id, () => pipeline.process(guide.id));
      } catch (error) {
        if (!(error instanceof QueueCapacityError)) throw error;
        await repository.updateStatus(guide.id, "failed", {
          expectedStatuses: ["queued"],
          expectedProcessingAttemptId: null,
          expectedProcessingAttemptCount: queued.processingAttemptCount,
          progress: 100,
          statusMessage: "영상 처리 대기열이 가득 찼어요.",
          errorCode: "QUEUE_FULL",
          errorMessage: "잠시 뒤 원본 영상으로 다시 시도해 주세요.",
        });
        throw new HttpError(503, "처리 대기열이 가득 찼어요. 잠시 뒤 다시 시도해 주세요.", "QUEUE_FULL");
      }
      response.status(202).json({ status: "queued" });
    } catch (error) {
      next(error);
    }
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "요청한 주소를 찾을 수 없어요.", code: "NOT_FOUND" });
  });
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    void _next;
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof HttpError ? error.message : "서버에서 요청을 처리하지 못했어요.";
    if (status >= 500) {
      console.error(JSON.stringify({ event: "http_error", code, message: error instanceof Error ? error.message : String(error) }));
    }
    response.status(status).json({ error: message, code });
  });
  return app;
}
