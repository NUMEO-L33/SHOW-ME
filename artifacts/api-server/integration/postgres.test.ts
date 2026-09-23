import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as processorSchema from "../src/processor/db/schema.js";
import { ANALYSIS_CONSENT_VERSION, analysisBatches, analysisManifest, initialDraft } from "../src/processor/analysis-contract.js";
import { type AnalysisFundingCommand, type AnalysisFundingPolicy } from "../src/processor/analysis-funding.js";
import { runDatabaseMigrations, verifyDatabaseMigrations } from "../src/processor/database-migrations.js";
import { loadConfig } from "../src/processor/config.js";
import { analysisBootstrapSettings, configuredAnalysisFactory, verifyAnalysisRuntimeRole } from "../src/processor/analysis-bootstrap.js";
import { createRuntimeRole } from "../src/processor/runtime-role-setup.js";
import { createOperatorRole, verifyOperatorRole } from "../src/processor/operator-role-setup.js";
import { PostgresGuideRepository, type ProcessorDatabase } from "../src/processor/repository.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "../src/processor/gemini/request.js";
import { fakeOutput } from "../tests/helpers/analysis-fixtures.js";
import { PostgresAnalysisQuotaStore } from "../src/processor/analysis-quota-store.js";
import { assertQuotaPermit, quotaRequestKey, type AnalysisQuotaCharge } from "../src/processor/analysis-quota-charge.js";
import { countBindingHash, type AnalysisCountCommand } from "../src/processor/analysis-count-accounting.js";
import type { AnalysisAdmissionReadiness, AnalysisAdmissionSnapshot } from "../src/processor/analysis-admission.js";
import { DurableAnalysisDispatcher } from "../src/processor/analysis-dispatcher.js";
import { AccountedGeminiMeasurements } from "../src/processor/gemini/counted-measurements.js";
import { GeminiAnalysisProvider } from "../src/processor/gemini/provider.js";
import { auditGeminiInput } from "../src/processor/gemini/input-bound.js";
import { inputBoundFixture } from "../tests/helpers/input-bound-fixture.js";
import { SYNTHETIC_COUNT_LIMITS } from "../src/processor/gemini/count-policy.js";
import { operationsBasisFixture, operationsReviewFixture } from "../tests/helpers/operations-review-fixture.js";
import { PostgresAnalysisOperationsStore, operationsActorRef } from "../src/processor/analysis-operations-store.js";
import { OperationsReviewEvidenceSource } from "../src/processor/analysis-operations-source.js";
import { PostgresAnalysisDatabaseProbe, AnalysisDatabaseProbeError } from "../src/processor/analysis-database-probe.js";
import { createFixedSyntheticAnalysisRuntime, attachFixedSyntheticAnalysisRuntime, syntheticStorageRef } from "../src/processor/analysis-synthetic-runtime.js";
import { bindAnalysisActivation } from "../src/processor/repository.js";
import { runAnalysisOperationsAdmin } from "../src/processor/analysis-operations-admin.js";
import { createAnalysisLifecycle } from "../src/processor/analysis-lifecycle.js";
import { LocalStorage, ReplitObjectStorage } from "../src/processor/storage.js";
import { type SyntheticInputGrant } from "../src/processor/analysis-synthetic-input.js";
import { syntheticAnalysisInput } from "../src/processor/gemini/synthetic.js";
import { attemptFrameObjectKey, DELETION_PENDING, finalizeGuideDeletion } from "../src/processor/asset-lifecycle.js";
import { testMediaPaths } from "../tests/helpers/media-binaries.js";
import { Readable } from "node:stream";
import { privacyAfterEdit, privacyReviewState } from "../src/processor/privacy-review.js";
import type { PrivacyCommand } from "../src/processor/privacy-review-schema.js";
import { reviewedAssetFixture } from "../tests/helpers/privacy-assets-fixture.js";
import { privacyAssetDigest, privacyAssetKeys } from "../src/processor/privacy-assets.js";
import { PUBLICATION_LEASE_MS, type PublicationRequest } from "../src/processor/publication-jobs.js";
import { publicationPreparationFixture } from "../tests/helpers/publication-preparation-fixture.js";
import { preparePublicationAssets, cleanupPublicationPreparation } from "../src/processor/publication-preparation.js";
import { privateAssetWriterBusy } from "../src/processor/privacy-asset-session.js";
import { PublicationRecoveryWorker } from "../src/processor/publication-recovery.js";
import { PUBLICATION_LIFETIME_MS } from "../src/processor/publication-commit.js";
import request from "supertest";
import { createProcessorApp } from "../src/processor/server.js";
import { DurablePublicationRuntime } from "../src/processor/publication-runtime.js";
import { cleanupExpiredPrivateMedia, PRIVATE_MEDIA_EXPIRED, PRIVATE_RETENTION_MS } from "../src/processor/private-retention.js";
import { runPublicationStorageCheck } from "../scripts/check-publication-storage.js";
import { verifyPublicationCheckRemoved } from "../scripts/publication-check-scope.js";

const run = process.env.SHOWME_PG_TEST_RUN;
const rawUrl = process.env.SHOWME_PG_TEST_URL;
if (!run || !/^[a-f0-9]{32}$/.test(run) || !rawUrl) throw new Error("Run only through the isolated Docker verification script.");
const endpoint = new URL(rawUrl);
if (endpoint.protocol !== "postgresql:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== `/showme_b5_${run}` || !endpoint.port) {
  throw new Error("Refusing a non-fixture database target.");
}
const limit = { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicrousd: 1_000_000 };
const policy: AnalysisFundingPolicy = { version: "real-pg-fictional-policy", accountingOnly: true,
  price: { model: GEMINI_TEST_MODEL, version: "fictional", inputMicrousdPerMillionTokens: 100000, outputMicrousdPerMillionTokens: 200000 },
  maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 1, globalLimit: limit, guideLimit: limit };
const identity = { runId: "run", batchIndex: 0, ordinal: 0 as const, dispatchId: "send" };
const known = { status: "known" as const, inputTokens: 100, outputTokens: 20 };

function quotaCommand(index = 1): AnalysisQuotaCharge {
  return { requestKey: index.toString(16).padStart(64, "0"), projectRef: "fictional-project", model: GEMINI_TEST_MODEL,
    inputTokenBound: 1000, notAfter: new Date(Date.now() + 25_000).toISOString(),
    limits: { requestsPerMinute: 3, inputTokensPerMinute: 250_000, requestsPerDay: 100, resetTimeZone: "America/Los_Angeles" } };
}

async function fixture(t: TestContext, migrate = true) {
  const database = `showme_b5_${run}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = new Pool({ connectionString: rawUrl, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10_000 });
  const connection = new URL(endpoint); connection.pathname = `/${database}`;
  await admin.query(`CREATE DATABASE "${database}"`); // Generated identifiers only, never a supplied application DB.
  const pool = new Pool({ connectionString: connection.toString(), max: 25, connectionTimeoutMillis: 5000,
    statement_timeout: 10_000, lock_timeout: 8000, application_name: `showme-b5-${run}` });
  t.after(async () => {
    await pool.end();
    try {
      assert.match(database, new RegExp(`^showme_b5_${run}_[a-f0-9]{8}$`));
      await admin.query(`DROP DATABASE "${database}"`);
    } finally { await admin.end(); }
  });
  if (migrate) await runDatabaseMigrations(connection.toString());
  const repository = PostgresGuideRepository.fromPool(pool);
  const now = () => new Date();
  async function seed(id = "guide", frames = 2, canonicalKeys = false, editToken = "synthetic-test-token") {
    await repository.createGuide({ id, slug: id, editToken, title: "synthetic guide", status: "queued",
      originalObjectKey: canonicalKeys ? `guides/${id}/source.mp4` : `fixture/${id}/source.mp4`, sourceFilename: "fictional.mp4", sourceMimeType: "video/mp4", sourceSizeBytes: 1 });
    await repository.claimProcessingAttempt(id, `media-${id}`); await repository.updateStatus(id, "extracting");
    const guide = await repository.completeProcessingAttempt(id, { attemptId: `media-${id}`, attemptCount: 1,
      steps: Array.from({ length: frames }, (_, i) => ({ id: `${id}-step-${i}`, position: i, shortLabel: "fixture", instruction: "fixture",
        startMs: i * 1000, endMs: (i + 1) * 1000, representativeTimestampMs: i * 1000 + 500,
        representativeFrameKey: canonicalKeys ? attemptFrameObjectKey(id, 1, i + 1, "frame") : `fixture/${id}/${i}.jpg`,
        thumbnailFrameKey: canonicalKeys ? attemptFrameObjectKey(id, 1, i + 1, "thumbnail") : `fixture/${id}/${i}-thumb.jpg`, frameWidth: 640, frameHeight: 360 })) });
    assert.ok(guide);
    const command: AnalysisFundingCommand = { type: "request", runId: identity.runId, baseDraftRevision: 0, consentVersion: ANALYSIS_CONSENT_VERSION,
      provider: "gemini", model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION, expectedInputFingerprint: analysisManifest(guide).fingerprint };
    return { guide, command };
  }
  async function fund(id = "guide", frames = 2, at = now()) {
    const h = await seed(id, frames); assert.ok(await repository.reserveAnalysisRequest(id, h.command, policy, at)); return h;
  }
  async function begin(id = "guide", leaseMs = 30_000) {
    const claim = await repository.claimAnalysisWork(id, { runId: "run", attemptId: randomUUID(), expectedAttemptCount: 0, leaseMs }); assert.ok(claim);
    const owner = { attemptId: claim.run.attemptId!, attemptCount: claim.run.attemptCount };
    assert.ok(await repository.executeAnalysisAccounting(id, { type: "allocate", ...identity, owner }));
    assert.ok(await repository.executeAnalysisAccounting(id, { type: "sending", ...identity, owner }));
    return owner;
  }
  const rows = async (table: string) => {
    assert.ok(["guides", "guide_steps", "guide_drafts", "analysis_runs", "analysis_batches", "analysis_reservations", "analysis_request_attempts", "analysis_budget_windows", "analysis_accounting_controls"].includes(table));
    return (await pool.query(`SELECT * FROM "${table}" ORDER BY 1, 2`)).rows;
  };
  return { pool, repository, seed, fund, begin, rows, connection: connection.toString() };
}

async function waitForFixtureLocks(pool: Pool, count: number) {
  for (let i = 0; i < 250; i++) {
    const row = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'`,
    [`showme-b5-${run}`])).rows[0];
    if (row.n >= count) return;
    await delay(10);
  }
  assert.fail(`Expected ${count} real PostgreSQL fixture lock waiters`);
}

async function publicationFixture(t: TestContext) {
  const h = await fixture(t), { guide } = await h.seed("publication-guide", 1, true);
  const reviewed = await reviewedAssetFixture(h.repository, guide);
  const command: PublicationRequest = { type: "request", id: randomUUID(), expectedDraftRevision: reviewed.request.revision,
    expectedInputFingerprint: reviewed.request.inputFingerprint, expectedReviewFingerprint: reviewed.request.reviewFingerprint,
    originalSharingEnabled: false };
  const execute = (c: Parameters<typeof h.repository.executePublicationCommand>[1], now?: Date) => h.repository.executePublicationCommand(guide.id, c, now);
  return { ...h, ...reviewed, guide, command, execute };
}

