import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { AnalysisAdmissionInput, AnalysisAdmissionSnapshot } from "../src/processor/analysis-admission.js";
import { operationsBasisFixture } from "./helpers/operations-review-fixture.js";
import { ANALYSIS_CONSENT_VERSION, ANALYSIS_LIMITS, analysisBatches, analysisManifest } from "../src/processor/analysis-contract.js";
import { DurableAnalysisDispatcher, type AnalysisDispatchProvider } from "../src/processor/analysis-dispatcher.js";
import type { AnalysisFundingCommand, AnalysisFundingPolicy } from "../src/processor/analysis-funding.js";
import { analysisAccountingControls, analysisRequestAttempts, analysisRuns, guides } from "../src/processor/db/schema.js";
import { GeminiAnalysisProvider, GeminiError } from "../src/processor/gemini/provider.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "../src/processor/gemini/request.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { createAnalysisHarness, fakeOutput } from "./helpers/analysis-fixtures.js";
import { postgresAccountingFixture } from "./helpers/accounting-postgres-fixture.js";
import { providerQuotaFixture } from "./helpers/provider-quota-fixture.js";
import { AnalysisQuotaChargeError } from "../src/processor/analysis-quota-charge.js";
import { inputBoundFixture } from "./helpers/input-bound-fixture.js";
import { inputMeasurementFixture } from "./helpers/input-measurement-fixture.js";
import { GeminiInputMeasurements } from "../src/processor/gemini/input-measurement.js";
import type { AnalysisMeasurementStage } from "../src/processor/gemini/counted-measurements.js";
import { SYNTHETIC_COUNT_LIMITS } from "../src/processor/gemini/count-policy.js";

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
    runtime: { repository: "postgres-0008", dispatcher: "durable-accounted-v1", inputTokenBound: 1000, boundIncludes: "prompt-schema-targets-context" },
    policy: selectedPolicy, entitlement: { mode: "free_only", projectRef: "private-project", evidenceId: "private-evidence", paidFallback: false,
      operationsBasis: operationsBasisFixture(clock(), "private-evidence"),
      providerLimits: { requestsPerMinute: 15, inputTokensPerMinute: 250_000, requestsPerDay: 100, resetTimeZone: "America/Los_Angeles" } },
  };
  const inspections: AnalysisAdmissionInput[] = [];
  const readiness = {
    async inspect(input: AnalysisAdmissionInput): Promise<unknown> { inspections.push(input); return structuredClone(snapshot); },
    isCurrent: () => current,
  };
  const calls: string[][] = []; const loads: string[] = [];
  const provider: AnalysisDispatchProvider = { name: "gemini", model: GEMINI_TEST_MODEL, transientRetries: 0, maxOutputTokens: 8192, dispatchContract: "locked-send-v2",
    async analyzeFrames(input, signal, authorizeSend) {
      await authorizeSend(signal, async () => new Response());
      signal.throwIfAborted(); calls.push(input.targets.map((f) => f.stepId));
      return { status: "completed", output: fakeOutput(input.targets.map((f) => f.stepId)), inputTokens: 100, outputTokens: 20 };
    } };
  const loadImage = async (guideId: string, stepId: string, signal: AbortSignal, inputFingerprint: string) => {
    assert.equal(guideId, h.guideId); assert.equal(inputFingerprint, command.expectedInputFingerprint);
    signal.throwIfAborted(); loads.push(stepId); return new Uint8Array([255, 216, 255, 217]);
  };
  const workers: DurableAnalysisDispatcher[] = [];
  const quotaStore = providerQuotaFixture(clock);
  const inputBoundVerifier = inputBoundFixture(clock);
  const inputMeasurementVerifier = inputMeasurementFixture(clock);
  const make = (overrides: Partial<ConstructorParameters<typeof DurableAnalysisDispatcher>[0]> = {}) => {
    const worker = new DurableAnalysisDispatcher({ repository: h.repository, provider, readiness, loadImage, clock, quotaStore, inputBoundVerifier, inputMeasurementVerifier,
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
  return { ...h, command, snapshot, selectedPolicy, readiness, inspections, provider, calls, loads, loadImage, clock, make, state, run, claim, seedSent, quotaStore, inputBoundVerifier, inputMeasurementVerifier,
    advance: (ms: number) => { timestamp += ms; }, revoke: () => { current = false; } };
}

test("dispatcher is disabled by default and is never registered in startup or HTTP", async (context) => {
  const h = await harness(context); const before = await h.state();
  for (const missing of [{ provider: undefined }, { readiness: undefined }, { loadImage: undefined }, { quotaStore: undefined }, { inputBoundVerifier: undefined }, { inputMeasurementVerifier: undefined }]) {
    assert.equal(await h.make(missing).tick(), "disabled");
  }
  assert.deepEqual(await h.state(), before); assert.deepEqual(h.calls, []); assert.deepEqual(h.loads, []);
  for (const path of ["src/processor/index.ts", "src/processor/server.ts"]) assert.ok(!(await readFile(path, "utf8")).includes("analysis-dispatcher"));
});

test("dispatcher explicitly measures each batch before generation and never uses an offline fallback on failure", async (t) => {
  for (const failed of [false, true]) {
    const h = await harness(t, 8); const events: string[] = [];
    const cache = new GeminiInputMeasurements({ clock: h.clock, counter: { contract: "separately-metered-countTokens-v1",
      async execute() { events.push("count"); if (failed) throw new Error("fictional count failure"); return { totalTokens: 321 }; } } });
    const stage: AnalysisMeasurementStage = { inspect: cache.inspect.bind(cache), isCurrent: cache.isCurrent.bind(cache),
      async recover() { events.push("recover"); }, async measureForAnalysis(input, scope, context, signal) {
        assert.equal(context.guideId, h.guideId); assert.equal(context.frameCount, 8); assert.equal(context.generationOrdinal, 0);
        assert.equal(context.owner.attemptCount, 1); assert.deepEqual(context.policy, h.selectedPolicy);
        return cache.measure(input, scope, signal);
      } };
    const analyze = h.provider.analyzeFrames; h.provider.analyzeFrames = async (...args) => { events.push("generate"); return analyze(...args); };
    assert.equal(await h.make({ inputMeasurementStage: stage }).tick(), failed ? "unavailable" : "completed");
    assert.deepEqual(events, failed ? ["recover", "count"] : ["recover", "count", "generate", "count", "generate"]);
    assert.equal(h.quotaStore.receipts.length, failed ? 0 : 2);
  }
});

test("a stage alone supplies offline measurements but disabled dispatchers cannot trigger even recovery", async (t) => {
  const h = await harness(t, 2); let recovered = 0; let measured = 0;
  const stage: AnalysisMeasurementStage = { ...h.inputMeasurementVerifier, async recover() { recovered++; },
    async measureForAnalysis() { measured++; } };
  assert.equal(await h.make({ provider: undefined, inputMeasurementStage: stage }).tick(), "disabled");
  assert.equal(recovered, 0); assert.equal(measured, 0);
  assert.equal(await h.make({ inputMeasurementVerifier: undefined, inputMeasurementStage: stage }).tick(), "completed");
  assert.equal(recovered, 1); assert.equal(measured, 1);
});

test("quota denial, invalid receipt or ambiguous commit acknowledgement prevents any actual send", async (context) => {
  for (const kind of ["denied", "invalid", "ack-lost"] as const) {
    const h = await harness(context, 2); let sends = 0;
    h.provider.analyzeFrames = async (_input, signal, authorize) => {
      await authorize(signal, async () => { sends += 1; return new Response(); });
      assert.fail("must not return from refused quota");
    };
    const consume = h.quotaStore.consume.bind(h.quotaStore);
    h.quotaStore.consume = async (...args) => {
      if (kind === "denied") throw new AnalysisQuotaChargeError("PROVIDER_QUOTA_LIMIT");
      const receipt = await consume(...args);
      if (kind === "ack-lost") throw new Error("private commit acknowledgement");
      return { ...receipt, requestKey: "0".repeat(64) };
    };
    assert.equal(await h.make().tick(), "failed"); assert.equal(sends, 0);
    assert.equal(h.quotaStore.receipts.length, kind === "denied" ? 0 : 1);
    assert.equal((await h.state()).funding.attempts[0].status, "uncertain");
  }
});

test("a quota permit is durable before the locked launch and cannot outlive its deadline", async (context) => {
  for (const expired of [false, true]) {
    const h = await harness(context, 2); let sends = 0;
    const consume = h.quotaStore.consume.bind(h.quotaStore);
    h.quotaStore.consume = async (...args) => { const receipt = await consume(...args); if (expired) h.advance(5000); return receipt; };
    h.provider.analyzeFrames = async (input, signal, authorize) => {
      await authorize(signal, async () => { assert.equal(h.quotaStore.receipts.length, 1); sends += 1; return new Response(); });
      return { status: "completed", output: fakeOutput(input.targets.map((f) => f.stepId)), inputTokens: 100, outputTokens: 20 };
    };
    assert.equal(await h.make().tick(), expired ? "failed" : "completed"); assert.equal(sends, expired ? 0 : 1);
    assert.equal(h.quotaStore.receipts.length, 1);
  }
});

test("cancellation after quota COMMIT still blocks launch without refunding the charge", async (context) => {
  const h = await harness(context, 2); const consume = h.quotaStore.consume.bind(h.quotaStore);
  h.quotaStore.consume = async (...args) => {
    const receipt = await consume(...args);
    await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: h.command.runId }); return receipt;
  };
  await h.make().tick(); assert.deepEqual(h.calls, []); assert.equal(h.quotaStore.receipts.length, 1);
  assert.equal((await h.run()).status, "cancelled");
});

