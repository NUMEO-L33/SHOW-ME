import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import express from "express";
import { test } from "node:test";
import { loadConfig } from "../src/processor/config.js";
import { createGuidePipeline } from "../src/processor/pipeline.js";
import { ProcessingQueue } from "../src/processor/queue.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { createProcessorApp } from "../src/processor/server.js";
import { LocalStorage } from "../src/processor/storage.js";
import { probeVideo } from "../src/processor/media/ffmpeg.js";
import { testMediaPaths } from "./helpers/media-binaries.js";
const { ffmpegPath, ffprobePath } = testMediaPaths();
// Dynamic URL imports: these dependency-free JS diagnostics are also run by Node
// directly in Replit, not transpiled into the production API bundle.
const checkerUrl = new URL("../../../scripts/private-access-check.mjs", import.meta.url).href;
const recoveryUrl = new URL("../../../scripts/private-access-recovery.mjs", import.meta.url).href;
const { checkPrivateAccess, createRun } = await import(checkerUrl);
const { recoveryStore } = await import(recoveryUrl);

for (const simulateLeak of [false, true]) {
  test(`synthetic access diagnostic against real HTTP/FFmpeg/LocalStorage, simulated leak=${simulateLeak}`, { timeout: 45000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), "showme-access-integration-"));
    const config = loadConfig({ NODE_ENV: "test", DATA_DIR: root, SHOWME_STORAGE: "local", CORS_ORIGINS: "http://localhost:5173",
      FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath, FFMPEG_TIMEOUT_MS: "15000", FFPROBE_TIMEOUT_MS: "15000", JOB_TIMEOUT_MS: "25000" });
    const repository = new JsonGuideRepository(join(root, "guides.json"));
    const storage = new LocalStorage(join(root, "objects"));
    const keys: string[] = [];
    const originalPut = storage.putFile.bind(storage);
    t.mock.method(storage, "putFile", async (key: string, path: string) => {
      if (key.endsWith(".mp4")) {
        const media = await probeVideo(path, { ffprobePath, timeoutMs: 15000 });
        assert.equal(media.displayWidth, 160);
        assert.equal(media.displayHeight, 90);
        assert.equal(media.hasAudio, false);
      }
      keys.push(key);
      await originalPut(key, path);
    });
    const queue = new ProcessingQueue(1, 10);
    const pipeline = createGuidePipeline({ config, repository, storage });
    const app = express();
    let analysisRequests = 0;
    app.use((req, res, next) => {
      if (req.path.includes("/analysis")) analysisRequests++;
      if (simulateLeak && req.method === "GET" && req.path.endsWith("/draft") && !req.header("authorization")) {
        res.json({ diagnostic: "simulated broken access control; synthetic only" });
      } else next();
    });
    app.use(createProcessorApp({ config, repository, storage, pipeline, queue }));
    const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    t.after(async () => {
      await queue.onIdle();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
      await rm(root, { recursive: true, force: true });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const run = createRun(`http://127.0.0.1:${address.port}`);
    const store = recoveryStore(join(root, "recovery"));
    const events: string[] = [];
    const execution = checkPrivateAccess(run, { pollMs: 50, cleanupDelayMs: 50, report: (event: string) => events.push(event),
      saveRecovery: () => store.save(run), clearRecovery: () => store.clear(run) });
    if (simulateLeak) await assert.rejects(execution, { code: "UNEXPECTED_HTTP_STATUS" });
    else await execution;
    assert.equal(events.includes("PASS"), !simulateLeak);
    assert.ok(events.includes("TEST_GUIDE_DELETED"));
    assert.equal(analysisRequests, 0);
    assert.equal(await repository.getGuideById(run.guideId), null);
    assert.equal(await repository.getAnalysisState(run.guideId), null);
    assert.ok(keys.length >= 3, "source, frame and thumbnail were really stored");
    for (const key of keys) await assert.rejects(access(join(storage.root, key)));
    await store.assertEmpty();
  });
}
