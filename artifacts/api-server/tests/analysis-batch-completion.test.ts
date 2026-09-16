import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import { type AnalysisBatchCompletion } from "../src/processor/analysis-batch-completion.js";
import { ANALYSIS_CONSENT_VERSION, analysisManifest } from "../src/processor/analysis-contract.js";
import type { AnalysisFundingCommand, AnalysisFundingPolicy } from "../src/processor/analysis-funding.js";
import { analysisAccountingControls, analysisBatchesTable, analysisBudgetWindows, analysisRequestAttempts, analysisRuns, guideDrafts, guides } from "../src/processor/db/schema.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "../src/processor/gemini/request.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { createAnalysisHarness, fakeOutput } from "./helpers/analysis-fixtures.js";
import { postgresAccountingFixture } from "./helpers/accounting-postgres-fixture.js";

const now = new Date("2026-09-14T12:00:00.000Z");
const at = (ms: number) => new Date(now.valueOf() + ms);
const limits = { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicrousd: 1_000_000 };
// Fictional usage/price and provider output. No network, source media or spending permission.
const policy: AnalysisFundingPolicy = { version: "batch-fixture", accountingOnly: true,
  price: { model: GEMINI_TEST_MODEL, version: "fictional", inputMicrousdPerMillionTokens: 100000, outputMicrousdPerMillionTokens: 200000 },
  maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 1, globalLimit: limits, guideLimit: limits };
const owner = { attemptId: "owner-a", attemptCount: 1 };
const claim = { runId: "funded", attemptId: owner.attemptId, expectedAttemptCount: 0, leaseMs: 1000 };

async function harness(context: TestContext, frames = 8) {
  const h = await createAnalysisHarness(context, frames);
  const command: AnalysisFundingCommand = { type: "request", runId: claim.runId, baseDraftRevision: 0,
    consentVersion: ANALYSIS_CONSENT_VERSION, provider: "gemini", model: GEMINI_TEST_MODEL,
    promptVersion: GEMINI_PROMPT_VERSION, expectedInputFingerprint: analysisManifest(h.guide).fingerprint };
  assert.ok(await h.repository.reserveAnalysisRequest(h.guideId, command, policy, now));
  assert.ok(await h.repository.claimAnalysisWork(h.guideId, claim, now));
  const state = async () => JSON.parse(await readFile(h.repository.filePath, "utf8"));
  async function begin(index = 0, selectedOwner = owner, time = now, ordinal: 0 | 1 = 0) {
    const dispatchId = `dispatch-${index}-${ordinal}`;
    const identity = { runId: claim.runId, batchIndex: index, ordinal, dispatchId };
    assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "allocate", ...identity, owner: selectedOwner }, time));
    assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "sending", ...identity, owner: selectedOwner }, time));
    const batch = (await h.repository.getAnalysisFunding(h.guideId, claim.runId))!.batches[index];
    return { ...identity, owner: { ...selectedOwner }, expectedInputFingerprint: command.expectedInputFingerprint,
      output: fakeOutput(batch.targetIds), inputTokens: 100, outputTokens: 20 } satisfies AnalysisBatchCompletion;
  }
  const complete = (body: AnalysisBatchCompletion, time = at(10)) => h.repository.completeAnalysisBatch(h.guideId, body, time);
  const pg = async () => postgresAccountingFixture(h.guide, (await h.repository.getAnalysisState(h.guideId))!, (await state()).funding);
  return { ...h, command, begin, complete, state, pg };
}

test("partial batch saves validated output and settlement together without applying the draft or changing the lease", async (context) => {
  const h = await harness(context);
  const body = await h.begin();
  const before = await h.state();
  const result = await h.complete(body);
  assert.equal(result?.outcome, "saved");
  assert.equal(result?.replayed, false);
  assert.equal(result?.batch.status, "succeeded");
  assert.equal(result?.analysis.runs[0].status, "running");
  const saved = await h.state();
  assert.deepEqual(saved.analysis[0].state, before.analysis[0].state);
  assert.equal(saved.funding.attempts[0].status, "settled");
  assert.equal(saved.funding.batches[1].status, "queued");
  assert.equal(saved.funding.windows.find((w: { scope: string }) => w.scope === "global").used.inputTokens, 3100);
  assert.deepEqual(saved.guides, before.guides);
  assert.equal((await h.repository.claimAnalysisWork(h.guideId, claim, at(20)))?.replayed, true);
});

