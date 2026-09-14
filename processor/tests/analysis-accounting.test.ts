import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import { AnalysisAccountingError, type AnalysisAccountingCommand } from "../src/analysis-accounting-contract.js";
import { analysisManifest, ANALYSIS_CONSENT_VERSION } from "../src/analysis-contract.js";
import { type AnalysisFundingCommand, type AnalysisFundingPolicy } from "../src/analysis-funding.js";
import { analysisAccountingControls, analysisBudgetWindows, analysisRequestAttempts, analysisReservations, guides } from "../src/db/schema.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "../src/gemini/request.js";
import { JsonGuideRepository } from "../src/repository.js";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { postgresAccountingFixture } from "./helpers/accounting-postgres-fixture.js";

const now = new Date("2026-09-14T12:00:00.000Z");
const later = new Date("2026-09-15T01:00:00.000Z");
const limits = { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicrousd: 1_000_000 };
// Fictional accounting policy. No live provider, free-tier proof or spending permission.
const policy: AnalysisFundingPolicy = { version: "accounting-fixture-v1", accountingOnly: true,
  price: { model: GEMINI_TEST_MODEL, version: "fixture-price-v1", inputMicrousdPerMillionTokens: 100000, outputMicrousdPerMillionTokens: 200000 },
  maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 1, globalLimit: limits, guideLimit: limits };
const known = { status: "known" as const, inputTokens: 100, outputTokens: 20 };
const unknown = { status: "unknown" as const };
const identity = { runId: "funded", batchIndex: 0, ordinal: 0 as const, dispatchId: "dispatch-a" };

async function harness(context: TestContext, frames = 2, selected = policy) {
  const h = await createAnalysisHarness(context, frames);
  const command: AnalysisFundingCommand = { type: "request", runId: identity.runId, baseDraftRevision: 0,
    consentVersion: ANALYSIS_CONSENT_VERSION, provider: "gemini", model: GEMINI_TEST_MODEL,
    promptVersion: GEMINI_PROMPT_VERSION, expectedInputFingerprint: analysisManifest(h.guide).fingerprint };
  const funding = await h.repository.reserveAnalysisRequest(h.guideId, command, selected, now);
  assert.ok(funding);
  const execute = (command: AnalysisAccountingCommand, at = now) => h.repository.executeAnalysisAccounting(h.guideId, command, at);
  const allocate = () => execute({ type: "allocate", ...identity });
  const send = () => execute({ type: "sending", ...identity });
  const settle = (usage = known) => execute({ type: "settle", ...identity, usage });
  const state = async () => JSON.parse(await readFile(h.repository.filePath, "utf8"));
  const begin = async () => { assert.ok(await allocate()); assert.ok(await send()); };
  return { ...h, funding, command, execute, allocate, send, settle, state, begin };
}

test("request allocation does not double reserve and known usage settles both windows exactly once", async (context) => {
  const h = await harness(context);
  const before = await h.state();
  const allocated = await h.allocate();
  assert.equal(allocated?.attempt.status, "reserved");
  assert.deepEqual((await h.state()).funding.windows, before.funding.windows);
  await h.send();
  const outcomes = await Promise.all(Array.from({ length: 20 }, () => h.settle()));
  assert.equal(outcomes.filter((o) => o?.replayed === false).length, 1);
  assert.equal(outcomes.filter((o) => o?.replayed === true).length, 19);
  assert.deepEqual(outcomes[0]?.attempt.charged, { requests: 1, inputTokens: 100, outputTokens: 20, costMicrousd: 14 });
  const saved = await h.state();
  for (const window of saved.funding.windows) {
    assert.equal(window.used.requests, 2); // One dispatched + one still reserved retry.
    assert.equal(window.used.inputTokens, 1100);
    assert.equal(window.used.outputTokens, 8212);
    assert.equal(window.used.costMicrousd, allocated!.attempt.maximum.costMicrousd + 14);
  }
  const reopened = new JsonGuideRepository(h.repository.filePath);
  assert.deepEqual(await reopened.getAnalysisRequestAttempts(h.guideId, identity.runId), [outcomes[0]!.attempt]);
  assert.deepEqual(await reopened.getGuideById(h.guideId), h.guide);
  assert.equal((await reopened.getAnalysisState(h.guideId))?.runs[0].status, "queued");
});