test("unverified or oversized total input evidence blocks sending before provider quota is consumed", async (context) => {
  for (const oversized of [false, true]) {
    const h = await harness(context, 2); const inspect = h.inputBoundVerifier.inspect.bind(h.inputBoundVerifier);
    h.inputBoundVerifier.inspect = async (...args) => oversized ? { ...await inspect(...args) as object, totalInputTokenUpperBound: 1001 } : args[0];
    assert.equal(await h.make().tick(), "unavailable"); assert.deepEqual(h.calls, []); assert.equal(h.quotaStore.receipts.length, 0);
    assert.equal((await h.state()).funding.attempts.filter((a: { status: string }) => a.status === "sending").length, 0);
  }
});

test("revoking exact-input evidence after quota COMMIT prevents the final send", async (context) => {
  const h = await harness(context, 2); const consume = h.quotaStore.consume.bind(h.quotaStore);
  h.quotaStore.consume = async (...args) => {
    const receipt = await consume(...args); h.inputBoundVerifier.isCurrent = () => false; return receipt;
  };
  assert.equal(await h.make().tick(), "unavailable"); assert.deepEqual(h.calls, []); assert.equal(h.quotaStore.receipts.length, 1);
});

test("a pause after the prelaunch check still cannot send with an expired quota permit", async (context) => {
  const h = await harness(context, 2); const launch = h.repository.launchAnalysisRequest.bind(h.repository);
  context.mock.method(h.repository, "launchAnalysisRequest", (...args: Parameters<typeof launch>) => {
    const [guideId, command, callback, at, before] = args;
    return launch(guideId, command, (lockedClock) => { h.advance(5000); return callback(lockedClock); }, at, before);
  });
  assert.equal(await h.make().tick(), "failed"); assert.deepEqual(h.calls, []); assert.equal(h.quotaStore.receipts.length, 1);
});

