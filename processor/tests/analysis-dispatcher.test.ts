import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { AnalysisAdmissionInput, AnalysisAdmissionSnapshot } from "../src/analysis-admission.js";
import { ANALYSIS_CONSENT_VERSION, ANALYSIS_LIMITS, analysisManifest } from "../src/analysis-contract.js";
import { DurableAnalysisDispatcher, type AnalysisDispatchProvider } from "../src/analysis-dispatcher.js";
import type { AnalysisFundingCommand, AnalysisFundingPolicy } from "../src/analysis-funding.js";
import { analysisAccountingControls, analysisRequestAttempts, analysisRuns, guides } from "../src/db/schema.js";
import { GeminiAnalysisProvider, GeminiError } from "../src/gemini/provider.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "../src/gemini/request.js";
import { JsonGuideRepository } from "../src/repository.js";
import { createAnalysisHarness, fakeOutput } from "./helpers/analysis-fixtures.js";
import { postgresAccountingFixture } from "./helpers/accounting-postgres-fixture.js";

const now = new Date("2026-09-15T12:00:00.000Z");
const limits = { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicrousd: 1_000_000 };
const policy: AnalysisFundingPolicy = { version: "dispatch-fixture", accountingOnly: true,
  price: { model: GEMINI_TEST_MODEL, version: "fictional", inputMicrousdPerMillionTokens: 100000, outputMicrousdPerMillionTokens: 200000 },
  maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 1, globalLimit: limits, guideLimit: limits };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness(context: TestContext, count = 8, retries: 0 | 1 = 1) {
  const h = await createAnalysisHarness(context, count);
  let timestamp = now.valueOf(); let current = true;
  const clock = () => new Date(timestamp);
  const command: AnalysisFundingCommand = { type: "request", runId: "dispatch-run", baseDraftRevision: 0,
    consentVersion: ANALYSIS_CONSENT_VERSION, provider: "gemini", model: GEMINI_TEST_MODEL,
    promptVersion: GEMINI_PROMPT_VERSION, expectedInputFingerprint: analysisManifest(h.guide).fingerprint };
  const selectedPolicy = { ...policy, transientRetries: retries };
  assert.ok(await h.repository.reserveAnalysisRequest(h.guideId, command, selectedPolicy, clock()));
  // Fictional reports, byte arrays and output only; no live DB, image files, provider or billing checks.
  const snapshot: AnalysisAdmissionSnapshot = {
    id: "dispatch-fixture", checkedAt: clock().toISOString(), validUntil: new Date(timestamp + 20_000).toISOString(),
    guideId: h.guideId, inputFingerprint: command.expectedInputFingerprint, frameCount: count,
    model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION, scope: "approved_synthetic", inputApprovalId: "fictional-input",
    runtime: { repository: "postgres-0006", dispatcher: "durable-accounted-v1", inputTokenBound: 1000, boundIncludes: "prompt-schema-targets-context" },
    policy: selectedPolicy, entitlement: { mode: "free_only", projectRef: "private-project", evidenceId: "private-evidence", paidFallback: false,
      dailyQuota: { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000 } },
  };
  const inspections: AnalysisAdmissionInput[] = [];
  const readiness = {
    async inspect(input: AnalysisAdmissionInput): Promise<unknown> { inspections.push(input); return structuredClone(snapshot); },
    isCurrent: () => current,
  };
  const calls: string[][] = []; const loads: string[] = [];
  const provider: AnalysisDispatchProvider = { name: "gemini", model: GEMINI_TEST_MODEL, transientRetries: 0, maxOutputTokens: 8192, dispatchContract: "single-send-v1",
    async analyzeFrames(input, signal, authorizeSend) {
      const finalCheck = await authorizeSend(signal); finalCheck();
      signal.throwIfAborted(); calls.push(input.targets.map((f) => f.stepId));
      return { status: "completed", output: fakeOutput(input.targets.map((f) => f.stepId)), inputTokens: 100, outputTokens: 20 };
    } };
  const loadImage = async (_guideId: string, stepId: string) => { loads.push(stepId); return new Uint8Array([255, 216, 255, 217]); };
  const workers: DurableAnalysisDispatcher[] = [];
  const make = (overrides: Partial<ConstructorParameters<typeof DurableAnalysisDispatcher>[0]> = {}) => {
    const worker = new DurableAnalysisDispatcher({ repository: h.repository, provider, readiness, loadImage, clock,
      leaseMs: 10_000, statusPollMs: 10, retryDelayMs: 1, ...overrides });
    workers.push(worker); return worker;
  };
  context.after(async () => { await Promise.all(workers.map((w) => w.stop())); });
  const state = async () => JSON.parse(await readFile(h.repository.filePath, "utf8"));
  const run = async () => (await h.repository.getAnalysisState(h.guideId))!.runs[0];
  const claim = async () => {
    const result = await h.repository.claimAnalysisWork(h.guideId, { runId: command.runId, attemptId: "previous-owner",
      expectedAttemptCount: 0, leaseMs: 1000 }, clock());
    assert.ok(result); return { attemptId: result.run.attemptId!, attemptCount: result.run.attemptCount };
  };
  const seedSent = async (index = 0) => {
    const owner = await claim();
    const identity = { runId: command.runId, batchIndex: index, ordinal: 0 as const, dispatchId: "previous-dispatch" };
    assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "allocate", ...identity, owner }, clock()));
    assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "sending", ...identity, owner }, clock()));
    return { ...identity, owner };
  };
  return { ...h, command, snapshot, selectedPolicy, readiness, inspections, provider, calls, loads, loadImage, clock, make, state, run, claim, seedSent,
    advance: (ms: number) => { timestamp += ms; }, revoke: () => { current = false; } };
}