test("last of six batches atomically completes the run and applies the untouched initial draft exactly once", async (context) => {
  const h = await harness(context, 24);
  let last: AnalysisBatchCompletion | undefined;
  for (let index = 5; index >= 0; index--) {
    last = await h.begin(index);
    const result = await h.complete(last);
    assert.equal(result?.analysis.runs[0].status, index === 0 ? "succeeded" : "running");
    assert.equal(result?.analysis.draft?.revision, index === 0 ? 1 : 0);
  }
  const saved = await h.state();
  const run = saved.analysis[0].state.runs[0];
  assert.equal(run.appliedDraftRevision, 1);
  assert.equal(run.inputTokens, 600);
  assert.equal(run.outputTokens, 120);
  assert.equal(run.leaseExpiresAt, null);
  assert.deepEqual(run.result.steps.map((s: { stepId: string }) => s.stepId), h.guide.steps.map((s) => s.id));
  assert.equal((await h.complete(last!))?.replayed, true);
  assert.deepEqual(await h.state(), saved);
  assert.deepEqual(await h.repository.listAnalysisWork(20, at(2000)), []);
});

test("an edited draft is preserved while the full AI proposal is retained separately", async (context) => {
  const h = await harness(context, 2);
  const body = await h.begin();
  const draft = (await h.repository.getAnalysisState(h.guideId))!.draft!;
  draft.document.title = "직접 수정한 안내";
  assert.ok(await h.repository.executeAnalysisCommand(h.guideId, { type: "save-draft", expectedRevision: 0, document: draft.document }));
  const edited = (await h.repository.getAnalysisState(h.guideId))!.draft;
  const result = await h.complete(body);
  assert.equal(result?.analysis.runs[0].status, "succeeded");
  assert.equal(result?.analysis.runs[0].appliedDraftRevision, null);
  assert.deepEqual(result?.analysis.draft, edited);
  assert.ok(result?.analysis.runs[0].result);
});

test("restart and lease takeover preserve completed batches and finish only the remaining batch", async (context) => {
  const h = await harness(context);
  const first = await h.begin();
  await h.complete(first);
  const completed = (await h.state()).funding.batches[0];
  const reopened = new JsonGuideRepository(h.repository.filePath);
  const takeover = { attemptId: "owner-b", attemptCount: 2 };
  assert.ok(await reopened.claimAnalysisWork(h.guideId, { ...claim, attemptId: takeover.attemptId, expectedAttemptCount: 1 }, at(1000)));
  assert.deepEqual((await reopened.getAnalysisFunding(h.guideId, claim.runId))!.batches[0], completed);
  // The original immutable receipt is still readable, but does not resume its expired worker.
  assert.equal((await reopened.completeAnalysisBatch(h.guideId, first, at(1010)))?.replayed, true);
  const second = await h.begin(1, takeover, at(1010));
  const result = await reopened.completeAnalysisBatch(h.guideId, second, at(1020));
  assert.equal(result?.analysis.runs[0].status, "succeeded");
  assert.equal(result?.analysis.runs[0].attemptCount, 2);
  assert.deepEqual((await h.state()).funding.batches[0], completed);
  assert.equal((await h.state()).funding.attempts.length, 2);
});

test("twenty concurrent identical completions settle once and return immutable receipts", async (context) => {
  const h = await harness(context, 2);
  const body = await h.begin();
  const results = await Promise.all(Array.from({ length: 20 }, () => h.complete(body)));
  assert.equal(results.filter((r) => r?.replayed === false).length, 1);
  assert.equal(results.filter((r) => r?.replayed === true).length, 19);
  assert.equal((await h.state()).analysis[0].state.draft.revision, 1);
  assert.equal((await h.state()).funding.attempts.length, 1);
});

test("conflicting outputs/usage and wrong receipts cannot overwrite a completed batch", async (context) => {
  const h = await harness(context);
  const body = await h.begin();
  await h.complete(body);
  const saved = await h.state();
  const altered = structuredClone(body.output); altered.steps[0].instruction = "다른 설명";
  for (const patch of [{ output: altered }, { inputTokens: 101 }, { outputTokens: 21 }, { dispatchId: "another" },
    { owner: { ...owner, attemptId: "another" } }, { expectedInputFingerprint: "0".repeat(64) }]) {
    assert.equal(await h.complete({ ...body, ...patch }), null);
    assert.deepEqual(await h.state(), saved);
  }
});