test("missing, oversized or differently approved measured input blocks generation before quota charge", async (context) => {
  for (const kind of ["missing", "oversized", "project", "approval", "request", "manifest"] as const) {
    const h = await harness(context, 2); const inspect = h.inputMeasurementVerifier.inspect;
    h.inputMeasurementVerifier.inspect = async (...args) => {
      const record = await inspect(...args) as object;
      return kind === "missing" ? null : { ...record, ...({
        oversized: { measuredInputTokens: 1001 }, project: { projectRef: "other" }, approval: { inputApprovalId: "other" },
        request: { requestFingerprint: "b".repeat(64) }, manifest: { inputFingerprint: "c".repeat(64) },
      }[kind]) };
    };
    assert.equal(await h.make().tick(), "unavailable"); assert.equal(h.quotaStore.receipts.length, 0); assert.deepEqual(h.calls, []);
    assert.equal((await h.run()).status, "failed");
    assert.equal((await h.state()).funding.attempts[0].status, "released");
  }
});

test("measurement cannot exceed a stricter reviewed upper bound even if the overall policy is larger", async (context) => {
  const h = await harness(context, 2); const inspect = h.inputBoundVerifier.inspect;
  h.inputBoundVerifier.inspect = async (...args) => ({ ...await inspect(...args) as object, totalInputTokenUpperBound: 99 });
  assert.equal(await h.make().tick(), "unavailable"); assert.equal(h.quotaStore.receipts.length, 0); assert.deepEqual(h.calls, []);
});

test("expiry after measurement lookup but before sending leaves no sent attempt or quota charge", async (context) => {
  const h = await harness(context, 2); const inspect = h.inputMeasurementVerifier.inspect;
  h.inputMeasurementVerifier.inspect = async (...args) => {
    const record = { ...await inspect(...args) as object, validUntil: new Date(h.clock().valueOf() + 1).toISOString() };
    h.advance(1); return record;
  };
  assert.equal(await h.make().tick(), "unavailable"); assert.equal(h.quotaStore.receipts.length, 0); assert.deepEqual(h.calls, []);
});