test("concurrent allocation and sending have one fresh transition, while identity collisions conflict", async (context) => {
  const h = await harness(context, 8);
  const allocations = await Promise.all(Array.from({ length: 20 }, () => h.allocate()));
  assert.equal(allocations.filter((a) => a?.replayed === false).length, 1);
  const sending = await Promise.all(Array.from({ length: 20 }, () => h.send()));
  assert.equal(sending.filter((a) => a?.replayed === false).length, 1);
  assert.equal(await h.execute({ type: "allocate", ...identity, dispatchId: "different" }), null);
  assert.equal(await h.execute({ type: "allocate", ...identity, batchIndex: 1 }), null);
  assert.equal(await h.execute({ type: "settle", ...identity, dispatchId: "different", usage: known }), null);
  assert.equal((await h.state()).funding.attempts.length, 1);
});

test("unknown usage retains maximum and a late confirmed usage settles once", async (context) => {
  const h = await harness(context);
  await h.begin();
  const before = await h.state();
  const result = await h.execute({ type: "settle", ...identity, usage: unknown });
  assert.equal(result?.attempt.status, "uncertain");
  assert.deepEqual((await h.state()).funding.windows, before.funding.windows);
  assert.equal((await h.execute({ type: "settle", ...identity, usage: unknown }))?.replayed, true);
  const confirmed = await h.execute({ type: "settle", ...identity, usage: known }, later);
  assert.equal(confirmed?.attempt.status, "settled");
  const settled = await h.state();
  assert.equal(await h.execute({ type: "settle", ...identity, usage: unknown }, later), null);
  assert.equal(await h.settle({ ...known, inputTokens: 101 }), null);
  assert.deepEqual(await h.state(), settled);
  assert.equal(await h.repository.getAnalysisBudgetWindow("2026-09-15", "global"), null);
});

test("zero known tokens keep the dispatched request count and unused retry budget", async (context) => {
  const h = await harness(context);
  await h.begin();
  const settled = await h.settle({ ...known, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(settled?.attempt.charged, { requests: 1, inputTokens: 0, outputTokens: 0, costMicrousd: 0 });
  assert.equal((await h.repository.getAnalysisBudgetWindow("2026-09-14", "global"))?.used.requests, 2);
});

test("retry slots cannot run concurrently, exceed bounds or reuse a dispatch ID", async (context) => {
  const h = await harness(context);
  const retry = { ...identity, ordinal: 1 as const, dispatchId: "dispatch-b" };
  assert.equal(await h.execute({ type: "allocate", ...retry }), null);
  await h.begin();
  assert.equal(await h.execute({ type: "allocate", ...retry }), null);
  await h.execute({ type: "settle", ...identity, usage: unknown });
  assert.ok(await h.execute({ type: "allocate", ...retry }));
  assert.ok(await h.execute({ type: "sending", ...retry }));
  assert.ok(await h.execute({ type: "settle", ...retry, usage: known }));
  assert.equal(await h.execute({ type: "allocate", ...retry, dispatchId: "dispatch-c" }), null);
  await assert.rejects(h.execute({ type: "allocate", ...identity, ordinal: 2 } as unknown as AnalysisAccountingCommand));
  assert.equal(await h.execute({ type: "allocate", ...identity, batchIndex: 1, dispatchId: "dispatch-c" }), null);
  assert.equal((await h.state()).funding.attempts.length, 2);
});

test("a zero-retry policy never allocates a retry", async (context) => {
  const h = await harness(context, 2, { ...policy, transientRetries: 0 });
  await h.begin(); await h.settle();
  assert.equal(await h.execute({ type: "allocate", ...identity, ordinal: 1, dispatchId: "retry" }), null);
});

test("cancelled unsent attempts may release once but cannot be transmitted or reused", async (context) => {
  const h = await harness(context);
  await h.allocate();
  assert.equal(await h.execute({ type: "release", ...identity }), null);
  await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: identity.runId });
  assert.equal(await h.send(), null);
  const outcomes = await Promise.all(Array.from({ length: 10 }, () => h.execute({ type: "release", ...identity })));
  assert.equal(outcomes.filter((o) => o?.replayed === false).length, 1);
  assert.equal(outcomes[0]?.attempt.status, "released");
  assert.equal((await h.repository.getAnalysisBudgetWindow("2026-09-14", "global"))?.used.requests, 1);
  assert.equal(await h.send(), null);
  assert.equal(await h.settle(), null);
  assert.equal(await h.execute({ type: "allocate", ...identity, ordinal: 1, dispatchId: "retry" }), null);
});

