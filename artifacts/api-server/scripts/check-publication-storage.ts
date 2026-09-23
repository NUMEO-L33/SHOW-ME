// Explicit synthetic acceptance check. Default: JSON, no application DB/AI/.env/public listener.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { access, readFile, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable } from "node:stream";
import type { TestContext } from "node:test";
import type { Storage } from "../src/processor/storage.js";
import type { GuideRepository } from "../src/processor/domain.js";
import { publicationCheckScope } from "./publication-check-scope.js";

type Environment = Readonly<Record<string, string | undefined>>;
type Target = { mode: "local" } | { mode: "replit"; bucketId: string; prefix: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const refused = () => new Error("SYNTHETIC_STORAGE_CHECK_REFUSED");

export function publicationStorageTarget(args: readonly string[], env: Environment): Target {
  if (args.length === 1 && args[0] === "--local-synthetic" && env.NODE_ENV === "test") return { mode: "local" };
  const id = args[0]?.replace(/^--replit-development=/, "") ?? "";
  if (args.length !== 2 || !args[0]?.startsWith("--replit-development=") || !uuid.test(id)
    || id !== env.REPL_ID || args[1] !== "--confirm-synthetic-storage"
    || ![undefined, "", "development"].includes(env.NODE_ENV)
    || ![undefined, "", "0", "false"].includes(env.REPLIT_DEPLOYMENT)
    || ![undefined, "", "off"].includes(env.SHOWME_ANALYSIS_MODE)) throw refused();
  const bucketId = env.REPLIT_OBJECT_STORAGE_BUCKET_ID;
  const prefix = env.REPLIT_OBJECT_STORAGE_PREFIX || "showme";
  if (!bucketId || !/^[A-Za-z0-9_-]{1,160}$/.test(bucketId)
    || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix) || prefix.length > 200) throw refused();
  return { mode: "replit", bucketId, prefix };
}

export function syntheticObjectAllowed(key: string, guideId: string): boolean {
  if (!uuid.test(guideId)) return false;
  const base = `guides/${guideId}/`;
  if (!key.startsWith(base)) return false;
  const tail = key.slice(base.length);
  if (/^attempts\/1\/frames\/frame-001(?:-thumb)?\.jpg$/.test(tail)) return true;
  const parts = tail.split("/");
  return parts.length === 3 && parts[0] === "private-redactions" && uuid.test(parts[1]) && /^0-(?:frame|thumbnail)\.png$/.test(parts[2]);
}

