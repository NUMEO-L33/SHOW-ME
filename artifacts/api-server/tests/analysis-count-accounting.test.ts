import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { countBindingHash, countRequestKey, parseCountCommand, parseCountRecord, prepareCountAccounting,
  type AnalysisCountCommand } from "../src/processor/analysis-count-accounting.js";
import { ANALYSIS_CONSENT_VERSION, analysisManifest } from "../src/processor/analysis-contract.js";
import type { AnalysisFundingPolicy } from "../src/processor/analysis-funding.js";
import { prepareQuotaCharge, quotaRequestKey } from "../src/processor/analysis-quota-charge.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "../src/processor/gemini/request.js";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";

const now = new Date("2026-09-15T12:00:00.000Z");
const limits = { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicrousd: 1_000_000 };
const policy: AnalysisFundingPolicy = { version: "count-fictional-v1", accountingOnly: true,
  price: { model: GEMINI_TEST_MODEL, version: "fictional", inputMicrousdPerMillionTokens: 100001, outputMicrousdPerMillionTokens: 200000 },
  maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 1, globalLimit: limits, guideLimit: limits };
const slot = { runId: "count-run", batchIndex: 0, generationOrdinal: 0 as const };
const providerLimits = { requestsPerMinute: 2, inputTokensPerMinute: 10000, requestsPerDay: 100, resetTimeZone: "America/Los_Angeles" as const };
async function fixture(t: TestContext) {
  const h = await createAnalysisHarness(t, 2);
  const funded = await h.repository.reserveAnalysisRequest(h.guideId, { type: "request", runId: slot.runId, baseDraftRevision: 0,
    consentVersion: ANALYSIS_CONSENT_VERSION, provider: "gemini", model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION,
    expectedInputFingerprint: analysisManifest(h.guide).fingerprint }, policy, now);
  assert.ok(funded);
  const claim = await h.repository.claimAnalysisWork(h.guideId, { runId: slot.runId, attemptId: "count-owner", expectedAttemptCount: 0, leaseMs: 30000 }, now);
  assert.ok(claim);
  const owner = { attemptId: claim.run.attemptId!, attemptCount: claim.run.attemptCount };
  const binding = { projectRef: "fictional-project", inputApprovalId: "fictional-approval", inputFingerprint: analysisManifest(h.guide).fingerprint,
    requestFingerprint: "a".repeat(64), model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION } as const;
  const reserve: AnalysisCountCommand = { type: "reserve", ...slot, owner, binding };
  const sending: AnalysisCountCommand = { type: "sending", ...slot, owner, binding, limits: providerLimits,
    notAfter: new Date(now.valueOf() + 20000).toISOString() };
  const state: Parameters<typeof prepareCountAccounting>[0] = { guideId: h.guideId, guide: h.guide,
    analysis: (await h.repository.getAnalysisState(h.guideId))!, reservation: funded.reservation, batches: funded.batches,
    attempts: [], previous: null, windows: (await Promise.all(["global", `guide:${h.guideId}`].map((s) => h.repository.getAnalysisBudgetWindow("2026-09-15", s)))).map((w) => w!),
    control: { halted: false }, command: reserve, now };
  const step = (command: AnalysisCountCommand) => {
    const result = prepareCountAccounting({ ...state, command });
    state.previous = result.record; if (result.windows.length) state.windows = result.windows; state.control = result.control;
    return result;
  };
  const settle = (totalTokens?: number) => step({ type: "settle", ...slot, bindingHash: countBindingHash(binding),
    usage: totalTokens === undefined ? { status: "unknown" } : { status: "known", totalTokens } });
  const release: AnalysisCountCommand = { type: "release", ...slot, bindingHash: countBindingHash(binding) };
  const recover: AnalysisCountCommand = { ...release, type: "recover" };
  return { ...h, state, reserve, sending, binding, step, settle, release, recover, owner };
}

test("count accounting validates strict commands without generation usage or extra network fields", () => {
  for (const raw of [{ type: "countTokens" }, { type: "settle", ...slot, bindingHash: "a".repeat(64), usage: { status: "known", totalTokens: 0 } },
    { type: "settle", ...slot, bindingHash: "a".repeat(64), usage: { status: "known", inputTokens: 1, outputTokens: 0 } },
    { type: "release", ...slot, bindingHash: "a".repeat(64), apiKey: "fictional" }]) assert.throws(() => parseCountCommand(raw));
});

