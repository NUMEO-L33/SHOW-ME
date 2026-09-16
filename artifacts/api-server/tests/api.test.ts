import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import request from "supertest";

import { UPLOAD_CANCELLATION_TOMBSTONE } from "../src/processor/asset-lifecycle.js";
import { loadConfig, type ProcessorConfig } from "../src/processor/config.js";
import type { GuidePipeline } from "../src/processor/pipeline.js";
import { ProcessingQueue } from "../src/processor/queue.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { createProcessorApp } from "../src/processor/server.js";
import { LocalStorage } from "../src/processor/storage.js";
import type { GuideStatus } from "../src/processor/domain.js";

let sandboxDir = "";
let config: ProcessorConfig;
let repository: JsonGuideRepository;
let storage: LocalStorage;
let app: ReturnType<typeof createProcessorApp>;
const processedGuideIds: string[] = [];

const fakePipeline: GuidePipeline = {
  async process(guideId) {
    processedGuideIds.push(guideId);
  },
  async processClaimed(guideId) {
    processedGuideIds.push(guideId);
  },
};

function seedToken(): string {
  return randomBytes(32).toString("base64url");
}

async function seedGuide(options: {
  id?: string;
  editToken?: string;
  status?: GuideStatus;
} = {}) {
  const id = options.id ?? randomUUID();
  const editToken = options.editToken ?? seedToken();
  await repository.createGuide({
    id,
    ownerId: null,
    slug: randomBytes(8).toString("base64url").toLowerCase(),
    editToken,
    title: `API test ${id}`,
    status: options.status ?? "queued",
    originalObjectKey: `guides/${id}/source.mp4`,
    sourceFilename: "fixture.mp4",
    sourceMimeType: "video/mp4",
    sourceSizeBytes: 12,
  });
  return { id, editToken };
}

before(async () => {
  sandboxDir = await mkdtemp(join(tmpdir(), "showme-api-test-"));
  config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: join(sandboxDir, "data"),
    SHOWME_STORAGE: "local",
    CORS_ORIGINS: "http://localhost:3000",
    REQUEST_TIMEOUT_MS: "10000",
    FFPROBE_TIMEOUT_MS: "10000",
    FFMPEG_TIMEOUT_MS: "10000",
    JOB_TIMEOUT_MS: "10000",
  });
  repository = new JsonGuideRepository(join(sandboxDir, "repository", "guides.json"));
  storage = new LocalStorage(join(sandboxDir, "objects"));
  app = createProcessorApp({ config, repository, storage, pipeline: fakePipeline });
});

after(async () => {
  if (sandboxDir) await rm(sandboxDir, { recursive: true, force: true });
});

test("GET /health reports an available processor and an empty queue", async () => {
  const response = await request(app).get("/health").expect(200);
  assert.deepEqual(response.body, {
    status: "ok",
    service: "showme-processor",
    queue: { waiting: 0, running: 0 },
  });
});

test("GET /api/healthz satisfies the managed Replit health contract", async () => {
  const response = await request(app).get("/api/healthz").expect(200).expect("Content-Type", /application\/json/);
  assert.deepEqual(response.body, { status: "ok" });
});

test("managed health switches from 503 to 200 only when startup is ready", async () => {
  const readiness = { ready: false };
  const startingApp = createProcessorApp({ config, repository, storage, pipeline: fakePipeline, readiness });
  const pending = await request(startingApp).get("/api/healthz").expect(503);
  assert.deepEqual(pending.body, { status: "starting" });
  readiness.ready = true;
  const ready = await request(startingApp).get("/api/healthz").expect(200);
  assert.deepEqual(ready.body, { status: "ok" });
});

test("startup probe returns 503 everywhere until the processor is ready", async () => {
  const readiness = { ready: false };
  const startingApp = createProcessorApp({ config, repository, storage, pipeline: fakePipeline, readiness });
  const root = await request(startingApp).get("/").expect(503);
  assert.equal(root.body.status, "starting");
  const health = await request(startingApp).get("/health").expect(503);
  assert.equal(health.body.status, "starting");
  const blocked = await request(startingApp).get(`/api/guides/${randomUUID()}`).expect(503);
  assert.equal(blocked.body.code, "SERVICE_STARTING");
  const identity = { guideId: randomUUID(), editToken: randomBytes(32).toString("base64url") };
  const blockedUpload = await request(startingApp)
    .post("/api/guides")
    .set("Authorization", `Bearer ${identity.editToken}`)
    .set("X-ShowMe-Guide-Id", identity.guideId)
    .attach("video", Buffer.from("synthetic mp4 payload"), {
      filename: "recording.mp4",
      contentType: "video/mp4",
    })
    .expect(503);
  assert.equal(blockedUpload.body.code, "SERVICE_STARTING");
});

