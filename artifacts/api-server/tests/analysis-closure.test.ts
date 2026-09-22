import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { beforeEach, test, type TestContext } from "node:test";
import { budgetUnitFields, zeroBudgetUnits, type AnalysisAccountingCommand } from "../src/processor/analysis-accounting-contract.js";
import { ANALYSIS_CONSENT_VERSION, analysisManifest } from "../src/processor/analysis-contract.js";
import { type AnalysisFundingCommand, type AnalysisFundingPolicy } from "../src/processor/analysis-funding.js";
import { analysisAccountingControls, analysisBudgetWindows, analysisRequestAttempts, analysisReservations, analysisRuns, guides } from "../src/processor/db/schema.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "../src/processor/gemini/request.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { createAnalysisHarness, fakeOutput } from "./helpers/analysis-fixtures.js";
import { postgresAccountingFixture } from "./helpers/accounting-postgres-fixture.js";

const now = new Date("2026-09-14T23:59:59.000Z");
const nextDay = new Date("2026-09-15T00:00:01.000Z");
const later = new Date("2026-09-16T12:00:00.000Z");
// Cancellation uses the repository's current Date rather than an explicit clock.
// Keep it inside the fixture timeline; a real date after `later` correctly makes
// closure reject a backwards timestamp. Timers and production guards stay real.
beforeEach((context) => {
  assert.ok("mock" in context);
  context.mock.timers.enable({ apis: ["Date"], now: now.valueOf() });
});
const limit = { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicrousd: 1_000_000 };
const policy: AnalysisFundingPolicy = { version: "closure-fixture", accountingOnly: true,
  price: { model: GEMINI_TEST_MODEL, version: "fictional", inputMicrousdPerMillionTokens: 100000, outputMicrousdPerMillionTokens: 200000 },
  maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 1, globalLimit: limit, guideLimit: limit };
const identity = { runId: "closure-run", batchIndex: 0, ordinal: 0 as const, dispatchId: "closure-send" };
const known = { status: "known" as const, inputTokens: 100, outputTokens: 20 };

async function harness(context: TestContext, frames = 2) {
  const h = await createAnalysisHarness(context, frames);
  const command: AnalysisFundingCommand = { type: "request", runId: identity.runId, baseDraftRevision: 0,
    consentVersion: ANALYSIS_CONSENT_VERSION, provider: "gemini", model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION,
    expectedInputFingerprint: analysisManifest(h.guide).fingerprint };
  const funded = await h.repository.reserveAnalysisRequest(h.guideId, command, policy, now); assert.ok(funded);
  const state = async () => JSON.parse(await readFile(h.repository.filePath, "utf8"));
  const execute = (c: AnalysisAccountingCommand, at = now) => h.repository.executeAnalysisAccounting(h.guideId, c, at);
  const cancel = () => h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: identity.runId });
  const close = (at = later) => h.repository.closeAnalysisReservation(h.guideId, identity.runId, at);
  const allocate = () => execute({ type: "allocate", ...identity });
  const begin = async () => { assert.ok(await allocate()); assert.ok(await execute({ type: "sending", ...identity })); };
  return { ...h, funded, command, state, execute, cancel, close, allocate, begin };
}

test("terminal reservations return all unallocated slots exactly once under twenty racing closures", async (context) => {
  const h = await harness(context, 8); await h.cancel();
  const outcomes = await Promise.all(Array.from({ length: 20 }, () => h.close()));
  assert.equal(outcomes.filter((r) => r && !r.replayed).length, 1);
  assert.equal(outcomes.filter((r) => r?.replayed).length, 19);
  const saved = await h.state();
  assert.deepEqual(saved.funding.reservations[0].released, h.funded.reservation.maximum);
  assert.deepEqual(saved.funding.attempts, []);
  for (const w of saved.funding.windows) assert.deepEqual(w.used, zeroBudgetUnits());
  assert.equal(await h.allocate(), null);
  const replay = await h.repository.reserveAnalysisRequest(h.guideId, h.command, policy, later);
  assert.equal(replay?.replayed, true); assert.deepEqual(await h.state(), saved);
});