test("late accounting after cancellation is allowed without resurrecting output; sent requests cannot release", async (context) => {
  const h = await harness(context);
  await h.begin();
  await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: identity.runId });
  assert.equal(await h.execute({ type: "release", ...identity }), null);
  assert.equal((await h.settle())?.attempt.status, "settled");
  const run = (await h.repository.getAnalysisState(h.guideId))!.runs[0];
  assert.equal(run.status, "cancelled"); assert.equal(run.result, null);
});

test("deletion retains numeric settlements and unknown charges, hides records and refuses late mutation", async (context) => {
  const h = await harness(context, 8);
  await h.begin(); await h.settle();
  const second = { ...identity, batchIndex: 1, dispatchId: "second" };
  await h.execute({ type: "allocate", ...second }); await h.execute({ type: "sending", ...second });
  const before = await h.state();
  await h.repository.deleteGuide(h.guideId);
  const saved = await h.state();
  assert.deepEqual(saved.funding.attempts, before.funding.attempts);
  assert.deepEqual(saved.funding.windows, before.funding.windows);
  assert.equal(saved.funding.reservations[0].details, null);
  assert.equal(await h.repository.getAnalysisRequestAttempts(h.guideId, identity.runId), null);
  assert.equal(await h.execute({ type: "settle", ...second, usage: known }), null);
  assert.equal(await h.allocate(), null);
  const text = JSON.stringify(saved.funding.attempts);
  for (const privateValue of ["screen-analysis-v1", h.guide.originalObjectKey, "fixture-token", "fixture-price-v1"]) assert.ok(!text.includes(privateValue));
  assert.deepEqual(await h.state(), saved);
});

test("overrun persists maximum and a global halt across cancellation, deletion, reopen and the next day", async (context) => {
  const h = await harness(context);
  await h.begin();
  const windows = (await h.state()).funding.windows;
  const result = await h.settle({ ...known, inputTokens: 1001 });
  assert.equal(result?.attempt.status, "overrun"); assert.equal(result?.halted, true);
  assert.deepEqual((await h.state()).funding.windows, windows);
  assert.equal((await h.settle({ ...known, inputTokens: 1001 }))?.replayed, true);
  assert.equal(await h.settle(), null);
  await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: identity.runId });
  const reopened = new JsonGuideRepository(h.repository.filePath);
  await assert.rejects(reopened.reserveAnalysisRequest(h.guideId, { ...h.command, runId: "new" }, policy, later),
    (error: unknown) => error instanceof AnalysisAccountingError && error.code === "ANALYSIS_ACCOUNTING_HALTED");
  await h.repository.deleteGuide(h.guideId);
  assert.deepEqual(await reopened.getAnalysisAccountingControl(), { halted: true });
  assert.equal((await h.state()).funding.attempts[0].status, "overrun");
});

