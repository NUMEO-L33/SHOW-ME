import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import request from "supertest";

import { loadConfig } from "../src/config.js";
import { createGuidePipeline } from "../src/pipeline.js";
import { ProcessingQueue } from "../src/queue.js";
import { JsonGuideRepository } from "../src/repository.js";
import { createProcessorApp } from "../src/server.js";
import { LocalStorage } from "../src/storage.js";

const localRequire = createRequire(import.meta.url);
const ffmpegPath = localRequire("ffmpeg-static") as string;
const ffprobePath = (localRequire("ffprobe-static") as { path: string }).path;

for (const [extension, mimeType, codec] of [
  ["mp4", "video/mp4", "libx264"],
  ["mov", "video/quicktime", "libx264"],
  ["webm", "video/webm", "libvpx-vp9"],
] as const) {
  test(`${extension}: real multipart upload → FFmpeg → private frame → draft → deletion`, { timeout: 30000 }, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "showme-upload-flow-test-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const fixturePath = join(root, `synthetic.${extension}`);
    await promisify(execFile)(ffmpegPath, [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=1",
      "-c:v", codec, "-pix_fmt", "yuv420p", "-an", fixturePath,
    ], { windowsHide: true, timeout: 10000 });
    const config = loadConfig({
      NODE_ENV: "test", DATA_DIR: root, SHOWME_STORAGE: "local", CORS_ORIGINS: "http://localhost:5173",
      FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath,
      REQUEST_TIMEOUT_MS: "10000", FFPROBE_TIMEOUT_MS: "10000", FFMPEG_TIMEOUT_MS: "10000", JOB_TIMEOUT_MS: "15000",
    });
    const repository = new JsonGuideRepository(join(root, "guides.json"));
    const storage = new LocalStorage(join(root, "objects"));
    const queue = new ProcessingQueue(1, 10);
    context.after(() => queue.onIdle());
    const pipeline = createGuidePipeline({ config, repository, storage });
    const app = createProcessorApp({ config, repository, storage, pipeline, queue });
    const guideId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const auth = `Bearer ${token}`;
    await request(app).post("/api/guides").set("Authorization", auth).set("X-ShowMe-Guide-Id", guideId)
      .attach("video", fixturePath, { filename: `synthetic.${extension}`, contentType: mimeType }).expect(202);
    await queue.onIdle();
    const response = await request(app).get(`/api/guides/${guideId}`).set("Authorization", auth).expect(200);
    assert.equal(response.body.guide.status, "ready");
    assert.ok(response.body.guide.steps.length > 0);
    assert.equal(response.body.guide.media.orientation, "landscape");
    const serialized = JSON.stringify(response.body);
    assert.ok(!serialized.includes(token));
    assert.ok(!serialized.includes("originalObjectKey"));
    await request(app).get(`/api/guides/${guideId}`).expect(404);
    const frameUrl = response.body.guide.steps[0].frameUrl as string;
    await request(app).get(frameUrl).expect(200).expect("Content-Type", /image\/jpeg/);
    await request(app).get(frameUrl.split("?", 1)[0]).expect(404);
    const guide = await repository.getGuideById(guideId);
    assert.ok(guide);
    assert.ok(await repository.executeAnalysisCommand(guideId, { type: "initialize" }));
    // No public AI routes or fake-provider product mode exist in this foundation.
    await request(app).post(`/api/guides/${guideId}/analysis`).set("Authorization", auth).expect(404);
    await request(app).delete(`/api/guides/${guideId}`).set("Authorization", auth).expect(204);
    assert.equal(await repository.getAnalysisState(guideId), null);
    await assert.rejects(() => access(join(storage.root, guide.originalObjectKey)));
    await request(app).get(frameUrl).expect(404);
    await request(app).get(`/api/guides/${guideId}`).set("Authorization", auth).expect(404);
  });
}
