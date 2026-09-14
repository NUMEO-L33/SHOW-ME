import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import { analysisManifest, ANALYSIS_CONSENT_VERSION } from "../src/analysis-contract.js";
import { AnalysisFundingError, parseFundingLedger, type AnalysisFundingCommand, type AnalysisFundingPolicy } from "../src/analysis-funding.js";
import { analysisBatchesTable, analysisBudgetWindows, analysisReservations, analysisRuns, guides, guideSteps } from "../src/db/schema.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "../src/gemini/request.js";
import { JsonGuideRepository, PostgresGuideRepository, type ProcessorDatabase } from "../src/repository.js";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";

const now = new Date("2026-09-14T12:00:00.000Z");
const limits = { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicrousd: 1_000_000 };
// Fictional accounting values, not prices, budget approval or live admission.
const policy: AnalysisFundingPolicy = { version: "fixture-policy-v1", accountingOnly: true,
  price: { model: GEMINI_TEST_MODEL, version: "fixture-price-v1", inputMicrousdPerMillionTokens: 100000, outputMicrousdPerMillionTokens: 200000 },
  maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 1, globalLimit: limits, guideLimit: limits };

async function harness(context: TestContext, frameCount = 2) {
  const h = await createAnalysisHarness(context, frameCount);
  const command = (runId = "funded-a"): AnalysisFundingCommand => ({ type: "request", runId, baseDraftRevision: 0,
    consentVersion: ANALYSIS_CONSENT_VERSION, provider: "gemini", model: GEMINI_TEST_MODEL,
    promptVersion: GEMINI_PROMPT_VERSION, expectedInputFingerprint: analysisManifest(h.guide).fingerprint });
  const reserve = (runId = "funded-a", selectedPolicy = policy, at = now) => h.repository.reserveAnalysisRequest(h.guideId, command(runId), selectedPolicy, at);
  const state = async () => JSON.parse(await readFile(h.repository.filePath, "utf8"));
  return { ...h, command, reserve, state };
}

test("funding atomically saves the draft, run, six bounded batches and both budget windows", async (context) => {
  const h = await harness(context, 24);
  const result = await h.reserve();
  assert.ok(result);
  assert.equal(result.replayed, false);
  assert.equal(result.analysis.draft?.revision, 0);
  assert.equal(result.batches.length, 6);
  assert.equal(result.reservation.maximum.requests, 12);
  assert.deepEqual(result.batches[0].contextIds, ["step-4"]);
  assert.deepEqual(result.batches[1].contextIds, ["step-3", "step-8"]);
  const saved = await h.state();
  assert.equal(saved.version, 3);
  assert.equal(saved.funding.reservations.length, 1);
  assert.equal(saved.funding.windows.length, 2);
  for (const window of saved.funding.windows) assert.deepEqual(window.used, result.reservation.maximum);
  assert.deepEqual(await h.repository.getGuideById(h.guideId), h.guide);
  const reopened = new JsonGuideRepository(h.repository.filePath);
  assert.deepEqual(await reopened.getAnalysisFunding(h.guideId, "funded-a"), { reservation: result.reservation, batches: result.batches });
  const privateData = JSON.stringify(saved.funding);
  for (const forbidden of ["fixture-token", h.guide.editTokenHash, h.guide.originalObjectKey, "private-fixture.mp4"]) assert.ok(!privateData.includes(forbidden));
});

test("twenty concurrent duplicate requests create exactly one reservation and one run", async (context) => {
  const h = await harness(context);
  const results = await Promise.all(Array.from({ length: 20 }, () => h.reserve()));
  assert.equal(results.filter((result) => result?.replayed === false).length, 1);
  assert.equal(results.filter((result) => result?.replayed === true).length, 19);
  const saved = await h.state();
  assert.equal(saved.analysis[0].state.runs.length, 1);
  assert.equal(saved.funding.reservations.length, 1);
  assert.deepEqual(saved.funding.windows[0].used, results[0]!.reservation.maximum);
});

test("different concurrent run IDs cannot both become active", async (context) => {
  const h = await harness(context);
  const results = await Promise.all([h.reserve("a"), h.reserve("b")]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await h.state()).funding.reservations.length, 1);
});