test("closure releases unsent allocated slots but retains unknown sent maximum and confirmed usage", async (context) => {
  for (const status of ["reserved", "sending", "uncertain", "settled", "overrun"] as const) {
    const h = await harness(context, 8); assert.ok(await h.allocate());
    if (status !== "reserved") await h.execute({ type: "sending", ...identity });
    if (["uncertain", "settled", "overrun"].includes(status)) await h.execute({ type: "settle", ...identity,
      usage: status === "uncertain" ? { status: "unknown" } : status === "overrun" ? { ...known, inputTokens: 1001 } : known });
    await h.cancel(); assert.ok(await h.close()); const s = await h.state();
    const attempt = s.funding.attempts[0];
    assert.equal(attempt.status, status === "reserved" ? "released" : status === "sending" ? "uncertain" : status);
    for (const w of s.funding.windows) assert.deepEqual(w.used, attempt.charged);
    for (const field of budgetUnitFields) assert.equal(s.funding.reservations[0].released[field], h.funded.reservation.maximum[field] - attempt.maximum[field]);
    assert.equal(s.funding.control.halted, status === "overrun");
  }
});

test("a completed batch and draft survive closure while its never-used retry returns", async (context) => {
  const h = await harness(context);
  const claim = await h.repository.claimAnalysisWork(h.guideId, { runId: identity.runId, attemptId: "owner", expectedAttemptCount: 0, leaseMs: 5000 }, now);
  assert.ok(claim); const owner = { attemptId: "owner", attemptCount: 1 };
  await h.execute({ type: "allocate", ...identity, owner }); await h.execute({ type: "sending", ...identity, owner });
  assert.ok(await h.repository.completeAnalysisBatch(h.guideId, { ...identity, owner, expectedInputFingerprint: h.command.expectedInputFingerprint,
    output: fakeOutput(h.guide.steps.map((s) => s.id)), inputTokens: 100, outputTokens: 20 }, now));
  const before = await h.state(); assert.ok(await h.close(now)); const after = await h.state();
  assert.deepEqual(after.analysis, before.analysis); assert.deepEqual(after.funding.batches, before.funding.batches);
  assert.equal(after.funding.windows[0].used.requests, 1); assert.equal(after.funding.reservations[0].released.requests, 1);
  assert.deepEqual(await new JsonGuideRepository(h.repository.filePath).getAnalysisState(h.guideId), after.analysis[0].state);
});

test("late known usage and late overrun settle a closed uncertain request without reopening budget", async (context) => {
  for (const usage of [known, { ...known, inputTokens: 1001 }]) {
    const h = await harness(context); await h.begin(); await h.cancel(); await h.close();
    const before = await h.state(); const receipt = await h.execute({ type: "settle", ...identity, usage }, new Date(later.valueOf() + 1));
    assert.ok(receipt); const saved = await h.state();
    assert.deepEqual(saved.funding.reservations, before.funding.reservations);
    for (const w of saved.funding.windows) assert.deepEqual(w.used, receipt.attempt.charged);
    assert.equal(saved.analysis[0].state.runs[0].status, "cancelled");
    assert.equal((await h.close(new Date(later.valueOf() + 2)))?.replayed, true);
    assert.equal(saved.funding.control.halted, usage.inputTokens > 1000);
  }
});

test("deleted tombstones close numeric budgets without recreating private details", async (context) => {
  const h = await harness(context); await h.begin(); await h.repository.deleteGuide(h.guideId);
  assert.deepEqual(await h.repository.listAnalysisClosures(20, later), [{ guideId: h.guideId, runId: identity.runId }]);
  assert.ok(await h.close()); const s = await h.state();
  assert.equal(s.funding.reservations[0].details, null); assert.equal(s.funding.attempts[0].status, "uncertain");
  assert.deepEqual(s.funding.windows[0].used, s.funding.attempts[0].maximum);
  assert.equal(await h.repository.getGuideById(h.guideId), null); assert.deepEqual(s.analysis, []); assert.deepEqual(s.funding.batches, []);
});

test("old-day queued work expires without moving budget and a new explicit request reserves the new day", async (context) => {
  const h = await harness(context); assert.equal(await h.close(now), null);
  assert.ok(await h.close(nextDay));
  const s = await h.state(); assert.equal(s.analysis[0].state.runs[0].status, "failed");
  assert.equal(s.analysis[0].state.runs[0].errorCode, "AI_TIMEOUT");
  assert.deepEqual(s.funding.windows[0].used, zeroBudgetUnits());
  assert.ok(await h.repository.reserveAnalysisRequest(h.guideId, { ...h.command, runId: "explicit-new-request" }, policy, nextDay));
  const saved = await h.state(); assert.equal(saved.funding.reservations.length, 2);
  assert.equal(saved.funding.reservations[1].day, "2026-09-15");
  assert.deepEqual(saved.funding.windows.find((w: { day: string; scope: string }) => w.day === "2026-09-14" && w.scope === "global").used, zeroBudgetUnits());
});