test("count reservation adds a distinct request to the same two budgets without spending generation slots", async (t) => {
  const h = await fixture(t); const original = structuredClone(h.state.reservation); const windows = structuredClone(h.state.windows);
  const r = h.step(h.reserve); assert.equal(r.replayed, false); assert.equal(r.record.operation, "countTokens");
  assert.deepEqual(r.record.maximum, { requests: 1, inputTokens: 1000, outputTokens: 0, costMicrousd: 101 });
  assert.deepEqual(h.state.reservation, original);
  h.state.windows.forEach((w, i) => assert.deepEqual(w.used, { requests: windows[i].used.requests + 1,
    inputTokens: windows[i].used.inputTokens + 1000, outputTokens: windows[i].used.outputTokens, costMicrousd: windows[i].used.costMicrousd + 101 }));
  assert.equal(h.step(h.reserve).replayed, true); assert.equal(h.state.windows[0].used.requests, 3);
});

test("count identities stay fixed across approval/project/owner changes and cannot collide with generation", async (t) => {
  const h = await fixture(t); const key = countRequestKey(h.guideId, slot);
  assert.notEqual(key, countRequestKey(h.guideId, { ...slot, generationOrdinal: 1 }));
  assert.notEqual(key, quotaRequestKey(h.guideId, { runId: slot.runId, batchIndex: 0, ordinal: 0, dispatchId: "dispatch",
    owner: h.owner, inputFingerprint: h.binding.inputFingerprint }));
  h.step(h.reserve);
  for (const change of [{ projectRef: "different" }, { inputApprovalId: "different" }, { requestFingerprint: "b".repeat(64) }]) {
    assert.throws(() => h.step({ ...h.reserve, type: "reserve", owner: h.owner, binding: { ...h.binding, ...change } }));
  }
  assert.equal(h.step({ ...h.reserve, type: "reserve", binding: h.binding, owner: { attemptId: "takeover", attemptCount: 2 } }).replayed, true);
});

test("count allowance semantics are persisted and bound without changing the stable one-shot slot", async (t) => {
  const h = await fixture(t); const binding = { ...h.binding, inputAccounting: "acceptance-allowance" as const };
  const command = { ...h.reserve, type: "reserve" as const, binding, owner: h.owner };
  const record = h.step(command).record;
  assert.equal(record.inputAccounting, "acceptance-allowance");
  assert.equal(record.requestKey, countRequestKey(h.guideId, h.reserve));
  assert.notEqual(record.bindingHash, countBindingHash(h.binding));
  assert.throws(() => h.step(h.reserve));
  assert.equal(h.step(command).replayed, true);
  const historical = await fixture(t); historical.step(historical.reserve);
  assert.throws(() => historical.step({ ...historical.reserve, type: "reserve", owner: historical.owner,
    binding: { ...historical.binding, inputAccounting: "acceptance-allowance" } }));
});

test("count sending is one-way and neither replay nor changed owner can obtain a new sending transition", async (t) => {
  const h = await fixture(t); h.step(h.reserve);
  assert.throws(() => h.step({ ...h.sending, type: "sending", binding: h.binding, limits: providerLimits, notAfter: now.toISOString(),
    owner: { attemptId: "wrong", attemptCount: 1 } }));
  h.step(h.sending); assert.throws(() => h.step(h.sending)); assert.throws(() => h.step(h.release));
  assert.equal(h.step(h.reserve).record.status, "sending");
});

test("launch claim is a one-way transition that survives recovery without refund or reissue", async (t) => {
  for (const recover of [false, true]) {
    const h = await fixture(t); h.step(h.reserve);
    const command = { ...h.sending, type: "claim-launch" } as AnalysisCountCommand;
    assert.throws(() => h.step(command)); h.step(h.sending); const before = structuredClone(h.state.windows);
    assert.equal(h.step(command).record.status, "launch_claimed"); assert.deepEqual(h.state.windows, before);
    assert.throws(() => h.step(command)); assert.throws(() => h.step(h.sending)); assert.throws(() => h.step(h.release));
    if (recover) { h.state.now = new Date(now.valueOf() + 30000); assert.equal(h.step(h.recover).record.status, "uncertain");
      assert.deepEqual(h.state.windows, before); }
    assert.equal(h.settle(100).record.status, "settled");
  }
});

