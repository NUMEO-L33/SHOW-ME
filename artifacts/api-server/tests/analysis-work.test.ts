import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import { AnalysisAccountingError } from "../src/processor/analysis-accounting-contract.js";
import { ANALYSIS_CONSENT_VERSION, analysisManifest } from "../src/processor/analysis-contract.js";
import type { AnalysisFundingCommand, AnalysisFundingPolicy } from "../src/processor/analysis-funding.js";
import { AnalysisWorkError, type AnalysisWorkClaim } from "../src/processor/analysis-work.js";
import { analysisAccountingControls, analysisBudgetWindows, analysisRequestAttempts, analysisRuns, guides } from "../src/processor/db/schema.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "../src/processor/gemini/request.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { postgresAccountingFixture } from "./helpers/accounting-postgres-fixture.js";

const now = new Date("2026-09-14T12:00:00.000Z");
const time = (offset: number) => new Date(now.valueOf() + offset);
const limit = { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicrousd: 1_000_000 };
// Fictional accounting only. No live provider, media loading, entitlement or DB connection.
const policy: AnalysisFundingPolicy = { version: "work-fixture", accountingOnly: true,
  price: { model: GEMINI_TEST_MODEL, version: "fictional", inputMicrousdPerMillionTokens: 100000, outputMicrousdPerMillionTokens: 200000 },
  maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 1, globalLimit: limit, guideLimit: limit };
const claim: AnalysisWorkClaim = { runId: "funded", attemptId: "worker-a", expectedAttemptCount: 0, leaseMs: 1000 };
const request = { runId: claim.runId, batchIndex: 0, ordinal: 0 as const, dispatchId: "dispatch-a" };
const owner = { attemptId: claim.attemptId, attemptCount: 1 };

async function harness(context: TestContext) {
  const h = await createAnalysisHarness(context);
  const command: AnalysisFundingCommand = { type: "request", runId: claim.runId, baseDraftRevision: 0,
    consentVersion: ANALYSIS_CONSENT_VERSION, provider: "gemini", model: GEMINI_TEST_MODEL,
    promptVersion: GEMINI_PROMPT_VERSION, expectedInputFingerprint: analysisManifest(h.guide).fingerprint };
  assert.ok(await h.repository.reserveAnalysisRequest(h.guideId, command, policy, now));
  const state = async () => JSON.parse(await readFile(h.repository.filePath, "utf8"));
  const acquire = (selected = claim, at = now) => h.repository.claimAnalysisWork(h.guideId, selected, at);
  const begin = async () => {
    assert.ok(await acquire());
    assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "allocate", ...request, owner }, now));
    assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "sending", ...request, owner }, now));
  };
  const pg = async () => postgresAccountingFixture(h.guide, (await h.repository.getAnalysisState(h.guideId))!, (await state()).funding);
  async function addGuide(id: string, funded = true) {
    await h.repository.createGuide({ id, slug: id, editToken: "synthetic-token", title: "fixture", status: "queued",
      originalObjectKey: `${id}/source.mp4`, sourceFilename: "synthetic.mp4", sourceMimeType: "video/mp4", sourceSizeBytes: 1 });
    await h.repository.claimProcessingAttempt(id, `media-${id}`);
    await h.repository.updateStatus(id, "extracting");
    const guide = await h.repository.completeProcessingAttempt(id, { attemptId: `media-${id}`, attemptCount: 1,
      steps: h.guide.steps.map((step) => ({ ...step, id: `${id}-${step.id}`, representativeFrameKey: `${id}/${step.id}.jpg` })) });
    assert.ok(guide);
    if (funded) assert.ok(await h.repository.reserveAnalysisRequest(id, { ...command,
      expectedInputFingerprint: analysisManifest(guide).fingerprint }, policy, time(1)));
    return guide;
  }
  return { ...h, state, acquire, begin, pg, addGuide, command };
}