test("midnight cleanup respects a valid in-flight lease, then expires it preserving sending maximum", async (context) => {
  const h = await harness(context);
  await h.repository.claimAnalysisWork(h.guideId, { runId: identity.runId, attemptId: "owner", expectedAttemptCount: 0, leaseMs: 5000 }, now);
  const owner = { attemptId: "owner", attemptCount: 1 };
  await h.execute({ type: "allocate", ...identity, owner }); await h.execute({ type: "sending", ...identity, owner });
  assert.deepEqual(await h.repository.listAnalysisClosures(20, nextDay), []); assert.equal(await h.close(nextDay), null);
  assert.ok(await h.close(new Date(now.valueOf() + 5000)));
  const s = await h.state(); assert.equal(s.funding.attempts[0].status, "uncertain");
  assert.deepEqual(s.funding.windows[0].used, s.funding.attempts[0].maximum);
  assert.equal(s.analysis[0].state.runs[0].status, "failed");
});

test("close precommit rejection and write failure leave run, reservation, attempts and totals untouched", async (context) => {
  for (const fault of ["guard", "async", "write"]) {
    const h = await harness(context); await h.begin(); const before = await h.state();
    if (fault === "write") context.mock.method(h.repository as unknown as { writeState(): Promise<void> }, "writeState", async () => { throw new Error("write failed"); });
    const guard = fault === "guard" ? () => { throw new Error("revoked"); } : fault === "async" ? (() => Promise.resolve()) as () => void : undefined;
    await assert.rejects(h.repository.closeAnalysisReservation(h.guideId, identity.runId, nextDay, guard));
    assert.deepEqual(await h.state(), before);
  }
});

test("lost closure acknowledgement reopens as a no-write replay with no double refund", async (context) => {
  const h = await harness(context); await h.begin();
  const hook = h.repository as unknown as { writeState(s: unknown): Promise<void> }; const write = hook.writeState.bind(h.repository);
  context.mock.method(hook, "writeState", async (s: unknown) => { await write(s); throw new Error("ack lost"); }, { times: 1 });
  await assert.rejects(h.close(nextDay)); const saved = await h.state();
  assert.equal((await new JsonGuideRepository(h.repository.filePath).closeAnalysisReservation(h.guideId, identity.runId, later))?.replayed, true);
  assert.deepEqual(await h.state(), saved);
});

test("v4 upgrades add only zero release fields, preserve reads, and reject corrupted v5 closure records", async (context) => {
  const h = await harness(context); await h.begin(); const current = await h.state();
  const old = structuredClone(current); old.version = 4;
  delete old.privacyAssets;
  delete old.publicationJobs; delete old.publications; delete old.publicationHeads; delete old.privateCleanup;
  for (const r of old.funding.reservations) { delete r.released; delete r.closedAt; }
  await writeFile(h.repository.filePath, JSON.stringify(old));
  assert.equal((await new JsonGuideRepository(h.repository.filePath).getAnalysisFunding(h.guideId, identity.runId))?.reservation.closedAt, null);
  assert.deepEqual(await h.state(), old); await h.close(nextDay); const saved = await h.state(); assert.equal(saved.version, 9);
  for (const mutate of [
    (s: typeof saved) => { delete s.funding.reservations[0].released; },
    (s: typeof saved) => { s.funding.reservations[0].released.requests++; },
    (s: typeof saved) => { s.funding.reservations[0].closedAt = null; },
    (s: typeof saved) => { s.analysis[0].state.runs[0].status = "queued"; },
  ]) {
    const bad = structuredClone(saved); mutate(bad); await writeFile(h.repository.filePath, JSON.stringify(bad));
    await assert.rejects(new JsonGuideRepository(h.repository.filePath).getAnalysisState(h.guideId)); assert.deepEqual(await h.state(), bad);
  }
});

test("Postgres closure locks control/windows/guide and commits old-day failure with numeric release (transaction double)", async (context) => {
  const h = await harness(context); await h.begin(); const s = await h.state();
  const pg = postgresAccountingFixture(h.guide, s.analysis[0].state, s.funding); pg.setClock(nextDay);
  const result = await pg.repository.closeAnalysisReservation(h.guideId, identity.runId); assert.ok(result && !result.replayed);
  assert.deepEqual(pg.locks.map((l) => l.table), [analysisAccountingControls, analysisBudgetWindows, analysisBudgetWindows, guides]);
  assert.deepEqual(pg.isolationLevels, ["read committed"]);
  assert.equal(pg.rows(analysisRuns)[0].status, "failed"); assert.equal(pg.rows(analysisRequestAttempts)[0].status, "uncertain");
  assert.equal(pg.rows(analysisReservations)[0].closedAt, nextDay.toISOString());
  const writes = pg.writes.length;
  assert.equal((await pg.repository.closeAnalysisReservation(h.guideId, identity.runId))?.replayed, true); assert.equal(pg.writes.length, writes);
});