async function preparationFixture(t: TestContext, id = "prepared-guide", editToken = "synthetic-test-token") {
  const h = await fixture(t), { guide } = await h.seed(id, 1, true, editToken);
  const root = await mkdtemp(join(tmpdir(), "showme-publication-pg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { ...h, guide, ...await publicationPreparationFixture(h.repository, guide, root) };
}

const commitOwner = (job: Awaited<ReturnType<typeof preparePublicationAssets>>) => ({
  id: job.id, leaseId: job.leaseId!, expectedVersion: job.version,
});

for (const failRender of [false, true]) test(`real PostgreSQL: isolated publication storage acceptance and cleanup preserve a different guide (render failure=${failRender})`, async t => {
  const h = await fixture(t), { guide } = await h.seed(randomUUID(), 1, true), logs: string[] = [];
  const reviewed = await reviewedAssetFixture(h.repository, guide);
  const job = (await h.repository.executePublicationCommand(guide.id, { type: "request", id: randomUUID(),
    expectedDraftRevision: reviewed.request.revision, expectedInputFingerprint: reviewed.request.inputFingerprint,
    expectedReviewFingerprint: reviewed.request.reviewFingerprint, originalSharingEnabled: false }))!;
  const before = await h.repository.getGuideById(guide.id);
  const execute = () => runPublicationStorageCheck(["--local-synthetic"], { NODE_ENV: "test",
    SHOWME_TEST_FFMPEG_PATH: process.env.SHOWME_TEST_FFMPEG_PATH, SHOWME_TEST_FFPROBE_PATH: process.env.SHOWME_TEST_FFPROBE_PATH,
    ...(failRender ? { FFMPEG_PATH: "showme-nonexistent-decoder" } : {}) }, line => logs.push(line),
    { repository: PostgresGuideRepository.fromPool(h.pool), verifyRemoved: id => verifyPublicationCheckRemoved(h.pool, id),
      seedTransaction: work => h.repository.database.transaction(tx => work(new PostgresGuideRepository(tx as unknown as ProcessorDatabase))) });
  if (failRender) await assert.rejects(execute());
  else { const result = await execute(); assert.equal(result.passed, true); assert.equal(result.databaseFixtureRemoved, true); }
  assert.ok(logs.includes("PUBLICATION_STORAGE_CHECK POSTGRES_FIXTURE_REMOVED"), logs.join("\n"));
  assert.equal(logs.some(line => line.includes("CLEANUP_PENDING")), false);
  assert.deepEqual(await h.repository.getGuideById(guide.id), before);
  assert.deepEqual(await h.repository.getPublicationJob(guide.id, job.id), job);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM guides")).rows[0].n, 1);
  assert.deepEqual(await h.repository.listPublicationRecovery({ kind: "queued", guideId: randomUUID(), limit: 1 }), []);
  assert.deepEqual(await h.repository.listPublicationRecovery({ kind: "queued", guideId: guide.id, limit: 1 }),
    [{ guideId: guide.id, id: job.id, version: job.version, batchId: job.batchId }]);
});

test("real PostgreSQL: owner publication HTTP and public PNG authority survive reconnect and revoke before physical deletion", async t => {
  const token = "a".repeat(43), h = await preparationFixture(t, randomUUID(), token), auth = `Bearer ${token}`, url = `/api/guides/${h.guide.id}`;
  const reopened = PostgresGuideRepository.fromPool(h.pool);
  const app = createProcessorApp({ config: loadConfig({ NODE_ENV: "test", SHOWME_STORAGE: "local", DATA_DIR: h.storage.root }),
    repository: reopened, storage: h.storage, pipeline: { async process() { assert.fail(); }, async processClaimed() { assert.fail(); } } });
  const before = await reopened.getGuideById(h.guide.id);
  await request(app).get(`${url}/publications`).expect(404);
  const queued = await request(app).get(`${url}/publications/${h.job.id}`).set("Authorization", auth).expect(200);
  assert.equal(queued.body.publication.pendingJobId, h.job.id); assert.equal(queued.body.publication.publicPath, null);
  assert.deepEqual(await reopened.getGuideById(h.guide.id), before);
  await request(app).post(`${url}/publish`).set("Authorization", auth).send({ publicationId: h.job.id, baseDraftRevision: h.request.revision,
    inputFingerprint: h.request.inputFingerprint, reviewFingerprint: h.request.reviewFingerprint, publicSharing: true, originalSharingEnabled: false }).expect(202);
  const ready = await preparePublicationAssets(h.options), p = (await h.repository.commitPublication(h.guide.id, commitOwner(ready)))!;
  const owner = await request(app).get(`${url}/publications`).set("Authorization", auth).expect(200);
  assert.equal(owner.body.publication.headVersion, 1); assert.equal(owner.body.publication.publicPath, `/g/${p.head.publicSlug}`);
  const publicUrl = `/api/public/guides/${p.head.publicSlug}`, view = await request(app).get(publicUrl).expect(200);
  assert.ok(!view.text.includes(h.guide.id)); assert.ok(!view.text.includes(h.guide.originalObjectKey));
  const image = view.body.guide.steps[0].frameUrl;
  await request(app).get(image).expect(200).expect("Content-Type", /image\/png/).expect("Cache-Control", "no-store");
  await request(app).post(`${url}/unpublish`).set("Authorization", auth).send({ expectedHeadVersion: 1, expectedJobId: null }).expect(200);
  await request(app).get(publicUrl).expect(404); await request(app).get(image).expect(404);
  const retained = await h.storage.openRead(p.publication.images[0].frame.key); retained.destroy();
  assert.equal((await reopened.getPublicationOwnerStatus(h.guide.id))!.active, false);
  assert.deepEqual(await reopened.getGuideById(h.guide.id), before);
});
async function nextPreparedPublication(h: Awaited<ReturnType<typeof preparationFixture>>) {
  const job = (await h.repository.executePublicationCommand(h.guide.id, { type: "request", id: randomUUID(),
    expectedDraftRevision: h.request.revision, expectedInputFingerprint: h.request.inputFingerprint,
    expectedReviewFingerprint: h.request.reviewFingerprint, originalSharingEnabled: false }))!;
  return preparePublicationAssets({ ...h.options, jobId: job.id, expectedVersion: job.version, render: h.fastRender });
}

test("real PostgreSQL: restarted publication executors discover queued work and commit one actual processed snapshot", async t => {
  const h = await preparationFixture(t, randomUUID(), "a".repeat(43)), before = await h.repository.getGuideById(h.guide.id);
  const config = { ...loadConfig({ NODE_ENV: "test", SHOWME_STORAGE: "local", DATA_DIR: h.options.workDir }), ...testMediaPaths() };
  const reopened = PostgresGuideRepository.fromPool(h.pool), make = () => new DurablePublicationRuntime({ repository: reopened, storage: h.storage, config });
  const first = await reopened.listPublicationRecovery({ kind: "queued", limit: 1 });
  assert.deepEqual(first, [{ guideId: h.guide.id, id: h.job.id, version: 1, batchId: h.job.batchId }]);
  assert.deepEqual(await reopened.listPublicationRecovery({ kind: "queued", after: first[0].batchId }), []);
  const a = make(), b = make(), put = t.mock.method(h.storage, "putFile", h.storage.putFile.bind(h.storage));
  await Promise.all([a.tick(), b.tick()]);
  const state = (await PostgresGuideRepository.fromPool(h.pool).getPublicationState(h.guide.id))!;
  assert.equal(state.publications.length, 1); assert.equal(state.head!.version, 1); assert.equal(put.mock.callCount(), 2);
  assert.ok(await reopened.getAccessiblePublication({ slug: state.head!.publicSlug }));
  assert.deepEqual(await reopened.listPublicationRecovery({ kind: "queued" }), []);
  assert.deepEqual(await reopened.getGuideById(h.guide.id), before);
  assert.deepEqual(await a.stop(), { pendingIO: false }); await b.stop();
});

test("real PostgreSQL: executor commit failure rolls back the replacement, retains the current link and cleans failed output", async t => {
  const h = await preparationFixture(t), ready = await preparePublicationAssets({ ...h.options, render: h.fastRender });
  const first = (await h.repository.commitPublication(h.guide.id, commitOwner(ready)))!;
  const job = (await h.repository.executePublicationCommand(h.guide.id, { type: "request", id: randomUUID(),
    expectedDraftRevision: h.request.revision, expectedInputFingerprint: h.request.inputFingerprint,
    expectedReviewFingerprint: h.request.reviewFingerprint, originalSharingEnabled: false }))!;
  await h.pool.query("CREATE FUNCTION reject_publication_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END $$");
  await h.pool.query("CREATE TRIGGER reject_publication_insert BEFORE INSERT ON guide_publications FOR EACH ROW EXECUTE FUNCTION reject_publication_insert()");
  const runtime = new DurablePublicationRuntime({ repository: PostgresGuideRepository.fromPool(h.pool), storage: h.storage,
    config: { ...loadConfig({ NODE_ENV: "test", SHOWME_STORAGE: "local", DATA_DIR: h.options.workDir }), ...testMediaPaths() } }, { render: h.fastRender });
  assert.equal((await runtime.tick()).published, 0);
  assert.deepEqual((await h.repository.getPublicationState(h.guide.id))!.head, first.head);
  assert.equal((await h.repository.getPublicationJob(h.guide.id, job.id))!.status, "failed");
  assert.ok(await h.repository.getAccessiblePublication({ slug: first.head.publicSlug }));
  assert.deepEqual((await h.repository.listPrivacyAssetBatches(h.guide.id)).map(a => a.id), [first.publication.batchId]);
  await runtime.stop();
});

async function retainedFixture(t: TestContext) {
  const h = await preparationFixture(t), ready = await preparePublicationAssets({ ...h.options, render: h.fastRender });
  const published = (await h.repository.commitPublication(h.guide.id, commitOwner(ready)))!;
  const guide = (await h.repository.getGuideById(h.guide.id))!;
  const command = { expectedUpdatedAt: guide.updatedAt, updatedBefore: guide.updatedAt };
  const at = new Date(Date.parse(guide.updatedAt) + PRIVATE_RETENTION_MS);
  const expire = () => h.repository.expirePrivateDraft(guide.id, command, at);
  return { ...h, guide, ready, published, command, at, expire };
}

test("real PostgreSQL: private expiry preserves the fifteen-day snapshot, purges private analysis, and retries raw cleanup after reconnect", async t => {
  const h = await retainedFixture(t);
  assert.ok(await h.repository.reserveAnalysisRequest(h.guide.id, { type: "request", runId: "private-run",
    baseDraftRevision: h.state.draft!.revision, consentVersion: ANALYSIS_CONSENT_VERSION, provider: "gemini", model: GEMINI_TEST_MODEL,
    promptVersion: GEMINI_PROMPT_VERSION, expectedInputFingerprint: h.manifest.fingerprint }, policy));
  const beforeAccounting = await h.rows("analysis_budget_windows");
  const expired = (await h.expire())!; assert.equal(expired.errorCode, PRIVATE_MEDIA_EXPIRED); assert.equal(expired.updatedAt, h.guide.updatedAt);
  assert.deepEqual((await h.repository.getGuideById(h.guide.id))!.steps, []);
  const state = (await h.repository.getAnalysisState(h.guide.id))!; assert.equal(state.draft, null); assert.deepEqual(state.runs, []);
  assert.equal((await h.rows("analysis_reservations"))[0].details, null);
  assert.deepEqual(await h.rows("analysis_budget_windows"), beforeAccounting);
  const row = (await h.repository.getPrivateCleanup(h.guide.id))!; assert.ok(row.keys.includes(h.guide.originalObjectKey));
  await assert.rejects(h.pool.query("DELETE FROM guides WHERE id=$1", [h.guide.id]), (e: unknown) => (e as { code: string }).code === "23503");
  t.mock.method(h.storage, "delete", async () => { throw new Error("synthetic delete failure"); });
  await assert.rejects(cleanupExpiredPrivateMedia(h.repository, h.storage, h.guide.id)); t.mock.restoreAll();
  const reopened = PostgresGuideRepository.fromPool(h.pool);
  assert.deepEqual(await reopened.getPrivateCleanup(h.guide.id), row);
  assert.equal(await reopened.completePrivateCleanup(h.guide.id, randomUUID()), false);
  assert.equal(await cleanupExpiredPrivateMedia(reopened, h.storage, h.guide.id), true);
  assert.equal(await reopened.getPrivateCleanup(h.guide.id), null);
  await assert.rejects(h.storage.openRead(h.guide.steps[0].representativeFrameKey!));
  const stream = await h.storage.openRead(h.published.publication.images[0].frame.key); stream.destroy();
  assert.ok(await reopened.getAccessiblePublication({ slug: h.published.head.publicSlug }, h.at));
  const expiry = new Date(h.published.head.expiresAt);
  assert.equal(await reopened.getAccessiblePublication({ slug: h.published.head.publicSlug }, expiry), null);
  assert.deepEqual(await reopened.listExpiredRetainedGuides(1, h.at), []);
  assert.equal((await reopened.listExpiredRetainedGuides(1, expiry)).length, 1);
  assert.ok(await reopened.expirePrivateDraft(h.guide.id, h.command, expiry));
  assert.equal(await finalizeGuideDeletion(reopened, h.storage, h.guide.id, 1), true);
  assert.equal(await reopened.getGuideById(h.guide.id), null);
});

test("real PostgreSQL: every private expiry write is acknowledged or the complete transaction rolls back", async t => {
  const h = await retainedFixture(t), pending = await nextPreparedPublication(h);
  assert.ok(await h.repository.reserveAnalysisRequest(h.guide.id, { type: "request", runId: "private-run",
    baseDraftRevision: h.state.draft!.revision, consentVersion: ANALYSIS_CONSENT_VERSION, provider: "gemini", model: GEMINI_TEST_MODEL,
    promptVersion: GEMINI_PROMPT_VERSION, expectedInputFingerprint: h.manifest.fingerprint }, policy));
  const tables = ["guides", "guide_steps", "guide_drafts", "analysis_runs", "analysis_reservations", "publication_jobs", "guide_assets", "private_media_cleanup"];
  const snapshot = async () => Promise.all(tables.map(async name => (await h.pool.query(`SELECT to_jsonb(t) AS value FROM "${name}" t ORDER BY to_jsonb(t)::text`)).rows));
  const before = await snapshot();
  for (const mode of ["exception", "skip"] as const) {
    await h.pool.query(`CREATE FUNCTION reject_private_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${mode === "exception" ? "RAISE EXCEPTION 'synthetic failure';" : "RETURN NULL;"} END $$`);
    for (const table of tables) {
      const event = table === "private_media_cleanup" ? "INSERT" : ["guide_steps", "guide_drafts", "analysis_runs"].includes(table) ? "DELETE" : "UPDATE";
      await h.pool.query(`CREATE TRIGGER reject_private_expiry BEFORE ${event} ON "${table}" FOR EACH ROW EXECUTE FUNCTION reject_private_expiry()`);
      await assert.rejects(h.expire(), table); assert.deepEqual(await snapshot(), before, table);
      await h.pool.query(`DROP TRIGGER reject_private_expiry ON "${table}"`);
    }
    await h.pool.query("DROP FUNCTION reject_private_expiry()");
  }
  assert.ok(await h.expire());
  const cancelled = (await h.repository.getPublicationJob(h.guide.id, pending.id))!;
  assert.equal(cancelled.status, "cancelled"); assert.notDeepEqual(cancelled.content, pending.content);
  assert.equal(await h.repository.commitPublication(h.guide.id, commitOwner(pending), h.at), null);
  assert.equal(await cleanupExpiredPrivateMedia(h.repository, h.storage, h.guide.id), true);
  assert.deepEqual((await h.repository.listPrivacyAssetBatches(h.guide.id)).map(b => b.id), [h.ready.batchId]);
});

for (const first of ["save", "expiry"] as const)
test(`real PostgreSQL: ${first} obtains the private/public retention parent lock first`, async t => {
  const h = await retainedFixture(t), blocker = await h.pool.connect();
  await blocker.query("BEGIN"); await blocker.query("SELECT id FROM guides WHERE id=$1 FOR UPDATE", [h.guide.id]);
  const document = { ...h.state.draft!.document, title: "fresh synthetic private title" };
  document.privacy = privacyAfterEdit(h.state.draft!.document, document);
  const save = () => h.repository.executeAnalysisCommand(h.guide.id, { type: "save-editor-draft", expectedRevision: h.state.draft!.revision,
    expectedInputFingerprint: h.manifest.fingerprint, document });
  let earlier: ReturnType<typeof save> | ReturnType<typeof h.expire>, later: typeof earlier;
  try {
    earlier = first === "save" ? save() : h.expire(); await waitForFixtureLocks(h.pool, 1);
    later = first === "save" ? h.expire() : save(); await waitForFixtureLocks(h.pool, 2);
  } finally { await blocker.query("COMMIT"); blocker.release(); }
  assert.ok(await earlier!); assert.equal(await later!, null);
  assert.equal((await h.repository.getGuideById(h.guide.id))!.status, first === "save" ? "ready" : "failed");
  assert.ok(await h.repository.getAccessiblePublication({ slug: h.published.head.publicSlug }, h.at));
});

test("real PostgreSQL: unknown replacement writers retain evidence but cannot block withdrawal after private expiry", async t => {
  const h = await retainedFixture(t), job = (await h.repository.executePublicationCommand(h.guide.id, { type: "request", id: randomUUID(),
    expectedDraftRevision: h.request.revision, expectedInputFingerprint: h.request.inputFingerprint,
    expectedReviewFingerprint: h.request.reviewFingerprint, originalSharingEnabled: false }))!;
  const leaseId = randomUUID(); await h.repository.executePublicationCommand(h.guide.id, { type: "claim", id: job.id, expectedVersion: 1, leaseId });
  await h.expire(); assert.equal(await cleanupExpiredPrivateMedia(h.repository, h.storage, h.guide.id), false);
  const batch = (await h.repository.listPrivacyAssetBatches(h.guide.id)).find(b => b.id === job.batchId)!;
  assert.equal(batch.writerSettled, false);
  assert.equal(await h.repository.updateStatus(h.guide.id, "ready", { errorCode: null }), null);
  assert.equal(await h.repository.claimProcessingAttempt(h.guide.id, "late", { expectedStatuses: ["failed"] }), null);
  await assert.rejects(h.repository.replaceSteps(h.guide.id, h.guide.steps));
  assert.equal(await h.repository.executeAnalysisCommand(h.guide.id, { type: "initialize" }), null);
  assert.ok(await h.repository.stopPublication(h.guide.id, { type: "withdraw", expectedHeadVersion: 1, expectedJobId: null }, h.at));
  assert.equal(await h.repository.getAccessiblePublication({ slug: h.published.head.publicSlug }, h.at), null);
  assert.ok(await h.repository.expirePrivateDraft(h.guide.id, h.command, h.at));
  assert.equal(await finalizeGuideDeletion(h.repository, h.storage, h.guide.id, 1), false);
  assert.ok(await h.repository.executePrivacyAssetCommand(h.guide.id, { type: "settle", id: batch.id, writerId: leaseId, receipts: null }));
  assert.equal(await finalizeGuideDeletion(h.repository, h.storage, h.guide.id, 1), true);
});

test("real PostgreSQL: real image preparation commits immutable snapshots with a protected active head and fixed lifetime", async t => {
  const h = await preparationFixture(t), ready = await preparePublicationAssets(h.options);
  const first = (await h.repository.commitPublication(h.guide.id, commitOwner(ready)))!;
  const reopened = PostgresGuideRepository.fromPool(h.pool);
  assert.equal(first.active, true); assert.equal(first.replayed, false);
  assert.equal(Date.parse(first.head.expiresAt) - Date.parse(first.head.firstPublishedAt), PUBLICATION_LIFETIME_MS);
  assert.notEqual(first.head.publicSlug, h.guide.slug);
  assert.deepEqual(await reopened.getPublicationState(h.guide.id), { head: first.head, publications: [first.publication] });
  assert.equal(await reopened.executePrivacyAssetCommand(h.guide.id, { type: "cancel", id: ready.batchId }), null);
  await assert.rejects(h.pool.query("UPDATE guide_publications SET payload=payload WHERE guide_id=$1", [h.guide.id]), /immutable/);
  await assert.rejects(h.pool.query("UPDATE publication_heads SET first_published_at=first_published_at+interval '1 hour', expires_at=expires_at+interval '1 hour' WHERE guide_id=$1", [h.guide.id]), /immutable/);
  await assert.rejects(h.pool.query("UPDATE publication_heads SET active_publication_id=$2 WHERE guide_id=$1", [h.guide.id, randomUUID()]),
    (e: unknown) => (e as { code: string }).code === "23503");
  const next = await nextPreparedPublication(h), second = (await reopened.commitPublication(h.guide.id, commitOwner(next)))!;
  assert.equal(second.head.publicSlug, first.head.publicSlug); assert.equal(second.head.expiresAt, first.head.expiresAt);
  assert.equal((await reopened.getPublicationState(h.guide.id))!.publications.length, 2);
  const worker = new PublicationRecoveryWorker({ repository: reopened, storage: h.storage });
  assert.equal((await worker.tick()).cleaned, 1);
  assert.deepEqual((await reopened.listPrivacyAssetBatches(h.guide.id)).map(a => a.id), [next.batchId]);
  assert.deepEqual(await reopened.getAnalysisState(h.guide.id), h.state);
  const replay = (await reopened.commitPublication(h.guide.id, commitOwner(ready)))!;
  assert.equal(replay.replayed, true); assert.equal(replay.active, false); assert.deepEqual(replay.publication, first.publication);
});

test("real PostgreSQL: exceptions or skipped writes at every commit boundary preserve the entire old publication", async t => {
  const h = await preparationFixture(t), ready = await preparePublicationAssets({ ...h.options, render: h.fastRender });
  await h.repository.commitPublication(h.guide.id, commitOwner(ready));
  const next = await nextPreparedPublication(h), before = await h.repository.getPublicationState(h.guide.id);
  const assets = await h.repository.listPrivacyAssetBatches(h.guide.id);
  await h.pool.query("CREATE FUNCTION reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$");
  await h.pool.query("CREATE FUNCTION skip_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
  for (const action of ["reject_commit", "skip_commit"]) for (const [table, event] of [
    ["guide_assets", "UPDATE"], ["guide_publications", "INSERT"], ["publication_jobs", "UPDATE"], ["publication_heads", "UPDATE"],
  ]) {
    await h.pool.query(`CREATE TRIGGER guard_commit BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${action}()`);
    await assert.rejects(h.repository.commitPublication(h.guide.id, commitOwner(next)));
    assert.deepEqual(await PostgresGuideRepository.fromPool(h.pool).getPublicationState(h.guide.id), before);
    const after = await h.repository.listPrivacyAssetBatches(h.guide.id);
    assert.deepEqual(after.sort((a, b) => a.id.localeCompare(b.id)), [...assets].sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepEqual(await h.repository.getPublicationJob(h.guide.id, next.id), next);
    await h.pool.query(`DROP TRIGGER guard_commit ON ${table}`);
  }
  assert.equal((await h.repository.commitPublication(h.guide.id, commitOwner(next)))!.active, true);
});

test("real PostgreSQL: concurrent commits acknowledge one snapshot and take the first-publication clock after lock wait", async t => {
  const h = await preparationFixture(t), ready = await preparePublicationAssets({ ...h.options, render: h.fastRender });
  const blocker = await h.pool.connect();
  let first;
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM guides WHERE id=$1 FOR UPDATE", [h.guide.id]);
    const pending = h.repository.commitPublication(h.guide.id, commitOwner(ready));
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await waitForFixtureLocks(h.pool, 1);
    const releasedAt = (await blocker.query("SELECT clock_timestamp() AS at")).rows[0].at as Date;
    await blocker.query("COMMIT"); const result = await outcome; if ("error" in result) throw result.error;
    first = result.value; assert.ok(first); assert.ok(Date.parse(first.head.firstPublishedAt) >= releasedAt.getTime());
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  const results = await Promise.all(Array.from({ length: 12 }, () => PostgresGuideRepository.fromPool(h.pool).commitPublication(h.guide.id, commitOwner(ready))));
  assert.ok(results.every(r => r?.replayed && r.head.version === 1 && r.publication.id === first!.publication.id));
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM guide_publications")).rows[0].n, 1);
});

test("real PostgreSQL: whole deletion fences a prepared replacement and cascades head/history only after image cleanup", async t => {
  const h = await preparationFixture(t), ready = await preparePublicationAssets({ ...h.options, render: h.fastRender });
  await h.repository.commitPublication(h.guide.id, commitOwner(ready)); const next = await nextPreparedPublication(h);
  assert.equal(await h.repository.deleteGuide(h.guide.id), false);
  await h.repository.updateStatus(h.guide.id, "failed", { errorCode: DELETION_PENDING });
  assert.equal(await h.repository.commitPublication(h.guide.id, commitOwner(next)), null);
  assert.equal(await finalizeGuideDeletion(h.repository, h.storage, h.guide.id, 1), true);
  assert.equal(await h.repository.getPublicationState(h.guide.id), null);
  assert.equal(await h.repository.commitPublication(h.guide.id, commitOwner(ready)), null);
  for (const table of ["publication_heads", "guide_publications", "publication_jobs"])
    assert.equal((await h.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
});

test("real PostgreSQL: withdrawal persists before cleanup and a fresh republish never extends or revives old image authority", async t => {
  const h = await preparationFixture(t), ready = await preparePublicationAssets(h.options);
  const first = (await h.repository.commitPublication(h.guide.id, commitOwner(ready)))!;
  const query = { slug: first.head.publicSlug, publicationId: first.publication.id };
  const stop = { type: "withdraw" as const, expectedHeadVersion: 1, expectedJobId: null };
  assert.ok(await h.repository.getAccessiblePublication(query));
  assert.equal((await h.repository.stopPublication(h.guide.id, stop))!.head!.activePublicationId, null);
  const reopened = PostgresGuideRepository.fromPool(h.pool);
  assert.equal(await reopened.getAccessiblePublication(query), null);
  const image = await h.storage.openRead(first.publication.images[0].frame.key); image.destroy();
  assert.equal((await new PublicationRecoveryWorker({ repository: reopened, storage: h.storage }).tick()).cleaned, 1);
  await assert.rejects(h.storage.openRead(first.publication.images[0].frame.key));
  const next = await nextPreparedPublication(h), second = (await reopened.commitPublication(h.guide.id, commitOwner(next)))!;
  assert.equal(second.head.expiresAt, first.head.expiresAt); assert.equal(second.head.publicSlug, first.head.publicSlug);
  assert.equal(await reopened.stopPublication(h.guide.id, stop), null);
  assert.equal(await reopened.getAccessiblePublication(query), null);
  assert.ok(await reopened.getAccessiblePublication({ slug: query.slug, publicationId: next.id }));
  assert.equal((await reopened.commitPublication(h.guide.id, commitOwner(ready)))!.active, false);
  assert.deepEqual(await reopened.getAnalysisState(h.guide.id), h.state);
});

test("real PostgreSQL: all withdrawal writes roll back together on exceptions and silently skipped updates", async t => {
  const h = await preparationFixture(t), ready = await preparePublicationAssets({ ...h.options, render: h.fastRender });
  await h.repository.commitPublication(h.guide.id, commitOwner(ready)); const next = await nextPreparedPublication(h);
  const command = { type: "withdraw" as const, expectedHeadVersion: 1, expectedJobId: next.id };
  const before = await h.repository.getPublicationState(h.guide.id), assets = await h.repository.listPrivacyAssetBatches(h.guide.id);
  await h.pool.query("CREATE FUNCTION reject_stop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$");
  await h.pool.query("CREATE FUNCTION skip_stop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
  for (const action of ["reject_stop", "skip_stop"]) for (const table of ["publication_heads", "publication_jobs", "guide_assets"]) {
    await h.pool.query(`CREATE TRIGGER guard_stop BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${action}()`);
    await assert.rejects(h.repository.stopPublication(h.guide.id, command));
    assert.deepEqual(await PostgresGuideRepository.fromPool(h.pool).getPublicationState(h.guide.id), before);
    assert.deepEqual(await h.repository.getPublicationJob(h.guide.id, next.id), next);
    assert.deepEqual((await h.repository.listPrivacyAssetBatches(h.guide.id)).sort((a, b) => a.id.localeCompare(b.id)),
      [...assets].sort((a, b) => a.id.localeCompare(b.id)));
    await h.pool.query(`DROP TRIGGER guard_stop ON ${table}`);
  }
  assert.equal((await h.repository.stopPublication(h.guide.id, command))!.changed, true);
});

test("real PostgreSQL: withdrawal wins its lock race against a late commit and a pre-lock image lookup", async t => {
  const h = await preparationFixture(t), ready = await preparePublicationAssets({ ...h.options, render: h.fastRender });
  const first = (await h.repository.commitPublication(h.guide.id, commitOwner(ready)))!, next = await nextPreparedPublication(h);
  const blocker = await h.pool.connect(), pending: Promise<unknown>[] = [];
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM guides WHERE id=$1 FOR UPDATE", [h.guide.id]);
    const stopped = h.repository.stopPublication(h.guide.id, { type: "withdraw", expectedHeadVersion: 1, expectedJobId: next.id }); pending.push(stopped);
    await waitForFixtureLocks(h.pool, 1);
    const read = PostgresGuideRepository.fromPool(h.pool).getAccessiblePublication({ slug: first.head.publicSlug }); pending.push(read);
    await waitForFixtureLocks(h.pool, 2);
    const commit = PostgresGuideRepository.fromPool(h.pool).commitPublication(h.guide.id, commitOwner(next)); pending.push(commit);
    await waitForFixtureLocks(h.pool, 3); await blocker.query("COMMIT");
    assert.equal((await stopped)!.changed, true); assert.equal(await read, null); assert.equal(await commit, null);
    assert.equal((await h.repository.getPublicationJob(h.guide.id, next.id))!.status, "cancelled");
  } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled(pending); }
});

test("real PostgreSQL: first-publication withdrawal fences work and expiry of a withdrawn head finds pending work without settling the writer", async t => {
  const h = await preparationFixture(t), original = h.job;
  const command = { type: "withdraw" as const, expectedHeadVersion: 0, expectedJobId: original.id };
  assert.equal((await h.repository.stopPublication(h.guide.id, command))!.head, null);
  assert.equal((await h.repository.stopPublication(h.guide.id, command))!.changed, false);
  const ready = await nextPreparedPublication(h), first = (await h.repository.commitPublication(h.guide.id, commitOwner(ready)))!;
  assert.equal(await h.repository.stopPublication(h.guide.id, command), null);
  await h.repository.stopPublication(h.guide.id, { type: "withdraw", expectedHeadVersion: 1, expectedJobId: null });
  await new PublicationRecoveryWorker({ repository: h.repository, storage: h.storage }).tick();
  const at = new Date(Date.parse(first.head.expiresAt) - 1);
  const job = (await h.repository.executePublicationCommand(h.guide.id, { type: "request", id: randomUUID(),
    expectedDraftRevision: h.request.revision, expectedInputFingerprint: h.request.inputFingerprint,
    expectedReviewFingerprint: h.request.reviewFingerprint, originalSharingEnabled: false }, at))!;
  await h.repository.executePublicationCommand(h.guide.id, { type: "claim", id: job.id, expectedVersion: 1, leaseId: randomUUID() }, at);
  const expiry = new Date(first.head.expiresAt), page = await h.repository.listExpiredPublications({ limit: 1 }, expiry);
  assert.equal(page.length, 1);
  assert.deepEqual(await h.repository.listExpiredPublications({ guideId: h.guide.id, limit: 1 }, expiry), page);
  assert.deepEqual(await h.repository.listExpiredPublications({ guideId: "different", limit: 1 }, expiry), []);
  assert.deepEqual(await h.repository.listExpiredPublications({ after: { expiresAt: page[0].expiresAt, publicSlug: page[0].publicSlug } }, expiry), []);
  const result = await new PublicationRecoveryWorker({ repository: h.repository, storage: h.storage, clock: () => expiry }).tick();
  assert.equal(result.publicationsExpired, 1); assert.equal(result.pending, 1);
  assert.equal((await h.repository.listPrivacyAssetBatches(h.guide.id))[0].writerSettled, false);
  assert.equal(await h.repository.getAccessiblePublication({ slug: first.head.publicSlug }, expiry), null);
});

test("real PostgreSQL: publication access takes a fresh clock after waiting past the expiry boundary", async t => {
  const h = await preparationFixture(t);
  await h.repository.executePublicationCommand(h.guide.id, { type: "cancel", id: h.job.id });
  // Metadata-only clock fixture: actual PNG storage is exercised in other tests.
  const base = new Date(Date.now() - PUBLICATION_LIFETIME_MS + 1000);
  const job = (await h.repository.executePublicationCommand(h.guide.id, { type: "request", id: randomUUID(),
    expectedDraftRevision: h.request.revision, expectedInputFingerprint: h.request.inputFingerprint,
    expectedReviewFingerprint: h.request.reviewFingerprint, originalSharingEnabled: false }, base))!;
  const running = (await h.repository.executePublicationCommand(h.guide.id, { type: "claim", id: job.id, expectedVersion: 1, leaseId: randomUUID() }, base))!;
  const batch = (await h.repository.listPrivacyAssetBatches(h.guide.id)).find(a => a.id === job.batchId)!;
  const ready = (await h.repository.executePublicationCommand(h.guide.id, { type: "complete-assets", ...commitOwner(running),
    receipts: privacyAssetKeys(batch).map(key => ({ key, sha256: "a".repeat(64), size: 100 })) }, base))!;
  const first = (await h.repository.commitPublication(h.guide.id, commitOwner(ready), base))!;
  const blocker = await h.pool.connect(); let pending: Promise<unknown> | undefined;
  let pendingOwner: ReturnType<typeof h.repository.getPublicationOwnerStatus> | undefined;
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM guides WHERE id=$1 FOR UPDATE", [h.guide.id]);
    pending = h.repository.getAccessiblePublication({ slug: first.head.publicSlug });
    pendingOwner = h.repository.getPublicationOwnerStatus(h.guide.id);
    await waitForFixtureLocks(h.pool, 2);
    await blocker.query("SELECT pg_sleep(GREATEST(0, extract(epoch from ($1::timestamptz - clock_timestamp()))) + 0.02)", [first.head.expiresAt]);
    await blocker.query("COMMIT"); assert.equal(await pending, null);
    const ownerStatus = await pendingOwner;
    assert.equal(ownerStatus!.expired, true); assert.equal(ownerStatus!.active, false);
    const result = (await h.repository.stopPublication(h.guide.id, { type: "expire", expectedHeadVersion: 1 }))!;
    assert.equal(result.changed, true); assert.equal(result.head!.activePublicationId, null);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled([pending, pendingOwner]); }
});

test("real PostgreSQL: recovery uses bounded UUID cursors, finds persisted expiry and leaves queued/live/unknown writers intact", async t => {
  const h = await publicationFixture(t), old = new Date(Date.now() - PUBLICATION_LEASE_MS - 1000);
  const expired = (await h.execute(h.command, old))!;
  await h.execute({ type: "claim", id: expired.id, expectedVersion: 1, leaseId: randomUUID() }, old);
  const jobs = [];
  for (const id of ["cleanup-a", "cleanup-b", "queued-c", "live-d"]) {
    const { guide } = await h.seed(id, 1, true), { request } = await reviewedAssetFixture(h.repository, guide);
    const job = (await h.repository.executePublicationCommand(id, { type: "request", id: randomUUID(),
      expectedDraftRevision: request.revision, expectedInputFingerprint: request.inputFingerprint,
      expectedReviewFingerprint: request.reviewFingerprint, originalSharingEnabled: false }))!;
    jobs.push(job);
    if (id.startsWith("cleanup")) await h.repository.executePublicationCommand(id, { type: "cancel", id: job.id });
    if (id.startsWith("live")) await h.repository.executePublicationCommand(id, { type: "claim", id: job.id,
      expectedVersion: 1, leaseId: randomUUID() });
  }
  const reopened = PostgresGuideRepository.fromPool(h.pool);
  const due = await reopened.listPublicationRecovery({ kind: "expired", limit: 1 });
  assert.equal(due.length, 1); assert.equal(due[0].id, expired.id);
  const a = await reopened.listPublicationRecovery({ kind: "cleanup", limit: 1 });
  const b = await reopened.listPublicationRecovery({ kind: "cleanup", limit: 1, after: a[0].batchId });
  assert.equal(a.length, 1); assert.equal(b.length, 1); assert.ok(a[0].batchId < b[0].batchId);
  assert.deepEqual(await reopened.listPublicationRecovery({ kind: "cleanup", after: b[0].batchId }), []);
  assert.deepEqual(Object.keys(a[0]).sort(), ["batchId", "guideId", "id", "version"]);
  const root = await mkdtemp(join(tmpdir(), "showme-recovery-pg-")); t.after(() => rm(root, { recursive: true, force: true }));
  const worker = new PublicationRecoveryWorker({ repository: reopened, storage: new LocalStorage(root) });
  const result = await worker.tick(); assert.equal(result.recovered, 1); assert.equal(result.cleaned, 2); assert.equal(result.pending, 1);
  assert.equal((await reopened.listPrivacyAssetBatches(h.guide.id))[0].writerSettled, false);
  assert.equal(await reopened.deleteGuide(h.guide.id), false);
  assert.equal((await reopened.getPublicationJob("queued-c", jobs[2].id))!.status, "queued");
  assert.equal((await reopened.getPublicationJob("live-d", jobs[3].id))!.phase, "rendering");
  await assert.rejects(reopened.listPublicationRecovery({ kind: "cleanup", limit: 21 }));
});

test("real PostgreSQL: silently skipped asset update/delete never reports cleanup complete and survives reconnection for retry", async t => {
  const h = await preparationFixture(t);
  await h.repository.executePublicationCommand(h.guide.id, { type: "cancel", id: h.job.id });
  await h.pool.query("CREATE FUNCTION skip_asset_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
  const remove = t.mock.method(h.storage, "delete", h.storage.delete.bind(h.storage));
  for (const operation of ["UPDATE", "DELETE"]) {
    await h.pool.query(`CREATE TRIGGER skip_asset_cleanup BEFORE ${operation} ON guide_assets FOR EACH ROW EXECUTE FUNCTION skip_asset_cleanup()`);
    const reopened = PostgresGuideRepository.fromPool(h.pool);
    const worker = new PublicationRecoveryWorker({ repository: reopened, storage: h.storage });
    const result = await worker.tick(); assert.equal(result.failed, 1); assert.equal(result.cleaned, 0);
    assert.equal((await reopened.listPrivacyAssetBatches(h.guide.id)).length, 1);
    if (operation === "UPDATE") assert.equal(remove.mock.callCount(), 0);
    assert.equal(await reopened.deleteGuide(h.guide.id), false);
    await h.pool.query("DROP TRIGGER skip_asset_cleanup ON guide_assets");
  }
  const worker = new PublicationRecoveryWorker({ repository: PostgresGuideRepository.fromPool(h.pool), storage: h.storage });
  assert.equal((await worker.tick()).cleaned, 1);
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guide.id), []);
  assert.deepEqual(await h.repository.getAnalysisState(h.guide.id), h.state);
});

test("real PostgreSQL: independent recovery workers converge on exact cancelled output keys and retain the private guide", async t => {
  const h = await preparationFixture(t); await preparePublicationAssets(h.options);
  const [batch] = await h.repository.listPrivacyAssetBatches(h.guide.id);
  await h.repository.executePublicationCommand(h.guide.id, { type: "cancel", id: h.job.id });
  const workers = Array.from({ length: 2 }, () => new PublicationRecoveryWorker({
    repository: PostgresGuideRepository.fromPool(h.pool), storage: new LocalStorage(h.storage.root) }));
  await Promise.all(workers.map(worker => worker.tick()));
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guide.id), []);
  for (const key of privacyAssetKeys(batch)) await assert.rejects(h.storage.openRead(key));
  assert.equal((await h.repository.getPublicationJob(h.guide.id, h.job.id))!.status, "cancelled");
  assert.deepEqual(await h.repository.getAnalysisState(h.guide.id), h.state);
  const stream = await h.storage.openRead(h.guide.steps[0].representativeFrameKey!); stream.destroy();
});

test("real PostgreSQL: actual redacted PNG preparation reuses its reservation and persists private receipts across connections", async t => {
  const h = await preparationFixture(t), before = await h.repository.getGuideById(h.guide.id);
  const put = t.mock.method(h.storage, "putFile", h.storage.putFile.bind(h.storage));
  const ready = await preparePublicationAssets(h.options), reopened = PostgresGuideRepository.fromPool(h.pool);
  assert.equal(ready.status, "running"); assert.equal(ready.phase, "assets-ready"); assert.equal(ready.batchId, h.job.batchId);
  assert.deepEqual(await reopened.getPublicationJob(h.guide.id, h.job.id), ready);
  const batches = await reopened.listPrivacyAssetBatches(h.guide.id); assert.equal(batches.length, 1);
  const [batch] = batches; assert.equal(batch.status, "ready"); assert.equal(batch.writerSettled, true);
  assert.equal(batch.writerId, ready.leaseId); assert.equal(put.mock.callCount(), 2);
  for (const [i, key] of privacyAssetKeys(batch).entries()) {
    const chunks: Buffer[] = []; for await (const chunk of await h.storage.openRead(key)) chunks.push(chunk);
    const png = Buffer.concat(chunks);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
    assert.equal(png.length, batch.receipts[i].size); assert.equal(privacyAssetDigest(png), batch.receipts[i].sha256);
  }
  assert.deepEqual(await readdir(h.options.workDir), []);
  assert.deepEqual(await reopened.getGuideById(h.guide.id), before);
  assert.deepEqual(await reopened.getAnalysisState(h.guide.id), h.state);
  await assert.rejects(preparePublicationAssets({ ...h.options, repository: reopened }));
  assert.equal(put.mock.callCount(), 2);
});

for (const failure of ["throw", "skip"] as const)
test(`real PostgreSQL: ${failure} on final publication preparation rolls back both ready states and cleans written images`, async t => {
  const h = await preparationFixture(t);
  await h.pool.query(`CREATE FUNCTION reject_preparation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.payload->>'phase'='assets-ready' THEN ${failure === "throw" ? "RAISE EXCEPTION 'fixture';" : "RETURN NULL;"} END IF;
    RETURN NEW; END $$`);
  await h.pool.query("CREATE TRIGGER reject_preparation BEFORE UPDATE ON publication_jobs FOR EACH ROW EXECUTE FUNCTION reject_preparation()");
  const execute = h.repository.executePublicationCommand.bind(h.repository);
  let verifiedRollback = false;
  t.mock.method(h.repository, "executePublicationCommand", async (...args: Parameters<typeof execute>) => {
    try { return await execute(...args); }
    catch (error) {
      if (args[1].type === "complete-assets") {
        const reopened = PostgresGuideRepository.fromPool(h.pool);
        assert.equal((await reopened.getPublicationJob(h.guide.id, h.job.id))!.phase, "rendering");
        const [asset] = await reopened.listPrivacyAssetBatches(h.guide.id);
        assert.equal(asset.status, "writing"); assert.equal(asset.writerSettled, false); assert.deepEqual(asset.receipts, []);
        verifiedRollback = true;
      }
      throw error;
    }
  });
  const keys: string[] = [], put = h.storage.putFile.bind(h.storage);
  t.mock.method(h.storage, "putFile", async (key: string, file: string) => { keys.push(key); await put(key, file); });
  await assert.rejects(preparePublicationAssets({ ...h.options, render: h.fastRender }), /PRIVACY_ASSET_WRITE_UNAVAILABLE/);
  assert.equal(verifiedRollback, true); assert.equal(keys.length, 2);
  assert.equal((await h.repository.getPublicationJob(h.guide.id, h.job.id))!.status, "failed");
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guide.id), []);
  for (const key of keys) await assert.rejects(h.storage.openRead(key));
  assert.deepEqual(await h.repository.getAnalysisState(h.guide.id), h.state);
});