test("measurement revocation after quota commit prevents sending without refunding the charge", async (context) => {
  const h = await harness(context, 2); const consume = h.quotaStore.consume.bind(h.quotaStore);
  h.quotaStore.consume = async (...args) => { const receipt = await consume(...args); h.inputMeasurementVerifier.isCurrent = () => false; return receipt; };
  assert.equal(await h.make().tick(), "unavailable"); assert.equal(h.quotaStore.receipts.length, 1); assert.deepEqual(h.calls, []);
});

test("mutating target/context pixels or metadata after measurement cannot reach the actual fetch", async (context) => {
  for (const kind of ["target", "context", "metadata"] as const) {
    const h = await harness(context, 8); const analyze = h.provider.analyzeFrames;
    h.provider.analyzeFrames = async (input, signal, authorize) => {
      if (kind === "metadata") input.targets[0].timestampMs++;
      else input.images[kind === "target" ? 0 : input.images.length - 1].bytes[3] = 0;
      return analyze(input, signal, authorize);
    };
    assert.equal(await h.make().tick(), "unavailable"); assert.deepEqual(h.calls, []); assert.equal(h.quotaStore.receipts.length, 0);
  }
});

test("final launch callback checks measurement again after the repository prelaunch check", async (context) => {
  const h = await harness(context, 2); const launch = h.repository.launchAnalysisRequest.bind(h.repository);
  context.mock.method(h.repository, "launchAnalysisRequest", (...args: Parameters<typeof launch>) => {
    const [guideId, command, callback, at, before] = args;
    return launch(guideId, command, (lockedClock) => { h.inputMeasurementVerifier.isCurrent = () => false; return callback(lockedClock); }, at, before);
  });
  assert.equal(await h.make().tick(), "unavailable"); assert.equal(h.quotaStore.receipts.length, 1); assert.deepEqual(h.calls, []);
});

test("separately prepared concrete measurements feed the worker without any hidden count during lookup", async (context) => {
  const h = await harness(context, 8); let counts = 0;
  const cache = new GeminiInputMeasurements({ clock: h.clock, counter: {
    contract: "separately-metered-countTokens-v1", async execute() { counts++; return { totalTokens: 100 }; },
  } });
  // Fictional metering executor; prepare records explicitly BEFORE the generation worker runs.
  for (const batch of analysisBatches(analysisManifest(h.guide).frames)) {
    const images = [...batch.targets, ...batch.context].map((frame) => ({ stepId: frame.stepId, mimeType: "image/jpeg" as const,
      bytes: new Uint8Array([255, 216, 255, 217]) }));
    await cache.measure({ ...batch, images }, { projectRef: "private-project", inputApprovalId: "fictional-input",
      inputFingerprint: h.command.expectedInputFingerprint }, new AbortController().signal);
  }
  assert.equal(counts, 2);
  assert.equal(await h.make({ inputMeasurementVerifier: cache }).tick(), "completed");
  assert.equal(counts, 2); assert.equal(h.calls.length, 2); assert.equal(h.quotaStore.receipts.length, 2);
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
  const h = await harness(context, 2); await h.seedSent(); h.advance(1001);
  assert.equal(await h.make().tick(), "failed"); assert.deepEqual(h.calls, []);
  const state = await h.state(); assert.equal(state.funding.attempts[0].status, "uncertain");
  for (const window of state.funding.windows) assert.deepEqual(window.used, state.funding.attempts[0].maximum);
  assert.equal(state.funding.reservations[0].released.requests, 1); assert.equal((await h.run()).status, "failed");
});

test("a persisted transient HTTP receipt survives takeover and permits only the single reserved retry", async (context) => {
  for (const knownLater of [false, true]) {
    const h = await harness(context, 2); const { owner: _owner, ...identity } = await h.seedSent(); void _owner;
    assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "settle", ...identity,
      usage: { status: "unknown" }, retryableHttpStatus: 503 }, h.clock()));
    if (knownLater) assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "settle", ...identity,
      usage: { status: "known", inputTokens: 10, outputTokens: 2 } }, h.clock()));
    h.advance(1001); const worker = h.make(); assert.equal(await worker.tick(), "completed");
    assert.equal(h.calls.length, 1); const s = await h.state();
    assert.equal(s.funding.attempts.length, 2); assert.equal(s.funding.attempts[0].retryableHttpStatus, 503);
    assert.equal(s.funding.attempts[1].ordinal, 1); assert.equal(s.funding.reservations[0].released.requests, 0);
    assert.equal((await h.run()).attemptCount, 2); assert.equal(await worker.tick(), "idle"); assert.equal(h.calls.length, 1);
  }
});