test("bounded discovery is read-only, ordered and excludes legacy, live, terminal and deleted work", async (context) => {
  const h = await harness(context);
  await h.addGuide("second");
  await h.addGuide("legacy", false);
  await h.repository.executeAnalysisCommand("legacy", { type: "initialize" });
  assert.ok(await h.repository.executeAnalysisCommand("legacy", { type: "start", runId: "legacy-run", baseDraftRevision: 0,
    consentVersion: ANALYSIS_CONSENT_VERSION, provider: "fixture", model: "fixture", promptVersion: "fixture" }));
  const before = await h.state();
  assert.deepEqual(await h.repository.listAnalysisWork(1, time(2)), [{ guideId: h.guideId, runId: claim.runId, expectedAttemptCount: 0 }]);
  assert.equal((await h.repository.listAnalysisWork(50, time(2))).length, 2);
  assert.deepEqual(await h.state(), before);
  await h.acquire();
  assert.deepEqual(await h.repository.listAnalysisWork(20, time(2)), [{ guideId: "second", runId: claim.runId, expectedAttemptCount: 0 }]);
  await h.repository.executeAnalysisCommand("second", { type: "cancel", runId: claim.runId });
  assert.deepEqual(await h.repository.listAnalysisWork(20, time(2)), []);
  await h.repository.deleteGuide(h.guideId);
  assert.deepEqual(await h.repository.listAnalysisWork(20, time(2000)), []);
});

test("twenty different claimants acquire exactly one persisted lease", async (context) => {
  const h = await harness(context);
  const before = await h.state();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => h.acquire({ ...claim, attemptId: `worker-${i}` })));
  const winner = results.find(Boolean)!;
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(winner.outcome, "claimed");
  assert.equal(winner.replayed, false);
  assert.equal(winner.run.attemptCount, 1);
  assert.equal(winner.run.leaseExpiresAt, time(1000).toISOString());
  const saved = await h.state();
  assert.deepEqual(saved.funding, before.funding);
  assert.deepEqual(saved.analysis[0].state.draft, before.analysis[0].state.draft);
  assert.deepEqual(saved.guides, before.guides);
});

test("same claim replays without extending its lease, spending or advancing attempts", async (context) => {
  const h = await harness(context);
  const results = await Promise.all(Array.from({ length: 20 }, () => h.acquire()));
  assert.equal(results.filter((r) => r?.replayed === false).length, 1);
  assert.equal(results.filter((r) => r?.replayed === true).length, 19);
  const before = await h.state();
  assert.equal((await h.acquire(claim, time(500)))?.replayed, true);
  assert.equal(await h.acquire({ ...claim, leaseMs: 2000 }, time(500)), null);
  assert.deepEqual(await h.state(), before);
});

test("different guides share one global funded-work slot, and cancellation frees ownership only", async (context) => {
  const h = await harness(context);
  await h.addGuide("second");
  const before = (await h.state()).funding;
  const results = await Promise.all([h.acquire(claim, time(2)),
    h.repository.claimAnalysisWork("second", { ...claim, attemptId: "worker-b" }, time(2))]);
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results[0] ? h.guideId : "second";
  const loser = results[0] ? "second" : h.guideId;
  await h.repository.executeAnalysisCommand(winner, { type: "cancel", runId: claim.runId });
  assert.ok(await h.repository.claimAnalysisWork(loser, { ...claim, attemptId: "worker-c" }, time(3)));
  assert.deepEqual((await h.state()).funding, before);
});

test("restart recovers at exact expiry with a new generation and rejects old or reused owners", async (context) => {
  const h = await harness(context);
  await h.acquire();
  const reopened = new JsonGuideRepository(h.repository.filePath);
  const next = { ...claim, attemptId: "worker-b", expectedAttemptCount: 1 };
  assert.deepEqual(await reopened.listAnalysisWork(20, time(999)), []);
  assert.equal(await reopened.claimAnalysisWork(h.guideId, next, time(999)), null);
  assert.equal((await reopened.listAnalysisWork(20, time(1000)))[0].expectedAttemptCount, 1);
  assert.equal(await reopened.claimAnalysisWork(h.guideId, { ...next, attemptId: claim.attemptId }, time(1000)), null);
  const recovered = await reopened.claimAnalysisWork(h.guideId, next, time(1000));
  assert.equal(recovered?.run.attemptCount, 2);
  assert.equal(recovered?.run.leaseExpiresAt, time(2000).toISOString());
  assert.equal(await reopened.claimAnalysisWork(h.guideId, claim, time(1000)), null);
  assert.equal(await reopened.claimAnalysisWork(h.guideId, { ...next, attemptId: "worker-c" }, time(1000)), null);
});