test("known count settlement rounds input-only proxy cost and refunds unused tokens exactly once", async (t) => {
  const h = await fixture(t); h.step(h.reserve); h.step(h.sending); const before = structuredClone(h.state.windows);
  const r = h.settle(100); assert.deepEqual(r.record.charged, { requests: 1, inputTokens: 100, outputTokens: 0, costMicrousd: 11 });
  assert.equal(h.settle(100).replayed, true);
  h.state.windows.forEach((w, i) => { assert.equal(w.used.requests, before[i].used.requests);
    assert.equal(w.used.inputTokens, before[i].used.inputTokens - 900); assert.equal(w.used.costMicrousd, before[i].used.costMicrousd - 90); });
  assert.throws(() => h.settle(101)); assert.throws(() => h.settle());
});

test("unknown count outcomes retain all usage and late known results settle the original day only", async (t) => {
  const h = await fixture(t); h.step(h.reserve); h.step(h.sending); const before = structuredClone(h.state.windows);
  assert.equal(h.settle().record.status, "uncertain"); assert.deepEqual(h.state.windows, before);
  assert.equal(h.settle().replayed, true); h.state.now = new Date("2026-09-16T12:00:00.000Z");
  assert.equal(h.settle(100).record.status, "settled"); assert.ok(h.state.windows.every((w) => w.day === "2026-09-15"));
});

test("count bound overrun preserves maximum and irreversibly requests the shared global halt", async (t) => {
  const h = await fixture(t); h.step(h.reserve); h.step(h.sending); const before = structuredClone(h.state.windows);
  const r = h.settle(1001); assert.equal(r.halted, true); assert.equal(r.record.status, "overrun"); assert.deepEqual(h.state.windows, before);
  assert.equal(h.settle(1001).replayed, true); assert.throws(() => h.settle(100)); assert.throws(() => h.step(h.release));
  assert.throws(() => prepareCountAccounting({ ...h.state, command: h.reserve, control: { halted: false } }));
});

test("both daily budgets include counts and a failed second-window check mutates nothing", async (t) => {
  for (const scope of [0, 1]) for (const field of ["requests", "inputTokens", "costMicrousd"] as const) {
    const h = await fixture(t); h.state.windows[scope].used[field] = h.state.windows[scope].limit[field];
    const before = structuredClone(h.state); assert.throws(() => h.step(h.reserve), /ANALYSIS_COUNT_LIMIT/); assert.deepEqual(h.state, before);
  }
});

test("counts cannot reserve under a halt, stale owner, changed input, terminal run or previous date", async (t) => {
  const h = await fixture(t);
  for (const mutate of [(s: typeof h.state) => { s.control.halted = true; }, (s: typeof h.state) => { s.guide = null; },
    (s: typeof h.state) => { s.analysis.runs[0].leaseExpiresAt = now.toISOString(); },
    (s: typeof h.state) => { s.now = new Date("2026-09-16T12:00:00.000Z"); }]) {
    const state = structuredClone(h.state); mutate(state); assert.throws(() => prepareCountAccounting(state));
  }
  assert.throws(() => h.step({ type: "reserve", ...slot, owner: h.owner, binding: { ...h.binding, inputFingerprint: "b".repeat(64) } }));
});

test("count retry-reference slot requires a persisted qualifying generation failure", async (t) => {
  const h = await fixture(t);
  assert.throws(() => h.step({ type: "reserve", ...slot, generationOrdinal: 1, owner: h.owner, binding: h.binding }));
  h.step(h.reserve); h.step(h.sending); h.settle();
  assert.throws(() => prepareCountAccounting({ ...h.state, previous: null, command: { type: "reserve", ...slot,
    generationOrdinal: 1, owner: h.owner, binding: h.binding } }));
});

test("release fences unsent count forever and returns only its own reservation", async (t) => {
  const h = await fixture(t); const before = structuredClone(h.state.windows); h.step(h.reserve);
  assert.equal(h.step(h.release).record.status, "released"); assert.deepEqual(h.state.windows, before);
  assert.equal(h.step(h.release).replayed, true); assert.equal(h.step(h.reserve).record.status, "released"); assert.throws(() => h.step(h.sending));
});