test("a full queue rejects before persisting an upload identity", async () => {
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const fullQueue = new ProcessingQueue(1, 1);
  fullQueue.enqueue("occupied", () => blocker);
  const fullApp = createProcessorApp({ config, repository, storage, pipeline: fakePipeline, queue: fullQueue });
  const identity = { guideId: randomUUID(), editToken: randomBytes(32).toString("base64url") };
  const response = await request(fullApp)
    .post("/api/guides")
    .set("Authorization", `Bearer ${identity.editToken}`)
    .set("X-ShowMe-Guide-Id", identity.guideId)
    .attach("video", Buffer.from("synthetic mp4 payload"), {
      filename: "recording.mp4",
      contentType: "video/mp4",
    })
    .expect(503);
  assert.equal(response.body.code, "QUEUE_FULL_BEFORE_UPLOAD");
  assert.equal(await repository.getGuideById(identity.guideId), null);
  release();
  await fullQueue.onIdle();
});

test("upload requires client-retained idempotent credentials", async () => {
  const response = await request(app)
    .post("/api/guides")
    .attach("video", Buffer.from("synthetic mp4 payload"), {
      filename: "recording.mp4",
      contentType: "video/mp4",
    })
    .expect(400);
  assert.equal(response.body.code, "INVALID_UPLOAD_IDENTITY");
});