test("a late overrun on an uncertain attempt halts an already allocated retry", async (context) => {
  const h = await harness(context);
  await h.begin(); await h.execute({ type: "settle", ...identity, usage: unknown });
  const retry = { ...identity, ordinal: 1 as const, dispatchId: "retry" };
  await h.execute({ type: "allocate", ...retry });
  assert.equal((await h.settle({ ...known, outputTokens: 8193 }))?.halted, true);
  await assert.rejects(h.execute({ type: "sending", ...retry }), /ANALYSIS_ACCOUNTING_HALTED/);
  assert.equal((await h.repository.getAnalysisRequestAttempts(h.guideId, identity.runId))?.length, 2);
});

test("new sending across UTC midnight fails closed while settlement stays in the original day", async (context) => {
  const h = await harness(context);
  await h.allocate();
  await assert.rejects(h.execute({ type: "sending", ...identity }, later), /ANALYSIS_DAY_ROLLOVER/);
  await h.send();
  assert.ok(await h.execute({ type: "settle", ...identity, usage: known }, later));
  await assert.rejects(h.execute({ type: "allocate", ...identity, ordinal: 1, dispatchId: "retry" }, later), /ANALYSIS_DAY_ROLLOVER/);
  assert.equal(await h.repository.getAnalysisBudgetWindow("2026-09-15", "global"), null);
});

test("invalid accounting commands and replaced media cannot create partial records", async (context) => {
  const h = await harness(context);
  const before = await h.state();
  for (const command of [
    { type: "allocate", ...identity, privateData: "do-not-persist" },
    { type: "settle", ...identity, usage: { ...known, inputTokens: -1 } },
    { type: "settle", ...identity, usage: { ...known, rawResponse: "do-not-persist" } },
  ]) await assert.rejects(h.execute(command as AnalysisAccountingCommand));
  assert.equal(await h.send(), null); assert.equal(await h.settle(), null);
  assert.deepEqual(await h.state(), before);
  await h.allocate();
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map((s) => ({ ...s, representativeFrameKey: `replaced/${s.id}.jpg` })));
  assert.equal(await h.send(), null);
});

test("accounting commands copy their timestamp and payload before awaiting storage", async (context) => {
  const h = await harness(context);
  const clock = new Date(now);
  const command: AnalysisAccountingCommand = { type: "allocate", ...identity };
  const pending = h.execute(command, clock);
  clock.setUTCDate(15); command.dispatchId = "mutated";
  const result = await pending;
  assert.equal(result?.attempt.createdAt, now.toISOString());
  assert.equal(result?.attempt.dispatchId, identity.dispatchId);
});

test("settlement write failure leaves both the attempt and counters unchanged", async (context) => {
  const h = await harness(context); await h.begin();
  const before = await h.state();
  const hook = h.repository as unknown as { writeState(state: unknown): Promise<void> };
  context.mock.method(hook, "writeState", async () => { throw new Error("write failure"); }, { times: 1 });
  await assert.rejects(h.settle()); assert.deepEqual(await h.state(), before);
  assert.ok(await h.settle());
});

test("lost settlement acknowledgement reopens as an idempotent replay", async (context) => {
  const h = await harness(context); await h.begin();
  const hook = h.repository as unknown as { writeState(state: unknown): Promise<void> };
  const write = hook.writeState.bind(h.repository);
  context.mock.method(hook, "writeState", async (state: unknown) => { await write(state); throw new Error("lost acknowledgement"); }, { times: 1 });
  await assert.rejects(h.settle()); const saved = await h.state();
  const reopened = new JsonGuideRepository(h.repository.filePath);
  assert.equal((await reopened.executeAnalysisAccounting(h.guideId, { type: "settle", ...identity, usage: known }, later))?.replayed, true);
  assert.deepEqual(await h.state(), saved);
});