test("real PostgreSQL: cancellation on another connection fences a pending put without falsely finishing cleanup", async t => {
  const h = await preparationFixture(t), reopened = PostgresGuideRepository.fromPool(h.pool);
  let begin!: () => void, release!: () => void;
  const begun = new Promise<void>(r => { begin = r; }), held = new Promise<void>(r => { release = r; });
  const keys: string[] = [], put = h.storage.putFile.bind(h.storage);
  t.mock.method(h.storage, "putFile", async (key: string, file: string) => { keys.push(key); begin(); await held; await put(key, file); });
  const pending = preparePublicationAssets({ ...h.options, render: h.fastRender }), rejected = assert.rejects(pending);
  try {
    await begun;
    await reopened.executePublicationCommand(h.guide.id, { type: "cancel", id: h.job.id });
    await rejected;
    const [asset] = await reopened.listPrivacyAssetBatches(h.guide.id);
    assert.equal(asset.status, "cleanup"); assert.equal(asset.writerSettled, false); assert.equal(privateAssetWriterBusy(), true);
    assert.equal(await cleanupPublicationPreparation(reopened, h.storage, h.guide.id, h.job.id), false);
    assert.equal(await reopened.deleteGuide(h.guide.id), false);
  } finally {
    release();
    for (let i = 0; i < 500 && privateAssetWriterBusy(); i++) await delay(10);
  }
  assert.equal(privateAssetWriterBusy(), false); assert.equal(keys.length, 1);
  for (const key of keys) await assert.rejects(h.storage.openRead(key));
  assert.deepEqual(await reopened.listPrivacyAssetBatches(h.guide.id), []);
  assert.equal((await reopened.getPublicationJob(h.guide.id, h.job.id))!.status, "cancelled");
  assert.equal(await reopened.deleteGuide(h.guide.id), true);
});

test("real PostgreSQL: publication request replay and single writer are durable under independent connections", async t => {
  const h = await publicationFixture(t);
  const before = await h.repository.getGuideById(h.guide.id);
  const replicas = Array.from({ length: 12 }, () => PostgresGuideRepository.fromPool(h.pool));
  const jobs = await Promise.all(replicas.map(r => r.executePublicationCommand(h.guide.id, h.command)));
  const job = jobs[0]!;
  assert.ok(jobs.every(j => j?.batchId === job.batchId));
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM publication_jobs")).rows[0].n, 1);
  assert.equal((await h.repository.listPrivacyAssetBatches(h.guide.id)).length, 1);
  const claims = await Promise.all(replicas.map(r => r.executePublicationCommand(h.guide.id,
    { type: "claim", id: job.id, expectedVersion: job.version, leaseId: randomUUID() })));
  assert.equal(claims.filter(Boolean).length, 1); const running = claims.find(Boolean)!;
  assert.equal((await h.repository.listPrivacyAssetBatches(h.guide.id))[0].writerId, running.leaseId);
  assert.deepEqual(await PostgresGuideRepository.fromPool(h.pool).getPublicationJob(h.guide.id, job.id), running);
  assert.deepEqual(await h.execute(h.command), running);
  assert.deepEqual(await h.repository.getGuideById(h.guide.id), before);
  assert.deepEqual(await h.repository.getAnalysisState(h.guide.id), h.state);
  await assert.rejects(h.execute({ ...h.command, originalSharingEnabled: true }), /PUBLICATION_CONFLICT/);
  await assert.rejects(h.execute({ ...h.command, id: randomUUID() }), /PUBLICATION_CAPACITY/);
  assert.equal(await h.repository.getPublicationJob("other-guide", job.id), null);
});

test("real PostgreSQL: publication and asset writes roll back together on errors and silently skipped writes", async t => {
  const h = await publicationFixture(t);
  await h.pool.query("CREATE FUNCTION reject_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$");
  await h.pool.query("CREATE TRIGGER reject_publication BEFORE INSERT ON publication_jobs FOR EACH ROW EXECUTE FUNCTION reject_publication()");
  await assert.rejects(h.execute(h.command));
  assert.equal(await h.repository.getPublicationJob(h.guide.id, h.command.id), null);
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guide.id), []);
  await h.pool.query("DROP TRIGGER reject_publication ON publication_jobs");
  const job = (await h.execute(h.command))!, [reserved] = await h.repository.listPrivacyAssetBatches(h.guide.id);
  await h.pool.query("CREATE FUNCTION skip_publication_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
  for (const table of ["guide_assets", "publication_jobs"] as const) {
    await h.pool.query(`CREATE TRIGGER skip_publication_write BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION skip_publication_write()`);
    await assert.rejects(h.execute({ type: "claim", id: job.id, expectedVersion: job.version, leaseId: randomUUID() }), /not acknowledged/);
    assert.deepEqual(await h.repository.getPublicationJob(h.guide.id, job.id), job);
    assert.deepEqual(await h.repository.listPrivacyAssetBatches(h.guide.id), [reserved]);
    await h.pool.query(`DROP TRIGGER skip_publication_write ON ${table}`);
  }
});

test("real PostgreSQL: prepared snapshot is private, edit-fenced and cancellation never releases unknown writes", async t => {
  const h = await publicationFixture(t), job = (await h.execute(h.command))!;
  const running = (await h.execute({ type: "claim", id: job.id, expectedVersion: job.version, leaseId: randomUUID() }))!;
  const [batch] = await h.repository.listPrivacyAssetBatches(h.guide.id);
  await h.repository.executePrivacyAssetCommand(h.guide.id, { type: "settle", id: batch.id, writerId: running.leaseId!,
    receipts: privacyAssetKeys(batch).map(key => ({ key, sha256: "a".repeat(64), size: 100 })) });
  const prepared = (await h.execute({ type: "assets-ready", id: job.id, expectedVersion: running.version, leaseId: running.leaseId! }))!;
  assert.equal(prepared.phase, "assets-ready"); assert.equal(prepared.status, "running");
  const document = structuredClone(h.state.draft!.document); document.title = "new private title";
  document.privacy = privacyAfterEdit(h.state.draft!.document, document);
  await h.repository.executeAnalysisCommand(h.guide.id, { type: "save-editor-draft", expectedRevision: h.request.revision,
    expectedInputFingerprint: h.request.inputFingerprint, document });
  const failed = (await h.execute({ type: "assets-ready", id: job.id, expectedVersion: prepared.version, leaseId: running.leaseId! }))!;
  assert.equal(failed.errorCode, "INPUT_CHANGED"); assert.equal(failed.content.title, job.content.title);
  assert.equal((await h.repository.listPrivacyAssetBatches(h.guide.id))[0].status, "cleanup");
  assert.equal(await h.repository.deleteGuide(h.guide.id), false);
  const cleaned = (await h.repository.listPrivacyAssetBatches(h.guide.id))[0];
  await h.repository.executePrivacyAssetCommand(h.guide.id, { type: "cleaned", id: cleaned.id, version: cleaned.version });
  assert.equal(await h.repository.deleteGuide(h.guide.id), true);
  assert.equal(await h.repository.getPublicationJob(h.guide.id, job.id), null);
  assert.equal(await h.execute(h.command), null);
});

test("real PostgreSQL: expired publication discovery survives restart, cancels without replay and preserves unresolved ownership", async t => {
  const h = await publicationFixture(t), at = new Date(Date.now() - PUBLICATION_LEASE_MS - 1000);
  const job = (await h.execute(h.command, at))!;
  const running = (await h.execute({ type: "claim", id: job.id, expectedVersion: job.version, leaseId: randomUUID() }, at))!;
  const reopened = PostgresGuideRepository.fromPool(h.pool);
  assert.deepEqual(await reopened.listPublicationWork(), [{ guideId: h.guide.id, id: job.id, version: running.version }]);
  const failed = (await reopened.executePublicationCommand(h.guide.id, { type: "recover", id: job.id, expectedVersion: running.version }))!;
  assert.equal(failed.errorCode, "LEASE_EXPIRED");
  const [asset] = await reopened.listPrivacyAssetBatches(h.guide.id);
  assert.equal(asset.status, "cleanup"); assert.equal(asset.writerSettled, false);
  assert.equal(await reopened.executePrivacyAssetCommand(h.guide.id, { type: "cleaned", id: asset.id, version: asset.version }), null);
  assert.equal(await reopened.deleteGuide(h.guide.id), false);
  assert.deepEqual(await reopened.listPublicationWork(), []);
  assert.deepEqual(await reopened.executePublicationCommand(h.guide.id, h.command), failed);
  await assert.rejects(h.pool.query("UPDATE publication_jobs SET status='queued' WHERE guide_id=$1", [h.guide.id]),
    (e: unknown) => (e as { code: string }).code === "23514");
});

test("real PostgreSQL: publication lease clock is taken after the parent lock wait", async t => {
  const h = await publicationFixture(t), job = (await h.execute(h.command))!;
  const blocker = await h.pool.connect();
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM guides WHERE id=$1 FOR UPDATE", [h.guide.id]);
    const pending = h.execute({ type: "claim", id: job.id, expectedVersion: job.version, leaseId: randomUUID() });
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await waitForFixtureLocks(h.pool, 1);
    const releasedAt = (await blocker.query("SELECT clock_timestamp() AS at")).rows[0].at as Date;
    await blocker.query("COMMIT");
    const result = await outcome;
    if ("error" in result) throw result.error;
    assert.ok(result.value);
    assert.ok(Date.parse(result.value.updatedAt) >= releasedAt.getTime());
    assert.equal(Date.parse(result.value.leaseExpiresAt!) - Date.parse(result.value.updatedAt), PUBLICATION_LEASE_MS);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
});

test("real PostgreSQL: private asset ownership is bounded, single-writer, persistent and blocks deletion", async t => {
  const h = await fixture(t), { guide } = await h.seed("asset-guide", 1, true);
  const { request } = await reviewedAssetFixture(h.repository, guide);
  const reservations = await Promise.all(Array.from({ length: 12 }, () => h.repository.executePrivacyAssetCommand(guide.id,
    { type: "reserve", id: randomUUID(), ...request })));
  assert.equal(reservations.filter(Boolean).length, 4);
  const batch = reservations.find(Boolean)!;
  const claims = await Promise.all(Array.from({ length: 12 }, () => h.repository.executePrivacyAssetCommand(guide.id,
    { type: "claim", id: batch.id, version: batch.version, writerId: randomUUID() })));
  assert.equal(claims.filter(Boolean).length, 1); const winner = claims.find(Boolean)!;
  const reopened = PostgresGuideRepository.fromPool(h.pool);
  assert.equal((await reopened.listPrivacyAssetBatches(guide.id)).length, 4);
  assert.equal(await reopened.deleteGuide(guide.id), false);
  assert.equal((await reopened.getGuideById(guide.id))!.steps.length, 1);
  const cancelled = await reopened.executePrivacyAssetCommand(guide.id, { type: "cancel", id: batch.id });
  assert.ok(cancelled);
  assert.equal(await reopened.executePrivacyAssetCommand(guide.id, { type: "cleaned", id: batch.id, version: cancelled.version }), null);
  const settled = await reopened.executePrivacyAssetCommand(guide.id, { type: "settle", id: batch.id, writerId: winner.writerId!, receipts: null });
  assert.ok(settled?.writerSettled);
  for (const record of await reopened.listPrivacyAssetBatches(guide.id)) {
    const c = (await reopened.executePrivacyAssetCommand(guide.id, { type: "cancel", id: record.id }))!;
    assert.ok(await reopened.executePrivacyAssetCommand(guide.id, { type: "cleaned", id: record.id, version: c.version }));
  }
  assert.equal(await reopened.deleteGuide(guide.id), true);
  assert.equal(await reopened.executePrivacyAssetCommand(guide.id, { type: "reserve", id: randomUUID(), ...request }), null);
});

test("real PostgreSQL: redaction finalization fences edits and failed ledger writes roll back", async t => {
  const h = await fixture(t), { guide } = await h.seed("asset-guide", 1, true);
  const { request, state } = await reviewedAssetFixture(h.repository, guide);
  const batch = (await h.repository.executePrivacyAssetCommand(guide.id, { type: "reserve", id: randomUUID(), ...request }))!;
  const writerId = randomUUID();
  await h.pool.query(`CREATE FUNCTION fail_asset_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$`);
  await h.pool.query(`CREATE TRIGGER fail_asset_write BEFORE UPDATE ON guide_assets FOR EACH ROW EXECUTE FUNCTION fail_asset_write()`);
  await assert.rejects(h.repository.executePrivacyAssetCommand(guide.id, { type: "claim", id: batch.id, version: batch.version, writerId }));
  assert.deepEqual(await h.repository.listPrivacyAssetBatches(guide.id), [batch]);
  await h.pool.query(`DROP TRIGGER fail_asset_write ON guide_assets`);
  assert.ok(await h.repository.executePrivacyAssetCommand(guide.id, { type: "claim", id: batch.id, version: batch.version, writerId }));
  const document = structuredClone(state.draft!.document); document.title = "edited";
  document.privacy = privacyAfterEdit(state.draft!.document, document);
  assert.ok(await h.repository.executeAnalysisCommand(guide.id, { type: "save-editor-draft", expectedRevision: request.revision,
    expectedInputFingerprint: request.inputFingerprint, document }));
  const settled = await h.repository.executePrivacyAssetCommand(guide.id, { type: "settle", id: batch.id, writerId,
    receipts: privacyAssetKeys(batch).map(key => ({ key, sha256: "a".repeat(64), size: 100 })) });
  assert.equal(settled?.status, "cleanup");
  assert.equal((await h.repository.getAnalysisState(guide.id))!.draft!.document.title, "edited");
  await assert.rejects(h.pool.query("DELETE FROM guides WHERE id=$1", [guide.id]), (e: unknown) => (e as {code:string}).code === "23503");
});

test("real PostgreSQL: private asset ready receipts survive reconnect without publishing or touching retention", async t => {
  const h = await fixture(t), { guide } = await h.seed("asset-guide", 1, true);
  const { request, state } = await reviewedAssetFixture(h.repository, guide);
  const before = await h.repository.getGuideById(guide.id);
  const batch = (await h.repository.executePrivacyAssetCommand(guide.id, { type: "reserve", id: randomUUID(), ...request }))!;
  const writerId = randomUUID();
  await h.repository.executePrivacyAssetCommand(guide.id, { type: "claim", id: batch.id, version: batch.version, writerId });
  const ready = await h.repository.executePrivacyAssetCommand(guide.id, { type: "settle", id: batch.id, writerId,
    receipts: privacyAssetKeys(batch).map(key => ({ key, sha256: "a".repeat(64), size: 100 })) });
  assert.equal(ready?.status, "ready");
  assert.deepEqual(await PostgresGuideRepository.fromPool(h.pool).listPrivacyAssetBatches(guide.id), [ready]);
  assert.deepEqual(await h.repository.getGuideById(guide.id), before);
  assert.deepEqual(await h.repository.getAnalysisState(guide.id), state);
});

test("real PostgreSQL: privacy v2 confirmations survive reopen, use revision CAS, and editing revokes only changed checks", async t => {
  const h = await fixture(t), { guide } = await h.seed(), manifest = analysisManifest(guide);
  let state = (await h.repository.executeAnalysisCommand(guide.id, { type: "save-editor-draft", expectedRevision: 0,
    expectedInputFingerprint: manifest.fingerprint, document: initialDraft(manifest) }))!;
  const command = (action: PrivacyCommand["action"]): PrivacyCommand => ({ type: "review-privacy", expectedRevision: state.draft!.revision,
    expectedInputFingerprint: manifest.fingerprint, expectedReviewFingerprint: privacyReviewState(guide, state)!.fingerprint,
    mutationId: randomUUID(), action });
  const first = command({ type: "title", confirmed: true });
  const rivals = await Promise.all([first, command({ type: "text", stepId: guide.steps[0].id, confirmed: true })]
    .map(c => h.repository.executeAnalysisCommand(guide.id, c)));
  assert.equal(rivals.filter(Boolean).length, 1);
  state = (await h.repository.getAnalysisState(guide.id))!;
  const last = command({ type: "text", stepId: guide.steps[0].id, confirmed: true });
  state = (await h.repository.executeAnalysisCommand(guide.id, last))!;
  const reopened = PostgresGuideRepository.fromPool(h.pool);
  assert.deepEqual(await reopened.getAnalysisState(guide.id), state);
  assert.deepEqual(await reopened.executeAnalysisCommand(guide.id, last), state);
  const edited = structuredClone(state.draft!.document); edited.steps[0].instruction = "합성 변경 문구";
  edited.privacy = privacyAfterEdit(state.draft!.document, edited);
  state = (await reopened.executeAnalysisCommand(guide.id, { type: "save-editor-draft", expectedRevision: state.draft!.revision,
    expectedInputFingerprint: manifest.fingerprint, document: edited }))!;
  assert.equal(privacyReviewState(guide, state)!.steps[0].textConfirmed, false);
  assert.equal(privacyReviewState(guide, state)!.complete, false);
  await reopened.deleteGuide(guide.id);
  assert.equal(await reopened.executeAnalysisCommand(guide.id, last), null);
  assert.equal(await reopened.getAnalysisState(guide.id), null);
});

test("real PostgreSQL: failed privacy acknowledgement rolls back both JSONB and retention timestamp", async t => {
  const h = await fixture(t), { guide } = await h.seed(), manifest = analysisManifest(guide);
  const state = (await h.repository.executeAnalysisCommand(guide.id, { type: "save-editor-draft", expectedRevision: 0,
    expectedInputFingerprint: manifest.fingerprint, document: initialDraft(manifest) }))!;
  const parentBefore = await h.rows("guides");
  await h.pool.query(`CREATE FUNCTION reject_privacy_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$;
    CREATE TRIGGER reject_privacy_fixture BEFORE UPDATE ON guides FOR EACH ROW EXECUTE FUNCTION reject_privacy_fixture()`);
  await assert.rejects(h.repository.executeAnalysisCommand(guide.id, { type: "review-privacy", expectedRevision: state.draft!.revision,
    expectedInputFingerprint: manifest.fingerprint, expectedReviewFingerprint: privacyReviewState(guide, state)!.fingerprint,
    mutationId: randomUUID(), action: { type: "title", confirmed: true } }));
  assert.deepEqual(await h.repository.getAnalysisState(guide.id), state);
  assert.deepEqual(await h.rows("guides"), parentBefore);
});