test("global budget protects multiple guides and rejection leaves no partial draft or guide window", async (context) => {
  const h = await harness(context);
  await h.repository.createGuide({ id: "second", slug: "second", editToken: "second-token", title: "fixture", status: "queued",
    originalObjectKey: "second/source.mp4", sourceFilename: "synthetic.mp4", sourceMimeType: "video/mp4", sourceSizeBytes: 1 });
  await h.repository.claimProcessingAttempt("second", "second-attempt");
  await h.repository.updateStatus("second", "extracting");
  const second = await h.repository.completeProcessingAttempt("second", { attemptId: "second-attempt", attemptCount: 1,
    steps: h.guide.steps.map((step) => ({ ...step, id: `second-${step.id}`, representativeFrameKey: `second/${step.id}.jpg` })) });
  assert.ok(second);
  const capped = { ...policy, globalLimit: { ...limits, requests: 2 } };
  const outcomes = await Promise.allSettled([h.reserve("a", capped), h.repository.reserveAnalysisRequest("second",
    { ...h.command("b"), expectedInputFingerprint: analysisManifest(second).fingerprint }, capped, now)]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(failed?.status === "rejected" && failed.reason instanceof AnalysisFundingError);
  assert.equal(failed.reason.code, "ANALYSIS_BUDGET_LIMIT");
  const saved = await h.state();
  assert.equal(saved.funding.reservations.length, 1);
  assert.equal(saved.funding.windows.length, 2);
  assert.equal(saved.analysis.length, 1);
});

test("guide limit survives cancellation without refunding or modifying the global window on rejection", async (context) => {
  const h = await harness(context);
  const capped = { ...policy, guideLimit: { ...limits, requests: 2 } };
  await h.reserve("a", capped);
  await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: "a" });
  const before = await h.state();
  await assert.rejects(h.reserve("b", capped), (error: unknown) => error instanceof AnalysisFundingError && error.code === "ANALYSIS_BUDGET_LIMIT");
  assert.deepEqual(await h.state(), before);
});

test("invalid policy, absent consent, zero caps and replaced input cannot partially initialize funding", async (context) => {
  const h = await harness(context);
  const before = await h.state();
  await assert.rejects(h.reserve("a", { ...policy, accountingOnly: false } as unknown as AnalysisFundingPolicy));
  await assert.rejects(h.reserve("a", { ...policy, globalLimit: { ...limits, requests: 0 } }));
  await assert.rejects(h.repository.reserveAnalysisRequest(h.guideId, { ...h.command(), consentVersion: "old" }, policy, now));
  assert.equal(await h.repository.reserveAnalysisRequest(h.guideId, { ...h.command(), baseDraftRevision: 1 }, policy, now), null);
  assert.equal(await h.repository.reserveAnalysisRequest(h.guideId, { ...h.command(), expectedInputFingerprint: "0".repeat(64) }, policy, now), null);
  assert.deepEqual(await h.state(), before);
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map((step) => ({ ...step, representativeFrameKey: `replaced/${step.id}.jpg` })));
  assert.equal(await h.reserve(), null);
  assert.deepEqual((await h.state()).funding, before.funding);
});

test("replay on a later day uses the original policy without reserving again, but changed input conflicts", async (context) => {
  const h = await harness(context);
  const first = await h.reserve();
  const before = await h.state();
  const later = new Date("2026-09-15T01:00:00Z");
  const result = await h.reserve("funded-a", { ...policy, version: "fixture-policy-v2", price: { ...policy.price, version: "fixture-price-v2" } }, later);
  assert.equal(result?.replayed, true);
  assert.deepEqual(result?.reservation, first?.reservation);
  assert.equal(await h.repository.getAnalysisBudgetWindow("2026-09-15", "global"), null);
  assert.equal(await h.repository.reserveAnalysisRequest(h.guideId, { ...h.command(), baseDraftRevision: 1 }, policy, now), null);
  assert.deepEqual(await h.state(), before);
});

test("changing an active day's policy cannot reset its budget and a fresh day leaves yesterday intact", async (context) => {
  const h = await harness(context);
  await h.reserve("a");
  await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: "a" });
  const before = await h.state();
  await assert.rejects(h.reserve("b", { ...policy, version: "fixture-policy-v2" }), (error: unknown) => error instanceof AnalysisFundingError && error.code === "ANALYSIS_POLICY_CHANGED");
  assert.deepEqual(await h.state(), before);
  assert.ok(await h.reserve("b", policy, new Date("2026-09-15T00:00:00Z")));
  assert.deepEqual(await h.repository.getAnalysisBudgetWindow("2026-09-14", "global"), before.funding.windows.find((w: { scope: string }) => w.scope === "global"));
});