test("v2 funding upgrades without repricing and malformed current attempts or counters never reset", async (context) => {
  const h = await harness(context);
  const legacy = await h.state(); legacy.version = 2; delete legacy.funding.attempts; delete legacy.funding.control;
  await writeFile(h.repository.filePath, JSON.stringify(legacy));
  await h.begin(); await h.settle();
  const saved = await h.state(); assert.equal(saved.version, 4);
  assert.deepEqual(saved.funding.reservations, legacy.funding.reservations);
  const malformed = [
    { ...saved, version: 2 },
    { ...saved, funding: { ...saved.funding, attempts: undefined } },
    { ...saved, funding: { ...saved.funding, control: undefined } },
  ];
  for (const mutate of [
    (s: typeof saved) => { s.funding.attempts.push(s.funding.attempts[0]); },
    (s: typeof saved) => { s.funding.attempts[0].charged.costMicrousd = 0; },
    (s: typeof saved) => { s.funding.attempts[0].dispatchId = "invalid/private"; },
    (s: typeof saved) => { s.funding.windows[0].used.requests = 0; },
    (s: typeof saved) => { s.funding.attempts[0].runId = "orphan"; },
  ]) { const bad = structuredClone(saved); mutate(bad); malformed.push(bad); }
  for (const bad of malformed) {
    await writeFile(h.repository.filePath, JSON.stringify(bad));
    await assert.rejects(new JsonGuideRepository(h.repository.filePath).getAnalysisAccountingControl());
    assert.deepEqual(await h.state(), JSON.parse(JSON.stringify(bad)));
  }
});

test("request accounting migration retains records, uniquely binds slots and seeds the stop control once", async () => {
  const attempts = getTableConfig(analysisRequestAttempts);
  assert.equal(attempts.primaryKeys[0].columns.length, 4);
  assert.equal(attempts.foreignKeys[0].reference().foreignTable, analysisReservations);
  assert.equal(attempts.foreignKeys[0].onDelete, "restrict");
  assert.equal(getTableConfig(analysisAccountingControls).foreignKeys.length, 0);
  const migration = await readFile("processor/drizzle/0004_analysis_accounting.sql", "utf8");
  assert.ok(!/DROP\s+(?:TABLE|COLUMN)|TRUNCATE/i.test(migration));
  assert.equal((migration.match(/INSERT INTO "analysis_accounting_controls"/g) ?? []).length, 1);
});

test("settlement discounts are available to new reservations and old reservation replay cannot reset them", async (context) => {
  const capped = { ...policy, globalLimit: { ...limits, requests: 4, inputTokens: 3200 }, guideLimit: { ...limits, requests: 4, inputTokens: 3200 } };
  const h = await harness(context, 2, capped); await h.begin(); await h.settle();
  await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: identity.runId });
  assert.ok(await h.repository.reserveAnalysisRequest(h.guideId, { ...h.command, runId: "new" }, capped, now));
  const before = await h.state();
  assert.equal((await h.repository.reserveAnalysisRequest(h.guideId, h.command, capped, later))?.replayed, true);
  assert.deepEqual(await h.state(), before);
  assert.equal((await h.repository.getAnalysisBudgetWindow("2026-09-14", "global"))?.used.inputTokens, 3100);
});