test("dispatcher is disabled by default and is never registered in startup or HTTP", async (context) => {
  const h = await harness(context); const before = await h.state();
  for (const missing of [{ provider: undefined }, { readiness: undefined }, { loadImage: undefined }]) {
    assert.equal(await h.make(missing).tick(), "disabled");
  }
  assert.deepEqual(await h.state(), before); assert.deepEqual(h.calls, []); assert.deepEqual(h.loads, []);
  for (const path of ["processor/src/index.ts", "processor/src/server.ts"]) assert.ok(!(await readFile(path, "utf8")).includes("analysis-dispatcher"));
});

test("one pass processes six ordered batches with sending recorded before each provider invocation", async (context) => {
  const h = await harness(context, 24); const analyze = h.provider.analyzeFrames;
  h.provider.analyzeFrames = async (input, signal, authorizeSend) => {
    const attempts = await h.repository.getAnalysisRequestAttempts(h.guideId, h.command.runId);
    assert.equal(attempts!.filter((a) => a.status === "sending").length, 1);
    assert.ok(input.images.length <= 6);
    return analyze(input, signal, authorizeSend);
  };
  assert.equal(await h.make().tick(), "completed");
  assert.equal(h.calls.length, 6); assert.equal((await h.run()).status, "succeeded");
  assert.equal((await h.run()).inputTokens, 600);
  assert.equal((await h.repository.getAnalysisState(h.guideId))!.draft!.revision, 1);
  assert.ok(!JSON.stringify(await h.state()).includes("private-project"));
});

test("twenty local ticks coalesce and competing dispatcher instances never double-send", async (context) => {
  const h = await harness(context, 2); const first = h.make(); const second = h.make();
  const results = await Promise.all([...Array.from({ length: 20 }, () => first.tick()), second.tick()]);
  assert.equal(results[0], "completed"); assert.equal(h.calls.length, 1);
  assert.equal((await h.run()).attemptCount, 1);
  assert.equal(await first.tick(), "idle");
});

