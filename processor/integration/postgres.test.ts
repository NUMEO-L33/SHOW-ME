import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { ANALYSIS_CONSENT_VERSION, analysisManifest } from "../src/analysis-contract.js";
import { type AnalysisFundingCommand, type AnalysisFundingPolicy } from "../src/analysis-funding.js";
import { runDatabaseMigrations } from "../src/database-migrations.js";
import { PostgresGuideRepository } from "../src/repository.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "../src/gemini/request.js";
import { fakeOutput } from "../tests/helpers/analysis-fixtures.js";

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
  async function seed(id = "guide", frames = 2) {
    await repository.createGuide({ id, slug: id, editToken: "synthetic-test-token", title: "synthetic guide", status: "queued",
      originalObjectKey: `fixture/${id}/source.mp4`, sourceFilename: "fictional.mp4", sourceMimeType: "video/mp4", sourceSizeBytes: 1 });
    await repository.claimProcessingAttempt(id, `media-${id}`); await repository.updateStatus(id, "extracting");
    const guide = await repository.completeProcessingAttempt(id, { attemptId: `media-${id}`, attemptCount: 1,
      steps: Array.from({ length: frames }, (_, i) => ({ id: `${id}-step-${i}`, position: i, shortLabel: "fixture", instruction: "fixture",
        startMs: i * 1000, endMs: (i + 1) * 1000, representativeTimestampMs: i * 1000 + 500,
        representativeFrameKey: `fixture/${id}/${i}.jpg`, thumbnailFrameKey: `fixture/${id}/${i}-thumb.jpg`, frameWidth: 640, frameHeight: 360 })) });
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

test("real PostgreSQL: all eight migrations apply and replay without resetting the halt or accounting", async (t) => {
  const h = await fixture(t);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).rows[0].n, 8);
  t.diagnostic(`PostgreSQL ${(await h.pool.query("SHOW server_version")).rows[0].server_version}; migrations 0000–0007`);
  await h.pool.query("UPDATE analysis_accounting_controls SET payload = '{\"halted\":true}'::jsonb WHERE id='global'");
  await runDatabaseMigrations(h.connection);
  assert.equal((await h.repository.getAnalysisAccountingControl()).halted, true);
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

test("real PostgreSQL: legacy 0004 payloads backfill safely through migrations 0005–0007", async (t) => {
  const h = await fixture(t, false);
  const journal = JSON.parse(await readFile("processor/drizzle/meta/_journal.json", "utf8"));
  for (const entry of journal.entries.slice(0, 5)) await h.pool.query(await readFile(`processor/drizzle/${entry.tag}.sql`, "utf8"));
  await h.pool.query("INSERT INTO guides(id,slug,edit_token_hash,title,original_object_key,source_filename,source_mime_type,source_size_bytes) VALUES ('legacy','legacy','fixture','fixture','fixture','fixture.mp4','video/mp4',1)");
  const timestamp = new Date().toISOString();
  await h.pool.query("INSERT INTO analysis_runs(guide_id,id,status,payload) VALUES ('legacy','run','queued',$1)", [{ createdAt: timestamp, attemptCount: 0, leaseExpiresAt: null }]);
  const maximum = { requests: 2, inputTokens: 2000, outputTokens: 16384, costMicrousd: 3478 };
  await h.pool.query("INSERT INTO analysis_reservations(guide_id,run_id,day,maximum) VALUES ('legacy','run',$1,$2)", [timestamp.slice(0, 10), maximum]);
  await h.pool.query("INSERT INTO analysis_batches(guide_id,run_id,batch_index,payload) VALUES ('legacy','run',0,$1)", [{ status: "queued", targetIds: ["fixture"], contextIds: [] }]);
  for (const entry of journal.entries.slice(5)) await h.pool.query(await readFile(`processor/drizzle/${entry.tag}.sql`, "utf8"));
  const row = (await h.rows("analysis_runs"))[0]; assert.equal(row.created_at.toISOString(), timestamp); assert.equal(row.attempt_count, 0);
  assert.deepEqual((await h.rows("analysis_reservations"))[0].maximum, maximum);
  assert.equal((await h.rows("analysis_reservations"))[0].closed_at, null); assert.equal((await h.rows("analysis_batches"))[0].status, "queued");
});
