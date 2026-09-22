// Manual synthetic browser fixture. No .env, application DB, AI or Replit connection.
import express from "express";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import { createAnalysisHarness } from "../tests/helpers/analysis-fixtures.js";
import { reviewedAssetFixture } from "../tests/helpers/privacy-assets-fixture.js";
import { attemptFrameObjectKey } from "../src/processor/asset-lifecycle.js";
import { LocalStorage } from "../src/processor/storage.js";
import { syntheticAnalysisInput } from "../src/processor/gemini/synthetic.js";
import { testMediaPaths } from "../tests/helpers/media-binaries.js";
import { loadConfig } from "../src/processor/config.js";
import { createProcessorApp } from "../src/processor/server.js";
import { DurablePublicationRuntime } from "../src/processor/publication-runtime.js";

if (process.argv[2] !== "--local-synthetic" || process.env.NODE_ENV !== "test") throw new Error("LOCAL_SYNTHETIC_ONLY");
const cleanups: Array<() => unknown> = [];
const h = await createAnalysisHarness({ after: (fn: () => unknown) => cleanups.push(fn) } as unknown as TestContext, 2,
  { guideId: randomUUID(), editToken: "s".repeat(43) });
await h.repository.replaceSteps(h.guideId, h.guide.steps.map((s, i) => ({ ...s,
  representativeFrameKey: attemptFrameObjectKey(h.guideId, 1, i + 1, "frame"), thumbnailFrameKey: attemptFrameObjectKey(h.guideId, 1, i + 1, "thumbnail") })));
const guide = (await h.repository.getGuideById(h.guideId))!;
await reviewedAssetFixture(h.repository, guide);
const storage = new LocalStorage(join(h.root, "objects"));
const file = join(h.root, "synthetic.jpg"); await writeFile(file, Buffer.from((await syntheticAnalysisInput()).images[0].bytes));
for (const step of guide.steps) { await storage.putFile(step.representativeFrameKey!, file); await storage.putFile(step.thumbnailFrameKey!, file); }
const config = { ...loadConfig({ NODE_ENV: "test", DATA_DIR: h.root, SHOWME_STORAGE: "local" }), ...testMediaPaths(), port: 0 };
const context = { repository: h.repository, storage, config };
const runtime = new DurablePublicationRuntime(context, { pollMs: 250 });
const app = express(); app.disable("x-powered-by");
app.post("/__synthetic_stop", (req, res) => { if (req.get("origin")) { res.sendStatus(403); return; } res.status(204).end(); void stop(); });
app.get("/__synthetic_editor", (_req, res) => {
  const record = JSON.stringify({ guideId: h.guideId, editToken: "s".repeat(43), phase: "processing", startedAt: Date.now(),
    intent: { goal: "합성 게시 확인", audience: "", notes: "" }, fileName: "synthetic-only.mp4" });
  res.set("Cache-Control", "no-store").type("html").send(`<!doctype html><meta charset="utf-8"><title>합성 시험 준비</title><script>
    const job=${record};job.baseUrl=location.origin;
    localStorage.setItem('showme:processing-job:'+job.guideId,JSON.stringify(job));
    sessionStorage.setItem('showme:active-processing-guide-id',job.guideId);location.replace('/');</script>`);
});
app.use(express.static(resolve("../showme/dist/public"), { index: false, setHeaders(res) { res.setHeader("Cache-Control", "no-store"); } }));
app.get(["/", "/g/:slug"], (_req, res) => res.set("Cache-Control", "no-store").sendFile(resolve("../showme/dist/public/index.html")));
app.use(createProcessorApp({ ...context, publicationAdmission: runtime.admission,
  pipeline: { async process() { throw new Error("NO_MEDIA_UPLOAD"); }, async processClaimed() { throw new Error("NO_MEDIA_UPLOAD"); } } }));
const server = app.listen(0, "127.0.0.1", () => {
  const address = server.address(); if (!address || typeof address === "string") throw new Error("NO_LOOPBACK");
  config.corsOrigins = [`http://127.0.0.1:${address.port}`];
  runtime.start(); console.log(`PUBLICATION_UI_FIXTURE http://127.0.0.1:${address.port}/__synthetic_editor`);
  console.log(`PUBLICATION_UI_TEMP ${h.root}`);
});
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  const result = await runtime.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  if (result.pendingIO) { console.error("SYNTHETIC_CLEANUP_PENDING"); process.exitCode = 1; return; }
  for (const cleanup of cleanups) await cleanup();
  console.log("PUBLICATION_UI_FIXTURE_REMOVED");
}
process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
// The terminal session can close just this fixture without touching any other server.
process.stdin.resume(); process.stdin.once("data", () => void stop().then(() => process.stdin.pause()));