test("third expired lease becomes terminal without a fourth claim or an automatic refund", async (context) => {
  const h = await harness(context);
  const budget = (await h.state()).funding;
  await h.acquire();
  await h.acquire({ ...claim, attemptId: "worker-b", expectedAttemptCount: 1 }, time(1000));
  await h.acquire({ ...claim, attemptId: "worker-c", expectedAttemptCount: 2 }, time(2000));
  const terminal = await h.acquire({ ...claim, attemptId: "worker-d", expectedAttemptCount: 3 }, time(3000));
  assert.equal(terminal?.outcome, "exhausted");
  assert.equal(terminal?.run.status, "failed");
  assert.equal(terminal?.run.errorCode, "AI_TIMEOUT");
  assert.equal(terminal?.run.attemptCount, 3);
  assert.equal(terminal?.run.leaseExpiresAt, null);
  assert.deepEqual(await h.repository.listAnalysisWork(20, time(3000)), []);
  assert.equal(await h.acquire({ ...claim, expectedAttemptCount: 3 }, time(3000)), null);
  assert.deepEqual((await h.state()).funding, budget);
});

test("orphan sending becomes uncertain atomically with takeover and keeps its entire reservation", async (context) => {
  const h = await harness(context);
  await h.begin();
  const before = await h.state();
  const recovered = await h.acquire({ ...claim, attemptId: "worker-b", expectedAttemptCount: 1 }, time(1000));
  assert.equal(recovered?.run.attemptCount, 2);
  const saved = await h.state();
  const attempt = saved.funding.attempts[0];
  assert.equal(attempt.status, "uncertain");
  assert.deepEqual(attempt.usage, { status: "unknown" });
  assert.deepEqual(attempt.charged, attempt.maximum);
  assert.equal(attempt.finishedAt, time(1000).toISOString());
  assert.deepEqual(saved.funding.windows, before.funding.windows);
  assert.deepEqual(saved.funding.reservations, before.funding.reservations);
  assert.deepEqual(saved.funding.batches, before.funding.batches);
});

test("missing, expired and stale owners cannot allocate/send or replay dispatch; late numeric settlement is allowed", async (context) => {
  const h = await harness(context);
  await h.begin();
  assert.equal(await h.repository.executeAnalysisAccounting(h.guideId, { type: "sending", ...request }, time(1)), null);
  assert.equal(await h.repository.executeAnalysisAccounting(h.guideId, { type: "sending", ...request, owner }, time(1000)), null);
  assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "settle", ...request,
    usage: { status: "unknown" }, retryableHttpStatus: 503 }, time(999)));
  await h.acquire({ ...claim, attemptId: "worker-b", expectedAttemptCount: 1 }, time(1000));
  for (const type of ["allocate", "sending"] as const) {
    assert.equal(await h.repository.executeAnalysisAccounting(h.guideId, { type, ...request, owner }, time(1001)), null);
  }
  const currentOwner = { attemptId: "worker-b", attemptCount: 2 };
  const retry = { ...request, ordinal: 1 as const, dispatchId: "dispatch-b", owner: currentOwner };
  assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "allocate", ...retry }, time(1001)));
  assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "sending", ...retry }, time(1001)));
  assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "settle", ...request,
    usage: { status: "known", inputTokens: 100, outputTokens: 20 } }, time(1002)));
  assert.equal((await h.repository.getAnalysisState(h.guideId))?.runs[0].status, "running");
  assert.equal((await h.state()).analysis[0].state.draft.revision, 0);
});

test("cancel/delete races cannot resurrect work or bypass the unmetered-runner fence", async (context) => {
  for (const remove of [false, true]) {
    const h = await harness(context);
    const end = remove ? h.repository.deleteGuide(h.guideId) : h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: claim.runId });
    await Promise.all([h.acquire(), end]);
    assert.deepEqual(await h.repository.listAnalysisWork(20, time(1000)), []);
    assert.equal(await h.acquire(), null);
  }
  const h = await harness(context);
  await h.acquire();
  for (const command of [
    { type: "claim" as const, ...claim },
    { type: "fail" as const, runId: claim.runId, ...owner, errorCode: "AI_TIMEOUT" as const },
  ]) assert.equal(await h.repository.executeAnalysisCommand(h.guideId, command), null);
});