test("different concurrent usage reports cannot both settle the same request", async (context) => {
  const h = await harness(context); await h.begin();
  const outcomes = await Promise.all([h.settle(), h.settle({ ...known, inputTokens: 500 })]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal((await h.repository.getAnalysisRequestAttempts(h.guideId, identity.runId))?.[0].charged.inputTokens, 100);
});

test("deletion races neither recreate requests nor reset already settled totals", async (context) => {
  for (const deleteFirst of [true, false]) {
    const h = await harness(context); await h.begin();
    const maximum = h.funding.reservation.maximum;
    if (deleteFirst) {
      const [, settled] = await Promise.all([h.repository.deleteGuide(h.guideId), h.settle()]);
      assert.equal(settled, null);
      assert.deepEqual((await h.repository.getAnalysisBudgetWindow("2026-09-14", "global"))?.used, maximum);
    } else {
      const [settled] = await Promise.all([h.settle(), h.repository.deleteGuide(h.guideId)]);
      assert.equal(settled?.attempt.status, "settled");
      assert.equal((await h.repository.getAnalysisBudgetWindow("2026-09-14", "global"))?.used.inputTokens, 1100);
    }
    assert.equal(await h.repository.getAnalysisRequestAttempts(h.guideId, identity.runId), null);
  }
});

test("a failed overrun commit cannot persist only the halt or only the attempt", async (context) => {
  const h = await harness(context); await h.begin();
  const before = await h.state();
  const hook = h.repository as unknown as { writeState(state: unknown): Promise<void> };
  context.mock.method(hook, "writeState", async () => { throw new Error("write failure"); }, { times: 1 });
  await assert.rejects(h.settle({ ...known, inputTokens: 1001 }));
  assert.deepEqual(await h.state(), before);
  assert.equal((await h.settle({ ...known, inputTokens: 1001 }))?.halted, true);
  const corrupt = await h.state(); corrupt.funding.control.halted = false;
  await writeFile(h.repository.filePath, JSON.stringify(corrupt));
  await assert.rejects(new JsonGuideRepository(h.repository.filePath).getAnalysisAccountingControl());
});

test("Postgres accounting uses control/window/guide lock order and atomically writes settlement (transaction double)", async (context) => {
  const h = await harness(context); await h.begin();
  const state = await h.state();
  const pg = postgresAccountingFixture(h.guide, state.analysis[0].state, state.funding);
  const result = await pg.repository.executeAnalysisAccounting(h.guideId, { type: "settle", ...identity, usage: known }, now);
  assert.equal(result?.attempt.status, "settled");
  assert.deepEqual(pg.locks, [analysisAccountingControls, analysisBudgetWindows, analysisBudgetWindows, guides].map((table) => ({ table, mode: "update" })));
  assert.deepEqual(pg.writes, [analysisBudgetWindows, analysisBudgetWindows, analysisRequestAttempts]);
  for (const row of pg.rows(analysisBudgetWindows)) assert.equal((row.payload as { used: { inputTokens: number } }).used.inputTokens, 1100);
  assert.equal((await pg.repository.executeAnalysisAccounting(h.guideId, { type: "settle", ...identity, usage: known }, later))?.replayed, true);
  assert.equal(pg.writes.length, 3);
});

test("Postgres accounting rolls attempted window writes back on failure and rejects missing control (transaction double)", async (context) => {
  const h = await harness(context); await h.begin(); const state = await h.state();
  const pg = postgresAccountingFixture(h.guide, state.analysis[0].state, state.funding);
  const before = pg.rows(analysisBudgetWindows); pg.failAttemptWrite();
  await assert.rejects(pg.repository.executeAnalysisAccounting(h.guideId, { type: "settle", ...identity, usage: known }, now));
  assert.deepEqual(pg.rows(analysisBudgetWindows), before);
  assert.equal(pg.rows(analysisRequestAttempts)[0].status, "sending");
  pg.removeControl();
  await assert.rejects(pg.repository.executeAnalysisAccounting(h.guideId, { type: "settle", ...identity, usage: known }, now), /ANALYSIS_ACCOUNTING_INVALID/);
});

test("Postgres overrun and halt are in the same transaction (transaction double)", async (context) => {
  const h = await harness(context); await h.begin(); const state = await h.state();
  const pg = postgresAccountingFixture(h.guide, state.analysis[0].state, state.funding);
  const before = pg.rows(analysisBudgetWindows);
  const result = await pg.repository.executeAnalysisAccounting(h.guideId, { type: "settle", ...identity, usage: { ...known, outputTokens: 8193 } }, now);
  assert.equal(result?.halted, true);
  assert.deepEqual(pg.rows(analysisBudgetWindows), before);
  assert.deepEqual(pg.rows(analysisAccountingControls)[0].payload, { halted: true });
  assert.equal(pg.rows(analysisRequestAttempts)[0].status, "overrun");
});