function operatorStore(pool: Pool) { return new PostgresAnalysisOperationsStore({ pool, writerRoles: ["postgres"] }); }
function operatorCommand() {
  // Fictional manual confirmations, not observations of any user's cloud account.
  const review = operationsReviewFixture(new Date(Date.now() - 1000), policy);
  review.reviewerRef = operationsActorRef("postgres");
  return { type: "put" as const, commandId: randomUUID(), expectedVersion: 0, review };
}
const operationsSignal = () => new AbortController().signal;
function syntheticGrant(deploymentRef: string, guideId: string, inputFingerprint: string): SyntheticInputGrant {
  return { kind: "fixed-synthetic-screens-v1", approvalId: "fixed-fixture-approval", deploymentRef,
    input: { guideId, inputFingerprint, frameCount: 2, model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION },
    createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
    inputTokenLimit: 1000, countPolicy: SYNTHETIC_COUNT_LIMITS };
}
function activationCommand(change: ReturnType<typeof operatorCommand>, grant: SyntheticInputGrant, expectedVersion = 0) {
  return { type: "activate" as const, commandId: randomUUID(), expectedVersion, deploymentRef: change.review.deploymentRef,
    reviewId: change.review.id, expectedReviewVersion: change.review.revision, grant };
}

async function withRuntimeLogin(h: Awaited<ReturnType<typeof fixture>>, check: (pool: Pool, connection: string, role: string) => Promise<void>) {
  const role = `showme_runtime_test_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const password = randomUUID().replaceAll("-", ""); // Disposable local Docker fixture credential, never an application secret.
  await h.pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
  const target = new URL(h.connection); target.username = role; target.password = password;
  let pool: Pool | undefined;
  try {
    await h.pool.query(`GRANT USAGE ON SCHEMA public, drizzle TO "${role}"`);
    await h.pool.query(`GRANT SELECT ON drizzle.__drizzle_migrations, analysis_operations_reviews, analysis_activation_events TO "${role}"`);
    await h.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON guides, guide_steps, guide_drafts, analysis_runs,
      analysis_budget_windows, analysis_reservations, analysis_batches, analysis_accounting_controls,
      analysis_request_attempts, analysis_provider_quota_charges, analysis_count_attempts TO "${role}"`);
    pool = new Pool({ connectionString: target.toString(), max: 8, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    await check(pool, target.toString(), role);
  } finally {
    await pool?.end(); await h.pool.query(`DROP OWNED BY "${role}"`); await h.pool.query(`DROP ROLE "${role}"`);
  }
}

test("real PostgreSQL: deployment setup creates a bounded authenticated runtime login and never changes existing data", async t => {
  const h = await fixture(t); await h.seed(); const before = await h.rows("guides");
  const url = new URL(h.connection); let selected: { role: string; password: string } | undefined;
  const target = { host: url.hostname, port: Number(url.port), database: url.pathname.slice(1),
    connectionTimeoutMillis: 3000, statement_timeout: 3000 };
  const result = await createRuntimeRole({ admin: h.pool, target, persist: async credentials => { selected = credentials; } });
  assert.ok(selected); const runtime = new Pool({ ...target, user: selected.role, password: selected.password });
  try {
    assert.equal(result.aiEnabled, false); assert.equal(result.authenticationChecked, true);
    assert.equal(JSON.stringify(result).includes(selected.password), false);
    await verifyAnalysisRuntimeRole(runtime, operationsSignal());
    assert.deepEqual(await h.rows("guides"), before);
    await assert.rejects(runtime.query("DELETE FROM analysis_operations_reviews"), (error: { code?: string }) => error.code === "42501");
  } finally { await runtime.end(); await h.pool.query(`DROP OWNED BY "${result.role}"`); await h.pool.query(`DROP ROLE "${result.role}"`); }
});

test("real PostgreSQL: failed credential persistence removes only the newly generated runtime role", async t => {
  const h = await fixture(t); const url = new URL(h.connection);
  const before = (await h.pool.query("SELECT rolname FROM pg_roles ORDER BY rolname")).rows;
  await assert.rejects(createRuntimeRole({ admin: h.pool,
    target: { host: url.hostname, port: Number(url.port), database: url.pathname.slice(1), connectionTimeoutMillis: 3000 },
    persist: async () => { throw new Error("fictional file write failure"); } }), /SHOWME_RUNTIME_ROLE_SETUP_FAILED/);
  assert.deepEqual((await h.pool.query("SELECT rolname FROM pg_roles ORDER BY rolname")).rows, before);
});

test("real PostgreSQL: runtime login verifies migrations without DDL and cannot alter approval history", async t => {
  const h = await fixture(t);
  await withRuntimeLogin(h, async (pool, _connection, role) => {
    const repository = PostgresGuideRepository.fromPool(pool);
    const before = (await h.pool.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
    await verifyAnalysisRuntimeRole(pool, operationsSignal());
    await verifyDatabaseMigrations(repository.database, resolve("drizzle"));
    assert.deepEqual((await h.pool.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows, before);
    for (const query of ["CREATE TABLE public.unexpected_fixture(id int)", "DELETE FROM drizzle.__drizzle_migrations",
      "UPDATE analysis_operations_reviews SET action='revoke'", "DELETE FROM analysis_activation_events",
      "INSERT INTO analysis_activation_events DEFAULT VALUES"]) {
      await assert.rejects(pool.query(query), (error: { code?: string }) => error.code === "42501");
    }
    // Column grants are an escalation too, even without a table-level UPDATE grant.
    await h.pool.query(`GRANT UPDATE(payload) ON analysis_operations_reviews TO "${role}"`);
    await assert.rejects(verifyAnalysisRuntimeRole(pool, operationsSignal()), /ANALYSIS_BOOTSTRAP_UNAVAILABLE/);
    await h.pool.query(`REVOKE UPDATE(payload) ON analysis_operations_reviews FROM "${role}"`);
    await verifyAnalysisRuntimeRole(pool, operationsSignal());
    await assert.rejects(verifyAnalysisRuntimeRole(h.pool, operationsSignal()), /ANALYSIS_BOOTSTRAP_UNAVAILABLE/);
    await h.pool.query("UPDATE drizzle.__drizzle_migrations SET hash='fixture-tampered-history' WHERE id=(SELECT max(id) FROM drizzle.__drizzle_migrations)");
    await assert.rejects(verifyDatabaseMigrations(repository.database, resolve("drizzle")), /DATABASE_MIGRATION_CHECK_FAILED/);
    assert.equal((await h.pool.query("SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1")).rows[0].hash, "fixture-tampered-history");
  });
});

test("real PostgreSQL: verify-only mode rejects an unmigrated DB without repairing or creating tables", async t => {
  const h = await fixture(t, false);
  await assert.rejects(verifyDatabaseMigrations(h.repository.database, resolve("drizzle")), /DATABASE_MIGRATION_CHECK_FAILED/);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema IN ('public','drizzle')")).rows[0].n, 0);
});

for (const storageBasis of ["direct-permission-review", "replit-policy-and-app-check"] as const) {
test(`real PostgreSQL: ${storageBasis} survives authenticated bootstrap, normal lifecycle and revocation`, async t => {
  const h = await fixture(t); const { guide, command } = await h.seed("guide", 2, true);
  const change = operatorCommand(); change.review.storageRef = syntheticStorageRef("fictional-bucket", "showme-test");
  if (storageBasis === "replit-policy-and-app-check") {
    change.review.checks.storageAccess = { status: "confirmed", observedAt: change.review.recordedAt,
      evidenceRef: "fictional-synthetic-only-decision", platformPolicyRef: "fictional-platform-document",
      targetCheckRef: "fictional-exact-target", appAccessCheckRef: "fictional-access-check",
      assurance: { basis: storageBasis, internalPermissionsVerified: false } };
  }
  const store = operatorStore(h.pool); await store.execute(change, operationsSignal());
  assert.deepEqual((await store.observe(change.review.deploymentRef, operationsSignal())).entry?.review.checks.storageAccess,
    change.review.checks.storageAccess);
  const grant = syntheticGrant(change.review.deploymentRef, guide.id, command.expectedInputFingerprint);
  const activate = activationCommand(change, grant); await store.executeActivation(activate, operationsSignal());
  const screens = await syntheticAnalysisInput(); const sends: string[] = []; let reads = 0;
  await withRuntimeLogin(h, async (pool, connection) => {
    const config = { ...loadConfig({ NODE_ENV: "test", DATABASE_URL: connection, SHOWME_STORAGE: "replit",
      SHOWME_DATABASE_MIGRATIONS: "verify-only", REPLIT_OBJECT_STORAGE_BUCKET_ID: "fictional-bucket",
      REPLIT_OBJECT_STORAGE_PREFIX: "showme-test" }), ...testMediaPaths() };
    const settings = analysisBootstrapSettings({ SHOWME_ANALYSIS_MODE: "fixed-synthetic", SHOWME_ANALYSIS_ACTIVATION_ID: activate.commandId,
      SHOWME_ANALYSIS_DEPLOYMENT_REF: change.review.deploymentRef, SHOWME_ANALYSIS_PROJECT_REF: change.review.projectRef,
      SHOWME_ANALYSIS_CREDENTIAL_REF: change.review.credentialRef, GEMINI_API_KEY: "fictional-fixture-key" }, config)!;
    const repository = PostgresGuideRepository.fromPool(pool);
    const storage = new ReplitObjectStorage({ bucketId: "fictional-bucket", prefix: "showme-test", client: {
      downloadAsStream: async (name: string) => {
        reads++; const index = guide.steps.findIndex(s => `showme-test/${s.representativeFrameKey}` === name);
        assert.ok(index >= 0); return Readable.from(Buffer.from(screens.images[index].bytes));
      },
    } as never });
    const factory = configuredAnalysisFactory(settings, config, { migrationsFolder: resolve("drizzle"), fetch: async url => {
      if (String(url).endsWith(":countTokens")) { sends.push("count"); return Response.json({ totalTokens: 321 }); }
      assert.ok(String(url).endsWith(":generateContent")); sends.push("generate");
      return Response.json({ modelVersion: GEMINI_TEST_MODEL,
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(fakeOutput(guide.steps.map(s => s.id))) }] } }],
        usageMetadata: { promptTokenCount: 322, candidatesTokenCount: 20, totalTokenCount: 342 } });
    } });
    // Wrong selector/project cannot replace an existing reviewed activation, nor send or read media.
    for (const override of [{ activationId: randomUUID() }, { projectRef: "wrong-project" }]) {
      await assert.rejects(async () => configuredAnalysisFactory({ ...settings, ...override }, config)({ repository, storage }), /ANALYSIS_BOOTSTRAP_UNAVAILABLE/);
    }
    const before = (await h.pool.query("SELECT * FROM analysis_activation_events ORDER BY version")).rows;
    const lifecycle = (await createAnalysisLifecycle({ repository, storage }, factory))!;
    try {
      assert.deepEqual((await h.pool.query("SELECT * FROM analysis_activation_events ORDER BY version")).rows, before);
      assert.equal(reads, 0); assert.deepEqual(sends, []);
      assert.equal(await lifecycle.admission.inspectAvailability!(grant.input, operationsSignal()), false);
      lifecycle.start();
      assert.equal(await lifecycle.admission.inspectAvailability!(grant.input, operationsSignal()), true);
      assert.equal(reads, 0); assert.deepEqual(sends, []);
      assert.ok(await lifecycle.admission.request(guide.id, command, operationsSignal()));
      for (let i = 0; i < 400; i++) {
        const status = (await repository.getAnalysisState(guide.id))?.runs[0]?.status;
        if (status === "succeeded" || status === "failed") break;
        await delay(25);
      }
      assert.equal((await repository.getAnalysisState(guide.id))?.runs[0]?.status, "succeeded");
      assert.equal((await repository.getAnalysisState(guide.id))?.draft?.revision, 1);
      assert.equal(reads, 2); assert.deepEqual(sends, ["count", "generate"]);
      await store.execute({ type: "revoke", commandId: randomUUID(), expectedVersion: 1,
        deploymentRef: change.review.deploymentRef, reviewId: change.review.id }, operationsSignal());
      assert.equal(await lifecycle.admission.inspectAvailability!(grant.input, operationsSignal()), false);
      await assert.rejects(async () => factory({ repository, storage }), /ANALYSIS_BOOTSTRAP_UNAVAILABLE/);
      assert.deepEqual(sends, ["count", "generate"]);
    } finally { await lifecycle.stop(); }
    assert.equal((await pool.query("SELECT 1 AS ok")).rows[0].ok, 1);
  });
});
}

test("real PostgreSQL: bootstrap resolver rejects a stopped or replayed activation and mutated grant history", async t => {
  const h = await fixture(t), seeded = await h.seed(), change = operatorCommand(), store = operatorStore(h.pool);
  await store.execute(change, operationsSignal());
  const binding = { deploymentRef: change.review.deploymentRef, projectRef: change.review.projectRef,
    credentialRef: change.review.credentialRef, storageRef: change.review.storageRef };
  const grant = syntheticGrant(binding.deploymentRef, seeded.guide.id, seeded.command.expectedInputFingerprint);
  const activate = activationCommand(change, grant); await store.executeActivation(activate, operationsSignal());
  const resolved = await store.resolveRuntimeActivation(activate.commandId, binding, operationsSignal());
  assert.deepEqual(resolved.grant, grant); assert.equal(resolved.activation.id, activate.commandId);
  const before = (await h.pool.query("SELECT payload FROM analysis_activation_events WHERE version=1")).rows[0].payload;
  await h.pool.query("UPDATE analysis_activation_events SET payload=jsonb_set(payload,'{command,grant,inputTokenLimit}','999') WHERE version=1");
  await assert.rejects(store.resolveRuntimeActivation(activate.commandId, binding, operationsSignal()), /OPERATIONS_UNAVAILABLE/);
  await h.pool.query("UPDATE analysis_activation_events SET payload=$1::jsonb WHERE version=1", [JSON.stringify(before)]);
  await store.executeActivation({ type: "deactivate", commandId: randomUUID(), expectedVersion: 1, deploymentRef: binding.deploymentRef }, operationsSignal());
  await store.executeActivation(activate, operationsSignal());
  await assert.rejects(store.resolveRuntimeActivation(activate.commandId, binding, operationsSignal()), /OPERATIONS_UNAVAILABLE/);
  assert.equal((await h.repository.getAnalysisAccountingControl()).halted, true);
});

test("real PostgreSQL: operations evidence reads the current DB review but cannot bypass a committed halt", async (t) => {
  const h = await fixture(t); const change = operatorCommand();
  await operatorStore(h.pool).execute(change, operationsSignal());
  const store = new PostgresAnalysisOperationsStore({ pool: h.pool });
  const r = change.review;
  const source = new OperationsReviewEvidenceSource({ store, binding: { deploymentRef: r.deploymentRef,
    projectRef: r.projectRef, credentialRef: r.credentialRef, storageRef: r.storageRef } });
  const input = { guideId: "guide", frameCount: 2, inputFingerprint: "a".repeat(64), model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION } as const;
  const observed = await store.observe(r.deploymentRef, operationsSignal());
  assert.equal(observed.authorizesAnalysis, false); assert.equal(observed.halted, true); assert.equal(observed.entry?.version, 1);
  await assert.rejects(source.inspect(input, operationsSignal()), /ANALYSIS_UNAVAILABLE/);
  assert.equal((await h.repository.getAnalysisAccountingControl()).halted, true);
  // Fixture ONLY: emulate a previously enabled runtime. Neither source nor store can unhalt.
  await h.pool.query("UPDATE analysis_accounting_controls SET payload = '{\"halted\":false}'::jsonb WHERE id='global'");
  const funded = await h.fund(); const owner = await h.begin();
  const evidence = await source.inspect({ ...input, inputFingerprint: funded.command.expectedInputFingerprint }, operationsSignal());
  assert.equal(evidence.review.recordedAt, r.recordedAt); assert.equal(source.isCurrent(evidence), true);
  const otherPool = new Pool({ connectionString: h.connection, max: 1 });
  try {
    await operatorStore(otherPool).execute({ type: "revoke", commandId: randomUUID(), expectedVersion: 1,
      deploymentRef: r.deploymentRef, reviewId: r.id }, operationsSignal());
    // Local isCurrent is NOT an imaginary synchronous cross-process notification.
    assert.equal(source.isCurrent(evidence), true);
    let sends = 0;
    assert.equal(await h.repository.launchAnalysisRequest("guide", { ...identity, owner,
      inputFingerprint: funded.command.expectedInputFingerprint }, () => { sends++; }), false);
    assert.equal(sends, 0);
    await assert.rejects(source.inspect(input, operationsSignal()), /ANALYSIS_UNAVAILABLE/);
    assert.equal(source.isCurrent(evidence), false);
    assert.equal((await new PostgresAnalysisOperationsStore({ pool: otherPool }).observe(r.deploymentRef, operationsSignal())).entry?.review.state, "revoked");
  } finally { await otherPool.end(); }
});

test("real PostgreSQL: operations observation uses a consistent read-only snapshot during concurrent revocation", async (t) => {
  const h = await fixture(t); const change = operatorCommand(); await operatorStore(h.pool).execute(change, operationsSignal());
  await h.pool.query("UPDATE analysis_accounting_controls SET payload = '{\"halted\":false}'::jsonb WHERE id='global'");
  const observingPool = { async connect() {
    const client = await h.pool.connect(); const original = client.query.bind(client);
    client.query = (async (text: string, values?: unknown[]) => {
      const result = await original(text, values);
      if (text.startsWith("SELECT payload, floor")) {
        await operatorStore(h.pool).execute({ type: "revoke", commandId: randomUUID(), expectedVersion: 1,
          deploymentRef: change.review.deploymentRef, reviewId: change.review.id }, operationsSignal());
      }
      return result;
    }) as typeof client.query;
    const release = client.release.bind(client);
    client.release = (...args) => { client.query = original; release(...args); };
    return client;
  } } as Pick<Pool, "connect">;
  const before = await new PostgresAnalysisOperationsStore({ pool: observingPool }).observe(change.review.deploymentRef, operationsSignal());
  assert.equal(before.halted, false); assert.equal(before.entry?.version, 1); assert.equal(before.entry?.review.state, "approved");
  const after = await new PostgresAnalysisOperationsStore({ pool: h.pool }).observe(change.review.deploymentRef, operationsSignal());
  assert.equal(after.halted, true); assert.equal(after.entry?.version, 2); assert.equal(after.entry?.review.state, "revoked");
});

test("real PostgreSQL: operations observation works with SELECT-only role and never repairs missing or corrupt state", async (t) => {
  const h = await fixture(t); const command = operatorCommand(); await operatorStore(h.pool).execute(command, operationsSignal());
  const reader = new Pool({ connectionString: h.connection, max: 1, options: "-c role=pg_read_all_data" });
  try {
    const store = new PostgresAnalysisOperationsStore({ pool: reader });
    const observed = await store.observe(command.review.deploymentRef, operationsSignal());
    assert.equal(observed.entry?.version, 1); assert.equal(observed.halted, true);
    await h.pool.query("UPDATE analysis_accounting_controls SET payload = '{\"halted\":\"unknown\"}'::jsonb WHERE id='global'");
    await assert.rejects(store.observe(command.review.deploymentRef, operationsSignal()), /OPERATIONS_UNAVAILABLE/);
    await h.pool.query("DELETE FROM analysis_accounting_controls");
    await assert.rejects(store.observe(command.review.deploymentRef, operationsSignal()), /OPERATIONS_UNAVAILABLE/);
    assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_accounting_controls")).rows[0].n, 0);
    assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_operations_reviews")).rows[0].n, 1);
  } finally { await reader.end(); }
});

test("real PostgreSQL: operator record persists across pools and role-gated writes never authorize execution", async (t) => {
  const h = await fixture(t); const command = operatorCommand();
  const unconfigured = new PostgresAnalysisOperationsStore({ pool: h.pool });
  assert.equal(await unconfigured.readLatest(command.review.deploymentRef, operationsSignal()), null);
  await assert.rejects(unconfigured.execute(command, operationsSignal()), /OPERATIONS_FORBIDDEN/);
  await assert.rejects(new PostgresAnalysisOperationsStore({ pool: h.pool, writerRoles: ["not_the_db_login"] }).execute(command, operationsSignal()), /OPERATIONS_FORBIDDEN/);
  assert.equal((await h.repository.getAnalysisAccountingControl()).halted, false);
  const result = await operatorStore(h.pool).execute(command, operationsSignal());
  assert.equal(result.authorizesAnalysis, false); assert.equal((await h.repository.getAnalysisAccountingControl()).halted, true);
  const pool = new Pool({ connectionString: h.connection, max: 1 });
  try {
    const other = new PostgresAnalysisOperationsStore({ pool });
    assert.deepEqual(await other.readLatest(command.review.deploymentRef, operationsSignal()), result.entry);
    assert.equal((await operatorStore(pool).execute(command, operationsSignal())).replayed, true);
  } finally { await pool.end(); }
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_operations_reviews")).rows[0].n, 1);
});

test("real PostgreSQL: SET ROLE cannot borrow an operator identity; reader-only role cannot insert", async (t) => {
  const h = await fixture(t); const command = operatorCommand(); await operatorStore(h.pool).execute(command, operationsSignal());
  const reader = new Pool({ connectionString: h.connection, max: 1, options: "-c role=pg_read_all_data" });
  try {
    const store = new PostgresAnalysisOperationsStore({ pool: reader, writerRoles: ["postgres", "pg_read_all_data"] });
    assert.equal((await store.readLatest(command.review.deploymentRef, operationsSignal()))?.version, 1);
    await assert.rejects(store.execute({ type: "revoke", commandId: randomUUID(), expectedVersion: 1,
      deploymentRef: command.review.deploymentRef, reviewId: command.review.id }, operationsSignal()), /OPERATIONS_FORBIDDEN/);
    await assert.rejects(reader.query("INSERT INTO analysis_operations_reviews SELECT * FROM analysis_operations_reviews"), /permission denied/);
  } finally { await reader.end(); }
  assert.equal((await operatorStore(h.pool).readLatest(command.review.deploymentRef, operationsSignal()))?.review.state, "approved");
});

test("real PostgreSQL: concurrent operator retries insert once; different commands race by expected version", async (t) => {
  const h = await fixture(t); const command = operatorCommand();
  const results = await Promise.all(Array.from({ length: 12 }, () => operatorStore(h.pool).execute(command, operationsSignal())));
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  const updates = Array.from({ length: 8 }, () => ({ ...command, commandId: randomUUID(), expectedVersion: 1,
    review: { ...command.review, revision: 2 } }));
  const races = await Promise.allSettled(updates.map((c) => operatorStore(h.pool).execute(c, operationsSignal())));
  assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(races.filter((r) => r.status === "rejected").every((r) => r.reason.code === "OPERATIONS_CONFLICT"));
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_operations_reviews")).rows[0].n, 2);
  await assert.rejects(operatorStore(h.pool).execute({ ...command, review: { ...command.review, id: "collision" } }, operationsSignal()), /OPERATIONS_CONFLICT/);
});

test("real PostgreSQL: revocation appends history, retains observations and survives guide deletion", async (t) => {
  const h = await fixture(t); await h.seed(); const command = operatorCommand();
  await operatorStore(h.pool).execute(command, operationsSignal());
  const revoke = { type: "revoke", commandId: randomUUID(), expectedVersion: 1, deploymentRef: command.review.deploymentRef, reviewId: command.review.id };
  const result = await operatorStore(h.pool).execute(revoke, operationsSignal());
  assert.equal(result.entry.review.state, "revoked"); assert.equal(result.entry.version, 2);
  assert.equal(result.entry.review.recordedAt, command.review.recordedAt);
  await h.repository.deleteGuide("guide");
  assert.equal((await operatorStore(h.pool).readLatest(command.review.deploymentRef, operationsSignal()))?.version, 2);
  const rows = (await h.pool.query("SELECT payload FROM analysis_operations_reviews ORDER BY version")).rows;
  assert.deepEqual(rows.map((r) => r.payload.state), ["approved", "revoked"]);
  assert.equal((await operatorStore(h.pool).execute(revoke, operationsSignal())).replayed, true);
  assert.equal((await operatorStore(h.pool).execute(command, operationsSignal())).entry.version, 1);
  assert.equal((await h.repository.getAnalysisAccountingControl()).halted, true);
});

test("real PostgreSQL: failed review insert or failed/silently skipped halt rolls both writes back", async (t) => {
  for (const mode of ["insert-failure", "halt-failure", "halt-skipped"]) {
    const h = await fixture(t); const command = operatorCommand();
    const target = mode === "insert-failure" ? "analysis_operations_reviews" : "analysis_accounting_controls";
    await h.pool.query(mode === "halt-skipped"
      ? "CREATE FUNCTION reject_operator_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$"
      : "CREATE FUNCTION reject_operator_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private operator failure'; END $$");
    // target comes from this fixed test list, never from application input.
    await h.pool.query(`CREATE TRIGGER reject_operator_change BEFORE INSERT OR UPDATE ON ${target} FOR EACH ROW EXECUTE FUNCTION reject_operator_change()`);
    await assert.rejects(operatorStore(h.pool).execute(command, operationsSignal()), /^AnalysisOperationsStoreError: OPERATIONS_UNAVAILABLE$/);
    assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_operations_reviews")).rows[0].n, 0);
    assert.equal((await h.repository.getAnalysisAccountingControl()).halted, false);
  }
});