test("stale media snapshots are rejected after discovery and again on lease replay", async (context) => {
  const h = await harness(context);
  assert.equal((await h.repository.listAnalysisWork(20, now)).length, 1);
  await h.acquire();
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map((s) => ({ ...s, representativeFrameKey: `changed/${s.id}.jpg` })));
  const before = await h.state();
  assert.equal(await h.acquire(claim, time(1)), null);
  assert.equal(await h.acquire({ ...claim, attemptId: "worker-b", expectedAttemptCount: 1 }, time(1000)), null);
  assert.deepEqual(await h.state(), before);
});

test("halt blocks new ownership but preserves exact replay and never clears the control", async (context) => {
  const h = await harness(context);
  await h.begin();
  await h.repository.executeAnalysisAccounting(h.guideId, { type: "settle", ...request,
    usage: { status: "known", inputTokens: 1001, outputTokens: 20 } }, time(1));
  const before = await h.state();
  assert.equal((await h.acquire(claim, time(2)))?.replayed, true);
  await assert.rejects(h.acquire({ ...claim, attemptId: "worker-b", expectedAttemptCount: 1 }, time(1000)),
    (e: unknown) => e instanceof AnalysisAccountingError && e.code === "ANALYSIS_ACCOUNTING_HALTED");
  assert.deepEqual(await h.state(), before);
});

test("UTC rollover rejects new ownership without moving budget or resetting attempts", async (context) => {
  const h = await harness(context);
  const before = await h.state();
  await assert.rejects(h.acquire(claim, new Date("2026-09-15T00:00:00.000Z")),
    (e: unknown) => e instanceof AnalysisAccountingError && e.code === "ANALYSIS_DAY_ROLLOVER");
  assert.deepEqual(await h.state(), before);
  assert.equal(await h.repository.getAnalysisBudgetWindow("2026-09-15", "global"), null);
});

test("invalid claim, limit and clock inputs never write or initialize", async (context) => {
  const h = await harness(context);
  const before = await h.state();
  for (const patch of [{ leaseMs: 0 }, { leaseMs: 180001 }, { expectedAttemptCount: 4 }, { expectedAttemptCount: 0.1 },
    { attemptId: "secret/path" }, { runId: "" }, { provider: "google" }]) {
    await assert.rejects(h.acquire({ ...claim, ...patch }), AnalysisWorkError);
  }
  for (const limit of [0, 51, 1.1, NaN]) await assert.rejects(h.repository.listAnalysisWork(limit, now), AnalysisWorkError);
  await assert.rejects(h.acquire(claim, new Date(NaN)), AnalysisWorkError);
  assert.equal(await h.acquire(claim, time(-1)), null);
  assert.deepEqual(await h.state(), before);
});

test("claim command and fixture timestamp are copied before awaiting the writer", async (context) => {
  const h = await harness(context);
  const mutable = { ...claim };
  const clock = time(0);
  const result = h.acquire(mutable, clock);
  mutable.attemptId = "changed";
  clock.setTime(time(100000).valueOf());
  assert.equal((await result)?.run.attemptId, claim.attemptId);
  assert.equal((await h.repository.getAnalysisState(h.guideId))?.runs[0].leaseExpiresAt, time(1000).toISOString());
});

test("precommit failure and accidental async validation leave no lease or partial uncertainty", async (context) => {
  const h = await harness(context);
  await h.begin();
  const before = await h.state();
  for (const guard of [() => { throw new Error("fixture stop"); }, async () => { throw new Error("private fixture stop"); }]) {
    await assert.rejects(h.repository.claimAnalysisWork(h.guideId, { ...claim, attemptId: "worker-b", expectedAttemptCount: 1 }, time(1000), guard));
    assert.deepEqual(await h.state(), before);
  }
});