test("restart claims an expired owner and automatically skips its saved batch", async (context) => {
  const h = await harness(context);
  const identity = await h.seedSent();
  assert.ok(await h.repository.completeAnalysisBatch(h.guideId, { ...identity, expectedInputFingerprint: h.command.expectedInputFingerprint,
    output: fakeOutput(h.guide.steps.slice(0, 4).map((s) => s.id)), inputTokens: 100, outputTokens: 20 }, h.clock()));
  h.advance(1001);
  const reopened = new JsonGuideRepository(h.repository.filePath);
  assert.equal(await h.make({ repository: reopened }).tick(), "completed");
  assert.deepEqual(h.calls, [["step-4", "step-5", "step-6", "step-7"]]);
  assert.ok(!h.loads.includes("step-0")); assert.equal((await h.run()).attemptCount, 2);
});

test("a recovered ambiguous send keeps maximum usage and is not blindly retried", async (context) => {
  const h = await harness(context, 2); await h.seedSent(); const before = await h.state(); h.advance(1001);
  assert.equal(await h.make().tick(), "failed"); assert.deepEqual(h.calls, []);
  const state = await h.state(); assert.equal(state.funding.attempts[0].status, "uncertain");
  assert.deepEqual(state.funding.windows, before.funding.windows); assert.equal((await h.run()).status, "failed");
});

test("a recovered reserved-but-never-sent slot is reused safely without adding a request", async (context) => {
  const h = await harness(context, 2); const owner = await h.claim();
  assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "allocate", runId: h.command.runId,
    batchIndex: 0, ordinal: 0, dispatchId: "unsent", owner }, h.clock()));
  h.advance(1001); assert.equal(await h.make().tick(), "completed");
  const attempts = (await h.state()).funding.attempts;
  assert.equal(attempts.length, 1); assert.equal(attempts[0].dispatchId, "unsent"); assert.equal(h.calls.length, 1);
});

test("only qualified transient HTTP failures retry once in a new durable request slot", async (context) => {
  for (const status of [500, 502, 503, 504]) {
    const h = await harness(context, 2); const analyze = h.provider.analyzeFrames; let invoked = 0;
    h.provider.analyzeFrames = async (input, signal, authorizeSend) => {
      if (++invoked === 1) { (await authorizeSend(signal))(); throw new GeminiError("GEMINI_HTTP_FAILED", status); }
      return analyze(input, signal, authorizeSend);
    };
    assert.equal(await h.make().tick(), "completed"); assert.equal(invoked, 2);
    const attempts = (await h.state()).funding.attempts;
    assert.deepEqual(attempts.map((a: { status: string }) => a.status), ["uncertain", "settled"]);
    assert.notEqual(attempts[0].dispatchId, attempts[1].dispatchId);
  }
});

test("quota, authentication, transport, refusal and invalid output never trigger an automatic retry", async (context) => {
  for (const error of [new GeminiError("GEMINI_QUOTA_LIMIT", 429), new GeminiError("GEMINI_AUTH_FAILED", 401),
    new GeminiError("GEMINI_HTTP_FAILED"), new GeminiError("GEMINI_RESPONSE_INVALID"), new Error("private provider body")]) {
    const h = await harness(context, 2); let invoked = 0;
    h.provider.analyzeFrames = async (_input, signal, authorize) => { (await authorize(signal))(); invoked++; throw error; };
    assert.equal(await h.make().tick(), "failed"); assert.equal(invoked, 1); assert.equal((await h.run()).status, "failed");
    assert.ok(!JSON.stringify(await h.state()).includes("private provider body"));
  }
  for (const status of ["refused", "incomplete"] as const) {
    const h = await harness(context, 2); h.provider.analyzeFrames = async (_input, signal, authorize) => { (await authorize(signal))(); return { status }; };
    assert.equal(await h.make().tick(), "failed");
    assert.equal((await h.run()).errorCode, status === "refused" ? "AI_REFUSED" : "AI_INCOMPLETE");
  }
});