test("two different completions racing for one batch cannot both win", async (context) => {
  const h = await harness(context);
  const first = await h.begin();
  const other = structuredClone(first); other.output.steps[0].instruction = "다른 제안";
  const results = await Promise.all([h.complete(first), h.complete(other)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await h.state()).funding.attempts[0].charged.inputTokens, 100);
});

test("saved batches cannot allocate retries or send again through the accounting path", async (context) => {
  const h = await harness(context);
  const body = await h.begin();
  await h.complete(body);
  const before = await h.state();
  const identity = { runId: body.runId, batchIndex: 0, ordinal: 1 as const, dispatchId: "retry", owner };
  for (const type of ["allocate", "sending"] as const) {
    assert.equal(await h.repository.executeAnalysisAccounting(h.guideId, { type, ...identity }, at(20)), null);
  }
  assert.deepEqual(await h.state(), before);
});

test("expired/stale ownership and a newer dispatch reject late output but still permit separate numeric settlement", async (context) => {
  const h = await harness(context);
  const stale = await h.begin();
  const before = await h.state();
  assert.equal(await h.complete(stale, at(1000)), null);
  assert.deepEqual(await h.state(), before);
  assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "settle", runId: stale.runId,
    batchIndex: 0, ordinal: 0, dispatchId: stale.dispatchId, usage: { status: "unknown" }, retryableHttpStatus: 503 }, at(999)));
  const takeover = { attemptId: "owner-b", attemptCount: 2 };
  await h.repository.claimAnalysisWork(h.guideId, { ...claim, attemptId: takeover.attemptId, expectedAttemptCount: 1 }, at(1000));
  assert.equal(await h.complete(stale, at(1010)), null);
  assert.equal(await h.complete({ ...stale, owner: takeover }, at(1010)), null);
  const retry = await h.begin(0, takeover, at(1010), 1);
  assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "settle", runId: stale.runId, batchIndex: 0,
    ordinal: 0, dispatchId: stale.dispatchId, usage: { status: "known", inputTokens: 70, outputTokens: 10 } }, at(1015)));
  assert.ok(await h.complete(retry, at(1020)));
  assert.equal((await h.state()).funding.batches[0].completion.ordinal, 1);
});

test("cancellation/deletion and changed frames never accept fresh late output", async (context) => {
  for (const action of ["cancel", "delete", "replace"] as const) {
    const h = await harness(context);
    const body = await h.begin();
    if (action === "cancel") await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: claim.runId });
    if (action === "delete") await h.repository.deleteGuide(h.guideId);
    if (action === "replace") await h.repository.replaceSteps(h.guideId, h.guide.steps.map((s) => ({ ...s, representativeFrameKey: `changed/${s.id}.jpg` })));
    const before = await h.state();
    assert.equal(await h.complete(body), null);
    assert.deepEqual(await h.state(), before);
  }
});

test("invalid output settles known usage and fails safely without saving provider text or altering the draft", async (context) => {
  for (const invalid of [null, { privateBody: "PRIVATE_PROVIDER_BODY" }, fakeOutput(["foreign-frame"])]) {
    const h = await harness(context, 2);
    const body = await h.begin();
    const draft = (await h.state()).analysis[0].state.draft;
    const result = await h.complete({ ...body, output: invalid });
    assert.equal(result?.outcome, "invalid-output");
    assert.equal(result?.analysis.runs[0].errorCode, "AI_INVALID_OUTPUT");
    assert.equal(result?.batch.status, "queued");
    const saved = await h.state();
    assert.equal(saved.funding.attempts[0].status, "settled");
    assert.deepEqual(saved.analysis[0].state.draft, draft);
    assert.ok(!JSON.stringify(saved).includes("PRIVATE_PROVIDER_BODY"));
  }
});

test("usage overrun wins over invalid output and atomically halts admission without accepting a result", async (context) => {
  const h = await harness(context, 2);
  const body = await h.begin();
  const before = await h.state();
  const result = await h.complete({ ...body, inputTokens: 1001, output: null });
  assert.equal(result?.outcome, "overrun");
  assert.equal(result?.analysis.runs[0].errorCode, "AI_PROVIDER_FAILED");
  const saved = await h.state();
  assert.equal(saved.funding.control.halted, true);
  assert.equal(saved.funding.attempts[0].status, "overrun");
  assert.deepEqual(saved.funding.windows, before.funding.windows);
  assert.deepEqual(saved.funding.batches, before.funding.batches);
  assert.deepEqual(saved.analysis[0].state.draft, before.analysis[0].state.draft);
});