test("atomic write failure keeps old lease and sending record, while lost acknowledgement replays", async (context) => {
  const h = await harness(context);
  await h.begin();
  const before = await h.state();
  const broken = new JsonGuideRepository(h.repository.filePath);
  const original = (broken as unknown as { writeState: (raw: unknown) => Promise<void> }).writeState.bind(broken);
  (broken as unknown as { writeState: () => Promise<void> }).writeState = async () => { throw new Error("fixture disk failure"); };
  const next = { ...claim, attemptId: "worker-b", expectedAttemptCount: 1 };
  await assert.rejects(broken.claimAnalysisWork(h.guideId, next, time(1000)));
  assert.deepEqual(await h.state(), before);
  (broken as unknown as { writeState: (raw: unknown) => Promise<void> }).writeState = async (raw) => { await original(raw); throw new Error("lost acknowledgement"); };
  await assert.rejects(broken.claimAnalysisWork(h.guideId, next, time(1000)));
  const saved = await h.state();
  const reopened = new JsonGuideRepository(h.repository.filePath);
  assert.equal((await reopened.claimAnalysisWork(h.guideId, next, time(1001)))?.replayed, true);
  assert.deepEqual(await h.state(), saved);
  assert.equal(saved.funding.attempts[0].status, "uncertain");
});

test("current JSON format reopens without version reset and rejects corrupted work or funding", async (context) => {
  const h = await harness(context);
  await h.acquire();
  const saved = await h.state();
  assert.equal(saved.version, 9);
  for (const mutation of [
    (raw: typeof saved) => { raw.analysis[0].state.runs[0].leaseExpiresAt = null; },
    (raw: typeof saved) => { raw.analysis[0].state.runs[0].attemptCount = 4; },
    (raw: typeof saved) => { raw.funding.control = null; },
  ]) {
    const corrupt = structuredClone(saved);
    mutation(corrupt);
    await writeFile(h.repository.filePath, JSON.stringify(corrupt));
    await assert.rejects(new JsonGuideRepository(h.repository.filePath).listAnalysisWork(20, time(1000)));
    assert.deepEqual(await h.state(), corrupt);
  }
});

test("Postgres claim locks global control then guide, writes projections and uses its DB clock (transaction double)", async (context) => {
  const h = await harness(context);
  const pg = await h.pg();
  pg.setClock(time(100));
  const result = await pg.repository.claimAnalysisWork(h.guideId, claim);
  assert.deepEqual(pg.isolationLevels, ["read committed"]);
  assert.equal(result?.run.leaseExpiresAt, time(1100).toISOString());
  assert.deepEqual(pg.locks, [{ table: analysisAccountingControls, mode: "update" }, { table: guides, mode: "update" }]);
  assert.deepEqual(pg.writes, [analysisRuns]);
  const row = pg.rows(analysisRuns)[0];
  assert.deepEqual(row.availableAt, time(1100));
  assert.equal(row.attemptCount, 1);
  assert.equal((await pg.repository.getAnalysisState(h.guideId))?.runs[0].attemptCount, 1);
  const activeQuery = pg.queries.find((q) => q.sql.includes('"analysis_runs"."available_at" >'));
  assert.ok(activeQuery?.sql.includes('"analysis_reservations"'));
  assert.equal(activeQuery?.limit, 1);
});

test("Postgres discovery filters durable due work before its bound and validates index projections (query double)", async (context) => {
  const h = await harness(context);
  const pg = await h.pg();
  assert.deepEqual(await pg.repository.listAnalysisWork(7, now), [{ guideId: h.guideId, runId: claim.runId, expectedAttemptCount: 0 }]);
  const query = pg.queries.at(-1)!;
  assert.equal(query.limit, 7);
  for (const fragment of ['"analysis_runs"."available_at" <=', '"analysis_reservations"', '"guides"', 'is not null', "'ready'"]) assert.ok(query.sql.includes(fragment));
  assert.deepEqual(pg.writes, []);
  const rows = pg.rows(analysisRuns);
  rows[0].attemptCount = 2;
  pg.replaceRows(analysisRuns, rows);
  await assert.rejects(pg.repository.listAnalysisWork(7, now), AnalysisWorkError);
  await assert.rejects(pg.repository.getAnalysisState(h.guideId), AnalysisWorkError);
});