test("retry policy zero and exhausted retry slots cannot send an extra request", async (context) => {
  for (const retries of [0, 1] as const) {
    const h = await harness(context, 2, retries); let invoked = 0;
    h.provider.analyzeFrames = async (_input, signal, authorize) => { (await authorize(signal))(); invoked++; throw new GeminiError("GEMINI_HTTP_FAILED", 503); };
    assert.equal(await h.make().tick(), "failed"); assert.equal(invoked, retries + 1);
    assert.equal((await h.state()).funding.attempts.length, retries + 1);
  }
});

test("provider identity, nested retries and output cap mismatches are rejected before claiming or loading", async (context) => {
  const h = await harness(context); const before = await h.state();
  for (const change of [{ name: "other" }, { model: "other" }, { transientRetries: 1 }, { maxOutputTokens: 8193 }, { maxOutputTokens: NaN }]) {
    assert.equal(await h.make({ provider: { ...h.provider, ...change } }).tick(), "unavailable");
  }
  assert.deepEqual(await h.state(), before); assert.deepEqual(h.loads, []);
  const adapter = new GeminiAnalysisProvider({ apiKey: "fictional-key", allowExternalProcessing: false, reserveRequest: async () => {}, transientRetries: 0 });
  assert.equal(adapter.transientRetries, 0); assert.equal(adapter.maxOutputTokens, 8192);
});

test("unavailable, changed, expired, paid or asynchronous permission reports never spend or claim", async (context) => {
  for (const kind of ["revoked", "policy", "expired", "paid", "async"] as const) {
    const h = await harness(context); const before = await h.state();
    if (kind === "revoked") h.revoke();
    if (kind === "policy") h.snapshot.policy = { ...h.selectedPolicy, version: "changed" };
    if (kind === "expired") h.snapshot.validUntil = h.clock().toISOString();
    if (kind === "paid") h.snapshot.entitlement = { mode: "paid_capped", approvalId: "unapproved", projectRef: "private-project", evidenceId: "private-evidence" };
    if (kind === "async") h.readiness.isCurrent = (() => Promise.resolve(true)) as unknown as () => boolean;
    assert.equal(await h.make().tick(), "unavailable"); assert.deepEqual(await h.state(), before); assert.equal(h.loads.length, 0);
  }
});

test("revocation during image loading prevents a send and bounds frame bytes", async (context) => {
  const h = await harness(context, 2);
  assert.equal(await h.make({ loadImage: async () => { h.revoke(); return new Uint8Array([1]); } }).tick(), "unavailable");
  assert.deepEqual(h.calls, []); assert.equal((await h.run()).status, "failed");
  assert.equal((await h.state()).funding.attempts[0].status, "reserved");
  for (const bytes of [new Uint8Array(), new Uint8Array(ANALYSIS_LIMITS.maxImageBytes + 1)]) {
    const bad = await harness(context, 2);
    assert.equal(await bad.make({ loadImage: async () => bytes }).tick(), "failed");
    assert.equal((await bad.run()).errorCode, "AI_INVALID_OUTPUT"); assert.deepEqual(bad.calls, []);
  }
});

test("cancellation during an uncooperative provider aborts locally and never applies its late output", async (context) => {
  const h = await harness(context, 2); const entered = deferred<void>(); const late = deferred<Awaited<ReturnType<AnalysisDispatchProvider["analyzeFrames"]>>>();
  let providerSignal!: AbortSignal;
  h.provider.analyzeFrames = (_input, signal) => { providerSignal = signal; entered.resolve(); return late.promise; };
  const work = h.make().tick(); await entered.promise;
  await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: h.command.runId });
  assert.equal(await work, "interrupted"); assert.equal(providerSignal.aborted, true);
  late.resolve({ status: "completed", output: fakeOutput(h.guide.steps.map((s) => s.id)), inputTokens: 1, outputTokens: 1 });
  await delay(20); const state = await h.state();
  assert.equal(state.analysis[0].state.runs[0].status, "cancelled"); assert.equal(state.analysis[0].state.draft.revision, 0);
  assert.equal(state.funding.attempts[0].status, "uncertain");
});