test("a lost transient-receipt acknowledgement recovers its durable eligibility without another original send", async (context) => {
  const h = await harness(context, 2); const analyze = h.provider.analyzeFrames; let invocations = 0;
  h.provider.analyzeFrames = async (input, signal, authorize) => {
    if (++invocations === 1) { await authorize(signal, async () => new Response()); throw new GeminiError("GEMINI_HTTP_FAILED", 503); }
    return analyze(input, signal, authorize);
  };
  const execute = h.repository.executeAnalysisAccounting.bind(h.repository); let lost = false;
  h.repository.executeAnalysisAccounting = async (...args) => {
    const result = await execute(...args);
    if (!lost && args[1].type === "settle" && args[1].retryableHttpStatus) { lost = true; throw new Error("lost acknowledgement"); }
    return result;
  };
  assert.equal(await h.make().tick(), "degraded"); assert.equal(invocations, 1);
  assert.equal((await h.state()).funding.attempts[0].retryableHttpStatus, 503);
  h.advance(10_001); assert.equal(await h.make().tick(), "completed"); assert.equal(invocations, 2);
  assert.equal((await h.state()).funding.attempts.length, 2);
});

test("twenty unavailable candidates cannot hide the next eligible page or consume their claim counts", async (context) => {
  const h = await harness(context, 2);
  const funding = h.repository.getAnalysisFunding.bind(h.repository); const state = h.repository.getAnalysisState.bind(h.repository);
  h.repository.getAnalysisFunding = async () => funding(h.guideId, h.command.runId);
  h.repository.getAnalysisState = async () => state(h.guideId);
  let pages = 0;
  h.repository.listAnalysisWork = async (limit, _at, after) => {
    assert.equal(limit, 20); pages++;
    if (!after) return Array.from({ length: 20 }, (_, i) => ({ guideId: `unavailable-${String(i).padStart(2, "0")}`, runId: h.command.runId, expectedAttemptCount: 0 }));
    assert.equal(after.guideId, "unavailable-19");
    return [{ guideId: h.guideId, runId: h.command.runId, expectedAttemptCount: 0 }];
  };
  // The fictional readiness report is bound to the real guide, so the other candidates fail permission.
  const worker = h.make(); assert.equal(await worker.tick(), "unavailable"); assert.equal(h.calls.length, 0);
  assert.equal((await h.run()).attemptCount, 0); assert.equal(pages, 1);
  assert.equal(await worker.tick(), "completed"); assert.equal(pages, 2); assert.equal(h.calls.length, 1);
});

test("an unavailable head does not stop a ready candidate later in the same bounded page", async (context) => {
  const h = await harness(context, 2);
  const funding = h.repository.getAnalysisFunding.bind(h.repository); const state = h.repository.getAnalysisState.bind(h.repository);
  h.repository.getAnalysisFunding = async () => funding(h.guideId, h.command.runId);
  h.repository.getAnalysisState = async () => state(h.guideId);
  h.repository.listAnalysisWork = async () => ["unavailable", h.guideId].map((guideId) => ({ guideId, runId: h.command.runId, expectedAttemptCount: 0 }));
  assert.equal(await h.make().tick(), "completed"); assert.equal(h.calls.length, 1); assert.equal((await h.run()).attemptCount, 1);
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
      if (++invoked === 1) { await authorizeSend(signal, async () => new Response()); throw new GeminiError("GEMINI_HTTP_FAILED", status); }
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
    h.provider.analyzeFrames = async (_input, signal, authorize) => { await authorize(signal, async () => new Response()); invoked++; throw error; };
    assert.equal(await h.make().tick(), "failed"); assert.equal(invoked, 1); assert.equal((await h.run()).status, "failed");
    assert.ok(!JSON.stringify(await h.state()).includes("private provider body"));
  }
  for (const status of ["refused", "incomplete"] as const) {
    const h = await harness(context, 2); h.provider.analyzeFrames = async (_input, signal, authorize) => { await authorize(signal, async () => new Response()); return { status }; };
    assert.equal(await h.make().tick(), "failed");
    assert.equal((await h.run()).errorCode, status === "refused" ? "AI_REFUSED" : "AI_INCOMPLETE");
  }
});