test("missing dispatch, changed usage after settlement and invalid command leave all state untouched", async (context) => {
  const h = await harness(context);
  const body = await h.begin();
  const initial = await h.state();
  assert.equal(await h.complete({ ...body, dispatchId: "never-sent" }), null);
  for (const patch of [{ output: undefined }, { inputTokens: -1 }, { outputTokens: NaN }, { batchIndex: 6 },
    { ordinal: 2 }, { owner: { ...owner, attemptCount: 0 } }, { extra: "not-allowed" }]) {
    await assert.rejects(h.complete({ ...body, ...patch } as AnalysisBatchCompletion));
  }
  assert.deepEqual(await h.state(), initial);
  await h.repository.executeAnalysisAccounting(h.guideId, { type: "settle", runId: body.runId, batchIndex: 0, ordinal: 0,
    dispatchId: body.dispatchId, usage: { status: "known", inputTokens: 50, outputTokens: 10 } }, at(1));
  const settled = await h.state();
  assert.equal(await h.complete(body), null);
  assert.deepEqual(await h.state(), settled);
  assert.ok(await h.complete({ ...body, inputTokens: 50, outputTokens: 10 }));
});

test("completion after UTC midnight settles the original day without allocating a new day's budget", async (context) => {
  const h = await harness(context, 2);
  // Use a short owner lease spanning midnight; no request is sent on the new day.
  const raw = await h.state();
  const nearMidnight = "2026-09-14T23:59:59.500Z";
  raw.analysis[0].state.runs[0].updatedAt = nearMidnight;
  raw.analysis[0].state.runs[0].leaseExpiresAt = "2026-09-15T00:00:00.500Z";
  await writeFile(h.repository.filePath, JSON.stringify(raw));
  const body = await h.begin(0, owner, new Date(nearMidnight));
  const result = await h.complete(body, new Date("2026-09-15T00:00:00.100Z"));
  assert.equal(result?.analysis.runs[0].status, "succeeded");
  assert.equal(await h.repository.getAnalysisBudgetWindow("2026-09-15", "global"), null);
  assert.equal((await h.state()).funding.reservations[0].day, "2026-09-14");
});

test("write failure and guard rejection cannot leave discounted budget, a result or applied draft alone", async (context) => {
  const h = await harness(context, 2);
  const body = await h.begin();
  const before = await h.state();
  const broken = new JsonGuideRepository(h.repository.filePath);
  (broken as unknown as { writeState: () => Promise<void> }).writeState = async () => { throw new Error("disk failed"); };
  await assert.rejects(broken.completeAnalysisBatch(h.guideId, body, at(10)));
  for (const guard of [() => { throw new Error("revoked"); }, async () => { throw new Error("private guard error"); }]) {
    await assert.rejects(h.repository.completeAnalysisBatch(h.guideId, body, at(10), guard));
  }
  assert.deepEqual(await h.state(), before);
});

test("lost commit acknowledgement reopens as an immutable result receipt without a second draft application", async (context) => {
  const h = await harness(context, 2);
  const body = await h.begin();
  const broken = new JsonGuideRepository(h.repository.filePath);
  const original = (broken as unknown as { writeState: (raw: unknown) => Promise<void> }).writeState.bind(broken);
  (broken as unknown as { writeState: (raw: unknown) => Promise<void> }).writeState = async (raw) => { await original(raw); throw new Error("lost reply"); };
  await assert.rejects(broken.completeAnalysisBatch(h.guideId, body, at(10)));
  const saved = await h.state();
  assert.equal((await new JsonGuideRepository(h.repository.filePath).completeAnalysisBatch(h.guideId, body, at(20)))?.replayed, true);
  assert.deepEqual(await h.state(), saved);
});

test("caller mutations while waiting cannot change output, owner or usage being committed", async (context) => {
  const h = await harness(context, 2);
  const body = await h.begin();
  const promise = h.complete(body);
  body.output.steps[0].instruction = "변경된 본문";
  body.owner.attemptId = "mutated-owner";
  body.inputTokens = 500;
  const result = await promise;
  assert.equal(result?.outcome, "saved");
  assert.equal(result?.analysis.runs[0].inputTokens, 100);
  assert.equal(result?.analysis.runs[0].result?.steps[0].instruction, "설정 버튼을 누르세요.");
});