test("deletion while loading an image cannot send or recreate a guide", async (context) => {
  const h = await harness(context, 2); const entered = deferred<void>(); const image = deferred<Uint8Array>();
  const work = h.make({ loadImage: async () => { entered.resolve(); return image.promise; } }).tick();
  await entered.promise; await h.repository.deleteGuide(h.guideId);
  assert.equal(await work, "interrupted"); image.resolve(new Uint8Array([1])); await delay(10);
  assert.deepEqual(h.calls, []); assert.equal(await h.repository.getGuideById(h.guideId), null);
});

test("request timeout keeps uncertain usage, fails safely and ignores late provider rejection", async (context) => {
  const h = await harness(context, 2); const late = deferred<never>(); let invoked = 0;
  h.provider.analyzeFrames = () => { invoked++; return late.promise; };
  assert.equal(await h.make({ requestTimeoutMs: 30 }).tick(), "failed");
  late.reject(new Error("private late failure")); await delay(10);
  assert.equal((await h.run()).errorCode, "AI_TIMEOUT"); assert.equal(invoked, 1);
  assert.equal((await h.state()).funding.attempts[0].status, "uncertain");
});

test("stop interrupts a hanging image read promptly and leaves completed work recoverable", async (context) => {
  const h = await harness(context); const entered = deferred<void>(); const image = deferred<Uint8Array>(); let calls = 0;
  const worker = h.make({ loadImage: async (_g, step) => {
    // First batch uses targets 0..3 and context 4; pause at the next batch's first image.
    if (++calls === 6) { entered.resolve(); return image.promise; }
    return h.loadImage(_g, step);
  } });
  const tick = worker.tick(); await entered.promise; await worker.stop(); assert.equal(await tick, "stopped");
  assert.equal((await h.state()).funding.batches[0].status, "succeeded");
  assert.equal((await h.run()).status, "running"); image.resolve(new Uint8Array([1]));
  h.advance(10_001); assert.equal(await h.make().tick(), "completed"); assert.equal(h.calls.length, 2);
});

test("lost result acknowledgement resumes durable progress without a duplicate provider call", async (context) => {
  const h = await harness(context); const complete = h.repository.completeAnalysisBatch.bind(h.repository); let lost = false;
  h.repository.completeAnalysisBatch = async (...args) => { const result = await complete(...args); if (!lost) { lost = true; throw new Error("lost acknowledgement"); } return result; };
  const worker = h.make(); assert.equal(await worker.tick(), "degraded"); assert.equal(h.calls.length, 1);
  h.advance(10_001); assert.equal(await worker.tick(), "completed"); assert.equal(h.calls.length, 2);
});

test("storage failures back off and reset after recovery without logging raw errors", async (context) => {
  const h = await harness(context); const list = h.repository.listAnalysisWork.bind(h.repository);
  h.repository.listAnalysisWork = async () => { throw new Error("private SQL and password"); };
  const worker = h.make({ pollMs: 100 });
  assert.equal(await worker.tick(), "degraded"); assert.equal(worker.getStatus().nextPollMs, 200);
  assert.equal(await worker.tick(), "degraded"); assert.equal(worker.getStatus().nextPollMs, 400);
  assert.ok(!JSON.stringify(worker.getStatus()).includes("password"));
  h.repository.listAnalysisWork = list;
  assert.equal(await worker.tick(), "completed"); assert.equal(worker.getStatus().consecutiveFailures, 0);
});

test("explicit start polls automatically, repeated start is single-flight, and stop clears the loop", async (context) => {
  const h = await harness(context, 2); const finished = deferred<void>(); const complete = h.repository.completeAnalysisBatch.bind(h.repository);
  h.repository.completeAnalysisBatch = async (...args) => { const value = await complete(...args); finished.resolve(); return value; };
  const worker = h.make({ pollMs: 10 }); worker.start(); worker.start();
  await finished.promise; await delay(20); await worker.stop();
  assert.equal(h.calls.length, 1); assert.equal(worker.getStatus().running, false); assert.equal(worker.getStatus().processing, false);
  assert.equal(await worker.tick(), "stopped");
});

