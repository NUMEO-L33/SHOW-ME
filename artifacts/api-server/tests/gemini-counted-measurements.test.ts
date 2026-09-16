import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AnalysisAdmissionSnapshot } from "../src/processor/analysis-admission.js";
import { ANALYSIS_CONSENT_VERSION, analysisBatches, analysisManifest } from "../src/processor/analysis-contract.js";
import { prepareCountAccounting, type AnalysisCountCommand } from "../src/processor/analysis-count-accounting.js";
import { prepareQuotaCharge, type AnalysisQuotaReceipt } from "../src/processor/analysis-quota-charge.js";
import { AccountedGeminiMeasurements, type CountRepository, type AnalysisCountContext } from "../src/processor/gemini/counted-measurements.js";
import { TOKEN_PROBE_ENDPOINT, buildTokenCountRequest } from "../src/processor/gemini/count-request.js";
import { auditGeminiInput } from "../src/processor/gemini/input-bound.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "../src/processor/gemini/request.js";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { inputBoundFixture } from "./helpers/input-bound-fixture.js";

// Fake DB/quota, tiny fixture bytes and injected fetch only. Real SQL tests live in integration/.
async function harness(t: TestContext) {
  const h = await createAnalysisHarness(t, 2); let time = Date.parse("2026-09-15T12:00:00.000Z"); let current = true;
  const clock = () => new Date(time); const manifest = analysisManifest(h.guide);
  const limit = { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicrousd: 1_000_000 };
  const policy: AnalysisCountContext["policy"] = { version: "count-test", accountingOnly: true as const, price: { model: GEMINI_TEST_MODEL,
    version: "fictional", inputMicrousdPerMillionTokens: 100000, outputMicrousdPerMillionTokens: 200000 },
    maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 1 as const, globalLimit: limit, guideLimit: limit };
  const funded = await h.repository.reserveAnalysisRequest(h.guideId, { type: "request", runId: "run", baseDraftRevision: 0,
    consentVersion: ANALYSIS_CONSENT_VERSION, provider: "gemini", model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION,
    expectedInputFingerprint: manifest.fingerprint }, policy, clock()); assert.ok(funded);
  const claim = await h.repository.claimAnalysisWork(h.guideId, { runId: "run", attemptId: "owner", expectedAttemptCount: 0, leaseMs: 30000 }, clock()); assert.ok(claim);
  const context: AnalysisCountContext = { guideId: h.guideId, runId: "run", batchIndex: 0, generationOrdinal: 0, frameCount: 2,
    owner: { attemptId: claim.run.attemptId!, attemptCount: claim.run.attemptCount }, policy };
  const batch = analysisBatches(manifest.frames)[0];
  const input = { ...batch, images: [...batch.targets, ...batch.context].map((f) => ({ stepId: f.stepId,
    mimeType: "image/jpeg" as const, bytes: new Uint8Array([255, 216, 255, 217]) })) };
  const scope = { ...auditGeminiInput(input, "fictional-approval", manifest.fingerprint), projectRef: "fictional-project" };
  const snapshot: AnalysisAdmissionSnapshot = { id: "fictional-readiness", checkedAt: clock().toISOString(), validUntil: new Date(time + 20000).toISOString(),
    guideId: h.guideId, inputFingerprint: manifest.fingerprint, frameCount: 2, model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION,
    scope: "approved_synthetic", inputApprovalId: scope.inputApprovalId, policy,
    runtime: { repository: "postgres-0008", dispatcher: "durable-accounted-v1", counting: "count-accounted-0010-v1",
      inputTokenBound: 1000, boundIncludes: "prompt-schema-targets-context" },
    entitlement: { mode: "free_only", projectRef: scope.projectRef, evidenceId: "fictional-project-evidence", paidFallback: false,
      providerLimits: { requestsPerMinute: 15, inputTokensPerMinute: 250000, requestsPerDay: 100, resetTimeZone: "America/Los_Angeles" } } };
  const readiness = { async inspect() { return structuredClone(snapshot); }, isCurrent: () => current };
  const inputBoundVerifier = inputBoundFixture(clock);
  const state: Parameters<typeof prepareCountAccounting>[0] = { guideId: h.guideId, guide: h.guide,
    analysis: (await h.repository.getAnalysisState(h.guideId))!, reservation: funded.reservation, batches: funded.batches,
    attempts: [], previous: null, windows: (await Promise.all(["global", `guide:${h.guideId}`].map((s) => h.repository.getAnalysisBudgetWindow("2026-09-15", s)))).map((w) => w!),
    control: { halted: false }, command: {} as AnalysisCountCommand, now: clock() };
  const events: string[] = []; const receipts: AnalysisQuotaReceipt[] = []; const tickets = new Set<object>();
  const repository: CountRepository = { countDispatchContract: "postgres-count-0010",
    async executeAnalysisCount(id, command, _at, guard) {
      assert.equal(id, h.guideId); guard?.(); events.push(command.type);
      const next = prepareCountAccounting({ ...state, command, now: clock() });
      let quotaReceipt: AnalysisQuotaReceipt | null = null;
      if (command.type === "sending") {
        quotaReceipt = prepareQuotaCharge({ requestKey: next.record.requestKey, projectRef: command.binding.projectRef, model: GEMINI_TEST_MODEL,
          inputTokenBound: next.record.maximum.inputTokens, limits: command.limits, notAfter: command.notAfter }, receipts, clock()); receipts.push(quotaReceipt);
      }
      if (command.type === "claim-launch") quotaReceipt = receipts[0];
      guard?.(); state.previous = next.record; state.control = next.control; if (next.windows.length) state.windows = next.windows;
      return { ...next, quotaReceipt };
    },
    async claimAnalysisCountLaunch(id, command, at, guard) {
      await repository.executeAnalysisCount(id, command, at, guard); const ticket = {}; tickets.add(ticket); return ticket;
    },
    async launchAnalysisCount(ticket, launch, _at, guard) {
      if (!tickets.delete(ticket)) return false; guard?.(clock); events.push("launch"); launch(clock); return true;
    },
    async listPendingAnalysisCounts() { return state.previous && ["reserved", "sending", "launch_claimed"].includes(state.previous.status) ? [state.previous] : []; },
  };
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, TOKEN_PROBE_ENDPOINT); assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
    assert.deepEqual(JSON.parse(String(init?.body)), buildTokenCountRequest(input)); events.push("http");
    assert.equal(state.previous?.status, "launch_claimed"); assert.equal(receipts.length, 1);
    return Response.json({ totalTokens: 321 });
  };
  const options = { repository, readiness, inputBoundVerifier, apiKey: "fictional-not-a-real-key", allowExternalProcessing: true, fetch: fetcher, clock };
  const stage = new AccountedGeminiMeasurements(options); const controller = new AbortController();
  const measure = (selected = stage) => selected.measureForAnalysis(input, scope, context, controller.signal);
  return { state, repository, events, receipts, options, stage, snapshot, inputBoundVerifier, controller, input, scope, context, measure, clock,
    revoke: () => { current = false; }, advance: (ms: number) => { time += ms; } };
}