test("expired/replaced owner recovery releases unsent but preserves potentially sent counts", async (t) => {
  for (const sent of [false, true]) {
    const h = await fixture(t); h.step(h.reserve); if (sent) h.step(h.sending);
    assert.throws(() => h.step(h.recover)); h.state.now = new Date(now.valueOf() + 30000);
    const r = h.step(h.recover); assert.equal(r.record.status, sent ? "uncertain" : "released");
    assert.equal(r.record.charged.requests, sent ? 1 : 0); assert.equal(h.step(h.recover).replayed, true);
  }
});

test("deleted guide recovery and numeric settlement never restore consent or media", async (t) => {
  const h = await fixture(t); h.step(h.reserve); h.step(h.sending);
  h.state.guide = null; h.state.analysis = { draft: null, runs: [] }; h.state.reservation.details = null; h.state.batches = [];
  assert.equal(h.step(h.recover).record.status, "uncertain"); assert.equal(h.settle(100).record.status, "settled");
  assert.equal(h.state.reservation.details, null); assert.equal(h.state.guide, null);
  assert.ok(!JSON.stringify(h.state.previous).includes(h.binding.inputApprovalId));
});

test("corrupt count records cannot change operation, bounds, cost, identity or time", async (t) => {
  const h = await fixture(t); const record = h.step(h.reserve).record;
  for (const change of [{ operation: "generateContent" }, { requestKey: "b".repeat(64) }, { day: "2026-09-16" },
    { maximum: { ...record.maximum, requests: 2 } }, { maximum: { ...record.maximum, outputTokens: 1 } },
    { charged: { ...record.charged, inputTokens: 0 } }, { accountingInputRate: 0 }, { status: "settled" }]) {
    assert.throws(() => parseCountRecord({ ...record, ...change }));
  }
  h.state.now = new Date(now.valueOf() - 1); assert.throws(() => h.step(h.reserve));
});

test("count and generation quota identities are separate but consume the same conservative RPM pool", async (t) => {
  const h = await fixture(t); const command = { requestKey: countRequestKey(h.guideId, slot), projectRef: h.binding.projectRef,
    model: GEMINI_TEST_MODEL, inputTokenBound: 1000, limits: providerLimits, notAfter: new Date(now.valueOf() + 20000).toISOString() } as const;
  const count = prepareQuotaCharge(command, [], now);
  const generated = prepareQuotaCharge({ ...command, requestKey: "b".repeat(64) }, [count], now);
  assert.equal(count.scopeKey, generated.scopeKey);
  assert.throws(() => prepareQuotaCharge({ ...command, requestKey: "c".repeat(64) }, [count, generated], now), /PROVIDER_QUOTA_LIMIT/);
});

test("internally consistent but repriced count records still conflict with their funded policy", async (t) => {
  const h = await fixture(t); const r = h.step(h.reserve).record;
  const changed = parseCountRecord({ ...r, accountingInputRate: 200000,
    maximum: { ...r.maximum, costMicrousd: 200 }, charged: { ...r.charged, costMicrousd: 200 } });
  assert.throws(() => prepareCountAccounting({ ...h.state, previous: changed, command: h.sending }));
  assert.throws(() => prepareCountAccounting({ ...h.state, previous: { ...r, scopeKey: "b".repeat(64) }, command: h.sending }));
  assert.throws(() => parseCountRecord({ ...r, createdAt: "2026-09-15T12:00:00Z" }));
});

test("generation retry qualification allows its own count slot without changing the generation ordinal", async (t) => {
  const h = await fixture(t); const generated = { runId: slot.runId, batchIndex: 0, ordinal: 0 as const, dispatchId: "generation-first" };
  assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "allocate", ...generated, owner: h.owner }, now));
  assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "sending", ...generated, owner: h.owner }, now));
  assert.ok(await h.repository.executeAnalysisAccounting(h.guideId, { type: "settle", ...generated, usage: { status: "unknown" }, retryableHttpStatus: 503 }, now));
  h.state.attempts = (await h.repository.getAnalysisRequestAttempts(h.guideId, slot.runId))!;
  const result = h.step({ type: "reserve", ...slot, generationOrdinal: 1, owner: h.owner, binding: h.binding });
  assert.equal(result.record.generationOrdinal, 1); assert.equal(h.state.attempts.length, 1); assert.equal(h.state.attempts[0].ordinal, 0);
});
