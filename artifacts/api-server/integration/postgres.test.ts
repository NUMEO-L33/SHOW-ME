import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { ANALYSIS_CONSENT_VERSION, analysisBatches, analysisManifest, initialDraft } from "../src/processor/analysis-contract.js";
import { type AnalysisFundingCommand, type AnalysisFundingPolicy } from "../src/processor/analysis-funding.js";
import { runDatabaseMigrations } from "../src/processor/database-migrations.js";
import { PostgresGuideRepository } from "../src/processor/repository.js";
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

test("real PostgreSQL: all eleven migrations apply and replay without resetting the halt or accounting", async (t) => {
  const h = await fixture(t);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).rows[0].n, 11);
  t.diagnostic(`PostgreSQL ${(await h.pool.query("SHOW server_version")).rows[0].server_version}; migrations 0000–0010`);
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

test("real PostgreSQL: legacy 0004 payloads backfill safely through migrations 0005–0010", async (t) => {
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

function pipelineReadiness(guideId: string, fingerprint: string): AnalysisAdmissionReadiness {
  return { async inspect(input) {
    const snapshot: AnalysisAdmissionSnapshot = { ...input, id: "pg-pipeline-fixture", guideId, inputFingerprint: fingerprint,
      checkedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 25000).toISOString(), scope: "approved_synthetic",
      inputApprovalId: "pg-pipeline-approval", runtime: { repository: "postgres-0008", dispatcher: "durable-accounted-v1",
        counting: "count-accounted-0010-v1", inputTokenBound: 1000, boundIncludes: "prompt-schema-targets-context" }, policy,
      entitlement: { mode: "free_only", projectRef: "pg-pipeline-project", evidenceId: "fictional-free-evidence", paidFallback: false,
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