test("the durable upload row exists before any private source object is written", async () => {
  const localRepository = new JsonGuideRepository(join(sandboxDir, "row-first", "guides.json"));
  const localStorage = new LocalStorage(join(sandboxDir, "row-first", "objects"));
  const identity = { guideId: randomUUID(), editToken: randomBytes(32).toString("base64url") };
  let observedUploadingRow = false;
  const rowCheckingStorage = new Proxy(localStorage, {
    get(target, property) {
      if (property === "putFile") {
        return async (key: string, sourcePath: string) => {
          const durable = await localRepository.getGuideById(identity.guideId);
          observedUploadingRow = durable?.status === "uploading" && durable.originalObjectKey === key;
          return target.putFile(key, sourcePath);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const localApp = createProcessorApp({
    config,
    repository: localRepository,
    storage: rowCheckingStorage,
    pipeline: fakePipeline,
  });

  await request(localApp)
    .post("/api/guides")
    .set("Authorization", `Bearer ${identity.editToken}`)
    .set("X-ShowMe-Guide-Id", identity.guideId)
    .attach("video", Buffer.from("row first payload"), {
      filename: "recording.mp4",
      contentType: "video/mp4",
    })
    .expect(202);
  assert.equal(observedUploadingRow, true);
});

test("a concurrent queued winner is returned without deleting its deterministic source", async () => {
  const localRepository = new JsonGuideRepository(join(sandboxDir, "queued-winner", "guides.json"));
  const localStorage = new LocalStorage(join(sandboxDir, "queued-winner", "objects"));
  const identity = { guideId: randomUUID(), editToken: randomBytes(32).toString("base64url") };
  let sourceKey = "";
  let committedByOtherInstance = false;
  const racingStorage = new Proxy(localStorage, {
    get(target, property) {
      if (property === "putFile") {
        return async (key: string, sourcePath: string) => {
          sourceKey = key;
          await target.putFile(key, sourcePath);
          const current = await localRepository.getGuideById(identity.guideId);
          assert.ok(current);
          const winner = await localRepository.updateStatus(identity.guideId, "queued", {
            expectedStatuses: ["uploading"],
            expectedProcessingAttemptId: current.processingAttemptId,
            expectedProcessingAttemptCount: current.processingAttemptCount,
            expectedErrorCode: current.errorCode,
          });
          committedByOtherInstance = Boolean(winner);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const localApp = createProcessorApp({
    config,
    repository: localRepository,
    storage: racingStorage,
    pipeline: fakePipeline,
  });

  const response = await request(localApp)
    .post("/api/guides")
    .set("Authorization", `Bearer ${identity.editToken}`)
    .set("X-ShowMe-Guide-Id", identity.guideId)
    .attach("video", Buffer.from("concurrent winner"), {
      filename: "source.mp4",
      contentType: "video/mp4",
    })
    .expect(202);
  assert.equal(committedByOtherInstance, true);
  assert.equal(response.body.status, "queued");
  assert.equal((await localRepository.getGuideById(identity.guideId))?.status, "queued");
  await access(join(localStorage.root, sourceKey));
});

test("multipart upload returns 202 with unique edit tokens and protects guide lookup", async () => {
  const upload = () => {
    const identity = { guideId: randomUUID(), editToken: randomBytes(32).toString("base64url") };
    return {
      identity,
      response: request(app)
        .post("/api/guides")
        .set("Authorization", `Bearer ${identity.editToken}`)
        .set("X-ShowMe-Guide-Id", identity.guideId)
        .attach("video", Buffer.from("synthetic mp4 payload"), {
          filename: "가족_송금_안내.mp4",
          contentType: "video/mp4",
        }),
    };
  };

  const firstUpload = upload();
  const secondUpload = upload();
  const first = await firstUpload.response.expect(202);
  const second = await secondUpload.response.expect(202);

  for (const [response, identity] of [[first, firstUpload.identity], [second, secondUpload.identity]] as const) {
    assert.equal(response.body.guideId, identity.guideId);
    assert.equal("editToken" in response.body, false);
    assert.equal(response.body.status, "queued");
    assert.ok(await repository.verifyEditToken(response.body.guideId, identity.editToken));
    assert.ok(processedGuideIds.includes(response.body.guideId));
    const durable = await repository.getGuideById(identity.guideId);
    assert.ok(durable);
    await access(join(storage.root, durable.originalObjectKey));
  }
  assert.notEqual(first.body.guideId, second.body.guideId);

  const guidePath = `/api/guides/${first.body.guideId}`;
  const withoutToken = await request(app).get(guidePath).expect(404);
  assert.equal(withoutToken.body.code, "GUIDE_NOT_FOUND");

  const withToken = await request(app)
    .get(guidePath)
    .set("Authorization", `Bearer ${firstUpload.identity.editToken}`)
    .expect(200)
    .expect("Cache-Control", "no-store");
  assert.equal(withToken.body.guide.id, first.body.guideId);
  assert.equal(withToken.body.guide.status, "queued");
  assert.equal(withToken.body.guide.title, "가족 송금 안내");
});

test("an interrupted durable uploading row resumes with the same identity and deterministic source key", async () => {
  const identity = { guideId: randomUUID(), editToken: randomBytes(32).toString("base64url") };
  const payload = Buffer.from("same resumable payload");
  const sourceDigest = createHash("sha256").update(payload).digest("hex");
  const sourceKey = `guides/${identity.guideId}/source/${sourceDigest}.mp4`;
  await repository.createGuide({
    id: identity.guideId,
    slug: randomBytes(8).toString("base64url").toLowerCase(),
    editToken: identity.editToken,
    title: "resumable",
    status: "uploading",
    originalObjectKey: sourceKey,
    sourceFilename: "recording.mp4",
    sourceMimeType: "video/mp4",
    sourceSizeBytes: payload.length,
    createdAt: new Date(Date.now() - 31_000).toISOString(),
  });

  const response = await request(app)
    .post("/api/guides")
    .set("Authorization", `Bearer ${identity.editToken}`)
    .set("X-ShowMe-Guide-Id", identity.guideId)
    .attach("video", payload, { filename: "recording.mp4", contentType: "video/mp4" })
    .expect(202);
  assert.equal(response.body.status, "queued");
  assert.equal((await repository.getGuideById(identity.guideId))?.status, "queued");
  await access(join(storage.root, sourceKey));
});

test("deleting before the upload row exists leaves a durable cancellation tombstone", async () => {
  const identity = { guideId: randomUUID(), editToken: randomBytes(32).toString("base64url") };

  await request(app)
    .delete(`/api/guides/${identity.guideId}`)
    .set("Authorization", `Bearer ${identity.editToken}`)
    .expect(204);

  const tombstone = await repository.getGuideById(identity.guideId);
  assert.ok(tombstone);
  assert.equal(tombstone.status, "failed");
  assert.equal(tombstone.errorCode, UPLOAD_CANCELLATION_TOMBSTONE);

  const lateUpload = await request(app)
    .post("/api/guides")
    .set("Authorization", `Bearer ${identity.editToken}`)
    .set("X-ShowMe-Guide-Id", identity.guideId)
    .attach("video", Buffer.from("late private payload"), {
      filename: "late.mp4",
      contentType: "video/mp4",
    })
    .expect(202);
  assert.equal(lateUpload.body.status, "failed");
  assert.equal((await repository.getGuideById(identity.guideId))?.errorCode, UPLOAD_CANCELLATION_TOMBSTONE);
  await assert.rejects(access(join(storage.root, "guides", identity.guideId, "source")));

  await request(app)
    .delete(`/api/guides/${identity.guideId}`)
    .set("Authorization", `Bearer ${identity.editToken}`)
    .expect(204);
  assert.ok(await repository.getGuideById(identity.guideId));
});

test("deleting after row creation but before upload lease claim preserves cancellation", async () => {
  const localRepository = new JsonGuideRepository(join(sandboxDir, "pre-lease-delete", "guides.json"));
  const localStorage = new LocalStorage(join(sandboxDir, "pre-lease-delete", "objects"));
  const identity = { guideId: randomUUID(), editToken: randomBytes(32).toString("base64url") };
  let enteredClaim!: () => void;
  let releaseClaim!: () => void;
  const claimEntered = new Promise<void>((resolve) => { enteredClaim = resolve; });
  const claimReleased = new Promise<void>((resolve) => { releaseClaim = resolve; });
  const barrierRepository = new Proxy(localRepository, {
    get(target, property) {
      if (property === "claimUploadLease") {
        return async (...args: Parameters<JsonGuideRepository["claimUploadLease"]>) => {
          enteredClaim();
          await claimReleased;
          return target.claimUploadLease(...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const localApp = createProcessorApp({
    config,
    repository: barrierRepository,
    storage: localStorage,
    pipeline: fakePipeline,
  });

  const uploadPromise = request(localApp)
    .post("/api/guides")
    .set("Authorization", `Bearer ${identity.editToken}`)
    .set("X-ShowMe-Guide-Id", identity.guideId)
    .attach("video", Buffer.from("cancel between row and lease"), {
      filename: "race.mp4",
      contentType: "video/mp4",
    });
  const uploadResponsePromise = uploadPromise.then((result) => result);
  await claimEntered;

  await request(localApp)
    .delete(`/api/guides/${identity.guideId}`)
    .set("Authorization", `Bearer ${identity.editToken}`)
    .expect(204);
  assert.equal((await localRepository.getGuideById(identity.guideId))?.errorCode, UPLOAD_CANCELLATION_TOMBSTONE);

  releaseClaim();
  const uploadResponse = await uploadResponsePromise;
  assert.equal(uploadResponse.status, 202);
  assert.equal(uploadResponse.body.status, "failed");
  assert.equal((await localRepository.getGuideById(identity.guideId))?.errorCode, UPLOAD_CANCELLATION_TOMBSTONE);
  await assert.rejects(access(join(localStorage.root, "guides", identity.guideId, "source")));
});

test("authenticated deletion removes a failed guide source and every deterministic attempt asset", async () => {
  const failed = await seedGuide({ status: "failed" });
  const fixture = join(sandboxDir, `${failed.id}.jpg`);
  await writeFile(fixture, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const sourceKey = `guides/${failed.id}/source.mp4`;
  const frameKey = `guides/${failed.id}/attempts/1/frames/frame-001.jpg`;
  await storage.putFile(sourceKey, fixture);
  await storage.putFile(frameKey, fixture);
  await repository.updateStatus(failed.id, "failed", {
    expectedStatuses: ["failed"],
    errorCode: "PROCESSING_FAILED",
  });
  await repository.claimProcessingAttempt(failed.id, "attempt-one", {
    expectedStatuses: ["failed"],
    maxAttempts: 3,
  });
  await repository.updateStatus(failed.id, "failed", {
    expectedStatuses: ["probing"],
    expectedProcessingAttemptId: "attempt-one",
    expectedProcessingAttemptCount: 1,
    errorCode: "PROCESSING_FAILED",
  });

  await request(app)
    .delete(`/api/guides/${failed.id}`)
    .set("Authorization", "Bearer wrong-token")
    .expect(404);
  assert.ok(await repository.getGuideById(failed.id));

  await request(app)
    .delete(`/api/guides/${failed.id}`)
    .set("Authorization", `Bearer ${failed.editToken}`)
    .expect(204);
  assert.equal(await repository.getGuideById(failed.id), null);
  await assert.rejects(access(join(storage.root, sourceKey)));
  await assert.rejects(access(join(storage.root, frameKey)));
});

test("deleting an active processing attempt remains pending for its worker to finalize", async () => {
  const active = await seedGuide({ status: "queued" });
  const claimed = await repository.claimProcessingAttempt(active.id, "active-delete-attempt", {
    expectedStatuses: ["queued"],
    maxAttempts: 3,
  });
  assert.ok(claimed);

  const deletion = await request(app)
    .delete(`/api/guides/${active.id}`)
    .set("Authorization", `Bearer ${active.editToken}`)
    .expect(202);
  assert.equal(deletion.body.status, "deleting");
  const pending = await repository.getGuideById(active.id);
  assert.equal(pending?.status, "failed");
  assert.equal(pending?.errorCode, "DELETION_PENDING_ACTIVE");
  assert.equal(pending?.processingAttemptId, "active-delete-attempt");
});

test("upload rejects an unsupported filename extension with 415", async () => {
  const identity = { guideId: randomUUID(), editToken: randomBytes(32).toString("base64url") };
  const response = await request(app)
    .post("/api/guides")
    .set("Authorization", `Bearer ${identity.editToken}`)
    .set("X-ShowMe-Guide-Id", identity.guideId)
    .attach("video", Buffer.from("not a supported upload"), {
      filename: "recording.avi",
      contentType: "video/x-msvideo",
    })
    .expect(415);

  assert.deepEqual(response.body, {
    error: "MP4, MOV, WebM 영상만 올릴 수 있어요.",
    code: "UNSUPPORTED_VIDEO",
  });
});

test("upload maps an extension/MIME mismatch to 415 and removes multipart temp files", async () => {
  const identity = { guideId: randomUUID(), editToken: randomBytes(32).toString("base64url") };
  const response = await request(app)
    .post("/api/guides")
    .set("Authorization", `Bearer ${identity.editToken}`)
    .set("X-ShowMe-Guide-Id", identity.guideId)
    .attach("video", Buffer.from("synthetic payload"), {
      filename: "recording.mp4",
      contentType: "video/webm",
    })
    .expect(415);
  assert.equal(response.body.code, "UNSUPPORTED_VIDEO");
  assert.deepEqual(await readdir(join(config.dataDir, "incoming")), []);
});

test("multipart limit errors remove the first received file", async () => {
  const identity = { guideId: randomUUID(), editToken: randomBytes(32).toString("base64url") };
  const response = await request(app)
    .post("/api/guides")
    .set("Authorization", `Bearer ${identity.editToken}`)
    .set("X-ShowMe-Guide-Id", identity.guideId)
    .attach("video", Buffer.from("first"), { filename: "first.mp4", contentType: "video/mp4" })
    .attach("video", Buffer.from("second"), { filename: "second.mp4", contentType: "video/mp4" })
    .expect(400);
  assert.equal(response.body.code, "TOO_MANY_FILES");
  assert.deepEqual(await readdir(join(config.dataDir, "incoming")), []);
});

test("retry returns 202 only for a failed guide", async () => {
  const failed = await seedGuide({ status: "failed" });
  const ready = await seedGuide({ status: "ready" });

  const failedResponse = await request(app)
    .post(`/api/guides/${failed.id}/retry`)
    .set("Authorization", `Bearer ${failed.editToken}`)
    .expect(202);
  assert.deepEqual(failedResponse.body, { status: "queued" });
  assert.equal((await repository.getGuideById(failed.id))?.status, "queued");
  assert.ok(processedGuideIds.includes(failed.id));

  const readyResponse = await request(app)
    .post(`/api/guides/${ready.id}/retry`)
    .set("Authorization", `Bearer ${ready.editToken}`)
    .expect(409);
  assert.equal(readyResponse.body.code, "GUIDE_NOT_FAILED");
  assert.equal((await repository.getGuideById(ready.id))?.status, "ready");
});

test("deterministic input failures cannot consume retry attempts repeatedly", async () => {
  const failed = await seedGuide({ status: "failed" });
  await repository.updateStatus(failed.id, "failed", {
    expectedStatuses: ["failed"],
    errorCode: "INVALID_VIDEO",
    errorMessage: "재생 가능한 영상이 아니에요.",
  });
  const response = await request(app)
    .post(`/api/guides/${failed.id}/retry`)
    .set("Authorization", `Bearer ${failed.editToken}`)
    .expect(409);
  assert.equal(response.body.code, "GUIDE_NOT_RETRYABLE");
});

test("retry is preserved when the previous same-key queue task is still releasing", async () => {
  const failed = await seedGuide({ status: "failed" });
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const retried: string[] = [];
  const raceQueue = new ProcessingQueue(1, 2);
  raceQueue.enqueue(failed.id, () => blocker);
  const racePipeline: GuidePipeline = {
    async process(guideId) { retried.push(guideId); },
    async processClaimed(guideId) { retried.push(guideId); },
  };
  const raceApp = createProcessorApp({
    config,
    repository,
    storage,
    pipeline: racePipeline,
    queue: raceQueue,
  });

  await request(raceApp)
    .post(`/api/guides/${failed.id}/retry`)
    .set("Authorization", `Bearer ${failed.editToken}`)
    .expect(202);
  assert.equal((await repository.getGuideById(failed.id))?.status, "queued");
  release();
  const deadline = Date.now() + 1_000;
  while (!retried.includes(failed.id)) {
    if (Date.now() >= deadline) throw new Error("same-key retry was stranded");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
});

test("frame and thumbnail assets require the matching guide edit token", async () => {
  const owner = await seedGuide({ status: "ready" });
  const otherGuide = await seedGuide({ status: "ready" });
  const frameKey = `guides/${owner.id}/frames/frame-001.jpg`;
  const thumbnailKey = `guides/${owner.id}/frames/frame-001-thumb.jpg`;
  const frameBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x53, 0x68, 0x6f, 0x77, 0x4d, 0x65]);
  const thumbnailBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x74, 0x68, 0x75, 0x6d, 0x62]);
  const frameSource = join(sandboxDir, "asset-frame.jpg");
  const thumbnailSource = join(sandboxDir, "asset-thumbnail.jpg");
  await Promise.all([
    writeFile(frameSource, frameBytes),
    writeFile(thumbnailSource, thumbnailBytes),
  ]);
  await Promise.all([
    storage.putFile(frameKey, frameSource),
    storage.putFile(thumbnailKey, thumbnailSource),
  ]);
  const [step] = await repository.replaceSteps(owner.id, [{
    id: randomUUID(),
    position: 0,
    shortLabel: "첫 화면",
    instruction: "표시된 곳을 누르세요.",
    startMs: 0,
    endMs: 1_000,
    representativeTimestampMs: 500,
    representativeFrameKey: frameKey,
    thumbnailFrameKey: thumbnailKey,
    frameWidth: 720,
    frameHeight: 1280,
  }]);
  assert.ok(step);

  const framePath = `/api/guides/${owner.id}/assets/${step.id}/frame`;
  await request(app).get(framePath).expect(404);
  await request(app)
    .get(framePath)
    .set("Authorization", `Bearer ${otherGuide.editToken}`)
    .expect(404);

  const frameResponse = await request(app)
    .get(framePath)
    .set("Authorization", `Bearer ${owner.editToken}`)
    .expect(200)
    .expect("Content-Type", /image\/jpeg/)
    .expect("Cache-Control", "private, max-age=300");
  assert.deepEqual(frameResponse.body, frameBytes);

  const thumbnailResponse = await request(app)
    .get(`/api/guides/${owner.id}/assets/${step.id}/thumbnail`)
    .set("Authorization", `Bearer ${owner.editToken}`)
    .expect(200)
    .expect("Content-Type", /image\/jpeg/);
  assert.deepEqual(thumbnailResponse.body, thumbnailBytes);

  const guideResponse = await request(app)
    .get(`/api/guides/${owner.id}`)
    .set("Authorization", `Bearer ${owner.editToken}`)
    .expect(200);
  const ticketedFrameUrl = guideResponse.body.guide.steps[0].frameUrl as string;
  const ticketedThumbnailUrl = guideResponse.body.guide.steps[0].thumbnailUrl as string;
  assert.equal(ticketedFrameUrl.startsWith(`${framePath}?asset_token=`), true);
  assert.match(ticketedThumbnailUrl, /\?asset_token=/);
  assert.equal(ticketedFrameUrl.includes(owner.editToken), false);
  assert.equal(ticketedThumbnailUrl.includes("edit_token"), false);
  const ticketedFrame = await request(app).get(ticketedFrameUrl).expect(200);
  assert.deepEqual(ticketedFrame.body, frameBytes);
});