test("v3 upgrades on write without resetting queued work and rejects downgraded completed results", async (context) => {
  const h = await harness(context);
  const body = await h.begin();
  const old = await h.state(); old.version = 3;
  for (const r of old.funding.reservations) { delete r.released; delete r.closedAt; }
  await writeFile(h.repository.filePath, JSON.stringify(old));
  assert.equal((await new JsonGuideRepository(h.repository.filePath).getAnalysisState(h.guideId))?.runs[0].attemptCount, 1);
  assert.equal((await h.state()).version, 3); // Read-only migration does not rewrite disk.
  await h.complete(body);
  const saved = await h.state();
  assert.equal(saved.version, 5);
  assert.deepEqual(saved.funding.reservations.map(({ released, closedAt, ...r }: Record<string, unknown>) => {
    void released; void closedAt; return r;
  }), old.funding.reservations);
  assert.deepEqual(saved.analysis[0].state, old.analysis[0].state);
  saved.version = 3;
  await writeFile(h.repository.filePath, JSON.stringify(saved));
  await assert.rejects(new JsonGuideRepository(h.repository.filePath).getAnalysisState(h.guideId));
});

test("corrupted completion fingerprints, frames, owners, accounting references and final results fail closed", async (context) => {
  const h = await harness(context, 2);
  const body = await h.begin(); await h.complete(body);
  const saved = await h.state();
  for (const mutate of [
    (s: typeof saved) => { s.funding.batches[0].completion.inputFingerprint = "0".repeat(64); },
    (s: typeof saved) => { s.funding.batches[0].completion.output.steps[0].stepId = "foreign"; },
    (s: typeof saved) => { s.funding.batches[0].completion.owner.attemptId = "foreign"; },
    (s: typeof saved) => { s.funding.batches[0].completion.dispatchId = "foreign"; },
    (s: typeof saved) => { s.funding.batches[0].completion.inputTokens = 99; },
    (s: typeof saved) => { delete s.funding.batches[0].completion; },
    (s: typeof saved) => { s.analysis[0].state.runs[0].result.steps[0].instruction = "불일치"; },
  ]) {
    const corrupt = structuredClone(saved); mutate(corrupt);
    await writeFile(h.repository.filePath, JSON.stringify(corrupt));
    await assert.rejects(new JsonGuideRepository(h.repository.filePath).getAnalysisState(h.guideId));
    assert.deepEqual(await h.state(), corrupt);
  }
});

test("Postgres completion uses control/window/guide locks and commits accounting, batch, draft and run together (transaction double)", async (context) => {
  const h = await harness(context, 2);
  const body = await h.begin(); const pg = await h.pg(); pg.setClock(at(10));
  const result = await pg.repository.completeAnalysisBatch(h.guideId, body);
  assert.equal(result?.analysis.runs[0].status, "succeeded");
  assert.deepEqual(pg.locks, [{ table: analysisAccountingControls, mode: "update" },
    { table: analysisBudgetWindows, mode: "update" }, { table: analysisBudgetWindows, mode: "update" }, { table: guides, mode: "update" }]);
  assert.deepEqual(pg.isolationLevels, ["read committed"]);
  assert.deepEqual(pg.writes, [analysisBudgetWindows, analysisBudgetWindows, analysisRequestAttempts, analysisBatchesTable, guideDrafts, analysisRuns]);
  assert.equal(pg.rows(analysisBatchesTable)[0].status, "succeeded");
  assert.equal((await pg.repository.getAnalysisState(h.guideId))?.draft?.revision, 1);
  const count = pg.writes.length;
  assert.equal((await pg.repository.completeAnalysisBatch(h.guideId, body))?.replayed, true);
  assert.equal(pg.writes.length, count);
});

test("Postgres late write failures roll back all affected rows including the final result (transaction double)", async (context) => {
  const h = await harness(context, 2);
  const body = await h.begin();
  const tables = [analysisBudgetWindows, analysisRequestAttempts, analysisBatchesTable, guideDrafts, analysisRuns, analysisAccountingControls];
  for (const table of tables.slice(0, 5)) {
    const pg = await h.pg();
    const before = tables.map(pg.rows);
    pg.failWrite(table);
    await assert.rejects(pg.repository.completeAnalysisBatch(h.guideId, body, at(10)));
    assert.deepEqual(tables.map(pg.rows), before);
  }
});