test("previous-day queued work is not claimed and midnight after image loading cannot send", async (context) => {
  const h = await harness(context); h.advance(86_400_000); const before = await h.state();
  assert.equal(await h.make().tick(), "idle"); assert.deepEqual(await h.state(), before);
  const active = await harness(context, 2);
  assert.equal(await active.make({ loadImage: async () => { active.advance(86_400_000); return new Uint8Array([1]); } }).tick(), "unavailable");
  assert.deepEqual(active.calls, []);
});

test("invalid output settles known usage and overrun atomically halts further dispatch", async (context) => {
  for (const overrun of [false, true]) {
    const h = await harness(context, 2);
    h.provider.analyzeFrames = async (_input, signal, authorize) => {
      (await authorize(signal))();
      return { status: "completed", output: { private: "bad output" }, inputTokens: overrun ? 1001 : 100, outputTokens: 20 };
    };
    assert.equal(await h.make().tick(), "failed");
    assert.equal((await h.run()).errorCode, overrun ? "AI_PROVIDER_FAILED" : "AI_INVALID_OUTPUT");
    assert.equal((await h.state()).funding.control.halted, overrun);
    assert.ok(!JSON.stringify(await h.state()).includes("bad output"));
  }
});

test("edited draft remains untouched when automatic processing completes", async (context) => {
  const h = await harness(context, 2); const state = await h.repository.getAnalysisState(h.guideId);
  state!.draft!.document.title = "사용자가 쓴 제목";
  await h.repository.executeAnalysisCommand(h.guideId, { type: "save-draft", expectedRevision: 0, document: state!.draft!.document });
  assert.equal(await h.make().tick(), "completed");
  const saved = await h.repository.getAnalysisState(h.guideId);
  assert.equal(saved!.draft!.document.title, "사용자가 쓴 제목"); assert.equal(saved!.runs[0].appliedDraftRevision, null);
});

test("fenced failure and sending uncertainty commit together, preserving known results and maximum budget", async (context) => {
  const h = await harness(context); const identity = await h.seedSent(); const before = await h.state();
  const command = { type: "fail" as const, runId: h.command.runId, ...identity.owner, errorCode: "AI_TIMEOUT" as const };
  assert.equal(await h.repository.failAnalysisWork(h.guideId, { ...command, attemptId: "stale" }, h.clock()), null);
  await assert.rejects(h.repository.failAnalysisWork(h.guideId, command, h.clock(), () => { throw new Error("revoked"); }));
  assert.deepEqual(await h.state(), before);
  h.advance(1001); assert.ok(await h.repository.failAnalysisWork(h.guideId, command, h.clock()));
  const saved = await h.state(); assert.deepEqual(saved.funding.windows, before.funding.windows);
  assert.equal(saved.funding.attempts[0].status, "uncertain"); assert.equal((await h.run()).errorCode, "AI_TIMEOUT");
  assert.equal(await h.repository.failAnalysisWork(h.guideId, command, h.clock()), null);
});

test("Postgres fenced failure uses control/guide locks and rolls back the run on attempt write failure (transaction double)", async (context) => {
  const h = await harness(context, 2); const identity = await h.seedSent();
  const command = { type: "fail" as const, runId: h.command.runId, ...identity.owner, errorCode: "AI_TIMEOUT" as const };
  for (const fail of [false, true]) {
    const pg = postgresAccountingFixture(h.guide, (await h.repository.getAnalysisState(h.guideId))!, (await h.state()).funding);
    const before = pg.rows(analysisRuns); if (fail) pg.failAttemptWrite();
    if (fail) { await assert.rejects(pg.repository.failAnalysisWork(h.guideId, command, h.clock())); assert.deepEqual(pg.rows(analysisRuns), before); }
    else { assert.ok(await pg.repository.failAnalysisWork(h.guideId, command, h.clock())); assert.equal(pg.rows(analysisRequestAttempts)[0].status, "uncertain"); }
    assert.deepEqual(pg.locks.map((l) => l.table), [analysisAccountingControls, guides]);
    assert.deepEqual(pg.isolationLevels, ["read committed"]);
  }
});