test("Postgres takeover and orphan accounting commit together; a late write failure rolls both back (transaction double)", async (context) => {
  const h = await harness(context);
  await h.begin();
  const pg = await h.pg();
  const before = [pg.rows(analysisRuns), pg.rows(analysisRequestAttempts), pg.rows(analysisBudgetWindows)];
  pg.failAttemptWrite();
  await assert.rejects(pg.repository.claimAnalysisWork(h.guideId, { ...claim, attemptId: "worker-b", expectedAttemptCount: 1 }, time(1000)));
  assert.deepEqual([pg.rows(analysisRuns), pg.rows(analysisRequestAttempts), pg.rows(analysisBudgetWindows)], before);
  assert.deepEqual(pg.writes, [analysisRuns, analysisRequestAttempts]);
  const good = await h.pg();
  assert.equal((await good.repository.claimAnalysisWork(h.guideId, { ...claim, attemptId: "worker-b", expectedAttemptCount: 1 }, time(1000)))?.run.attemptCount, 2);
  assert.equal(good.rows(analysisRequestAttempts)[0].status, "uncertain");
  assert.deepEqual(good.rows(analysisBudgetWindows), before[2]);
});

test("Postgres missing control and guard failure never persist a new owner (transaction double)", async (context) => {
  const h = await harness(context);
  const pg = await h.pg();
  const before = pg.rows(analysisRuns);
  await assert.rejects(pg.repository.claimAnalysisWork(h.guideId, claim, now, () => { throw new Error("revoked"); }));
  assert.deepEqual(pg.rows(analysisRuns), before);
  assert.deepEqual(pg.writes, []);
  pg.removeControl();
  await assert.rejects(pg.repository.claimAnalysisWork(h.guideId, claim, now));
  assert.deepEqual(pg.rows(analysisRuns), before);
});

test("dispatch accounting checks the DB clock after locks rather than trusting a former owner's timestamp (transaction double)", async (context) => {
  const h = await harness(context);
  await h.begin();
  const pg = await h.pg();
  pg.setClock(time(1000));
  assert.equal(await pg.repository.executeAnalysisAccounting(h.guideId, { type: "sending", ...request, owner }), null);
  assert.deepEqual(pg.isolationLevels, ["read committed"]);
  assert.deepEqual(pg.writes, []);
  pg.setClock(time(500));
  assert.equal((await pg.repository.executeAnalysisAccounting(h.guideId, { type: "sending", ...request, owner }))?.replayed, true);
  assert.deepEqual(pg.writes, []);
});

test("takeover racing confirmed settlement never replaces known usage with an unknown maximum", async (context) => {
  for (const settleFirst of [true, false]) {
    const h = await harness(context);
    await h.begin();
    const settle = () => h.repository.executeAnalysisAccounting(h.guideId, { type: "settle", ...request,
      usage: { status: "known", inputTokens: 100, outputTokens: 20 } }, time(1000));
    const recover = () => h.acquire({ ...claim, attemptId: "worker-b", expectedAttemptCount: 1 }, time(1000));
    const outcomes = await Promise.all(settleFirst ? [settle(), recover()] : [recover(), settle()]);
    assert.ok(outcomes.every(Boolean));
    const saved = await h.state();
    assert.equal(saved.funding.attempts[0].status, "settled");
    assert.equal(saved.funding.windows.find((w: { scope: string }) => w.scope === "global").used.inputTokens, 1100);
    assert.equal(saved.analysis[0].state.runs[0].attemptCount, 2);
    assert.equal((await new JsonGuideRepository(h.repository.filePath).getAnalysisRequestAttempts(h.guideId, claim.runId))?.[0].status, "settled");
  }
});

test("queue migration backfills existing payloads before enforcing projections without deleting or resetting them", async () => {
  const migration = await readFile("drizzle/0005_analysis_work_queue.sql", "utf8");
  assert.ok(!/DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i.test(migration));
  assert.ok(migration.indexOf('UPDATE "analysis_runs" SET') < migration.indexOf('ALTER COLUMN "created_at" SET NOT NULL'));
  for (const key of ["createdAt", "attemptCount", "leaseExpiresAt"]) assert.ok(migration.includes(`->>'${key}'`));
  assert.ok(migration.includes("analysis_runs_work_projection_check"));
  const config = getTableConfig(analysisRuns);
  assert.ok(config.indexes.some((i) => i.config.name === "analysis_runs_work_due_idx"));
  assert.ok(config.checks.some((c) => c.name === "analysis_runs_work_projection_check"));
});