test("Postgres closure rolls every write back if run, window, attempt or reservation persistence fails (transaction double)", async (context) => {
  for (const table of [analysisRuns, analysisBudgetWindows, analysisRequestAttempts, analysisReservations]) {
    const h = await harness(context); await h.begin(); const s = await h.state();
    const pg = postgresAccountingFixture(h.guide, s.analysis[0].state, s.funding); pg.setClock(nextDay);
    const tables = [analysisRuns, analysisBudgetWindows, analysisRequestAttempts, analysisReservations];
    const before = tables.map(pg.rows); pg.failWrite(table);
    await assert.rejects(pg.repository.closeAnalysisReservation(h.guideId, identity.runId)); assert.deepEqual(tables.map(pg.rows), before);
  }
});

test("ambiguous settlement replays cannot invent retry permission and owned legacy retries cannot send", async (context) => {
  const h = await harness(context); await h.begin();
  assert.ok(await h.execute({ type: "settle", ...identity, usage: { status: "unknown" } }));
  assert.equal(await h.execute({ type: "settle", ...identity, usage: { status: "unknown" }, retryableHttpStatus: 503 }), null);
  const retry = { ...identity, ordinal: 1 as const, dispatchId: "old-internal-retry" };
  // The old unowned accounting contract could allocate this; ownership must not promote it to permission.
  assert.ok(await h.execute({ type: "allocate", ...retry }));
  assert.ok(await h.repository.claimAnalysisWork(h.guideId, { runId: identity.runId, attemptId: "owner", expectedAttemptCount: 0, leaseMs: 5000 }, now));
  const owner = { attemptId: "owner", attemptCount: 1 };
  assert.equal(await h.execute({ type: "allocate", ...retry, owner }), null);
  assert.equal(await h.execute({ type: "sending", ...retry, owner }), null);
});

test("keyset discovery validates and applies an exclusive cursor without writes in JSON and Postgres doubles", async (context) => {
  const h = await harness(context); const s = await h.state(); const pg = postgresAccountingFixture(h.guide, s.analysis[0].state, s.funding);
  const cursor = { availableAt: now.toISOString(), createdAt: now.toISOString(), guideId: h.guideId, runId: identity.runId };
  for (const repository of [h.repository, pg.repository]) {
    assert.equal((await repository.listAnalysisWork(1, now)).length, 1);
    assert.deepEqual(await repository.listAnalysisWork(1, now, cursor), []);
    assert.equal((await repository.listAnalysisWork(1, now, { ...cursor, availableAt: new Date(now.valueOf() - 1).toISOString() })).length, 1);
    await assert.rejects(repository.listAnalysisWork(1, now, { ...cursor, availableAt: "invalid" }));
  }
  assert.deepEqual(await h.state(), s); assert.deepEqual(pg.writes, []);
  assert.match(pg.queries.at(-1)!.sql, /timestamptz/); assert.equal(pg.queries.at(-1)!.limit, 1);
});

test("Postgres closure discovery excludes live leases and rechecks the DB clock before mutating (transaction double)", async (context) => {
  const h = await harness(context);
  await h.repository.claimAnalysisWork(h.guideId, { runId: identity.runId, attemptId: "owner", expectedAttemptCount: 0, leaseMs: 5000 }, now);
  const s = await h.state(); const pg = postgresAccountingFixture(h.guide, s.analysis[0].state, s.funding); pg.setClock(nextDay);
  assert.deepEqual(await pg.repository.listAnalysisClosures(1), []);
  assert.equal(await pg.repository.closeAnalysisReservation(h.guideId, identity.runId), null); assert.deepEqual(pg.writes, []);
  pg.setClock(new Date(now.valueOf() + 5000));
  assert.deepEqual(await pg.repository.listAnalysisClosures(1), [{ guideId: h.guideId, runId: identity.runId }]);
  const query = pg.queries.at(-1)!; assert.equal(query.limit, 1); assert.match(query.sql, /closed_at/);
  assert.ok(await pg.repository.closeAnalysisReservation(h.guideId, identity.runId));
  assert.deepEqual(await pg.repository.listAnalysisClosures(1), []);
});

test("closure migration adds safe defaults without deleting, resetting or moving historical accounting", async () => {
  const sql = await readFile("drizzle/0007_analysis_reservation_closure.sql", "utf8");
  assert.match(sql, /ADD COLUMN "released"/); assert.match(sql, /ADD COLUMN "closed_at"/); assert.match(sql, /analysis_reservations_open_idx/);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|TRUNCATE|UPDATE "analysis_budget_windows"/i);
});