test("accounting precommit guard rejects revoked or asynchronous permission with no partial changes", async (context) => {
  const h = await harness(context, 2); const owner = await h.claim(); const before = await h.state();
  const command = { type: "allocate" as const, runId: h.command.runId, batchIndex: 0, ordinal: 0 as const, dispatchId: "guarded", owner };
  for (const guard of [() => { throw new Error("revoked"); }, async () => {}]) {
    await assert.rejects(h.repository.executeAnalysisAccounting(h.guideId, command, h.clock(), guard));
    assert.deepEqual(await h.state(), before);
    const pg = postgresAccountingFixture(h.guide, (await h.repository.getAnalysisState(h.guideId))!, before.funding);
    await assert.rejects(pg.repository.executeAnalysisAccounting(h.guideId, command, h.clock(), guard));
    assert.deepEqual(pg.writes, []);
  }
});

test("Gemini adapter and dispatcher use one send guard per durable request with only outer retries (stub fetch, no network)", async (context) => {
  const h = await harness(context, 2); let fetched = 0; let permits = 0;
  const adapter = new GeminiAnalysisProvider({ model: GEMINI_TEST_MODEL, apiKey: "fictional-api-key", allowExternalProcessing: true,
    transientRetries: 0, reserveRequest: async () => { permits++; }, fetch: async () => {
      if (++fetched === 1) return new Response("unavailable", { status: 503 });
      return Response.json({ modelVersion: GEMINI_TEST_MODEL,
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(fakeOutput(["step-0", "step-1"])) }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } });
    } });
  assert.equal(await h.make({ provider: adapter }).tick(), "completed");
  assert.equal(fetched, 2); assert.equal(permits, 2);
  assert.deepEqual((await h.state()).funding.attempts.map((a: { ordinal: number }) => a.ordinal), [0, 1]);
});

test("revocation during asynchronous adapter preparation prevents the actual fetch (stub fetch, no network)", async (context) => {
  const h = await harness(context, 2); let fetched = 0;
  const adapter = new GeminiAnalysisProvider({ model: GEMINI_TEST_MODEL, apiKey: "fictional-api-key", allowExternalProcessing: true,
    transientRetries: 0, reserveRequest: async () => h.revoke(), fetch: async () => { fetched++; throw new Error("must not fetch"); } });
  assert.equal(await h.make({ provider: adapter, statusPollMs: 5000 }).tick(), "failed");
  assert.equal(fetched, 0); assert.equal((await h.state()).funding.attempts[0].status, "uncertain");
});

test("lost sending acknowledgement cannot invoke a provider or become a blind retry after restart", async (context) => {
  const h = await harness(context, 2); const accounting = h.repository.executeAnalysisAccounting.bind(h.repository);
  h.repository.executeAnalysisAccounting = async (...args) => {
    const result = await accounting(...args); if (args[1].type === "sending") throw new Error("lost sending acknowledgement"); return result;
  };
  const worker = h.make(); assert.equal(await worker.tick(), "degraded"); assert.deepEqual(h.calls, []);
  h.advance(10_001); assert.equal(await worker.tick(), "failed"); assert.deepEqual(h.calls, []);
  assert.equal((await h.state()).funding.attempts.length, 1);
});