test("real PostgreSQL: incomplete records stay pending; expiry, missing control and corrupt rows fail closed", async (t) => {
  const h = await fixture(t); const command = operatorCommand(); command.review.checks.storageAccess = { status: "unknown" };
  await assert.rejects(operatorStore(h.pool).execute(command, operationsSignal()), /OPERATIONS_INVALID/);
  command.review.state = "pending";
  assert.equal((await operatorStore(h.pool).execute(command, operationsSignal())).entry.review.state, "pending");
  assert.equal((await h.repository.getAnalysisAccountingControl()).halted, true);
  // This asserts an ALREADY expired review, not equality between the host and Docker DB clocks.
  const dbNow = (await h.pool.query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::double precision AS at_ms")).rows[0].at_ms;
  const next = { ...command, commandId: randomUUID(), expectedVersion: 1,
    review: { ...command.review, revision: 2, expiresAt: new Date(dbNow - 250).toISOString() } };
  await assert.rejects(operatorStore(h.pool).execute(next, operationsSignal()), /OPERATIONS_INVALID/);
  await h.pool.query("UPDATE analysis_operations_reviews SET payload = payload || '{\"kind\":\"corrupt\"}'::jsonb");
  await assert.rejects(operatorStore(h.pool).readLatest(command.review.deploymentRef, operationsSignal()), /OPERATIONS_UNAVAILABLE/);
  const empty = await fixture(t); await empty.pool.query("DELETE FROM analysis_accounting_controls");
  await assert.rejects(operatorStore(empty.pool).execute(operatorCommand(), operationsSignal()), /OPERATIONS_UNAVAILABLE/);
  assert.equal((await empty.pool.query("SELECT count(*)::int AS n FROM analysis_operations_reviews")).rows[0].n, 0);
});

test("real PostgreSQL: revoked review stops new admission and queued generation across repository instances", async (t) => {
  const h = await fixture(t); const change = operatorCommand(); await operatorStore(h.pool).execute(change, operationsSignal());
  // Fixture ONLY: emulate an earlier enabled runtime. Product store has NO resume API.
  await h.pool.query("UPDATE analysis_accounting_controls SET payload = '{\"halted\":false}'::jsonb WHERE id='global'");
  const funded = await h.fund(); const owner = await h.begin(); const second = await h.seed("second");
  await operatorStore(h.pool).execute({ type: "revoke", commandId: randomUUID(), expectedVersion: 1,
    deploymentRef: change.review.deploymentRef, reviewId: change.review.id }, operationsSignal());
  const other = PostgresGuideRepository.fromPool(h.pool); let sends = 0;
  assert.equal(await other.launchAnalysisRequest("guide", { ...identity, owner, inputFingerprint: funded.command.expectedInputFingerprint }, () => { sends++; }), false);
  await assert.rejects(other.reserveAnalysisRequest("second", second.command, policy), /ANALYSIS_/);
  assert.equal(sends, 0); assert.equal((await h.rows("analysis_reservations")).length, 1);
});

test("real PostgreSQL: review mutation invalidates an already claimed count launch ticket", async (t) => {
  const h = await launchFixture(t); let sends = 0;
  await operatorStore(h.pool).execute(operatorCommand(), operationsSignal());
  await assert.rejects(h.repository.launchAnalysisCount(h.ticket, () => { sends++; }), /ANALYSIS_COUNT_UNAVAILABLE/);
  assert.equal(sends, 0); assert.equal((await h.quotas()).length, 1);
});

test("real PostgreSQL: operator mutation and generation serialize on the existing shared halt lock", async (t) => {
  const h = await fixture(t); const { command } = await h.fund(); const owner = await h.begin();
  const blocker = await h.pool.connect(); let sends = 0;
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM analysis_accounting_controls WHERE id='global' FOR UPDATE");
    const write = operatorStore(h.pool).execute(operatorCommand(), operationsSignal());
    await waitForFixtureLocks(h.pool, 1);
    const launch = h.repository.launchAnalysisRequest("guide", { ...identity, owner, inputFingerprint: command.expectedInputFingerprint }, () => { sends++; });
    await waitForFixtureLocks(h.pool, 2); await blocker.query("COMMIT");
    await write; assert.equal(await launch, false); assert.equal(sends, 0);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
});

test("real PostgreSQL: operator cancellation while waiting for the lock commits nothing", async (t) => {
  const h = await fixture(t); const blocker = await h.pool.connect(); const controller = new AbortController();
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM analysis_accounting_controls WHERE id='global' FOR UPDATE");
    const pending = operatorStore(h.pool).execute(operatorCommand(), controller.signal);
    const rejected = assert.rejects(pending, /OPERATIONS_UNAVAILABLE/);
    await waitForFixtureLocks(h.pool, 1); controller.abort(); await rejected;
    await blocker.query("COMMIT");
    // Let the owned transaction observe its abort and release; no subsequent write may begin.
    await h.pool.query("SELECT id FROM analysis_accounting_controls WHERE id='global' FOR UPDATE");
    assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_operations_reviews")).rows[0].n, 0);
    assert.equal((await h.repository.getAnalysisAccountingControl()).halted, false);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
});

test("real PostgreSQL: analysis database observation is read-only, private and not an execution permit", async t => {
  const h = await fixture(t); await h.seed();
  const before = await Promise.all(["guides", "guide_steps", "guide_drafts", "analysis_runs", "analysis_budget_windows",
    "analysis_reservations", "analysis_batches", "analysis_accounting_controls", "analysis_request_attempts"].map(h.rows));
  const probe = new PostgresAnalysisDatabaseProbe({ database: h.repository.database, migrationsFolder: "drizzle" });
  const report = await probe.inspect(new AbortController().signal);
  assert.equal(report.authorizesAnalysis, false); assert.equal(report.scope, "database-only");
  assert.equal(report.countLaunchStatus, "supported"); assert.equal(report.accountingControl, "open");
  assert.ok(Math.abs(Date.parse(report.observedAt) - Date.now()) < 5000);
  const serialized = JSON.stringify(report);
  for (const secret of ["synthetic-test-token", "synthetic guide", "fictional.mp4", h.connection, "fixture/", "postgresql:"]) assert.ok(!serialized.includes(secret));
  assert.deepEqual(await Promise.all(["guides", "guide_steps", "guide_drafts", "analysis_runs", "analysis_budget_windows",
    "analysis_reservations", "analysis_batches", "analysis_accounting_controls", "analysis_request_attempts"].map(h.rows)), before);
  for (const table of ["analysis_count_attempts", "analysis_provider_quota_charges"]) {
    assert.equal((await h.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  }
  assert.equal((await h.pool.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "off");
});

for (const scenario of ["healthy", "unmigrated", "halted", "wrong-password"] as const) {
  test(`real PostgreSQL: standalone DB check ${scenario} is private, read-only and not readiness`, async t => {
    const h = await fixture(t, scenario !== "unmigrated");
    if (scenario === "halted") await h.pool.query("UPDATE analysis_accounting_controls SET payload='{\"halted\":true}' WHERE id='global'");
    if (scenario === "healthy") await h.seed();
    const before = scenario === "unmigrated" ? null : await Promise.all(["guides", "guide_steps", "guide_drafts", "analysis_accounting_controls"].map(h.rows));
    const target = new URL(h.connection);
    if (scenario === "wrong-password") target.password = "fictional-wrong-password";
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      execFile(process.execPath, ["--import", "tsx", resolve("src/processor/analysis-database-check.ts"), "--configured-database", "--read-only"], {
        // Parent environment was scrubbed by the isolated Docker runner. No operational URL is used.
        env: { ...process.env, DATABASE_URL: target.toString(), NODE_ENV: "production", PORT: "invalid",
          PGHOST: "wrong.invalid", PGDATABASE: "wrong-db", PGUSER: "wrong-user", PGPASSWORD: "wrong-password",
          PGOPTIONS: "-c default_transaction_read_only=on", PGREPLICATION: "database", PGSSLMODE: "no-verify",
          GEMINI_API_KEY: "fictional-must-not-be-used" },
        encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 16384,
      }, (error, stdout, stderr) => done({ code: typeof error?.code === "number" ? error.code : error ? -1 : 0, stdout, stderr }));
    });
    assert.equal(result.code, scenario === "healthy" ? 0 : 1); assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, scenario === "healthy" ? "passed" : "failed");
    assert.equal(output.ready, false); assert.equal(output.authorizesAnalysis, false); assert.equal(output.changesApplied, false);
    for (const secret of [h.connection, target.password, "synthetic-test-token", "fixture/", "fictional-wrong-password", "wrong.invalid"]) {
      assert.ok(!result.stdout.includes(secret));
    }
    if (scenario === "unmigrated") {
      assert.equal((await h.pool.query("SELECT to_regclass('public.guides') AS relation")).rows[0].relation, null);
      assert.equal((await h.pool.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS relation")).rows[0].relation, null);
    } else {
      assert.deepEqual(await Promise.all(["guides", "guide_steps", "guide_drafts", "analysis_accounting_controls"].map(h.rows)), before);
    }
    assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='showme-analysis-database-check'")).rows[0].n, 0);
  });
}

const databaseProbeFailures = [
  ["unmigrated database", ""],
  ["changed historical migration", "UPDATE drizzle.__drizzle_migrations SET hash=repeat('a',64) WHERE id=(SELECT min(id) FROM drizzle.__drizzle_migrations)"],
  ["missing final migration", "DELETE FROM drizzle.__drizzle_migrations WHERE id=(SELECT max(id) FROM drizzle.__drizzle_migrations)"],
  ["missing quota relation", "DROP TABLE analysis_provider_quota_charges"],
  ["wrong column type", "ALTER TABLE analysis_count_attempts ALTER COLUMN batch_index TYPE bigint"],
  ["missing unique key", "DROP INDEX analysis_count_slot_unique"],
  ["missing safety check", "ALTER TABLE analysis_count_attempts DROP CONSTRAINT analysis_count_identity_check"],
  ["unvalidated safety check", "ALTER TABLE analysis_count_attempts DROP CONSTRAINT analysis_count_identity_check; ALTER TABLE analysis_count_attempts ADD CONSTRAINT analysis_count_identity_check CHECK (false) NOT VALID"],
  ["old count launch status", "ALTER TABLE analysis_count_attempts DROP CONSTRAINT analysis_count_status_check; ALTER TABLE analysis_count_attempts ADD CONSTRAINT analysis_count_status_check CHECK (status IN ('reserved','sending','settled','uncertain','overrun','released'))"],
  ["weakened count launch status", "ALTER TABLE analysis_count_attempts DROP CONSTRAINT analysis_count_status_check; ALTER TABLE analysis_count_attempts ADD CONSTRAINT analysis_count_status_check CHECK (true)"],
  ["row level filtering", "ALTER TABLE analysis_runs ENABLE ROW LEVEL SECURITY"],
  ["missing global control", "DELETE FROM analysis_accounting_controls WHERE id='global'"],
  ["halted accounting", "UPDATE analysis_accounting_controls SET payload='{\"halted\":true}' WHERE id='global'"],
  ["malformed control", "UPDATE analysis_accounting_controls SET payload='{\"halted\":\"false\"}' WHERE id='global'"],
] as const;
for (const [name, change] of databaseProbeFailures) {
  test(`real PostgreSQL: database probe rejects ${name} without repair`, async t => {
    const h = await fixture(t, Boolean(change));
    if (change) {
      const healthy = new PostgresAnalysisDatabaseProbe({ database: h.repository.database, migrationsFolder: "drizzle" });
      assert.equal((await healthy.inspect(new AbortController().signal)).accountingControl, "open");
    }
    if (change) await h.pool.query(change); // Only this test's disposable fixture database.
    const probe = new PostgresAnalysisDatabaseProbe({ database: h.repository.database, migrationsFolder: "drizzle" });
    await assert.rejects(probe.inspect(new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof AnalysisDatabaseProbeError);
      assert.equal(error.message, "ANALYSIS_DATABASE_UNAVAILABLE"); return true;
    });
    if (!change) assert.equal((await h.pool.query("SELECT to_regclass('public.analysis_runs') AS relation")).rows[0].relation, null);
    if (name === "halted accounting") assert.deepEqual((await h.pool.query("SELECT payload FROM analysis_accounting_controls WHERE id='global'")).rows[0].payload, { halted: true });
  });
}

test("real PostgreSQL: lock contention times out without cancelling or modifying the blocking transaction", async t => {
  const h = await fixture(t);
  const blocker = await h.pool.connect();
  try {
    await blocker.query("BEGIN"); await blocker.query("LOCK TABLE analysis_accounting_controls IN ACCESS EXCLUSIVE MODE");
    const probe = new PostgresAnalysisDatabaseProbe({ database: h.repository.database, migrationsFolder: "drizzle" });
    const rejection = assert.rejects(probe.inspect(new AbortController().signal), AnalysisDatabaseProbeError);
    await waitForFixtureLocks(h.pool, 1);
    await rejection;
    assert.equal((await blocker.query("SELECT 1 AS alive")).rows[0].alive, 1);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  const probe = new PostgresAnalysisDatabaseProbe({ database: h.repository.database, migrationsFolder: "drizzle" });
  assert.equal((await probe.inspect(new AbortController().signal)).authorizesAnalysis, false);
});

test("real PostgreSQL: a read-only role cannot masquerade as a writable analysis runtime", async t => {
  const h = await fixture(t); const client = await h.pool.connect();
  const role = `showme_probe_${randomUUID().replaceAll("-", "")}`;
  await client.query(`CREATE ROLE "${role}" NOLOGIN`);
  try {
    await client.query(`GRANT USAGE ON SCHEMA public,drizzle TO "${role}"`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public,drizzle TO "${role}"`);
    await client.query(`SET ROLE "${role}"`);
    const probe = new PostgresAnalysisDatabaseProbe({ database: drizzle(client, { schema: processorSchema }), migrationsFolder: "drizzle" });
    await assert.rejects(probe.inspect(new AbortController().signal), AnalysisDatabaseProbeError);
    assert.equal((await client.query("SELECT has_table_privilege('public.analysis_count_attempts','INSERT') AS allowed")).rows[0].allowed, false);
  } finally {
    await client.query("RESET ROLE");
    await client.query(`DROP OWNED BY "${role}"`); // Only the generated fixture role's grants in this disposable database.
    await client.query(`DROP ROLE "${role}"`); client.release();
  }
});

for (const mode of ["default-read-only", "shadow-schema"] as const) {
  test(`real PostgreSQL: database inspection rejects ${mode} without changing the connection setting`, async t => {
    const h = await fixture(t); const client = await h.pool.connect();
    try {
      if (mode === "default-read-only") await client.query("SET default_transaction_read_only=on");
      else {
        await client.query("CREATE SCHEMA probe_shadow");
        await client.query("CREATE TABLE probe_shadow.analysis_runs AS TABLE public.analysis_runs WITH NO DATA");
        await client.query("SET search_path=probe_shadow,public");
      }
      const probe = new PostgresAnalysisDatabaseProbe({ database: drizzle(client, { schema: processorSchema }), migrationsFolder: "drizzle" });
      await assert.rejects(probe.inspect(new AbortController().signal), AnalysisDatabaseProbeError);
      if (mode === "default-read-only") assert.equal((await client.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only, "on");
      else assert.equal((await client.query("SHOW search_path")).rows[0].search_path, "probe_shadow, public");
    } finally { await client.query("RESET default_transaction_read_only"); await client.query("RESET search_path"); client.release(); }
  });
}

test("real PostgreSQL: saved drafts fence expiry, legacy drafts filter before LIMIT, and retention updates roll back", async t => {
  const h = await fixture(t);
  const { guide } = await h.seed();
  await h.pool.query("UPDATE guides SET updated_at = now() - interval '8 days' WHERE id = 'guide'");
  const stale = (await h.repository.getGuideById("guide"))!;
  const manifest = analysisManifest(guide);
  const command = { type: "save-editor-draft" as const, expectedRevision: 0,
    expectedInputFingerprint: manifest.fingerprint, document: initialDraft(manifest) };
  const saved = await h.repository.executeAnalysisCommand("guide", command);
  assert.equal(saved?.draft?.revision, 1);
  const parent = (await h.repository.getGuideById("guide"))!;
  assert.equal(parent.updatedAt, saved!.draft!.updatedAt);
  const savedAt = saved!.draft!.updatedAt;
  assert.deepEqual(await h.repository.listExpiredDrafts(new Date(Date.parse(savedAt) - 1).toISOString(), ["DELETION_PENDING"]), []);
  assert.deepEqual((await h.repository.listExpiredDrafts(savedAt, ["DELETION_PENDING"])).map(g => g.id), ["guide"]);
  assert.equal(await h.repository.updateStatus("guide", "failed", {
    expectedStatuses: ["ready"], expectedUpdatedAt: stale.updatedAt, errorCode: "DELETION_PENDING",
  }), null);
  await h.repository.executeAnalysisCommand("guide", command);
  assert.equal((await h.repository.getGuideById("guide"))?.updatedAt, parent.updatedAt);
  await h.pool.query("CREATE FUNCTION reject_retention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$");
  await h.pool.query("CREATE TRIGGER reject_retention BEFORE UPDATE ON guides FOR EACH ROW EXECUTE FUNCTION reject_retention()");
  await assert.rejects(h.repository.executeAnalysisCommand("guide", {
    ...command, expectedRevision: 1, document: { ...command.document, title: "must roll back" },
  }));
  assert.deepEqual((await h.repository.getAnalysisState("guide"))?.draft, saved?.draft);
  assert.equal((await h.repository.getGuideById("guide"))?.updatedAt, parent.updatedAt);
  await h.pool.query("DROP TRIGGER reject_retention ON guides");

  // Previous-release shape: parent is old but the successful editor draft is recent.
  await h.pool.query("UPDATE guides SET updated_at = now() - interval '10 days' WHERE id = 'guide'");
  await h.seed("expired");
  await h.pool.query("UPDATE guides SET updated_at = now() - interval '8 days' WHERE id = 'expired'");
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  assert.deepEqual((await h.repository.listExpiredDrafts(cutoff, ["DELETION_PENDING"], 1)).map(g => g.id), ["expired"]);
  await h.repository.updateStatus("expired", "failed", { errorCode: "DELETION_PENDING" });
  await h.pool.query("UPDATE guides SET updated_at = now() - interval '8 days' WHERE id = 'expired'");
  assert.deepEqual(await h.repository.listExpiredDrafts(cutoff, ["DELETION_PENDING"], 1), []);
});

for (const first of ["save", "expiry"] as const) {
  test(`real PostgreSQL: ${first} first on the actual parent lock fences the competing retention operation`, async t => {
    const h = await fixture(t);
    const { guide } = await h.seed();
    const oldAt = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    await h.pool.query("UPDATE guides SET updated_at=$1::timestamptz WHERE id='guide'", [oldAt]);
    const manifest = analysisManifest(guide);
    const command = { type: "save-editor-draft" as const, expectedRevision: 0,
      expectedInputFingerprint: manifest.fingerprint, document: initialDraft(manifest) };
    const save = () => h.repository.executeAnalysisCommand("guide", command);
    const expire = () => h.repository.updateStatus("guide", "failed", {
      expectedStatuses: ["ready"], expectedUpdatedAt: oldAt, errorCode: "DELETION_PENDING",
    });
    const blocker = await h.pool.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM guides WHERE id='guide' FOR UPDATE");
      let saving: ReturnType<typeof save>;
      let expiring: ReturnType<typeof expire>;
      if (first === "save") {
        saving = save(); pending.push(saving); void saving.catch(() => undefined);
        await waitForFixtureLocks(h.pool, 1);
        expiring = expire(); pending.push(expiring); void expiring.catch(() => undefined);
      } else {
        expiring = expire(); pending.push(expiring); void expiring.catch(() => undefined);
        await waitForFixtureLocks(h.pool, 1);
        saving = save(); pending.push(saving); void saving.catch(() => undefined);
      }
      await waitForFixtureLocks(h.pool, 2);
      await blocker.query("COMMIT");
      const [saved, expired] = await Promise.all([saving, expiring]);
      const parent = (await h.repository.getGuideById("guide"))!;
      if (first === "save") {
        assert.equal(saved?.draft?.revision, 1);
        assert.equal(expired, null);
        assert.equal(parent.status, "ready");
        assert.equal(parent.updatedAt, saved!.draft!.updatedAt);
        assert.deepEqual((await h.repository.getAnalysisState("guide"))?.draft, saved?.draft);
      } else {
        assert.equal(saved, null);
        assert.equal(expired?.errorCode, "DELETION_PENDING");
        assert.equal(parent.status, "failed");
        assert.equal(parent.updatedAt, expired!.updatedAt);
        assert.equal((await h.repository.getAnalysisState("guide"))?.draft, null);
      }
    } finally {
      try { await blocker.query("ROLLBACK"); } finally { blocker.release(); }
      await Promise.allSettled(pending);
    }
  });
}

test("real PostgreSQL: twenty simultaneous editor saves commit one revision and one matching retention timestamp", async t => {
  const h = await fixture(t);
  const { guide } = await h.seed();
  const manifest = analysisManifest(guide);
  const blocker = await h.pool.connect();
  const pending: ReturnType<typeof h.repository.executeAnalysisCommand>[] = [];
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM guides WHERE id='guide' FOR UPDATE");
    for (let i = 0; i < 20; i++) {
      const save = h.repository.executeAnalysisCommand("guide", { type: "save-editor-draft", expectedRevision: 0,
        expectedInputFingerprint: manifest.fingerprint, document: { ...initialDraft(manifest), title: `synthetic edit ${i}` } });
      pending.push(save); void save.catch(() => undefined);
    }
    await waitForFixtureLocks(h.pool, 20);
    await blocker.query("COMMIT");
    const results = await Promise.all(pending);
    const winners = results.filter(result => result !== null);
    assert.equal(winners.length, 1);
    assert.equal(results.filter(result => result === null).length, 19);
    const draft = winners[0]!.draft!;
    assert.equal(draft.revision, 1);
    assert.deepEqual((await h.repository.getAnalysisState("guide"))?.draft, draft);
    assert.equal((await h.repository.getGuideById("guide"))?.updatedAt, draft.updatedAt);
    assert.ok(h.pool.totalCount > 1);
  } finally {
    try { await blocker.query("ROLLBACK"); } finally { blocker.release(); }
    await Promise.allSettled(pending);
  }
});

test("real PostgreSQL: all eighteen migrations apply and replay without resetting the halt or accounting", async (t) => {
  const h = await fixture(t);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).rows[0].n, 18);
  t.diagnostic(`PostgreSQL ${(await h.pool.query("SHOW server_version")).rows[0].server_version}; migrations 0000–0017`);
  await h.pool.query("UPDATE analysis_accounting_controls SET payload = '{\"halted\":true}'::jsonb WHERE id='global'");
  await runDatabaseMigrations(h.connection);
  assert.equal((await h.repository.getAnalysisAccountingControl()).halted, true);
});

test("real PostgreSQL: twenty independent quota consumers cannot overspend the shared RPM", async (t) => {
  const h = await fixture(t);
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
    new PostgresAnalysisQuotaStore(h.repository.database).consume(quotaCommand(i + 1), new AbortController().signal, () => undefined)));
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_provider_quota_charges")).rows[0].n, 3);
  assert.ok(h.pool.totalCount > 1);
});

test("real PostgreSQL: concurrent duplicate quota charges commit once and survive reconnection and guide deletion", async (t) => {
  const h = await fixture(t); await h.seed(); const command = quotaCommand();
  const store = new PostgresAnalysisQuotaStore(h.repository.database);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => store.consume(command, new AbortController().signal, () => undefined)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  await h.pool.query("DELETE FROM guides WHERE id='guide'");
  const pool = new Pool({ connectionString: h.connection, max: 1 });
  try {
    const reopened = new PostgresAnalysisQuotaStore(PostgresGuideRepository.fromPool(pool).database);
    await assert.rejects(reopened.consume(command, new AbortController().signal, () => undefined), /PROVIDER_QUOTA_REPLAY/);
  } finally { await pool.end(); }
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_provider_quota_charges")).rows[0].n, 1);
});

test("real PostgreSQL: quota insert failure or post-insert revocation rolls back every charge", async (t) => {
  const h = await fixture(t); const store = new PostgresAnalysisQuotaStore(h.repository.database);
  await h.pool.query("CREATE FUNCTION reject_quota() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private database error'; END $$");
  await h.pool.query("CREATE TRIGGER reject_quota BEFORE INSERT ON analysis_provider_quota_charges FOR EACH ROW EXECUTE FUNCTION reject_quota()");
  await assert.rejects(store.consume(quotaCommand(), new AbortController().signal, () => undefined), /^AnalysisQuotaChargeError: PROVIDER_QUOTA_UNAVAILABLE$/);
  await h.pool.query("DROP TRIGGER reject_quota ON analysis_provider_quota_charges");
  let guards = 0;
  await assert.rejects(store.consume(quotaCommand(), new AbortController().signal, () => { if (++guards === 4) throw new Error("revoked"); }), /PROVIDER_QUOTA_UNAVAILABLE/);
  assert.equal(guards, 4);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_provider_quota_charges")).rows[0].n, 0);
  await assert.rejects(store.consume(quotaCommand(), new AbortController().signal, async () => undefined), /PROVIDER_QUOTA_UNAVAILABLE/);
});

test("real PostgreSQL: quota waiter rechecks abort and halt after obtaining the global lock", async (t) => {
  const h = await fixture(t); const store = new PostgresAnalysisQuotaStore(h.repository.database);
  const blocker = await h.pool.connect(); const controller = new AbortController();
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM analysis_accounting_controls WHERE id='global' FOR UPDATE");
    const pending = store.consume(quotaCommand(), controller.signal, () => undefined);
    const rejected = assert.rejects(pending, /PROVIDER_QUOTA_UNAVAILABLE/);
    await delay(50); controller.abort(); await blocker.query("COMMIT"); await rejected;
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  await h.pool.query("UPDATE analysis_accounting_controls SET payload = '{\"halted\":true}'::jsonb WHERE id='global'");
  await assert.rejects(store.consume(quotaCommand(), new AbortController().signal, () => undefined), /PROVIDER_QUOTA_UNAVAILABLE/);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_provider_quota_charges")).rows[0].n, 0);
});

test("real PostgreSQL: a committed quota receipt is checked at the actual locked launch without network I/O", async (t) => {
  const h = await fixture(t); const { command } = await h.fund(); const owner = await h.begin();
  const send = { ...identity, owner, inputFingerprint: command.expectedInputFingerprint };
  const quota = { ...quotaCommand(), requestKey: quotaRequestKey("guide", send) };
  const receipt = await new PostgresAnalysisQuotaStore(h.repository.database).consume(quota, new AbortController().signal, () => undefined);
  let launches = 0;
  assert.equal(await h.repository.launchAnalysisRequest("guide", send, () => { launches += 1; }, undefined,
    (lockedAt) => assertQuotaPermit(receipt, quota, lockedAt)), true);
  assert.equal(launches, 1);
  await assert.rejects(h.repository.launchAnalysisRequest("guide", send, () => { launches += 1; }, new Date(receipt.validUntil),
    (lockedAt) => assertQuotaPermit(receipt, quota, lockedAt)), /PROVIDER_QUOTA_UNAVAILABLE/);
  assert.equal(launches, 1);
});

test("real PostgreSQL: quota row constraints reject corrupt bounds, timestamps and reset days", async (t) => {
  const h = await fixture(t); const store = new PostgresAnalysisQuotaStore(h.repository.database);
  const receipt = await store.consume(quotaCommand(), new AbortController().signal, () => undefined);
  for (const [column, value] of [["input_token_bound", 0], ["input_token_bound", "9007199254740992"],
    ["charged_at", "invalid"], ["valid_until", new Date(Date.parse(receipt.chargedAt) + 5001).toISOString()], ["day", "2000-01-01"]]) {
    assert.ok(["input_token_bound", "charged_at", "valid_until", "day"].includes(column as string));
    await assert.rejects(h.pool.query(`UPDATE analysis_provider_quota_charges SET ${column} = $1`, [value]));
  }
});

test("real PostgreSQL: twenty simultaneous admissions reserve one run and both windows once", async (t) => {
  const h = await fixture(t); const { command } = await h.seed();
  const outcomes = await Promise.all(Array.from({ length: 20 }, () => h.repository.reserveAnalysisRequest("guide", command, policy)));
  assert.equal(outcomes.filter((r) => r && !r.replayed).length, 1); assert.equal(outcomes.filter((r) => r?.replayed).length, 19);
  assert.equal((await h.rows("analysis_reservations")).length, 1); assert.equal((await h.rows("analysis_runs")).length, 1);
  for (const w of await h.rows("analysis_budget_windows")) assert.equal(w.payload.used.requests, 2);
});

test("real PostgreSQL: twenty claimants on independent connections share one global owner", async (t) => {
  const h = await fixture(t); await h.fund("first"); await h.fund("second");
  const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => h.repository.claimAnalysisWork(i % 2 ? "first" : "second",
    { runId: "run", attemptId: `worker-${i}`, expectedAttemptCount: 0, leaseMs: 30_000 })));
  assert.equal(outcomes.filter((r) => r?.outcome === "claimed").length, 1);
  assert.equal((await h.rows("analysis_runs")).filter((r) => r.status === "running").length, 1);
  assert.ok(h.pool.totalCount > 1);
});

test("real PostgreSQL: duplicate settlements and closures release each budget amount once", async (t) => {
  const h = await fixture(t); await h.fund(); await h.begin();
  const outcomes = await Promise.all(Array.from({ length: 20 }, () => h.repository.executeAnalysisAccounting("guide", { type: "settle", ...identity, usage: known })));
  assert.equal(outcomes.filter((r) => r && !r.replayed).length, 1);
  await h.repository.executeAnalysisCommand("guide", { type: "cancel", runId: "run" });
  const closed = await Promise.all(Array.from({ length: 20 }, () => h.repository.closeAnalysisReservation("guide", "run")));
  assert.equal(closed.filter((r) => r && !r.replayed).length, 1);
  for (const w of await h.rows("analysis_budget_windows")) assert.deepEqual(w.payload.used, { requests: 1, inputTokens: 100, outputTokens: 20, costMicrousd: 14 });
});

test("real PostgreSQL: batch result, settlement and final draft commit as one immutable receipt", async (t) => {
  const h = await fixture(t); const { guide, command } = await h.fund(); const owner = await h.begin();
  const body = { ...identity, owner, expectedInputFingerprint: command.expectedInputFingerprint,
    output: fakeOutput(guide.steps.map((s) => s.id)), inputTokens: 100, outputTokens: 20 };
  const outcomes = await Promise.all(Array.from({ length: 20 }, () => h.repository.completeAnalysisBatch("guide", body)));
  assert.equal(outcomes.filter((r) => r && !r.replayed).length, 1);
  assert.equal((await h.repository.getAnalysisState("guide"))!.draft!.revision, 1);
  assert.equal((await h.repository.getAnalysisState("guide"))!.runs[0].status, "succeeded");
  await h.repository.closeAnalysisReservation("guide", "run");
  assert.equal((await h.repository.completeAnalysisBatch("guide", body))?.replayed, true);
});

test("real PostgreSQL: an actual trigger failure rolls result, draft and discounted windows back together", async (t) => {
  const h = await fixture(t); const { guide, command } = await h.fund(); const owner = await h.begin();
  const before = await Promise.all(["analysis_runs", "analysis_batches", "analysis_request_attempts", "analysis_budget_windows", "guide_drafts"].map(h.rows));
  await h.pool.query("CREATE FUNCTION fail_fixture_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$");
  await h.pool.query("CREATE TRIGGER fail_fixture BEFORE INSERT OR UPDATE ON analysis_batches FOR EACH ROW EXECUTE FUNCTION fail_fixture_write()");
  await assert.rejects(h.repository.completeAnalysisBatch("guide", { ...identity, owner, expectedInputFingerprint: command.expectedInputFingerprint,
    output: fakeOutput(guide.steps.map((s) => s.id)), inputTokens: 100, outputTokens: 20 }));
  assert.deepEqual(await Promise.all(["analysis_runs", "analysis_batches", "analysis_request_attempts", "analysis_budget_windows", "guide_drafts"].map(h.rows)), before);
});

test("real PostgreSQL: cancellation committed while launch waits on the guide lock prevents send", async (t) => {
  const h = await fixture(t); const { command } = await h.fund(); const owner = await h.begin();
  const blocker = await h.pool.connect();
  let sends = 0;
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM guides WHERE id='guide' FOR UPDATE");
    const waiting = async (count: number) => {
      for (let i = 0; i < 250; i++) {
        const row = (await h.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [`showme-b5-${run}`])).rows[0];
        if (row.n >= count) return;
        await delay(10);
      }
      assert.fail("Expected real PostgreSQL lock wait was not observed");
    };
    const cancel = h.repository.executeAnalysisCommand("guide", { type: "cancel", runId: "run" });
    void cancel.catch(() => undefined);
    await waiting(1); // Cancellation is queued on the parent lock before launch can enter.
    const launch = h.repository.launchAnalysisRequest("guide", { ...identity, owner, inputFingerprint: command.expectedInputFingerprint }, () => { sends++; });
    void launch.catch(() => undefined);
    await waiting(2);
    await blocker.query("COMMIT");
    assert.ok(await cancel); assert.equal(await launch, false);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  assert.equal(sends, 0);
});

test("real PostgreSQL: launch releases locks without waiting on its simulated network response", async (t) => {
  const h = await fixture(t); const { command } = await h.fund(); const owner = await h.begin(); let sends = 0;
  let cancel!: Promise<unknown>;
  assert.equal(await h.repository.launchAnalysisRequest("guide", { ...identity, owner, inputFingerprint: command.expectedInputFingerprint }, () => {
    sends++; cancel = h.repository.executeAnalysisCommand("guide", { type: "cancel", runId: "run" });
  }), true);
  assert.ok(await cancel); assert.equal(sends, 1); assert.equal((await h.repository.getAnalysisState("guide"))!.runs[0].status, "cancelled");
});

test("real PostgreSQL: deletion cascades private payloads but retains unknown accounting and safe closure", async (t) => {
  const h = await fixture(t); await h.fund(); await h.begin();
  assert.equal(await h.repository.deleteGuide("guide"), true);
  for (const name of ["guides", "guide_steps", "guide_drafts", "analysis_runs", "analysis_batches"]) assert.deepEqual(await h.rows(name), []);
  assert.equal((await h.rows("analysis_reservations"))[0].details, null);
  assert.equal((await h.rows("analysis_request_attempts"))[0].status, "sending");
  assert.ok(await h.repository.closeAnalysisReservation("guide", "run"));
  const attempt = (await h.rows("analysis_request_attempts"))[0]; assert.equal(attempt.status, "uncertain");
  for (const w of await h.rows("analysis_budget_windows")) assert.deepEqual(w.payload.used, attempt.payload.maximum);
});

test("real PostgreSQL: old-day queue expires and a new request uses its own day", async (t) => {
  const h = await fixture(t); const today = new Date(); const yesterday = new Date(today.valueOf() - 86_400_000);
  const { command } = await h.fund("guide", 2, yesterday);
  assert.deepEqual(await h.repository.listAnalysisClosures(), [{ guideId: "guide", runId: "run" }]);
  assert.ok(await h.repository.closeAnalysisReservation("guide", "run"));
  assert.equal((await h.repository.getAnalysisState("guide"))!.runs[0].status, "failed");
  assert.ok(await h.repository.reserveAnalysisRequest("guide", { ...command, runId: "new-day-request" }, policy));
  const saved = await h.rows("analysis_reservations"); assert.equal(saved.length, 2);
  assert.deepEqual((await h.repository.getAnalysisBudgetWindow(yesterday.toISOString().slice(0, 10), "global"))!.used,
    { requests: 0, inputTokens: 0, outputTokens: 0, costMicrousd: 0 });
});

test("real PostgreSQL: keyset discovery reaches the twenty-first guide without skips or duplicates", async (t) => {
  const h = await fixture(t);
  for (let i = 0; i < 21; i++) await h.fund(`g-${String(i).padStart(2, "0")}`);
  const first = await h.repository.listAnalysisWork(20); assert.equal(first.length, 20);
  const last = first.at(-1)!; const state = (await h.repository.getAnalysisState(last.guideId))!.runs[0];
  const second = await h.repository.listAnalysisWork(20, undefined, { guideId: last.guideId, runId: last.runId,
    availableAt: state.createdAt, createdAt: state.createdAt });
  assert.equal(second.length, 1); assert.equal(new Set([...first, ...second].map((r) => r.guideId)).size, 21);
});

test("real PostgreSQL: a restarted repository recovers qualified retry evidence without dropping maximum usage", async (t) => {
  const h = await fixture(t); await h.fund(); const owner = await h.begin("guide", 1000);
  assert.ok(owner); await h.repository.executeAnalysisAccounting("guide", { type: "settle", ...identity, usage: { status: "unknown" }, retryableHttpStatus: 503 });
  await delay(1020);
  const reopened = PostgresGuideRepository.connect(h.connection, { max: 2 });
  try {
  const claim = await reopened.claimAnalysisWork("guide", { runId: "run", attemptId: "replacement", expectedAttemptCount: 1, leaseMs: 30_000 });
  assert.ok(claim); const retry = { ...identity, ordinal: 1 as const, dispatchId: "retry", owner: { attemptId: "replacement", attemptCount: 2 } };
  assert.ok(await reopened.executeAnalysisAccounting("guide", { type: "allocate", ...retry }));
  assert.ok(await reopened.executeAnalysisAccounting("guide", { type: "sending", ...retry }));
  assert.equal((await reopened.getAnalysisRequestAttempts("guide", "run"))![0].retryableHttpStatus, 503);
  } finally { await reopened.close(); }
});

test("real PostgreSQL: SQL projection constraints reject corrupt work rows", async (t) => {
  const h = await fixture(t); await h.fund();
  await assert.rejects(h.pool.query("UPDATE analysis_runs SET attempt_count=99 WHERE guide_id='guide'"), (e: { code: string }) => e.code === "23514");
  await assert.rejects(h.pool.query("UPDATE analysis_batches SET status='succeeded' WHERE guide_id='guide'"), (e: { code: string }) => e.code === "23514");
  await assert.rejects(h.pool.query("UPDATE analysis_reservations SET released='{\"requests\":1}'::jsonb WHERE guide_id='guide'"), (e: { code: string }) => e.code === "23514");
  assert.equal((await h.repository.getAnalysisState("guide"))!.runs[0].status, "queued");
});

test("real PostgreSQL: overrun halts new spending and survives closure, deletion and reconnection", async (t) => {
  const h = await fixture(t); await h.fund(); await h.begin();
  const receipt = await h.repository.executeAnalysisAccounting("guide", { type: "settle", ...identity, usage: { ...known, inputTokens: 1001 } });
  assert.equal(receipt?.attempt.status, "overrun"); assert.equal((await h.repository.getAnalysisAccountingControl()).halted, true);
  const { command } = await h.seed("other");
  await assert.rejects(h.repository.reserveAnalysisRequest("other", command, policy));
  await h.repository.executeAnalysisCommand("guide", { type: "cancel", runId: "run" });
  await h.repository.closeAnalysisReservation("guide", "run"); await h.repository.deleteGuide("guide");
  const reopened = PostgresGuideRepository.connect(h.connection, { max: 1 });
  try { assert.equal((await reopened.getAnalysisAccountingControl()).halted, true); }
  finally { await reopened.close(); }
  const attempt = (await h.rows("analysis_request_attempts"))[0]; assert.equal(attempt.status, "overrun");
  for (const w of await h.rows("analysis_budget_windows")) assert.deepEqual(w.payload.used, attempt.payload.maximum);
});

test("real PostgreSQL: lease expiry while waiting on a real DB lock prevents the delayed launch", async (t) => {
  const h = await fixture(t); const { command } = await h.fund(); const owner = await h.begin("guide", 1000);
  const blocker = await h.pool.connect(); let sends = 0;
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM analysis_accounting_controls WHERE id='global' FOR UPDATE");
    const launch = h.repository.launchAnalysisRequest("guide", { ...identity, owner, inputFingerprint: command.expectedInputFingerprint }, () => { sends++; });
    void launch.catch(() => undefined);
    await delay(1100); await blocker.query("COMMIT"); assert.equal(await launch, false);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  assert.equal(sends, 0); assert.equal((await h.repository.getAnalysisRequestAttempts("guide", "run"))![0].status, "sending");
});

test("real PostgreSQL: closure's final write failure rolls back expiry, release and unknown conversion", async (t) => {
  const h = await fixture(t); const yesterday = new Date(Date.now() - 86_400_000); await h.fund("guide", 2, yesterday);
  assert.ok(await h.repository.executeAnalysisAccounting("guide", { type: "allocate", ...identity }, yesterday));
  assert.ok(await h.repository.executeAnalysisAccounting("guide", { type: "sending", ...identity }, yesterday));
  const tables = ["analysis_runs", "analysis_reservations", "analysis_request_attempts", "analysis_budget_windows"];
  const before = await Promise.all(tables.map(h.rows));
  await h.pool.query("CREATE FUNCTION fail_fixture_close() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture closure failure'; END $$");
  await h.pool.query("CREATE TRIGGER fail_fixture_close BEFORE UPDATE ON analysis_reservations FOR EACH ROW EXECUTE FUNCTION fail_fixture_close()");
  await assert.rejects(h.repository.closeAnalysisReservation("guide", "run"));
  assert.deepEqual(await Promise.all(tables.map(h.rows)), before);
});

test("real PostgreSQL: legacy 0004 payloads backfill safely through migrations 0005–0012", async (t) => {
  const h = await fixture(t, false);
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  for (const entry of journal.entries.slice(0, 5)) await h.pool.query(await readFile(`drizzle/${entry.tag}.sql`, "utf8"));
  await h.pool.query("INSERT INTO guides(id,slug,edit_token_hash,title,original_object_key,source_filename,source_mime_type,source_size_bytes) VALUES ('legacy','legacy','fixture','fixture','fixture','fixture.mp4','video/mp4',1)");
  const timestamp = new Date().toISOString();
  await h.pool.query("INSERT INTO analysis_runs(guide_id,id,status,payload) VALUES ('legacy','run','queued',$1)", [{ createdAt: timestamp, attemptCount: 0, leaseExpiresAt: null }]);
  const maximum = { requests: 2, inputTokens: 2000, outputTokens: 16384, costMicrousd: 3478 };
  await h.pool.query("INSERT INTO analysis_reservations(guide_id,run_id,day,maximum) VALUES ('legacy','run',$1,$2)", [timestamp.slice(0, 10), maximum]);
  await h.pool.query("INSERT INTO analysis_batches(guide_id,run_id,batch_index,payload) VALUES ('legacy','run',0,$1)", [{ status: "queued", targetIds: ["fixture"], contextIds: [] }]);
  for (const entry of journal.entries.slice(5)) await h.pool.query(await readFile(`drizzle/${entry.tag}.sql`, "utf8"));
  const row = (await h.rows("analysis_runs"))[0]; assert.equal(row.created_at.toISOString(), timestamp); assert.equal(row.attempt_count, 0);
  assert.deepEqual((await h.rows("analysis_reservations"))[0].maximum, maximum);
  assert.equal((await h.rows("analysis_reservations"))[0].closed_at, null); assert.equal((await h.rows("analysis_batches"))[0].status, "queued");
});

async function countFixture(t: TestContext, frames = 2, selected = policy) {
  const h = await fixture(t); const seeded = await h.seed("guide", frames);
  assert.ok(await h.repository.reserveAnalysisRequest("guide", seeded.command, selected));
  const claim = await h.repository.claimAnalysisWork("guide", { runId: "run", attemptId: randomUUID(), expectedAttemptCount: 0, leaseMs: 180_000 });
  assert.ok(claim);
  const owner = { attemptId: claim.run.attemptId!, attemptCount: claim.run.attemptCount };
  const slot = { runId: "run", batchIndex: 0, generationOrdinal: 0 as const };
  const binding = { projectRef: "fictional-project", inputApprovalId: "count-only-fixture", inputFingerprint: seeded.command.expectedInputFingerprint,
    requestFingerprint: "d".repeat(64), model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION } as const;
  const reserve = { type: "reserve" as const, ...slot, binding, owner };
  const execute = (c: AnalysisCountCommand, now?: Date, guard?: () => void) => h.repository.executeAnalysisCount("guide", c, now, guard);
  const send = () => execute({ ...reserve, type: "sending", limits: quotaCommand().limits, notAfter: new Date(Date.now() + 25000).toISOString() });
  const settle = (totalTokens?: number) => execute({ type: "settle", ...slot, bindingHash: countBindingHash(binding),
    usage: totalTokens === undefined ? { status: "unknown" } : { status: "known", totalTokens } });
  const recover = () => execute({ type: "recover", ...slot, bindingHash: countBindingHash(binding) });
  const counts = async () => (await h.pool.query("SELECT * FROM analysis_count_attempts ORDER BY request_key")).rows;
  const quotas = async () => (await h.pool.query("SELECT * FROM analysis_provider_quota_charges ORDER BY request_key")).rows;
  return { ...h, ...seeded, claim, owner, slot, binding, reserve, execute, send, settle, recover, counts, quotas };
}

test("real PostgreSQL: twenty duplicate count reservations add one separate request to both shared budgets", async (t) => {
  const h = await countFixture(t); const before = await h.rows("analysis_budget_windows");
  const results = await Promise.all(Array.from({ length: 20 }, () => h.execute(h.reserve)));
  assert.equal(results.filter((r) => !r.replayed).length, 1); assert.equal(results.filter((r) => r.replayed).length, 19);
  assert.equal((await h.counts()).length, 1); assert.equal((await h.rows("analysis_request_attempts")).length, 0);
  const windows = await h.rows("analysis_budget_windows");
  windows.forEach((w, i) => { assert.equal(w.payload.used.requests, before[i].payload.used.requests + 1);
    assert.equal(w.payload.used.inputTokens, before[i].payload.used.inputTokens + 1000); assert.equal(w.payload.used.outputTokens, before[i].payload.used.outputTokens); });
  assert.equal((await h.quotas()).length, 0);
});

test("real PostgreSQL: concurrent count sends commit once and a lost acknowledgement cannot reissue the slot", async (t) => {
  const h = await countFixture(t); await h.execute(h.reserve);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => h.send()));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1); assert.equal((await h.quotas()).length, 1);
  const pool = new Pool({ connectionString: h.connection, max: 2 });
  try {
    const reopened = PostgresGuideRepository.fromPool(pool);
    const record = (await reopened.listPendingAnalysisCounts())[0]; assert.equal(record.status, "sending");
    // Simulates caller losing the successful return, not a real TCP/COMMIT response loss.
    await assert.rejects(reopened.executeAnalysisCount("guide", { ...h.reserve, type: "sending", limits: quotaCommand().limits,
      notAfter: new Date(Date.now() + 20000).toISOString() }), /ANALYSIS_COUNT_UNAVAILABLE/);
    assert.equal((await reopened.executeAnalysisCount("guide", h.reserve)).quotaReceipt, null);
  } finally { await pool.end(); }
  assert.equal((await h.quotas()).length, 1);
});

test("real PostgreSQL: count and generation consumers cannot each spend the full project RPM", async (t) => {
  const h = await countFixture(t); await h.execute(h.reserve); await h.send(); await h.settle(100);
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
    new PostgresAnalysisQuotaStore(h.repository.database).consume(quotaCommand(i + 1), new AbortController().signal, () => undefined)));
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 2); assert.equal((await h.quotas()).length, 3);
});

test("real PostgreSQL: count reservation and later generation admission share the original daily cap", async (t) => {
  const cap = { ...limit, requests: 3 }; const selected = { ...policy, globalLimit: cap, guideLimit: cap };
  const h = await countFixture(t, 2, selected); await h.execute(h.reserve);
  const second = await h.seed("second");
  await assert.rejects(h.repository.reserveAnalysisRequest("second", second.command, selected), /ANALYSIS_BUDGET_LIMIT/);
  assert.equal((await h.rows("analysis_reservations")).length, 1); assert.equal((await h.rows("analysis_budget_windows")).length, 2);
  for (const w of await h.rows("analysis_budget_windows")) assert.equal(w.payload.used.requests, 3);
});

test("real PostgreSQL: count reservation rejects either exhausted global or guide headroom", async (t) => {
  for (const scope of ["globalLimit", "guideLimit"] as const) {
    const h = await countFixture(t, 2, { ...policy, [scope]: { ...limit, requests: 2 } });
    const before = await h.rows("analysis_budget_windows");
    await assert.rejects(h.execute(h.reserve), /ANALYSIS_COUNT_LIMIT/); assert.equal((await h.counts()).length, 0);
    assert.deepEqual(await h.rows("analysis_budget_windows"), before);
  }
});

test("real PostgreSQL: failed count insert or sending write rolls back both budgets and the provider charge", async (t) => {
  const h = await countFixture(t); const before = await h.rows("analysis_budget_windows");
  await h.pool.query("CREATE FUNCTION reject_count() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private error'; END $$");
  await h.pool.query("CREATE TRIGGER reject_count BEFORE INSERT OR UPDATE ON analysis_count_attempts FOR EACH ROW EXECUTE FUNCTION reject_count()");
  await assert.rejects(h.execute(h.reserve), /^AnalysisCountError: ANALYSIS_COUNT_UNAVAILABLE$/);
  assert.deepEqual(await h.rows("analysis_budget_windows"), before); assert.equal((await h.counts()).length, 0);
  await h.pool.query("DROP TRIGGER reject_count ON analysis_count_attempts"); await h.execute(h.reserve);
  await h.pool.query("CREATE TRIGGER reject_count BEFORE UPDATE ON analysis_count_attempts FOR EACH ROW EXECUTE FUNCTION reject_count()");
  const reserved = await h.counts(); await assert.rejects(h.send(), /ANALYSIS_COUNT_UNAVAILABLE/);
  assert.deepEqual(await h.counts(), reserved); assert.equal((await h.quotas()).length, 0);
});

test("real PostgreSQL: cancellation while waiting and post-write revocation prevent count transitions", async (t) => {
  const h = await countFixture(t); await h.execute(h.reserve);
  const blocker = await h.pool.connect(); let revoked = false;
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM analysis_accounting_controls WHERE id='global' FOR UPDATE");
    const pending = h.execute({ ...h.reserve, type: "sending", limits: quotaCommand().limits, notAfter: new Date(Date.now() + 20000).toISOString() },
      undefined, () => { if (revoked) throw new Error("revoked"); });
    const rejected = assert.rejects(pending, /ANALYSIS_COUNT_UNAVAILABLE/); await delay(50); revoked = true;
    await blocker.query("COMMIT"); await rejected;
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  let guards = 0;
  await assert.rejects(h.execute({ ...h.reserve, type: "sending", limits: quotaCommand().limits, notAfter: new Date(Date.now() + 20000).toISOString() },
    undefined, () => { if (++guards === 4) throw new Error("revoked after writes"); }), /ANALYSIS_COUNT_UNAVAILABLE/);
  assert.equal(guards, 4); assert.equal((await h.quotas()).length, 0); assert.equal((await h.counts())[0].status, "reserved");
  await h.repository.executeAnalysisCommand("guide", { type: "cancel", runId: "run" });
  await assert.rejects(h.send(), /ANALYSIS_COUNT_UNAVAILABLE/); assert.equal((await h.recover()).record.status, "released");
});

test("real PostgreSQL: count and generation settlements refund only their own amounts once", async (t) => {
  const h = await countFixture(t); await h.execute(h.reserve); await h.send();
  const settled = await Promise.all(Array.from({ length: 20 }, () => h.settle(100)));
  assert.equal(settled.filter((r) => !r.replayed).length, 1);
  await h.repository.executeAnalysisAccounting("guide", { type: "allocate", ...identity, owner: h.owner });
  await h.repository.executeAnalysisAccounting("guide", { type: "sending", ...identity, owner: h.owner });
  await h.repository.executeAnalysisAccounting("guide", { type: "settle", ...identity, usage: known });
  await h.repository.executeAnalysisCommand("guide", { type: "cancel", runId: "run" });
  await h.repository.closeAnalysisReservation("guide", "run");
  for (const w of await h.rows("analysis_budget_windows")) assert.deepEqual(w.payload.used,
    { requests: 2, inputTokens: 200, outputTokens: 20, costMicrousd: 24 });
  assert.equal((await h.quotas()).length, 1); // Count settlement never refunds rate usage.
});

test("real PostgreSQL: expired count recovery survives reconnection and never starts an uncertain request again", async (t) => {
  const h = await countFixture(t, 8); await h.execute(h.reserve);
  const second = { ...h.reserve, batchIndex: 1 }; await h.execute(second); await h.send();
  const pool = new Pool({ connectionString: h.connection, max: 2 });
  try {
    const reopened = PostgresGuideRepository.fromPool(pool); const firstPage = await reopened.listPendingAnalysisCounts(1);
    const secondPage = await reopened.listPendingAnalysisCounts(1, firstPage[0].requestKey);
    assert.equal(firstPage.length, 1); assert.equal(secondPage.length, 1); assert.notEqual(firstPage[0].requestKey, secondPage[0].requestKey);
    const at = new Date(h.claim.run.leaseExpiresAt!);
    for (const r of [...firstPage, ...secondPage]) {
      const recovered = await reopened.executeAnalysisCount("guide", { type: "recover", runId: r.runId, batchIndex: r.batchIndex,
        generationOrdinal: r.generationOrdinal, bindingHash: r.bindingHash }, at);
      assert.equal(recovered.record.status, r.status === "sending" ? "uncertain" : "released");
    }
    assert.deepEqual(await reopened.listPendingAnalysisCounts(), []);
    await assert.rejects(reopened.executeAnalysisCount("guide", { ...h.reserve, type: "sending", limits: quotaCommand().limits,
      notAfter: new Date(at.valueOf() + 20000).toISOString() }, at), /ANALYSIS_COUNT_UNAVAILABLE/);
  } finally { await pool.end(); }
  assert.equal((await h.quotas()).length, 1);
});

test("real PostgreSQL: deleting a guide retains count usage and permits only numeric late settlement", async (t) => {
  const h = await countFixture(t); await h.execute(h.reserve); await h.send();
  await h.repository.deleteGuide("guide"); await h.repository.closeAnalysisReservation("guide", "run");
  assert.equal((await h.recover()).record.status, "uncertain");
  const before = await h.rows("analysis_budget_windows"); assert.ok(before.every((w) => w.payload.used.requests === 1));
  assert.equal((await h.settle(100)).record.status, "settled");
  assert.equal((await h.rows("guides")).length, 0); assert.equal((await h.rows("analysis_reservations"))[0].details, null);
  assert.equal((await h.counts()).length, 1); assert.equal((await h.quotas()).length, 1);
  assert.ok(!JSON.stringify(await h.counts()).includes(h.binding.inputApprovalId));
});

test("real PostgreSQL: a count overrun and the shared halt commit together or roll back together", async (t) => {
  const h = await countFixture(t); await h.execute(h.reserve); await h.send(); const before = await h.rows("analysis_budget_windows");
  await h.pool.query("CREATE FUNCTION reject_count_halt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private error'; END $$");
  await h.pool.query("CREATE TRIGGER reject_count_halt BEFORE UPDATE ON analysis_accounting_controls FOR EACH ROW EXECUTE FUNCTION reject_count_halt()");
  await assert.rejects(h.settle(1001), /ANALYSIS_COUNT_UNAVAILABLE/);
  assert.equal((await h.counts())[0].status, "sending"); assert.equal((await h.repository.getAnalysisAccountingControl()).halted, false);
  await h.pool.query("DROP TRIGGER reject_count_halt ON analysis_accounting_controls");
  assert.equal((await h.settle(1001)).halted, true); assert.deepEqual(await h.rows("analysis_budget_windows"), before);
  assert.equal((await h.settle(1001)).replayed, true); await assert.rejects(h.settle(100), /ANALYSIS_COUNT_UNAVAILABLE/);
  await h.repository.deleteGuide("guide"); assert.equal((await h.repository.getAnalysisAccountingControl()).halted, true);
});

test("real PostgreSQL: count constraints reject malformed operation, units and slot projections", async (t) => {
  const h = await countFixture(t); const r = (await h.execute(h.reserve)).record;
  const payload = (await h.counts())[0].payload;
  for (const changed of [{ ...payload, operation: "generateContent" }, { ...payload, maximum: { ...r.maximum, requests: 2 } },
    { ...payload, charged: { ...r.charged, inputTokens: 1001 } }, { ...payload, charged: { ...r.charged, inputTokens: 0.5 } },
    { ...payload, maximum: { ...r.maximum, inputTokens: "9007199254740992" } }]) {
    await assert.rejects(h.pool.query("UPDATE analysis_count_attempts SET payload=$1", [changed]));
  }
  await assert.rejects(h.pool.query("UPDATE analysis_count_attempts SET generation_ordinal=2"));
  await assert.rejects(h.pool.query("UPDATE analysis_count_attempts SET status='succeeded'"));
  // A valid-shaped but wrong scope must not make the quota query overlook this project's charges.
  await h.pool.query("UPDATE analysis_count_attempts SET payload=$1", [{ ...payload, scopeKey: "b".repeat(64) }]);
  await assert.rejects(h.send(), /ANALYSIS_COUNT_INVALID/); assert.equal((await h.quotas()).length, 0);
  await h.pool.query("UPDATE analysis_count_attempts SET payload=$1", [payload]);
  await runDatabaseMigrations(h.connection); assert.equal((await h.counts()).length, 1);
});

async function launchFixture(t: TestContext) {
  const h = await countFixture(t); await h.execute(h.reserve); await h.send();
  const command = { ...h.reserve, type: "claim-launch" as const, limits: quotaCommand().limits,
    notAfter: new Date(Date.now() + 20000).toISOString() };
  const ticket = await h.repository.claimAnalysisCountLaunch("guide", command);
  return { ...h, command, ticket };
}

test("real PostgreSQL: twenty launch claims mint one ticket and twenty uses of that ticket launch once", async (t) => {
  const h = await countFixture(t); await h.execute(h.reserve); await h.send();
  const command = { ...h.reserve, type: "claim-launch" as const, limits: quotaCommand().limits,
    notAfter: new Date(Date.now() + 20000).toISOString() };
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => h.repository.claimAnalysisCountLaunch("guide", command)));
  const success = outcomes.filter((r) => r.status === "fulfilled"); assert.equal(success.length, 1);
  const ticket = success[0].value; let launches = 0;
  assert.equal(await h.repository.launchAnalysisCount(structuredClone(ticket), () => { launches++; }), false);
  assert.equal(await PostgresGuideRepository.fromPool(h.pool).launchAnalysisCount(ticket, () => { launches++; }), false);
  const launched = await Promise.all(Array.from({ length: 20 }, () => h.repository.launchAnalysisCount(ticket, () => { launches++; })));
  assert.equal(launched.filter(Boolean).length, 1); assert.equal(launches, 1);
  assert.equal((await h.counts())[0].status, "launch_claimed"); assert.equal((await h.quotas()).length, 1);
});

test("real PostgreSQL: acknowledged launch claim loss and reconnect cannot reconstruct permission", async (t) => {
  const h = await launchFixture(t); const reconnected = PostgresGuideRepository.fromPool(h.pool); let launches = 0;
  // Discarding the successful ticket models lost acknowledgement; no TCP fault is injected.
  await assert.rejects(reconnected.claimAnalysisCountLaunch("guide", h.command), /ANALYSIS_COUNT_UNAVAILABLE/);
  assert.equal(await reconnected.launchAnalysisCount(h.ticket, () => { launches++; }), false);
  const recovered = await reconnected.executeAnalysisCount("guide", { type: "recover", ...h.slot,
    bindingHash: countBindingHash(h.binding) }, new Date(h.claim.run.leaseExpiresAt!));
  assert.equal(recovered.record.status, "uncertain"); assert.equal(recovered.record.charged.inputTokens, 1000);
  assert.equal(await h.repository.launchAnalysisCount(h.ticket, () => { launches++; }), false); assert.equal(launches, 0);
});

test("real PostgreSQL: cancellation, deletion and quota expiry after claim block launch forever", async (t) => {
  for (const kind of ["cancel", "delete", "quota-expiry", "async-guard"] as const) {
    const h = await launchFixture(t); let launches = 0; const launch = () => { launches++; };
    if (kind === "cancel") await h.repository.executeAnalysisCommand("guide", { type: "cancel", runId: "run" });
    if (kind === "delete") await h.repository.deleteGuide("guide");
    if (kind === "delete") assert.equal(await h.repository.launchAnalysisCount(h.ticket, launch), false);
    else await assert.rejects(h.repository.launchAnalysisCount(h.ticket, launch,
      kind === "quota-expiry" ? new Date((await h.quotas())[0].valid_until) : undefined,
      kind === "async-guard" ? async () => {} : undefined), /ANALYSIS_COUNT_UNAVAILABLE/);
    assert.equal(await h.repository.launchAnalysisCount(h.ticket, launch), false);
    assert.equal(launches, 0); assert.equal((await h.counts())[0].payload.charged.inputTokens, 1000);
  }
});

test("real PostgreSQL: launch rechecks revocation after waiting for a DB lock and consumes the ticket even on failure", async (t) => {
  const h = await launchFixture(t); const blocker = await h.pool.connect(); let revoked = false; let launches = 0;
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM analysis_accounting_controls WHERE id='global' FOR UPDATE");
    const pending = h.repository.launchAnalysisCount(h.ticket, () => { launches++; }, undefined, () => { if (revoked) throw new Error("revoked"); });
    const rejected = assert.rejects(pending, /ANALYSIS_COUNT_UNAVAILABLE/); await delay(50); revoked = true;
    await blocker.query("COMMIT"); await rejected;
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  assert.equal(await h.repository.launchAnalysisCount(h.ticket, () => { launches++; }), false); assert.equal(launches, 0);
});

test("real PostgreSQL: final launch performs no writes and does not hold cancellation while awaiting the response", async (t) => {
  const h = await launchFixture(t); const before = await h.counts(); let launches = 0; let cancelled: Promise<unknown> | undefined;
  await h.pool.query("CREATE FUNCTION reject_launch_writes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unexpected launch write'; END $$");
  for (const table of ["analysis_count_attempts", "analysis_provider_quota_charges", "analysis_budget_windows", "analysis_accounting_controls"]) {
    await h.pool.query(`CREATE TRIGGER reject_launch_writes BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_launch_writes()`);
  }
  assert.equal(await h.repository.launchAnalysisCount(h.ticket, () => {
    launches++; cancelled = h.repository.executeAnalysisCommand("guide", { type: "cancel", runId: "run" });
  }), true);
  await cancelled; assert.equal(launches, 1); assert.deepEqual(await h.counts(), before);
  assert.equal((await h.repository.getAnalysisState("guide"))!.runs[0].status, "cancelled");
});

test("real PostgreSQL: failed launch claim transaction cannot leak a ticket or duplicate quota", async (t) => {
  const h = await countFixture(t); await h.execute(h.reserve); await h.send();
  const command = { ...h.reserve, type: "claim-launch" as const, limits: quotaCommand().limits,
    notAfter: new Date(Date.now() + 20000).toISOString() };
  let guards = 0;
  await assert.rejects(h.repository.claimAnalysisCountLaunch("guide", command, undefined, () => {
    if (++guards === 4) throw new Error("revoked after writes");
  }), /ANALYSIS_COUNT_UNAVAILABLE/);
  assert.equal(guards, 4); assert.equal((await h.counts())[0].status, "sending"); assert.equal((await h.quotas()).length, 1);
  const ticket = await h.repository.claimAnalysisCountLaunch("guide", command); let launches = 0;
  assert.equal(await h.repository.launchAnalysisCount(ticket, () => { launches++; }), true); assert.equal(launches, 1);
});

function pipelineReadiness(guideId: string, fingerprint: string, countFirst = false): AnalysisAdmissionReadiness {
  const operationsBasis = operationsBasisFixture(new Date(), "fictional-free-evidence");
  return { async inspect(input) {
    const snapshot: AnalysisAdmissionSnapshot = { ...input, id: "pg-pipeline-fixture", guideId, inputFingerprint: fingerprint,
      checkedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 25000).toISOString(), scope: "approved_synthetic",
      inputApprovalId: "pg-pipeline-approval", runtime: { repository: "postgres-0008", dispatcher: "durable-accounted-v1",
        counting: "count-accounted-0010-v1", ...(countFirst
          ? { inputTokenLimit: 1000, countPolicy: { ...SYNTHETIC_COUNT_LIMITS } }
          : { inputTokenBound: 1000, boundIncludes: "prompt-schema-targets-context" as const }) }, policy,
      entitlement: { mode: "free_only", projectRef: "pg-pipeline-project", evidenceId: "fictional-free-evidence", paidFallback: false,
        operationsBasis,
        providerLimits: { requestsPerMinute: 15, inputTokensPerMinute: 250000, requestsPerDay: 100, resetTimeZone: "America/Los_Angeles" } } };
    return snapshot;
  }, isCurrent: () => true };
}

test("real PostgreSQL: counted measurements and generation dispatcher complete together using mock HTTP only", async (t) => {
  for (const countFails of [false, true]) {
    const h = await fixture(t); const { guide, command } = await h.fund();
    const readiness = pipelineReadiness("guide", command.expectedInputFingerprint);
    const inputBoundVerifier = inputBoundFixture(() => new Date()); const events: string[] = []; let countedBody: unknown;
    const inputMeasurementStage = new AccountedGeminiMeasurements({ repository: h.repository, readiness, inputBoundVerifier,
      apiKey: "fictional-pg-key", allowExternalProcessing: true, fetch: async (url, init) => {
        assert.ok(String(url).endsWith(":countTokens")); events.push("count");
        assert.equal((await h.pool.query("SELECT status FROM analysis_count_attempts")).rows[0].status, "launch_claimed");
        assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_provider_quota_charges")).rows[0].n, 1);
        const { model, ...body } = JSON.parse(String(init?.body)).generateContentRequest;
        assert.equal(model, `models/${GEMINI_TEST_MODEL}`); countedBody = body;
        return countFails ? new Response(null, { status: 503 }) : Response.json({ totalTokens: 321 });
      } });
    const provider = new GeminiAnalysisProvider({ model: GEMINI_TEST_MODEL, apiKey: "fictional-pg-key", allowExternalProcessing: true,
      transientRetries: 0, reserveRequest: async () => {}, fetch: async (url, init) => {
        assert.ok(String(url).endsWith(":generateContent")); events.push("generate");
        assert.deepEqual(JSON.parse(String(init?.body)), countedBody);
        assert.equal((await h.pool.query("SELECT status FROM analysis_count_attempts")).rows[0].status, "settled");
        assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_provider_quota_charges")).rows[0].n, 2);
        return Response.json({ modelVersion: GEMINI_TEST_MODEL,
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(fakeOutput(guide.steps.map((s) => s.id))) }] } }],
          usageMetadata: { promptTokenCount: 322, candidatesTokenCount: 20, thoughtsTokenCount: 0, totalTokenCount: 342 } });
      } });
    const dispatcher = new DurableAnalysisDispatcher({ repository: h.repository, provider, readiness, inputBoundVerifier, inputMeasurementStage,
      quotaStore: new PostgresAnalysisQuotaStore(h.repository.database), loadImage: async () => new Uint8Array([255, 216, 255, 217]), statusPollMs: 500 });
    t.after(() => dispatcher.stop());
    assert.equal(await dispatcher.tick(), countFails ? "unavailable" : "completed");
    assert.deepEqual(events, countFails ? ["count"] : ["count", "generate"]);
    const analysis = (await h.repository.getAnalysisState("guide"))!;
    assert.equal(analysis.runs[0].status, countFails ? "failed" : "succeeded"); assert.equal(analysis.draft!.revision, countFails ? 0 : 1);
    for (const w of await h.rows("analysis_budget_windows")) assert.deepEqual(w.payload.used, countFails
      ? { requests: 1, inputTokens: 1000, outputTokens: 0, costMicrousd: 100 }
      : { requests: 2, inputTokens: 643, outputTokens: 20, costMicrousd: 70 });
    assert.equal(await dispatcher.tick(), "idle"); assert.equal(events.length, countFails ? 1 : 2);
  }
});

test("real PostgreSQL: late count result after cancellation settles usage but cannot create a measurement", async (t) => {
  const h = await countFixture(t); const manifest = analysisManifest(h.guide); const batch = analysisBatches(manifest.frames)[0];
  const input = { ...batch, images: batch.targets.map((f) => ({ stepId: f.stepId, mimeType: "image/jpeg" as const, bytes: new Uint8Array([255, 216, 255, 217]) })) };
  const readiness = pipelineReadiness("guide", manifest.fingerprint); let approved = true; readiness.isCurrent = () => approved;
  const stage = new AccountedGeminiMeasurements({ repository: h.repository, readiness, inputBoundVerifier: inputBoundFixture(() => new Date()),
    apiKey: "fictional-pg-key", allowExternalProcessing: true, fetch: async () => {
      await h.repository.executeAnalysisCommand("guide", { type: "cancel", runId: "run" }); approved = false;
      return Response.json({ totalTokens: 321 });
    } });
  const signal = new AbortController().signal;
  const scope = { ...auditGeminiInput(input, "pg-pipeline-approval", manifest.fingerprint), projectRef: "pg-pipeline-project" };
  await assert.rejects(stage.measureForAnalysis(input, scope, { guideId: "guide", ...h.slot, frameCount: 2, owner: h.owner, policy }, signal));
  assert.equal((await h.counts())[0].status, "settled"); assert.equal((await h.counts())[0].payload.charged.inputTokens, 321);
  assert.equal(await stage.inspect(scope, signal), null); assert.equal((await h.quotas()).length, 1);
});

test("real PostgreSQL: count-first pipeline has no bound verifier and gates generation on durable exact measurements", async (t) => {
  for (const outcome of ["ok", "overrun", "cancel", "http-failure"] as const) {
    const h = await fixture(t); const { guide, command } = await h.fund(); let approved = true;
    const readiness = pipelineReadiness("guide", command.expectedInputFingerprint, true); readiness.isCurrent = () => approved;
    const events: string[] = []; let countedBody: unknown;
    const stage = new AccountedGeminiMeasurements({ repository: h.repository, readiness,
      apiKey: "fictional-pg-key", allowExternalProcessing: true, fetch: async (url, init) => {
        assert.ok(String(url).endsWith(":countTokens")); events.push("count");
        const rows = (await h.pool.query("SELECT status, payload FROM analysis_count_attempts")).rows;
        assert.equal(rows.length, 1); assert.equal(rows[0].status, "launch_claimed");
        assert.equal(rows[0].payload.inputAccounting, "acceptance-allowance");
        const { model, ...body } = JSON.parse(String(init?.body)).generateContentRequest;
        assert.equal(model, `models/${GEMINI_TEST_MODEL}`); countedBody = body;
        if (outcome === "cancel") { await h.repository.executeAnalysisCommand("guide", { type: "cancel", runId: "run" }); approved = false; }
        return outcome === "http-failure" ? new Response(null, { status: 503 }) : Response.json({ totalTokens: outcome === "overrun" ? 1001 : 321 });
      } });
    const provider = new GeminiAnalysisProvider({ model: GEMINI_TEST_MODEL, apiKey: "fictional-pg-key", allowExternalProcessing: true,
      transientRetries: 0, reserveRequest: async () => {}, fetch: async (url, init) => {
        assert.ok(String(url).endsWith(":generateContent")); assert.equal(outcome, "ok"); events.push("generate");
        assert.deepEqual(JSON.parse(String(init?.body)), countedBody);
        assert.equal((await h.pool.query("SELECT status FROM analysis_count_attempts")).rows[0].status, "settled");
        return Response.json({ modelVersion: GEMINI_TEST_MODEL,
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(fakeOutput(guide.steps.map((s) => s.id))) }] } }],
          usageMetadata: { promptTokenCount: 322, candidatesTokenCount: 20, thoughtsTokenCount: 0, totalTokenCount: 342 } });
      } });
    const worker = new DurableAnalysisDispatcher({ repository: h.repository, provider, readiness, inputMeasurementStage: stage,
      quotaStore: new PostgresAnalysisQuotaStore(h.repository.database), loadImage: async () => new Uint8Array([255, 216, 255, 217]), statusPollMs: 500 });
    t.after(() => worker.stop());
    assert.equal(await worker.tick(), outcome === "ok" ? "completed" : "unavailable", outcome);
    assert.deepEqual(events, outcome === "ok" ? ["count", "generate"] : ["count"]);
    const record = (await h.pool.query("SELECT status, payload FROM analysis_count_attempts")).rows[0];
    assert.equal(record.status, outcome === "overrun" ? "overrun" : outcome === "http-failure" ? "uncertain" : "settled");
    assert.equal((await h.repository.getAnalysisAccountingControl()).halted, outcome === "overrun");
    if (outcome === "overrun") assert.deepEqual(record.payload.usage, { status: "known", totalTokens: 1001 });
    assert.equal((await h.repository.getAnalysisState("guide"))?.draft?.revision, outcome === "ok" ? 1 : 0);
    assert.equal(await worker.tick(), "idle"); assert.equal(events.length, outcome === "ok" ? 2 : 1);
    const reopened = new Pool({ connectionString: h.connection, max: 1 });
    try { assert.equal((await reopened.query("SELECT payload FROM analysis_count_attempts")).rows[0].payload.inputAccounting, "acceptance-allowance"); }
    finally { await reopened.end(); }
  }
});

test("real PostgreSQL: composed fixed-synthetic runtime checks real DB, operator record and real JPEGs before count and generation", async (t) => {
  const h = await fixture(t); const { guide, command } = await h.seed("guide", 2, true);
  const screens = await syntheticAnalysisInput(); const change = operatorCommand();
  change.review.storageRef = syntheticStorageRef("fictional-bucket", "showme-test");
  await operatorStore(h.pool).execute(change, operationsSignal());
  const grant: SyntheticInputGrant = { kind: "fixed-synthetic-screens-v1", approvalId: "fixed-fixture-approval",
    deploymentRef: change.review.deploymentRef, input: { guideId: guide.id, frameCount: 2,
      inputFingerprint: command.expectedInputFingerprint, model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION },
    createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
    inputTokenLimit: 1000, countPolicy: SYNTHETIC_COUNT_LIMITS };
  const reads: string[] = [], sends: string[] = []; let countedBody: unknown;
  const activate = activationCommand(change, grant);
  await operatorStore(h.pool).executeActivation(activate, operationsSignal());
  const runtime = createFixedSyntheticAnalysisRuntime({ pool: h.pool, grant, activationId: activate.commandId, migrationsFolder: resolve("drizzle"), ffmpegPath: testMediaPaths().ffmpegPath,
    config: { deploymentRef: change.review.deploymentRef, projectRef: change.review.projectRef,
      credentialRef: change.review.credentialRef, bucketId: "fictional-bucket", prefix: "showme-test" },
    apiKey: "fictional-fixture-key", allowExternalProcessing: true,
    storageClient: { downloadAsStream: async (name: string) => {
      reads.push(name); const index = guide.steps.findIndex((s) => `showme-test/${s.representativeFrameKey}` === name);
      assert.ok(index >= 0); return Readable.from(Buffer.from(screens.images[index].bytes));
    } } as never,
    fetch: async (url, init) => {
      assert.equal(init?.redirect, "error"); const body = JSON.parse(String(init?.body));
      if (String(url).endsWith(":countTokens")) {
        sends.push("count"); const { model: _model, ...request } = body.generateContentRequest; countedBody = request;
        const pixels = request.contents[0].parts.filter((p: { inlineData?: unknown }) => p.inlineData).map((p: { inlineData: { data: string } }) => p.inlineData.data);
        assert.deepEqual(pixels, screens.images.map((image) => Buffer.from(image.bytes).toString("base64")));
        return Response.json({ totalTokens: 321 });
      }
      assert.ok(String(url).endsWith(":generateContent")); sends.push("generate"); assert.deepEqual(body, countedBody);
      return Response.json({ modelVersion: GEMINI_TEST_MODEL,
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(fakeOutput(guide.steps.map((s) => s.id))) }] } }],
        usageMetadata: { promptTokenCount: 322, candidatesTokenCount: 20, totalTokenCount: 342 } });
    } });
  t.after(() => runtime.stop()); assert.equal(reads.length, 0); assert.equal(sends.length, 0);
  const snapshot = await runtime.readiness.inspect(grant.input, operationsSignal());
  assert.equal(runtime.readiness.isCurrent(snapshot.id), true); assert.equal(reads.length, 0);
  assert.equal(await runtime.admission.inspectAvailability(grant.input, operationsSignal()), true);
  assert.equal(reads.length, 0); assert.equal(sends.length, 0);
  assert.ok(await runtime.admission.request(guide.id, command, operationsSignal()));
  assert.equal(await runtime.tick(), "completed"); assert.deepEqual(sends, ["count", "generate"]); assert.equal(reads.length, 2);
  assert.equal((await h.repository.getAnalysisState(guide.id))?.draft?.revision, 1);
  assert.equal(await runtime.tick(), "idle"); assert.equal(sends.length, 2);
  await runtime.stop(); assert.equal(runtime.readiness.isCurrent(snapshot.id), false); assert.equal(await runtime.tick(), "disabled");
  assert.equal((await h.pool.query("SELECT 1 AS ok")).rows[0].ok, 1); // Caller pool remains open.
});

test("real PostgreSQL: composed runtime refuses mismatched binding, revoked review and altered synthetic bytes without AI sends", async (t) => {
  for (const reason of ["binding", "revoked", "pixels"] as const) {
    const h = await fixture(t); const { guide, command } = await h.seed("guide", 2, true);
    const screens = await syntheticAnalysisInput(); const change = operatorCommand();
    change.review.storageRef = syntheticStorageRef("fictional-bucket", "showme-test");
    await operatorStore(h.pool).execute(change, operationsSignal());
    let sends = 0, reads = 0;
    const grant = syntheticGrant(change.review.deploymentRef, guide.id, command.expectedInputFingerprint);
    const activate = activationCommand(change, grant); await operatorStore(h.pool).executeActivation(activate, operationsSignal());
    const runtime = createFixedSyntheticAnalysisRuntime({ pool: h.pool, grant, activationId: activate.commandId, migrationsFolder: resolve("drizzle"), ffmpegPath: testMediaPaths().ffmpegPath,
      config: { deploymentRef: change.review.deploymentRef, projectRef: change.review.projectRef,
        credentialRef: reason === "binding" ? "other-key-version" : change.review.credentialRef, bucketId: "fictional-bucket", prefix: "showme-test" },
      apiKey: "fictional-fixture-key", allowExternalProcessing: true,
      storageClient: { downloadAsStream: async () => { reads++; const bytes = Buffer.from(screens.images[0].bytes); bytes[20] ^= 1; return Readable.from(bytes); } } as never,
      fetch: async () => { sends++; throw new Error("must never send"); } });
    t.after(() => runtime.stop());
    if (reason === "binding") {
      await assert.rejects(runtime.admission.request(guide.id, command, operationsSignal()), /ANALYSIS_UNAVAILABLE/);
      assert.equal(await h.repository.getAnalysisFunding(guide.id, command.runId), null);
    } else {
      assert.ok(await runtime.admission.request(guide.id, command, operationsSignal()));
      if (reason === "revoked") await operatorStore(h.pool).execute({ type: "revoke", commandId: randomUUID(), expectedVersion: 1,
        deploymentRef: change.review.deploymentRef, reviewId: change.review.id }, operationsSignal());
      assert.notEqual(await runtime.tick(), "completed");
    }
    assert.equal(sends, 0); assert.equal(reads, reason === "pixels" ? 1 : 0);
    assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_count_attempts")).rows[0].n, 0);
    await runtime.stop();
  }
});

test("real PostgreSQL: operator entry authenticates a separate minimal-role login for review, activation, stop and revoke", async (t) => {
  const h = await fixture(t); const seeded = await h.seed();
  const before = await h.rows("guides"); const controlsBefore = await h.rows("analysis_accounting_controls");
  const target = new URL(h.connection); let selected: { role: string; password: string } | undefined;
  const connection = { host: target.hostname, port: Number(target.port), database: target.pathname.slice(1), connectionTimeoutMillis: 3000, statement_timeout: 3000 };
  const result = await createOperatorRole({ admin: h.pool, target: connection, persist: async credentials => { selected = credentials; } });
  assert.ok(selected); const { role, password } = selected;
  target.username = role; target.password = password;
  let operatorPool: Pool | undefined;
  try {
    assert.equal(result.aiEnabled, false); assert.equal(result.permissionsChecked, true); assert.equal(result.authenticationChecked, true);
    assert.equal(JSON.stringify(result).includes(password), false);
    assert.deepEqual(await h.rows("guides"), before); assert.deepEqual(await h.rows("analysis_accounting_controls"), controlsBefore);
    await assert.rejects(createOperatorRole({ admin: h.pool, target: connection, persist: async () => assert.fail("no duplicate") }), /SHOWME_OPERATOR_ROLE_SETUP_FAILED/);
    operatorPool = new Pool({ connectionString: target.toString(), max: 1 });
    await h.pool.query(`GRANT SELECT(instruction) ON guide_steps TO "${role}"`);
    await assert.rejects(verifyOperatorRole(operatorPool, role), /SHOWME_OPERATOR_ROLE_INVALID/);
    await h.pool.query(`REVOKE SELECT(instruction) ON guide_steps FROM "${role}"`);
    await verifyOperatorRole(operatorPool, role);
    for (const query of ["SELECT * FROM guides", "SELECT * FROM guide_steps", "SELECT * FROM guide_drafts", "SELECT payload FROM analysis_count_attempts", "SELECT payload FROM analysis_request_attempts", "DELETE FROM analysis_operations_reviews",
      "UPDATE analysis_operations_reviews SET action='revoke'", "DELETE FROM analysis_accounting_controls",
      "SELECT payload FROM analysis_runs", "DELETE FROM analysis_activation_events", "UPDATE analysis_activation_events SET action='deactivate'"]) {
      await assert.rejects(operatorPool.query(query), (error: { code?: string }) => error.code === "42501");
    }
    const command = operatorCommand(); const { reviewerRef: _actor, ...review } = command.review;
    const payload = { ...command, review }; const database = target.pathname.slice(1);
    const invoke = async (action: "put" | "revoke" | "status" | "activate" | "deactivate", raw: unknown, overrides = {}) => {
      const result = await runAnalysisOperationsAdmin({ args: [`--action=${action}`, `--deployment=${review.deploymentRef}`, `--database=${database}`,
        ...(action === "status" ? [] : [action === "activate" ? "--confirm-synthetic-activation" : "--confirm-stop"])], env: { SHOWME_OPERATOR_DATABASE_URL: target.toString(), ...overrides },
        signal: operationsSignal(), readCommand: async () => raw });
      assert.ok(!result.output.includes(password)); assert.ok(!result.output.includes(target.toString())); return result;
    };
    const first = await invoke("put", payload); assert.equal(first.exitCode, 0); assert.equal(JSON.parse(first.output).authorizesAnalysis, false);
    assert.equal((await h.repository.getAnalysisAccountingControl()).halted, true);
    assert.equal((await operatorStore(h.pool).readLatest(review.deploymentRef, operationsSignal()))?.actorRef, operationsActorRef(role));
    assert.equal(JSON.parse((await invoke("put", payload)).output).replayed, true);
    const status = JSON.parse((await invoke("status", null)).output); assert.equal(status.version, 1); assert.equal(status.halted, true);
    const activation = activationCommand(command, syntheticGrant(review.deploymentRef, seeded.guide.id, seeded.command.expectedInputFingerprint));
    assert.equal((await invoke("activate", activation)).exitCode, 0);
    assert.equal((await h.repository.getAnalysisAccountingControl()).activation?.id, activation.commandId);
    assert.equal(JSON.parse((await invoke("status", null)).output).lastActivationVersion, 1);
    const stop = { type: "deactivate", commandId: randomUUID(), expectedVersion: 1, deploymentRef: review.deploymentRef };
    assert.equal((await invoke("deactivate", stop)).exitCode, 0);
    assert.equal((await h.repository.getAnalysisAccountingControl()).halted, true);
    assert.equal(JSON.parse((await invoke("activate", activation)).output).replayed, true);
    assert.equal((await h.repository.getAnalysisAccountingControl()).halted, true);
    const revoke = { type: "revoke", commandId: randomUUID(), expectedVersion: 1, deploymentRef: review.deploymentRef, reviewId: review.id };
    assert.equal((await invoke("revoke", revoke)).exitCode, 0);
    assert.equal(JSON.parse((await invoke("status", null)).output).state, "revoked");
    // Replaying an old write is explicitly not a current-state receipt or permission.
    assert.equal(JSON.parse((await invoke("put", payload)).output).requiresCurrentStatusCheck, true);
    assert.equal(JSON.parse((await invoke("status", null)).output).version, 2);
    assert.equal((await invoke("status", null, { SHOWME_OPERATOR_DATABASE_URL: target.toString().replace(password, "wrong-password") })).exitCode, 1);
    assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_operations_reviews")).rows[0].n, 2);
  } finally {
    await operatorPool?.end(); await h.pool.query(`DROP OWNED BY "${role}"`); await h.pool.query(`DROP ROLE "${role}"`);
  }
});

test("real PostgreSQL: failed operator credential persistence removes only its new role", async t => {
  const h = await fixture(t); const url = new URL(h.connection);
  const before = (await h.pool.query("SELECT rolname FROM pg_roles ORDER BY rolname")).rows;
  await assert.rejects(createOperatorRole({ admin: h.pool,
    target: { host: url.hostname, port: Number(url.port), database: url.pathname.slice(1), connectionTimeoutMillis: 3000 },
    persist: async () => { throw new Error("fictional persistence failure"); } }), /SHOWME_OPERATOR_ROLE_SETUP_FAILED/);
  assert.deepEqual((await h.pool.query("SELECT rolname FROM pg_roles ORDER BY rolname")).rows, before);
});

test("real PostgreSQL: activation is audited, replay cannot reopen a stop and old replicas cannot spend after reactivation", async t => {
  const h = await fixture(t), seeded = await h.seed(), change = operatorCommand();
  const store = operatorStore(h.pool); await store.execute(change, operationsSignal());
  const grant = syntheticGrant(change.review.deploymentRef, seeded.guide.id, seeded.command.expectedInputFingerprint);
  const first = activationCommand(change, grant);
  const result = await store.executeActivation(first, operationsSignal());
  assert.equal(result.entry.version, 1); assert.equal(result.authorizesAnalysis, false); assert.ok(result.entry.activation);
  const oldReplica = PostgresGuideRepository.fromPool(h.pool); bindAnalysisActivation(oldReplica, result.entry.activation);
  await assert.rejects(h.repository.reserveAnalysisRequest(seeded.guide.id, seeded.command, policy), /ANALYSIS_ACCOUNTING_HALTED/);
  await store.executeActivation({ type: "deactivate", commandId: randomUUID(), expectedVersion: 1, deploymentRef: grant.deploymentRef }, operationsSignal());
  const replay = await store.executeActivation(first, operationsSignal()); assert.equal(replay.replayed, true);
  assert.deepEqual(await h.repository.getAnalysisAccountingControl(), { halted: true });
  const second = activationCommand(change, grant, 2);
  const activated = await store.executeActivation(second, operationsSignal()); assert.ok(activated.entry.activation);
  await assert.rejects(oldReplica.reserveAnalysisRequest(seeded.guide.id, seeded.command, policy), /ANALYSIS_ACCOUNTING_HALTED/);
  const current = PostgresGuideRepository.fromPool(h.pool); bindAnalysisActivation(current, activated.entry.activation);
  assert.ok(await current.reserveAnalysisRequest(seeded.guide.id, seeded.command, policy));
  assert.throws(() => bindAnalysisActivation(oldReplica, activated.entry.activation!), /ANALYSIS_ACCOUNTING_HALTED/);
  assert.equal((await store.activationStatus(operationsSignal()))?.version, 3);
  // Review mutation invalidates the permit and its cached readiness in every replica.
  await store.execute({ type: "revoke", commandId: randomUUID(), expectedVersion: 1, deploymentRef: grant.deploymentRef, reviewId: change.review.id }, operationsSignal());
  await assert.rejects(current.claimAnalysisWork(seeded.guide.id, { runId: seeded.command.runId, attemptId: randomUUID(), expectedAttemptCount: 0, leaseMs: 30_000 }), /ANALYSIS_ACCOUNTING_HALTED/);
});

test("real PostgreSQL: activation rejects stale reviews, bad scope, expired grants and simultaneous switches without partial history", async t => {
  const h = await fixture(t), seeded = await h.seed(), change = operatorCommand();
  const store = operatorStore(h.pool); await store.execute(change, operationsSignal());
  const grant = syntheticGrant(change.review.deploymentRef, seeded.guide.id, seeded.command.expectedInputFingerprint);
  const valid = activationCommand(change, grant);
  for (const invalid of [{ ...valid, expectedReviewVersion: 2 }, { ...valid, reviewId: "wrong" },
    { ...valid, grant: { ...grant, deploymentRef: "other" } }, { ...valid, grant: { ...grant, inputTokenLimit: 1001 } },
    { ...valid, grant: { ...grant, expiresAt: new Date(Date.now() - 10_000).toISOString() } },
    { ...valid, grant: { ...grant, input: { ...grant.input, frameCount: 3 } } }]) {
    await assert.rejects(store.executeActivation(invalid, operationsSignal()));
    assert.equal(await store.activationStatus(operationsSignal()), null);
    assert.deepEqual(await h.repository.getAnalysisAccountingControl(), { halted: true });
  }
  await assert.rejects(new PostgresAnalysisOperationsStore({ pool: h.pool }).executeActivation(valid, operationsSignal()), /OPERATIONS_FORBIDDEN/);
  const both = await Promise.allSettled([store.executeActivation(valid, operationsSignal()),
    operatorStore(h.pool).executeActivation({ ...valid, commandId: randomUUID() }, operationsSignal())]);
  assert.equal(both.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM analysis_activation_events")).rows[0].n, 1);
});

test("real PostgreSQL: activation cannot clear unresolved work or unknown prior usage", async t => {
  const h = await fixture(t); const funded = await h.fund(); await h.begin();
  const change = operatorCommand(), store = operatorStore(h.pool); await store.execute(change, operationsSignal());
  const activate = activationCommand(change, syntheticGrant(change.review.deploymentRef, funded.guide.id, funded.command.expectedInputFingerprint));
  await assert.rejects(store.executeActivation(activate, operationsSignal()), /OPERATIONS_CONFLICT/);
  await h.repository.executeAnalysisCommand(funded.guide.id, { type: "cancel", runId: funded.command.runId });
  await h.repository.executeAnalysisAccounting(funded.guide.id, { type: "settle", ...identity, usage: { status: "unknown" } });
  await assert.rejects(store.executeActivation(activate, operationsSignal()), /OPERATIONS_CONFLICT/);
  assert.equal(await store.activationStatus(operationsSignal()), null);
  assert.equal((await h.repository.getAnalysisAccountingControl()).halted, true);
});

test("real PostgreSQL: scoped activation is rechecked at both final send boundaries, not just readiness", async t => {
  for (const boundary of ["count", "generation"] as const) {
  const h = await fixture(t), seeded = await h.seed(), change = operatorCommand(), store = operatorStore(h.pool);
  await store.execute(change, operationsSignal());
  const grant = syntheticGrant(change.review.deploymentRef, seeded.guide.id, seeded.command.expectedInputFingerprint);
  const result = await store.executeActivation(activationCommand(change, grant), operationsSignal()); assert.ok(result.entry.activation);
  bindAnalysisActivation(h.repository, result.entry.activation);
  assert.ok(await h.repository.reserveAnalysisRequest("guide", seeded.command, policy));
  const claim = await h.repository.claimAnalysisWork("guide", { runId: "run", attemptId: randomUUID(), expectedAttemptCount: 0, leaseMs: 30_000 }); assert.ok(claim);
  const owner = { attemptId: claim.run.attemptId!, attemptCount: claim.run.attemptCount };
  let ticket: object | undefined;
  if (boundary === "count") {
  const reserve: Extract<AnalysisCountCommand, { type: "reserve" }> = { type: "reserve", runId: "run", batchIndex: 0, generationOrdinal: 0, owner,
    binding: { projectRef: change.review.projectRef, inputApprovalId: grant.approvalId,
      inputFingerprint: seeded.command.expectedInputFingerprint, requestFingerprint: "d".repeat(64), model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION } };
  await h.repository.executeAnalysisCount("guide", reserve);
  const count = { ...reserve, limits: quotaCommand().limits, notAfter: new Date(Date.now() + 20000).toISOString() };
  await h.repository.executeAnalysisCount("guide", { ...count, type: "sending" });
  ticket = await h.repository.claimAnalysisCountLaunch("guide", { ...count, type: "claim-launch" });
  } else {
    assert.ok(await h.repository.executeAnalysisAccounting("guide", { type: "allocate", ...identity, owner }));
    assert.ok(await h.repository.executeAnalysisAccounting("guide", { type: "sending", ...identity, owner }));
  }
  // Fixture fault injection: force an open switch with a different nonce. This
  // isolates scope fencing from halt handling; real activation refuses pending work.
  await h.pool.query("UPDATE analysis_accounting_controls SET payload=$1 WHERE id='global'",
    [{ halted: false, activation: { ...result.entry.activation, id: randomUUID() } }]);
  let sends = 0;
  if (boundary === "count") {
    assert.ok(ticket); await assert.rejects(h.repository.launchAnalysisCount(ticket, () => { sends++; }), /ANALYSIS_COUNT_UNAVAILABLE/);
    assert.equal(await h.repository.launchAnalysisCount(ticket, () => { sends++; }), false);
  } else await assert.rejects(h.repository.launchAnalysisRequest("guide", { ...identity, owner,
    inputFingerprint: seeded.command.expectedInputFingerprint }, () => { sends++; }), /ANALYSIS_ACCOUNTING_HALTED/);
  assert.equal(sends, 0);
  }
});

test("real PostgreSQL: a silently skipped activation switch rolls back its audit event", async t => {
  const h = await fixture(t), seeded = await h.seed(), change = operatorCommand(), store = operatorStore(h.pool);
  await store.execute(change, operationsSignal());
  await h.pool.query("CREATE FUNCTION skip_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'halted'='false' THEN RETURN NULL; END IF; RETURN NEW; END $$");
  await h.pool.query("CREATE TRIGGER skip_activation BEFORE UPDATE ON analysis_accounting_controls FOR EACH ROW EXECUTE FUNCTION skip_activation()");
  await assert.rejects(store.executeActivation(activationCommand(change,
    syntheticGrant(change.review.deploymentRef, seeded.guide.id, seeded.command.expectedInputFingerprint)), operationsSignal()), /OPERATIONS_UNAVAILABLE/);
  assert.equal(await store.activationStatus(operationsSignal()), null);
  assert.deepEqual(await h.repository.getAnalysisAccountingControl(), { halted: true });
});

test("real PostgreSQL: API attachment shares actual repository/storage and lifecycle shutdown stops the worker without closing its pool", async (t) => {
  const h = await fixture(t); const { guide, command } = await h.seed("guide", 2, true);
  const storage = new ReplitObjectStorage({ bucketId: "fictional-bucket", prefix: "fixture", client: {} as never });
  const options: Parameters<typeof attachFixedSyntheticAnalysisRuntime>[1] = { config: { deploymentRef: "test", projectRef: "test", credentialRef: "test", bucketId: "fictional-bucket", prefix: "fixture" },
    grant: { kind: "fixed-synthetic-screens-v1" as const, approvalId: "fixture-only", deploymentRef: "test",
      input: { guideId: guide.id, frameCount: 2, inputFingerprint: command.expectedInputFingerprint, model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION },
      createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), inputTokenLimit: 1000, countPolicy: SYNTHETIC_COUNT_LIMITS },
    activationId: randomUUID(), migrationsFolder: resolve("drizzle"), ffmpegPath: testMediaPaths().ffmpegPath, apiKey: "fictional-fixture-key", allowExternalProcessing: true,
    fetch: (async () => { assert.fail("no external request is allowed"); }) as typeof fetch };
  const runtime = attachFixedSyntheticAnalysisRuntime({ repository: h.repository, storage }, options);
  assert.equal(runtime.repository, h.repository); assert.equal(runtime.storage, storage);
  assert.throws(() => attachFixedSyntheticAnalysisRuntime({ repository: h.repository, storage }, { ...options,
    config: { ...options.config, bucketId: "another-bucket" } }), /ANALYSIS_UNAVAILABLE/);
  const lifecycle = (await createAnalysisLifecycle({ repository: h.repository, storage }, () => runtime))!;
  t.after(() => runtime.stop());
  await assert.rejects(lifecycle.admission.request(guide.id, command, operationsSignal()), /ANALYSIS_UNAVAILABLE/);
  lifecycle.start(); assert.equal(runtime.getStatus().running, true);
  // There is no operator record: starting a loop is not approval to admit or transmit.
  await assert.rejects(lifecycle.admission.request(guide.id, command, operationsSignal()), /ANALYSIS_UNAVAILABLE/);
  await lifecycle.stop(); assert.equal(runtime.getStatus().running, false); assert.equal(await runtime.tick(), "disabled");
  assert.equal((await h.pool.query("SELECT 1 AS ok")).rows[0].ok, 1);
});