export async function runPublicationStorageCheck(args: readonly string[], env: Environment,
  log: (message: string) => void = console.log,
  database?: { repository: GuideRepository; verifyRemoved: (guideId: string) => Promise<void>;
    seedTransaction?: (work: (repository: GuideRepository) => Promise<void>) => Promise<void> }) {
  // Validation precedes SDK/repository/server imports, fixture creation and all I/O.
  const target = publicationStorageTarget(args, env);
  const { createAnalysisHarness } = await import("../tests/helpers/analysis-fixtures.js");
  const { reviewedAssetFixture } = await import("../tests/helpers/privacy-assets-fixture.js");
  const { attemptFrameObjectKey } = await import("../src/processor/asset-lifecycle.js");
  const { LocalStorage, ReplitObjectStorage } = await import("../src/processor/storage.js");
  const { syntheticAnalysisInput } = await import("../src/processor/gemini/synthetic.js");
  const { redactRgb, thumbnailRgb, encodePrivacyPng } = await import("../src/processor/privacy-render.js");
  const { loadConfig } = await import("../src/processor/config.js");
  const { createProcessorApp } = await import("../src/processor/server.js");
  const { DurablePublicationRuntime } = await import("../src/processor/publication-runtime.js");
  const runId = randomUUID(), token = randomBytes(32).toString("base64url"), cleanups: Array<() => unknown> = [];
  const remotePrefix = target.mode === "replit" ? `${target.prefix}/diagnostics/publication/${runId}` : undefined;
  const { Client } = await import("@replit/object-storage");
  const client = target.mode === "replit" ? new Client({ bucketId: target.bucketId }) : undefined;
  let h: Awaited<ReturnType<typeof createAnalysisHarness>>;
  try {
    h = await createAnalysisHarness({ after: (fn: () => unknown) => cleanups.push(fn) } as unknown as TestContext,
      1, { guideId: runId, editToken: token });
  } catch (error) { for (const cleanup of cleanups) await cleanup(); throw error; }
  const raw = client ? new ReplitObjectStorage({ client, bucketId: target.mode === "replit" ? target.bucketId : undefined,
    prefix: remotePrefix }) : new LocalStorage(join(h.root, "objects"));
  const manifest = join(h.root, "storage-check.jsonl");
  try {
    await writeFile(manifest, JSON.stringify({ kind: "showme-synthetic-publication-storage-v1", runId, remotePrefix,
      bucketId: target.mode === "replit" ? target.bucketId : null }) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) { for (const cleanup of cleanups) await cleanup(); throw error; }
  const written = new Set<string>(), inFlight = new Set<Promise<unknown>>(), streams = new Set<Readable>();
  const signal = AbortSignal.timeout(180_000);
  let stage = "storage-preflight", passed = false, objectsRemoved = false, localRemoved = false, pendingIO = false;
  let localFailure: unknown;
  let runtime: InstanceType<typeof DurablePublicationRuntime> | undefined;
  let server: import("node:http").Server | undefined;
  const track = <T>(operation: Promise<T>) => {
    inFlight.add(operation); void operation.finally(() => inFlight.delete(operation)).catch(() => undefined); return operation;
  };
  // Only the separate explicit integration entrypoint supplies a real DB.
  const repository = database ? publicationCheckScope(database.repository, runId, track) : h.repository;
  let databasePlanned = false, databaseRemoved = false;
  const wait = async <T>(operation: Promise<T>, waitSignal = signal): Promise<T> => {
    let abort!: () => void;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        abort = () => reject(refused()); waitSignal.addEventListener("abort", abort, { once: true });
        if (waitSignal.aborted) abort();
      })]);
    } finally { waitSignal.removeEventListener("abort", abort); }
  };
  const check = (key: string) => { if (!syntheticObjectAllowed(key, runId)) throw refused(); };
  const storage: Storage = {
    async putFile(key, source) {
      check(key); if (written.has(key) || written.size >= 4) throw refused();
      written.add(key); await appendFile(manifest, JSON.stringify({ operation: "put-planned", key }) + "\n");
      return track(raw.putFile(key, source));
    },
    async openRead(key) {
      check(key); if (!written.has(key)) throw refused();
      return track(raw.openRead(key).then(stream => {
        streams.add(stream); stream.once("close", () => streams.delete(stream));
        if (signal.aborted) stream.destroy(); return stream;
      }));
    },
    async materialize(key, destination, options) { check(key); if (!written.has(key)) throw refused(); return track(raw.materialize(key, destination, options)); },
    async delete(key) { check(key); if (!written.has(key)) throw refused(); return track(raw.delete(key)); },
  };
  signal.addEventListener("abort", () => { for (const stream of streams) stream.destroy(); }, { once: true });
  const exists = async (key: string) => {
    check(key);
    if (client) { const result = await track(client.exists(`${remotePrefix}/${key}`)); if (!result.ok) throw refused(); return result.value; }
    try { await access(join(h.root, "objects", key)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw refused(); return false; }
  };
  const readBytes = async (key: string) => {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of await storage.openRead(key)) {
      bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw refused(); chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };
  try {
    if (client) { const result = await wait(track(client.list({ prefix: `${remotePrefix}/` }))); assert.ok(result.ok && result.value.length === 0); }
    if (database) {
      assert.equal(await repository.getGuideById(runId), null);
      assert.equal(await repository.getGuideBySlug(runId), null);
      await appendFile(manifest, JSON.stringify({ operation: "database-guide-planned", guideId: runId }) + "\n");
      databasePlanned = true;
      const seed = async (rawRepository: GuideRepository) => {
        const seedRepository = publicationCheckScope(rawRepository, runId, track);
        await seedRepository.createGuide({ id: runId, slug: runId, editToken: token, title: "Synthetic publication integration check",
          status: "queued", originalObjectKey: `guides/${runId}/source.mp4`,
          sourceFilename: "synthetic-check.mp4", sourceMimeType: "video/mp4", sourceSizeBytes: 128 });
        await seedRepository.claimProcessingAttempt(runId, "synthetic-check");
        await seedRepository.updateStatus(runId, "extracting");
        assert.ok(await seedRepository.completeProcessingAttempt(runId, { attemptId: "synthetic-check", attemptCount: 1,
          steps: h.guide.steps.map(s => ({ ...s, id: `${runId}-step-0` })) }));
      };
      // Real DB creation commits as ready in ONE transaction, so the app's
      // existing media dispatcher never sees a new queued diagnostic video.
      if (database.seedTransaction) await wait(track(database.seedTransaction(seed)));
      else { assert.equal(target.mode, "local"); await seed(database.repository); }
      log("PUBLICATION_STORAGE_CHECK POSTGRES_GUIDE_CREATED");
    }
    const frame = attemptFrameObjectKey(runId, 1, 1, "frame"), thumb = attemptFrameObjectKey(runId, 1, 1, "thumbnail");
    await repository.replaceSteps(runId, (await repository.getGuideById(runId))!.steps.map(s => ({ ...s, representativeFrameKey: frame, thumbnailFrameKey: thumb })));
    const guide = (await repository.getGuideById(runId))!, reviewed = await reviewedAssetFixture(repository, guide);
    const sourceState = await repository.getGuideById(runId);
    const source = Buffer.from((await syntheticAnalysisInput()).images[0].bytes), sourceFile = join(h.root, "synthetic.jpg");
    await writeFile(sourceFile, source);
    stage = "source-roundtrip";
    for (const key of [frame, thumb]) { await wait(storage.putFile(key, sourceFile)); assert.deepEqual(await wait(readBytes(key)), source); }
    const downloaded = join(h.root, "roundtrip.jpg"); await wait(storage.materialize(frame, downloaded, { signal }));
    assert.deepEqual(await readFile(downloaded), source); log("PUBLICATION_STORAGE_CHECK SOURCE_ROUNDTRIP_OK");
    const config = { ...loadConfig({ NODE_ENV: "test", DATA_DIR: h.root, SHOWME_STORAGE: "local",
      FFMPEG_PATH: env.FFMPEG_PATH || env.SHOWME_TEST_FFMPEG_PATH || (target.mode === "replit" ? "ffmpeg" : undefined),
      FFPROBE_PATH: env.FFPROBE_PATH || env.SHOWME_TEST_FFPROBE_PATH || (target.mode === "replit" ? "ffprobe" : undefined) }), port: 0 };
    assert.equal(config.databaseUrl, undefined);
    runtime = new DurablePublicationRuntime({ config, repository, storage }, { pollMs: 250, shutdownTimeoutMs: 5000 });
    const app = createProcessorApp({ config, repository, storage, publicationAdmission: runtime.admission,
      pipeline: { async process() { throw refused(); }, async processClaimed() { throw refused(); } } });
    server = app.listen(0, "127.0.0.1"); await new Promise<void>((ok, fail) => { server!.once("listening", ok); server!.once("error", fail); });
    const address = server.address(); assert.ok(address && typeof address !== "string" && address.address === "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`, owner = `/api/guides/${runId}`, auth = { Authorization: `Bearer ${token}` };
    const http = async (path: string, status: number, method = "GET", body?: unknown, authorized = false) => {
      assert.ok(path.startsWith("/api/") && !path.includes("//"));
      const response = await fetch(base + path, { method, redirect: "error", signal,
        headers: { ...(authorized ? auth : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      assert.equal(response.status, status); return response;
    };
    const publicationId = randomUUID(), body = { publicationId, baseDraftRevision: reviewed.request.revision,
      inputFingerprint: reviewed.request.inputFingerprint, reviewFingerprint: reviewed.request.reviewFingerprint,
      originalSharingEnabled: false, publicSharing: true };
    stage = "publication";
    await http(`${owner}/publish`, 404, "POST", body);
    await http(`${owner}/publish`, 503, "POST", body, true);
    runtime.start();
    await http(`${owner}/publish`, 202, "POST", body, true);
    while ((await repository.getPublicationJob(runId, publicationId))?.status !== "succeeded") {
      signal.throwIfAborted(); assert.notEqual((await repository.getPublicationJob(runId, publicationId))?.status, "failed"); await delay(100, undefined, { signal });
    }
    const status = ((await (await http(`${owner}/publications/${publicationId}`, 200, "GET", undefined, true)).json()) as
      { publication: { publicPath: string; headVersion: number } }).publication;
    const slug = status.publicPath.split("/").at(-1), publicPath = `/api/public/guides/${slug}`;
    stage = "processed-pixels";
    const view = await (await http(publicPath, 200)).json() as
      { guide: { originalSharingEnabled: boolean; steps: Array<{ frameUrl: string; thumbnailUrl: string }> } };
    assert.equal(view.guide.originalSharingEnabled, false);
    const pixels = redactRgb(Buffer.alloc(640 * 360 * 3), 640, 360, [{ x: 0, y: 0, width: 100, height: 100 }]);
    const small = thumbnailRgb(pixels, 640, 360), expected = [encodePrivacyPng(pixels, 640, 360), encodePrivacyPng(small.pixels, small.width, small.height)];
    const urls = [view.guide.steps[0].frameUrl, view.guide.steps[0].thumbnailUrl];
    for (const [i, url] of urls.entries()) { const r = await http(url, 200); assert.match(r.headers.get("content-type")!, /image\/png/); assert.deepEqual(Buffer.from(await r.arrayBuffer()), expected[i]); }
    assert.deepEqual(await wait(readBytes(frame)), source); assert.deepEqual(await repository.getGuideById(runId), sourceState);
    log("PUBLICATION_STORAGE_CHECK PROCESSED_PIXELS_AND_SOURCE_PRESERVATION_OK");
    stage = "withdrawal";
    await http(`${owner}/unpublish`, 200, "POST", { expectedHeadVersion: status.headVersion, expectedJobId: null }, true);
    await http(publicPath, 404); for (const url of urls) await http(url, 404);
    while ((await repository.listPrivacyAssetBatches(runId)).length) { signal.throwIfAborted(); await delay(100, undefined, { signal }); }
    assert.equal(written.size, 4);
    for (const key of written) if (key.includes("/private-redactions/")) assert.equal(await wait(exists(key)), false);
    log("PUBLICATION_STORAGE_CHECK WITHDRAWAL_AND_PROCESSED_DELETION_OK"); passed = true;
  } catch (error) { if (target.mode === "local") localFailure = error; log(`PUBLICATION_STORAGE_CHECK FAILED ${stage}`); }
  finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
    const stopped = await runtime?.stop(); pendingIO = !!stopped?.pendingIO || inFlight.size > 0 || streams.size > 0;
    if (!pendingIO) {
      try {
        const cleanupSignal = AbortSignal.timeout(30_000);
        if (databasePlanned && await wait(repository.getGuideById(runId), cleanupSignal)) {
          assert.equal(await wait(repository.verifyEditToken(runId, token), cleanupSignal), true);
          const current = await wait(repository.getPublicationOwnerStatus(runId), cleanupSignal);
          if (current && (current.active || current.pendingJobId)) assert.ok(await wait(repository.stopPublication(runId,
            { type: "withdraw", expectedHeadVersion: current.head?.version ?? 0, expectedJobId: current.pendingJobId }), cleanupSignal));
          for (const batch of await wait(repository.listPrivacyAssetBatches(runId), cleanupSignal)) {
            // A stalled writer must retain its DB ledger and local manifest.
            assert.equal(batch.writerSettled, true);
            assert.ok(await wait(repository.executePrivacyAssetCommand(runId, { type: "cancel", id: batch.id }), cleanupSignal));
          }
        }
        for (const key of written) await wait(storage.delete(key), cleanupSignal);
        for (const key of written) assert.equal(await wait(exists(key), cleanupSignal), false);
        if (client) { const result = await wait(track(client.list({ prefix: `${remotePrefix}/` })), cleanupSignal); assert.ok(result.ok && result.value.length === 0); }
        objectsRemoved = true;
        if (databasePlanned) {
          const { privacyAssetKeys } = await import("../src/processor/privacy-assets.js");
          for (const batch of await wait(repository.listPrivacyAssetBatches(runId), cleanupSignal)) {
            for (const key of privacyAssetKeys(batch)) assert.equal(await wait(exists(key), cleanupSignal), false);
            assert.ok(await wait(repository.executePrivacyAssetCommand(runId, { type: "cleaned", id: batch.id, version: batch.version }), cleanupSignal));
          }
          const remaining = await wait(repository.getGuideById(runId), cleanupSignal);
          if (remaining) assert.equal(await wait(repository.deleteGuide(runId, { expectedUpdatedAt: remaining.updatedAt }), cleanupSignal), true);
          await wait(track(database!.verifyRemoved(runId)), cleanupSignal); databaseRemoved = true;
          log("PUBLICATION_STORAGE_CHECK POSTGRES_FIXTURE_REMOVED");
        }
        for (const cleanup of cleanups) await cleanup(); localRemoved = true;
      } catch { passed = false; }
    }
    pendingIO ||= inFlight.size > 0 || streams.size > 0;
    if (!localRemoved) log(`PUBLICATION_STORAGE_CHECK CLEANUP_PENDING ${h.root}`);
  }
  const result = { passed: passed && objectsRemoved && localRemoved && !pendingIO && (!database || databaseRemoved), mode: target.mode, remoteObjectsRemoved: target.mode === "replit" && objectsRemoved,
    localFixtureRemoved: localRemoved, pendingIO, applicationDatabaseUsed: !!database && target.mode === "replit", externalAIUsed: false, publicListener: false,
    ...(database ? { database: "postgres" as const, databaseFixtureRemoved: databaseRemoved } : {}) };
  log(`PUBLICATION_STORAGE_CHECK ${result.passed ? "PASS" : "FAIL"} ${JSON.stringify(result)}`);
  if (localFailure) throw localFailure; // Local fixture assertions are useful; never expose remote SDK errors.
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Keep retained manifests on a stalled SDK operation; never call it cleaned.
  const watchdog = setTimeout(() => { console.error("PUBLICATION_STORAGE_CHECK INCOMPLETE_PROCESS_DEADLINE"); process.exit(1); }, 240_000);
  watchdog.unref();
  try { if (!(await runPublicationStorageCheck(process.argv.slice(2), process.env)).passed) process.exitCode = 1; }
  catch { console.error("PUBLICATION_STORAGE_CHECK REFUSED"); process.exitCode = 2; }
}