test("an I/O timeout invalidates a delayed claim guard so it cannot write after the tick ends", async (context) => {
  const h = await harness(context, 2); const proceed = deferred<void>(); const entered = deferred<void>();
  const claim = h.repository.claimAnalysisWork.bind(h.repository);
  h.repository.claimAnalysisWork = async (...args) => { entered.resolve(); await proceed.promise; return claim(...args); };
  const before = await h.state(); const worker = h.make({ ioTimeoutMs: 100 }); const work = worker.tick();
  await entered.promise; assert.equal(await work, "degraded"); proceed.resolve(); await delay(30);
  assert.deepEqual(await h.state(), before); assert.deepEqual(h.calls, []);
});

test("a replacement owner survives the previous worker's late completion and cleanup", async (context) => {
  const h = await harness(context, 2); const entered = deferred<void>(); const late = deferred<Awaited<ReturnType<AnalysisDispatchProvider["analyzeFrames"]>>>();
  h.provider.analyzeFrames = async (_input, signal, authorize) => { (await authorize(signal))(); entered.resolve(); return late.promise; };
  const work = h.make().tick(); await entered.promise; h.advance(10_001);
  assert.ok(await h.repository.claimAnalysisWork(h.guideId, { runId: h.command.runId, attemptId: "replacement-owner",
    expectedAttemptCount: 1, leaseMs: 1000 }, h.clock()));
  assert.equal(await work, "interrupted");
  late.resolve({ status: "completed", output: fakeOutput(["step-0", "step-1"]), inputTokens: 100, outputTokens: 20 }); await delay(10);
  assert.equal((await h.run()).attemptId, "replacement-owner"); assert.equal((await h.run()).status, "running");
  assert.equal((await h.repository.getAnalysisState(h.guideId))!.draft!.revision, 0);
});

test("global halt while a provider is pending aborts processing without erasing the overrun", async (context) => {
  const h = await harness(context, 2); const entered = deferred<void>(); const late = deferred<never>();
  h.provider.analyzeFrames = async (_input, signal, authorize) => { (await authorize(signal))(); entered.resolve(); return late.promise; };
  const work = h.make().tick(); await entered.promise;
  const attempt = (await h.repository.getAnalysisRequestAttempts(h.guideId, h.command.runId))![0];
  await h.repository.executeAnalysisAccounting(h.guideId, { type: "settle", runId: h.command.runId,
    batchIndex: 0, ordinal: 0, dispatchId: attempt.dispatchId, usage: { status: "known", inputTokens: 1001, outputTokens: 20 } }, h.clock());
  assert.equal(await work, "unavailable"); late.reject(new Error("late private error")); await delay(10);
  const state = await h.state(); assert.equal(state.funding.control.halted, true); assert.equal(state.funding.attempts[0].status, "overrun");
  assert.equal((await h.run()).status, "failed");
});

test("a dispatcher provider cannot return success without the send gate or request two permits", async (context) => {
  for (const twice of [false, true]) {
    const h = await harness(context, 2);
    h.provider.analyzeFrames = async (_input, signal, authorize) => {
      if (twice) { (await authorize(signal))(); await authorize(signal); }
      return { status: "completed", output: fakeOutput(["step-0", "step-1"]), inputTokens: 100, outputTokens: 20 };
    };
    assert.ok(["failed", "unavailable"].includes(await h.make().tick()));
    assert.equal((await h.run()).status, "failed"); assert.equal((await h.state()).funding.batches[0].status, "queued");
  }
});

test("stop waits for bounded uncertain settlement after interrupting a provider", async (context) => {
  const h = await harness(context, 2); const entered = deferred<void>(); const late = deferred<never>();
  h.provider.analyzeFrames = async (_input, signal, authorize) => { (await authorize(signal))(); entered.resolve(); return late.promise; };
  const worker = h.make(); const work = worker.tick(); await entered.promise; await worker.stop();
  assert.equal(await work, "stopped"); assert.equal((await h.state()).funding.attempts[0].status, "uncertain");
  assert.equal((await h.run()).status, "running"); late.reject(new Error("late")); await delay(10);
});