test("counted stage commits count, quota and launch before fetch; only settled usage creates offline evidence", async (t) => {
  const h = await harness(t); assert.equal(await h.stage.inspect(h.scope, h.controller.signal), null); assert.deepEqual(h.events, []);
  await h.measure(); assert.deepEqual(h.events, ["reserve", "sending", "claim-launch", "launch", "http", "settle"]);
  assert.equal(h.state.previous?.status, "settled"); assert.equal(h.state.previous?.charged.inputTokens, 321);
  const evidence = await h.stage.inspect(h.scope, h.controller.signal) as { measuredInputTokens: number }; assert.equal(evidence.measuredInputTokens, 321);
  assert.ok(!JSON.stringify(h.state.previous).includes(h.scope.inputApprovalId));
  assert.equal(await new AccountedGeminiMeasurements(h.options).inspect(h.scope, h.controller.signal), null);
  await assert.rejects(h.measure(), /ANALYSIS_UNAVAILABLE/); assert.equal(h.events.filter((e) => e === "http").length, 1);
  assert.equal(h.events.filter((e) => e === "settle").length, 1); // Replays cannot clean up another attempt.
});

test("count execution is off by default and missing capability, key or fresh counting readiness cannot send", async (t) => {
  for (const kind of ["disabled", "key", "contract", "count-marker", "project", "approval", "policy", "bound", "revoked", "aborted", "request-hash", "audit-hash", "metadata"] as const) {
    const h = await harness(t); const options = { ...h.options };
    if (kind === "disabled") options.allowExternalProcessing = false;
    if (kind === "key") options.apiKey = "";
    if (kind === "contract") Object.assign(h.repository, { countDispatchContract: "postgres-0008" });
    if (kind === "count-marker") delete h.snapshot.runtime.counting;
    if (kind === "project") h.scope.projectRef = "other";
    if (kind === "approval") h.scope.inputApprovalId = "other";
    if (kind === "policy") h.context.policy = { ...h.context.policy, version: "changed" };
    if (kind === "bound") h.inputBoundVerifier.isCurrent = () => false;
    if (kind === "revoked") h.revoke();
    if (kind === "aborted") h.controller.abort();
    if (kind === "request-hash") h.scope.inputFingerprint = "b".repeat(64);
    if (kind === "audit-hash") h.scope.requestFingerprint = "b".repeat(64);
    if (kind === "metadata") h.input.targets[0].width = 0;
    await assert.rejects(h.measure(new AccountedGeminiMeasurements(options))); assert.deepEqual(h.events, [], kind);
  }
});