test("the admission timestamp is copied before awaiting storage", async (context) => {
  const h = await harness(context);
  const clock = new Date(now);
  const pending = h.reserve("a", policy, clock);
  clock.setUTCDate(15);
  const result = await pending;
  assert.equal(result?.reservation.day, "2026-09-14");
  assert.equal(result?.reservation.details?.createdAt, now.toISOString());
  assert.equal(await h.repository.getAnalysisBudgetWindow("2026-09-15", "global"), null);
});

test("deletion erases batch and consent details but retains accounting and cannot replay a deleted run", async (context) => {
  const h = await harness(context);
  const capped = { ...policy, guideLimit: { ...limits, requests: 2 } };
  await h.reserve("funded-a", capped);
  const before = await h.state();
  assert.equal(await h.repository.deleteGuide(h.guideId), true);
  const saved = await h.state();
  assert.deepEqual(saved.funding.windows, before.funding.windows);
  assert.equal(saved.funding.reservations[0].details, null);
  assert.equal(saved.funding.batches.length, 0);
  assert.equal(await h.repository.getAnalysisFunding(h.guideId, "funded-a"), null);
  assert.equal(await h.reserve(), null);
  assert.equal(await h.repository.getAnalysisState(h.guideId), null);
  assert.ok(!JSON.stringify(saved).includes("screen-analysis-v1"));
  await h.repository.createGuide({ id: h.guideId, slug: h.guideId, editToken: "replacement-token", title: "replacement",
    status: "queued", originalObjectKey: h.guide.originalObjectKey, sourceFilename: "synthetic.mp4", sourceMimeType: "video/mp4", sourceSizeBytes: 1 });
  await h.repository.claimProcessingAttempt(h.guideId, "media-a");
  await h.repository.updateStatus(h.guideId, "extracting");
  assert.ok(await h.repository.completeProcessingAttempt(h.guideId, { attemptId: "media-a", attemptCount: 1, steps: h.guide.steps }));
  assert.equal(await h.reserve("funded-a", capped), null);
  await assert.rejects(h.reserve("new-run", capped), (error: unknown) => error instanceof AnalysisFundingError && error.code === "ANALYSIS_BUDGET_LIMIT");
  assert.deepEqual((await h.state()).funding.windows, before.funding.windows);
});

test("legacy commands cannot claim a funded run and legacy runs are not retroactively funded", async (context) => {
  const h = await harness(context);
  await h.reserve();
  assert.equal(await h.repository.executeAnalysisCommand(h.guideId, { type: "claim", runId: "funded-a", attemptId: "unmetered", expectedAttemptCount: 0, leaseMs: 1000 }), null);
  await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: "funded-a" });
  assert.ok(await h.repository.executeAnalysisCommand(h.guideId, h.command("legacy")));
  const before = await h.state();
  assert.equal(await h.reserve("legacy"), null);
  assert.deepEqual(await h.state(), before);
});

test("persistence failure cannot leave only a reservation or only a queued run", async (context) => {
  const h = await harness(context);
  const before = await readFile(h.repository.filePath, "utf8");
  const hook = h.repository as unknown as { writeState(state: unknown): Promise<void> };
  context.mock.method(hook, "writeState", async () => { throw new Error("simulated write failure"); }, { times: 1 });
  await assert.rejects(h.reserve());
  assert.equal(await readFile(h.repository.filePath, "utf8"), before);
  assert.ok(await h.reserve());
});

test("a lost commit acknowledgement reopens as one reservation and replay does not write twice", async (context) => {
  const h = await harness(context);
  const hook = h.repository as unknown as { writeState(state: unknown): Promise<void> };
  const write = hook.writeState.bind(h.repository);
  context.mock.method(hook, "writeState", async (state: unknown) => { await write(state); throw new Error("lost acknowledgement"); }, { times: 1 });
  await assert.rejects(h.reserve());
  const before = await h.state();
  const reopened = new JsonGuideRepository(h.repository.filePath);
  const replay = await reopened.reserveAnalysisRequest(h.guideId, h.command(), policy, now);
  assert.equal(replay?.replayed, true);
  assert.equal(before.funding.reservations.length, 1);
  assert.deepEqual(await h.state(), before);
});