test("retry policy zero and exhausted retry slots cannot send an extra request", async (context) => {
  for (const retries of [0, 1] as const) {
    const h = await harness(context, 2, retries); let invoked = 0;
    h.provider.analyzeFrames = async (_input, signal, authorize) => { await authorize(signal, async () => new Response()); invoked++; throw new GeminiError("GEMINI_HTTP_FAILED", 503); };
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

test("unavailable, changed, expired, unreviewed, paid or asynchronous permission reports never spend or claim", async (context) => {
  for (const kind of ["revoked", "policy", "expired", "unreviewed", "review-expired", "paid", "async"] as const) {
    const h = await harness(context); const before = await h.state();
    if (kind === "revoked") h.revoke();
    if (kind === "policy") h.snapshot.policy = { ...h.selectedPolicy, version: "changed" };
    if (kind === "expired") h.snapshot.validUntil = h.clock().toISOString();
    if (kind === "unreviewed") Object.assign(h.snapshot.entitlement, { operationsBasis: undefined });
    if (kind === "review-expired" && h.snapshot.entitlement.mode === "free_only") h.snapshot.entitlement.operationsBasis.expiresAt = h.clock().toISOString();
    if (kind === "paid") h.snapshot.entitlement = { mode: "paid_capped", approvalId: "unapproved", projectRef: "private-project", evidenceId: "private-evidence" };
    if (kind === "async") h.readiness.isCurrent = (() => Promise.resolve(true)) as unknown as () => boolean;
    assert.equal(await h.make().tick(), "unavailable"); assert.deepEqual(await h.state(), before); assert.equal(h.loads.length, 0);
  }
});

test("revocation during image loading prevents a send and bounds frame bytes", async (context) => {
  const h = await harness(context, 2);
  assert.equal(await h.make({ loadImage: async () => { h.revoke(); return new Uint8Array([1]); } }).tick(), "unavailable");
  assert.deepEqual(h.calls, []); assert.equal((await h.run()).status, "failed");
  assert.equal((await h.state()).funding.attempts[0].status, "released");
  for (const bytes of [new Uint8Array(), new Uint8Array(ANALYSIS_LIMITS.maxImageBytes + 1)]) {
    const bad = await harness(context, 2);
    assert.equal(await bad.make({ loadImage: async () => bytes }).tick(), "failed");
    assert.equal((await bad.run()).errorCode, "AI_INVALID_OUTPUT"); assert.deepEqual(bad.calls, []);
  }
});

test("explicit count-first dispatcher needs no bound verifier but always measures before generation", async (t) => {
  for (const count of [321, 1001]) {
    const h = await harness(t, 2); const events: string[] = [];
    h.snapshot.runtime = { repository: "postgres-0008", dispatcher: "durable-accounted-v1", counting: "count-accounted-0010-v1",
      inputTokenLimit: 1000, countPolicy: { ...SYNTHETIC_COUNT_LIMITS } };
    const cache = new GeminiInputMeasurements({ clock: h.clock, counter: { contract: "separately-metered-countTokens-v1",
      async execute() { events.push("count"); return { totalTokens: count }; } } });
    const stage: AnalysisMeasurementStage = { inspect: cache.inspect.bind(cache), isCurrent: cache.isCurrent.bind(cache),
      async recover() {}, async measureForAnalysis(input, scope, _context, signal) { return cache.measure(input, scope, signal); } };
    const analyze = h.provider.analyzeFrames; h.provider.analyzeFrames = async (...args) => { events.push("generate"); return analyze(...args); };
    const worker = h.make({ inputBoundVerifier: undefined, inputMeasurementVerifier: undefined, inputMeasurementStage: stage });
    assert.equal(await worker.tick(), count > 1000 ? "unavailable" : "completed");
    assert.deepEqual(events, count > 1000 ? ["count"] : ["count", "generate"]);
    assert.equal(h.quotaStore.receipts.length, count > 1000 ? 0 : 1);
  }
});

test("count-first cannot substitute cached measurements for the count stage or exceed its payload policy", async (t) => {
  for (const mode of ["no-stage", "oversized", "revoked", "changed-pixels"]) {
    const h = await harness(t, 2); let measurements = 0;
    h.snapshot.runtime = { repository: "postgres-0008", dispatcher: "durable-accounted-v1", counting: "count-accounted-0010-v1",
      inputTokenLimit: 1000, countPolicy: { ...SYNTHETIC_COUNT_LIMITS } };
    if (mode === "oversized") h.snapshot.runtime.countPolicy.maxRequestBytes = 100;
    const stage: AnalysisMeasurementStage = { ...h.inputMeasurementVerifier, async recover() {}, async measureForAnalysis(input) {
      measurements++; if (mode === "revoked") h.revoke();
      if (mode === "changed-pixels") input.images[0].bytes[3] = 0;
    } };
    assert.equal(await h.make({ inputMeasurementStage: mode === "no-stage" ? undefined : stage }).tick(),
      mode === "oversized" ? "failed" : "unavailable");
    assert.equal(measurements, mode === "no-stage" || mode === "oversized" ? 0 : 1);
    assert.deepEqual(h.calls, []); assert.equal(h.quotaStore.receipts.length, 0);
  }
});

test("image loading has its own finite budget and can exceed the ordinary 5s I/O deadline", async (context) => {
  const h = await harness(context, 2); let loads = 0;
  const worker = h.make({ statusPollMs: 1000, loadImage: async (...args) => {
    if (++loads === 1) await delay(5200);
    return h.loadImage(...args);
  } });
  assert.equal(await worker.tick(), "completed"); assert.equal(loads, 2); assert.equal(h.calls.length, 1);
});

test("image deadline aborts uncooperative reads and never retries or sends their late output", async (context) => {
  const h = await harness(context, 2); const late = deferred<Uint8Array>();
  let loads = 0; let imageSignal: AbortSignal | undefined;
  const worker = h.make({ imageTimeoutMs: 30, loadImage: async (_g, _s, signal) => {
    loads++; imageSignal = signal; return late.promise;
  } });
  assert.equal(await worker.tick(), "failed"); assert.equal(imageSignal?.aborted, true);
  assert.equal((await h.run()).errorCode, "AI_TIMEOUT");
  late.resolve(new Uint8Array([1])); await delay(10);
  h.advance(10_001); assert.equal(await worker.tick(), "idle");
  assert.equal(loads, 1); assert.deepEqual(h.calls, []); assert.equal(h.quotaStore.receipts.length, 0);
  assert.equal((await h.state()).funding.attempts[0].status, "released");
});

test("a failed private image read terminates unsent work rather than retrying on a later lease", async (context) => {
  const h = await harness(context, 2); let loads = 0;
  const worker = h.make({ loadImage: async () => { loads++; throw new Error("private decoder path"); } });
  assert.equal(await worker.tick(), "failed"); assert.equal((await h.run()).status, "failed");
  h.advance(10_001); assert.equal(await worker.tick(), "idle");
  assert.equal(loads, 1); assert.deepEqual(h.calls, []); assert.equal(h.quotaStore.receipts.length, 0);
  assert.equal((await h.state()).funding.attempts[0].status, "released");
});

test("image-specific budgets cannot remove the global cap or relax ordinary I/O limits", async (context) => {
  const h = await harness(context, 2);
  for (const imageTimeoutMs of [0, -1, 0.5, NaN, Infinity, 15001]) {
    assert.throws(() => h.make({ imageTimeoutMs }));
  }
  assert.throws(() => h.make({ ioTimeoutMs: 5001 }));
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
  const worker = h.make({ loadImage: async (_g, step, signal, fingerprint) => {
    // First batch uses targets 0..3 and context 4; pause at the next batch's first image.
    if (++calls === 6) { entered.resolve(); return image.promise; }
    return h.loadImage(_g, step, signal, fingerprint);
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

test("previous-day queued work closes without claiming and midnight after image loading cannot send", async (context) => {
  const h = await harness(context); h.advance(86_400_000);
  assert.equal(await h.make().tick(), "idle"); assert.equal((await h.run()).status, "failed");
  assert.equal((await h.run()).attemptCount, 0); assert.equal((await h.state()).funding.windows[0].used.requests, 0);
  const active = await harness(context, 2);
  assert.equal(await active.make({ loadImage: async () => { active.advance(86_400_000); return new Uint8Array([1]); } }).tick(), "unavailable");
  assert.deepEqual(active.calls, []);
});

test("invalid output settles known usage and overrun atomically halts further dispatch", async (context) => {
  for (const overrun of [false, true]) {
    const h = await harness(context, 2);
    h.provider.analyzeFrames = async (_input, signal, authorize) => {
      await authorize(signal, async () => new Response());
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
  h.provider.analyzeFrames = async (_input, signal, authorize) => { await authorize(signal, async () => new Response()); entered.resolve(); return late.promise; };
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
  h.provider.analyzeFrames = async (_input, signal, authorize) => { await authorize(signal, async () => new Response()); entered.resolve(); return late.promise; };
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
      if (twice) { await authorize(signal, async () => new Response()); await authorize(signal, async () => new Response()); }
      return { status: "completed", output: fakeOutput(["step-0", "step-1"]), inputTokens: 100, outputTokens: 20 };
    };
    assert.ok(["failed", "unavailable"].includes(await h.make().tick()));
    assert.equal((await h.run()).status, "failed"); assert.equal((await h.state()).funding.batches[0].status, "queued");
  }
});

test("stop waits for bounded uncertain settlement after interrupting a provider", async (context) => {
  const h = await harness(context, 2); const entered = deferred<void>(); const late = deferred<never>();
  h.provider.analyzeFrames = async (_input, signal, authorize) => { await authorize(signal, async () => new Response()); entered.resolve(); return late.promise; };
  const worker = h.make(); const work = worker.tick(); await entered.promise; await worker.stop();
  assert.equal(await work, "stopped"); assert.equal((await h.state()).funding.attempts[0].status, "uncertain");
  assert.equal((await h.run()).status, "running"); late.reject(new Error("late")); await delay(10);
});

test("regression: cancellation committed during the final control read prevents the actual fetch", async (context) => {
  const h = await harness(context, 2); let armed = false; let fetched = 0;
  const control = h.repository.getAnalysisAccountingControl.bind(h.repository);
  h.repository.getAnalysisAccountingControl = async () => {
    if (armed) { armed = false; await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: h.command.runId }); }
    return control();
  };
  const provider = new GeminiAnalysisProvider({ model: GEMINI_TEST_MODEL, apiKey: "fictional-key", allowExternalProcessing: true,
    transientRetries: 0, reserveRequest: async () => { armed = true; }, fetch: async () => { fetched++; return new Response("stub"); } });
  assert.notEqual(await h.make({ provider, statusPollMs: 5000 }).tick(), "completed");
  assert.equal(fetched, 0); assert.equal((await h.run()).status, "cancelled");
  assert.equal((await h.repository.getAnalysisState(h.guideId))!.draft!.revision, 0);
});

test("locked launch linearizes against cancellation without holding the lock for the response", async (context) => {
  for (const cancelFirst of [false, true]) {
    const h = await harness(context, 2); const identity = await h.seedSent(); const events: string[] = [];
    const command = { ...identity, inputFingerprint: h.command.expectedInputFingerprint };
    const response = deferred<Response>(); let pendingCancel: Promise<unknown> | undefined;
    if (cancelFirst) await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: h.command.runId });
    const launched = await h.repository.launchAnalysisRequest(h.guideId, command, () => {
      events.push("send-started"); void response.promise;
      pendingCancel = h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: h.command.runId }).then(() => events.push("cancel-committed"));
    }, h.clock());
    assert.equal(launched, !cancelFirst); await pendingCancel;
    assert.deepEqual(events, cancelFirst ? [] : ["send-started", "cancel-committed"]);
    response.resolve(new Response());
  }
});

test("locked launch revalidates deletion, owner, fingerprint, lease, day and synchronous permission", async (context) => {
  const h = await harness(context, 2); const identity = await h.seedSent(); let launches = 0;
  const command = { ...identity, inputFingerprint: h.command.expectedInputFingerprint };
  for (const wrong of [{ ...command, owner: { ...command.owner, attemptId: "stale" } },
    { ...command, inputFingerprint: "a".repeat(64) }, { ...command, dispatchId: "wrong" }]) {
    assert.equal(await h.repository.launchAnalysisRequest(h.guideId, wrong, () => { launches++; }, h.clock()), false);
  }
  await assert.rejects(h.repository.launchAnalysisRequest(h.guideId, command, () => { launches++; }, h.clock(), async () => {}));
  h.advance(1000); assert.equal(await h.repository.launchAnalysisRequest(h.guideId, command, () => { launches++; }, h.clock()), false);
  await h.repository.deleteGuide(h.guideId);
  assert.equal(await h.repository.launchAnalysisRequest(h.guideId, command, () => { launches++; }, h.clock()), false);
  assert.equal(launches, 0);
});

test("Postgres launches under control/guide locks using a post-read DB clock, with no writes (transaction double)", async (context) => {
  const h = await harness(context, 2); const identity = await h.seedSent();
  const pg = postgresAccountingFixture(h.guide, (await h.repository.getAnalysisState(h.guideId))!, (await h.state()).funding);
  const command = { ...identity, inputFingerprint: h.command.expectedInputFingerprint }; let launches = 0;
  pg.setClock(h.clock());
  assert.equal(await pg.repository.launchAnalysisRequest(h.guideId, command, () => {
    launches++; assert.deepEqual(pg.locks.map((l) => l.table), [analysisAccountingControls, guides]);
  }), true);
  assert.equal(launches, 1); assert.deepEqual(pg.writes, []); assert.deepEqual(pg.isolationLevels, ["read committed"]);
  h.advance(1000); pg.setClock(h.clock());
  assert.equal(await pg.repository.launchAnalysisRequest(h.guideId, command, () => { launches++; }), false);
  assert.equal(launches, 1);
});