test("revocation or expiry after committed sending/claim blocks fetch and keeps the maximum", async (t) => {
  for (const kind of ["sending", "claim", "locked", "expired"] as const) {
    const h = await harness(t);
    if (kind === "sending") { const execute = h.repository.executeAnalysisCount; h.repository.executeAnalysisCount = async (...args) => {
      const r = await execute(...args); if (args[1].type === "sending") h.revoke(); return r;
    }; } else if (kind === "claim") { const claim = h.repository.claimAnalysisCountLaunch; h.repository.claimAnalysisCountLaunch = async (...args) => {
      const ticket = await claim(...args); h.controller.abort(); return ticket;
    }; } else { const launch = h.repository.launchAnalysisCount; h.repository.launchAnalysisCount = async (...args) => {
      if (kind === "expired") h.advance(20000); else h.revoke(); return launch(...args);
    }; }
    await assert.rejects(h.measure(), /ANALYSIS_UNAVAILABLE/);
    // Cache abort may return before bounded numeric cleanup completes.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.events.includes("http"), false); assert.equal(h.state.previous?.status, "uncertain");
    assert.equal(h.state.previous?.charged.inputTokens, 1000); assert.equal(h.receipts.length, 1);
  }
});

test("HTTP errors and malformed count responses keep usage uncertain and never retry or cache", async (t) => {
  for (const reply of [() => new Response(null, { status: 400 }), () => new Response(null, { status: 401 }),
    () => new Response(null, { status: 429 }), () => new Response(null, { status: 503 }), () => new Response("private-invalid-json"),
    () => Response.json({ totalTokens: 0 }), () => Response.json({ totalTokens: "321" }),
    () => new Response("x", { headers: { "content-length": "65537" } }), () => new Response("x".repeat(65537))]) {
    const h = await harness(t); let calls = 0;
    const stage = new AccountedGeminiMeasurements({ ...h.options, fetch: async () => { calls++; return reply(); } });
    await assert.rejects(h.measure(stage), /^AnalysisAdmissionError: ANALYSIS_UNAVAILABLE$/);
    assert.equal(calls, 1); assert.equal(h.state.previous?.status, "uncertain");
    assert.equal(h.state.previous?.charged.inputTokens, 1000); assert.equal(await stage.inspect(h.scope, h.controller.signal), null);
  }
});

test("settlement failure or over-bound result cannot issue evidence; confirmed overrun halts shared accounting", async (t) => {
  for (const kind of ["settlement", "overrun", "smaller-reviewed-bound", "revoke-after-response"] as const) {
    const h = await harness(t);
    if (kind === "settlement") { const execute = h.repository.executeAnalysisCount; h.repository.executeAnalysisCount = async (...args) => {
      const result = await execute(...args); if (args[1].type === "settle") throw new Error("private acknowledgement loss"); return result;
    }; }
    if (kind === "smaller-reviewed-bound") { const inspect = h.inputBoundVerifier.inspect; h.inputBoundVerifier.inspect = async (...args) =>
      ({ ...await inspect(...args) as object, totalInputTokenUpperBound: 300 }); }
    const stage = new AccountedGeminiMeasurements({ ...h.options, fetch: async () => {
      if (kind === "revoke-after-response") h.revoke(); return Response.json({ totalTokens: kind === "overrun" ? 1001 : 321 });
    } });
    await assert.rejects(h.measure(stage), /ANALYSIS_UNAVAILABLE/);
    assert.equal(h.state.control.halted, kind === "overrun"); assert.equal(h.state.previous?.status, kind === "overrun" ? "overrun" : "settled");
    assert.equal(await stage.inspect(h.scope, h.controller.signal), null);
  }
});

test("timeout aborts hanging fetch and a late response is discarded without a second send", async (t) => {
  const h = await harness(t); let finish!: (r: Response) => void; let cancelled = false; let calls = 0;
  const stage = new AccountedGeminiMeasurements({ ...h.options, timeoutMs: 50, fetch: () => { calls++;
    return new Promise((resolve) => { finish = resolve; }); } });
  await assert.rejects(h.measure(stage), /ANALYSIS_UNAVAILABLE/); assert.equal(calls, 1);
  await assert.rejects(h.measure(stage), /ANALYSIS_UNAVAILABLE/);
  assert.equal(h.events.filter((e) => e === "reserve").length, 1); // Ignored abort keeps the executor latch until the actual fetch settles.
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(cancelled, true);
  assert.equal(h.state.previous?.status, "uncertain"); assert.equal(await stage.inspect(h.scope, h.controller.signal), null);
});

test("recovery uses bounded cursor pages, preserves active ownership and never calls the provider", async (t) => {
  const h = await harness(t); const original = h.repository.claimAnalysisCountLaunch;
  h.repository.claimAnalysisCountLaunch = async (...args) => { await original(...args); throw new Error("lost launch acknowledgement"); };
  await assert.rejects(h.measure()); assert.equal(h.events.includes("http"), false);
  const row = h.state.previous!; const cursors: Array<string | undefined> = [];
  h.repository.listPendingAnalysisCounts = async (limit, after) => { assert.equal(limit, 20); cursors.push(after); return after ? [] : [row]; };
  await h.stage.recover(h.controller.signal); await h.stage.recover(h.controller.signal); await h.stage.recover(h.controller.signal);
  assert.deepEqual(cursors, [undefined, row.requestKey, undefined]); assert.equal(h.events.includes("http"), false);
});