test("Postgres read paths reject a batch status projection or output/accounting mismatch (transaction double)", async (context) => {
  const h = await harness(context, 2);
  const body = await h.begin(); await h.complete(body);
  const pg = await h.pg();
  const rows = pg.rows(analysisBatchesTable); rows[0].status = "queued";
  pg.replaceRows(analysisBatchesTable, rows);
  await assert.rejects(pg.repository.getAnalysisFunding(h.guideId, claim.runId));
  await assert.rejects(pg.repository.getAnalysisState(h.guideId));
});

test("completion and cancellation races leave a cancelled run and never apply a partial draft", async (context) => {
  for (const cancelFirst of [true, false]) {
    const h = await harness(context);
    const body = await h.begin();
    const cancel = () => h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: claim.runId });
    await Promise.all(cancelFirst ? [cancel(), h.complete(body)] : [h.complete(body), cancel()]);
    const saved = await h.state();
    assert.equal(saved.analysis[0].state.runs[0].status, "cancelled");
    assert.equal(saved.analysis[0].state.draft.revision, 0);
    assert.equal(saved.funding.batches[0].status, cancelFirst ? "queued" : "succeeded");
  }
});

test("guide deletion removes saved partial output while retaining numeric usage and budget", async (context) => {
  const h = await harness(context);
  const body = await h.begin(); await h.complete(body);
  const before = await h.state();
  assert.equal(await h.repository.deleteGuide(h.guideId), true);
  const saved = await h.state();
  assert.deepEqual(saved.analysis, []);
  assert.deepEqual(saved.funding.batches, []);
  assert.equal(saved.funding.reservations[0].details, null);
  assert.deepEqual(saved.funding.attempts, before.funding.attempts);
  assert.deepEqual(saved.funding.windows, before.funding.windows);
  assert.equal(await h.complete(body), null);
  assert.ok(!JSON.stringify(saved).includes("설정 버튼을 누르세요."));
});

test("immutable partial receipt replay after cancellation never changes a subsequent user edit", async (context) => {
  const h = await harness(context);
  const body = await h.begin(); await h.complete(body);
  await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: claim.runId });
  const draft = (await h.repository.getAnalysisState(h.guideId))!.draft!;
  draft.document.title = "취소 후 직접 편집";
  await h.repository.executeAnalysisCommand(h.guideId, { type: "save-draft", expectedRevision: 0, document: draft.document });
  const saved = await h.state();
  const receipt = await h.complete(body);
  assert.equal(receipt?.replayed, true);
  assert.equal(receipt?.analysis.runs[0].status, "cancelled");
  assert.deepEqual(await h.state(), saved);
});

test("Postgres overrun and safe failure roll back if the global halt cannot be saved (transaction double)", async (context) => {
  const h = await harness(context, 2);
  const body = await h.begin(); const pg = await h.pg();
  const tables = [analysisBudgetWindows, analysisRequestAttempts, analysisBatchesTable, guideDrafts, analysisRuns, analysisAccountingControls];
  const before = tables.map(pg.rows);
  pg.failWrite(analysisAccountingControls);
  await assert.rejects(pg.repository.completeAnalysisBatch(h.guideId, { ...body, inputTokens: 1001 }, at(10)));
  assert.deepEqual(tables.map(pg.rows), before);
  const good = await h.pg();
  assert.equal((await good.repository.completeAnalysisBatch(h.guideId, { ...body, inputTokens: 1001 }, at(10)))?.outcome, "overrun");
  assert.equal(good.rows(analysisAccountingControls)[0].payload && (good.rows(analysisAccountingControls)[0].payload as { halted: boolean }).halted, true);
  assert.equal(good.rows(analysisRuns)[0].status, "failed");
});

test("Postgres uses its post-lock clock to reject fresh output at lease expiry (transaction double)", async (context) => {
  const h = await harness(context, 2);
  const body = await h.begin(); const pg = await h.pg();
  pg.setClock(at(1000));
  assert.equal(await pg.repository.completeAnalysisBatch(h.guideId, body), null);
  assert.deepEqual(pg.writes, []);
});

test("batch status migration backfills prior payloads without resetting results or deleting accounting", async () => {
  const sql = await readFile("drizzle/0006_analysis_batch_completion.sql", "utf8");
  assert.ok(sql.indexOf('UPDATE "analysis_batches"') < sql.indexOf('SET NOT NULL'));
  assert.ok(!/DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i.test(sql));
  assert.ok(sql.includes('"payload"->>\'status\''));
  assert.ok(getTableConfig(analysisBatchesTable).checks.some((c) => c.name === "analysis_batches_status_check"));
});