test("legacy files upgrade on write and malformed accounting is never reset on reopen", async (context) => {
  const h = await harness(context);
  const legacy = await h.state();
  legacy.version = 1;
  delete legacy.funding;
  await writeFile(h.repository.filePath, JSON.stringify(legacy));
  assert.ok(await h.reserve());
  const saved = await h.state();
  assert.equal(saved.version, 3);
  const invalid = [ { ...saved, funding: null }, { ...saved, funding: undefined }, { ...saved, version: 1 } ];
  const tampered = structuredClone(saved);
  tampered.funding.windows[0].used.requests = 0;
  invalid.push(tampered);
  const wrongBatch = structuredClone(saved);
  wrongBatch.funding.batches[0].targetIds[0] = "foreign-step";
  invalid.push(wrongBatch);
  for (const corrupted of invalid) {
    await writeFile(h.repository.filePath, JSON.stringify(corrupted));
    await assert.rejects(new JsonGuideRepository(h.repository.filePath).getAnalysisState(h.guideId));
    assert.deepEqual(await h.state(), JSON.parse(JSON.stringify(corrupted)));
  }
});

test("funding reads do not initialize and invalid dates and duplicate ledger keys fail closed", async (context) => {
  const h = await harness(context);
  const before = await h.state();
  assert.equal(await h.repository.getAnalysisFunding(h.guideId, "missing"), null);
  assert.equal(await h.repository.getAnalysisBudgetWindow("2026-09-14", "global"), null);
  await assert.rejects(h.repository.getAnalysisBudgetWindow("2026-02-30", "global"));
  await assert.rejects(h.reserve("a", policy, new Date(NaN)));
  assert.deepEqual(await h.state(), before);
  await h.reserve();
  const ledger = (await h.state()).funding;
  for (const field of ["windows", "reservations", "batches"] as const) {
    const corrupt = structuredClone(ledger);
    corrupt[field].push(corrupt[field][0]);
    assert.throws(() => parseFundingLedger(corrupt));
  }
});

test("funding migration preserves accounting independently of guide cascades", async () => {
  const windows = getTableConfig(analysisBudgetWindows);
  const reservations = getTableConfig(analysisReservations);
  const batches = getTableConfig(analysisBatchesTable);
  assert.equal(windows.foreignKeys.length, 0);
  assert.equal(reservations.foreignKeys.length, 0);
  assert.equal(batches.foreignKeys[0].reference().foreignTable, analysisRuns);
  assert.equal(batches.foreignKeys[0].onDelete, "cascade");
  assert.equal(reservations.primaryKeys[0].columns.length, 2);
  const migration = await readFile("processor/drizzle/0003_analysis_funding.sql", "utf8");
  assert.ok(!/DROP\s+(?:TABLE|COLUMN)|TRUNCATE/i.test(migration));
  for (const table of ["analysis_batches", "analysis_reservations", "analysis_budget_windows"]) assert.ok(migration.includes(`CREATE TABLE "${table}"`));
});

test("Postgres deletion orchestration redacts reservation details only after guards, never on media completion (mock transaction)", async (context) => {
  const h = await harness(context);
  const row = { ...h.guide, status: "extracting", createdAt: new Date(h.guide.createdAt), updatedAt: new Date(h.guide.updatedAt) };
  const writes: Array<{ operation: string; table: unknown; values?: unknown }> = [];
  // Verifies repository call placement only, not SQL, locks, rollback or cascades.
  const transaction = {
    select: () => ({ from: (table: unknown) => {
      assert.equal(table, guides);
      return { where: () => ({ limit: () => ({ for: async () => [row] }) }) };
    } }),
    delete: (table: unknown) => ({ where: () => {
      writes.push({ operation: "delete", table });
      return { returning: async () => [{ id: h.guideId }] };
    } }),
    update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: () => {
      writes.push({ operation: "update", table, values });
      return { returning: async () => [{ ...row, ...values }] };
    } }) }),
  };
  const database = { transaction: async <T>(work: (tx: typeof transaction) => Promise<T>) => work(transaction) };
  const repository = new PostgresGuideRepository(database as unknown as ProcessorDatabase);
  assert.ok(await repository.completeProcessingAttempt(h.guideId, {
    attemptId: h.guide.processingAttemptId!, attemptCount: h.guide.processingAttemptCount, steps: [],
  }));
  assert.ok(writes.length > 0);
  assert.ok(writes.every((write) => write.table !== analysisReservations));
  writes.length = 0;
  assert.equal(await repository.deleteGuide(h.guideId, { expectedStatuses: ["failed"] }), false);
  assert.equal(await repository.deleteGuide(h.guideId, { expectedUpdatedAt: "stale" }), false);
  assert.deepEqual(writes, []);
  assert.equal(await repository.deleteGuide(h.guideId), true);
  assert.deepEqual(writes, [
    { operation: "delete", table: guideSteps },
    { operation: "update", table: analysisReservations, values: { details: null } },
    { operation: "delete", table: guides },
  ]);
});
