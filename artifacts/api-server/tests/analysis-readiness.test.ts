import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";

import { AnalysisAdmissionError, DurableAnalysisAdmission, verifyAnalysisReadiness, type AnalysisAdmissionInput } from "../src/processor/analysis-admission.js";
import { ANALYSIS_CONSENT_VERSION, analysisManifest } from "../src/processor/analysis-contract.js";
import { EvidenceAnalysisReadiness, type AnalysisRuntimeEvidence, type AnalysisApprovedInputEvidence,
  type AnalysisFreeProjectEvidence, type AnalysisReadinessSources } from "../src/processor/analysis-readiness.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "../src/processor/gemini/request.js";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";

const initial = Date.parse("2026-09-18T12:00:00.000Z");
const defaultInput: AnalysisAdmissionInput = { guideId: "synthetic-guide", inputFingerprint: "a".repeat(64),
  frameCount: 2, model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION };
const signal = () => new AbortController().signal;
const denied = (error: unknown) => {
  assert.ok(error instanceof AnalysisAdmissionError);
  assert.equal(error.message, "ANALYSIS_UNAVAILABLE");
  return true;
};
type Evidence = { runtime: AnalysisRuntimeEvidence; approvedInput: AnalysisApprovedInputEvidence; freeProject: AnalysisFreeProjectEvidence };
type SourceName = keyof Evidence;
const names: SourceName[] = ["runtime", "approvedInput", "freeProject"];

function fixture(input = defaultInput, timeoutMs?: number) {
  let now = initial;
  const stamp = { checkedAt: new Date(now).toISOString(), validUntil: new Date(now + 20_000).toISOString(), deploymentRef: "fixture-deployment" };
  // Simulated verifier evidence ONLY. No actual cloud, billing, storage or token-bound claim.
  const evidence: Evidence = {
    runtime: { ...stamp, id: "runtime-1", kind: "verified-analysis-runtime", repository: "postgres-0008",
      dispatcher: "durable-accounted-v1", counting: "count-accounted-0010-v1", storage: "replit-private",
      quotaAccounting: "project-wide-atomic", hostingAllowance: "verified", projectRef: "fixture-project", credentialRef: "fixture-key-version" },
    approvedInput: { ...stamp, id: "input-1", kind: "reviewed-analysis-input", input: structuredClone(input),
      scope: "approved_synthetic", inputApprovalId: "fixture-approval", boundReviewId: "fixture-bound",
      inputTokenBound: 1000, boundCoverage: "all-batches-system-schema-metadata-targets-context-envelope" },
    freeProject: { ...stamp, id: "project-1", kind: "verified-free-project", projectRef: "fixture-project", credentialRef: "fixture-key-version",
      model: GEMINI_TEST_MODEL, mode: "free_only", paidFallback: false,
      providerLimits: { requestsPerMinute: 15, inputTokensPerMinute: 250_000, requestsPerDay: 100, resetTimeZone: "America/Los_Angeles" },
      policy: { version: "fixture-policy", accountingOnly: true, price: { model: GEMINI_TEST_MODEL, version: "fixture-price",
        inputMicrousdPerMillionTokens: 100000, outputMicrousdPerMillionTokens: 200000 },
        maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 1,
        globalLimit: { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicrousd: 1_000_000 },
        guideLimit: { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicrousd: 1_000_000 } } },
  };
  const calls: AnalysisAdmissionInput[] = [];
  const sources: AnalysisReadinessSources = {
    runtime: { async inspect(i) { calls.push(i); return evidence.runtime; }, isCurrent: (e) => isDeepStrictEqual(e, evidence.runtime) },
    approvedInput: { async inspect(i) { calls.push(i); return evidence.approvedInput; }, isCurrent: (e) => isDeepStrictEqual(e, evidence.approvedInput) },
    freeProject: { async inspect(i) { calls.push(i); return evidence.freeProject; }, isCurrent: (e) => isDeepStrictEqual(e, evidence.freeProject) },
  };
  const clock = () => new Date(now);
  const readiness = new EvidenceAnalysisReadiness({ sources, clock, timeoutMs });
  return { evidence, sources, calls, clock, readiness, input, setTime: (time: number) => { now = time; },
    inspect: (s = signal()) => readiness.inspect(input, s) };
}

test("readiness has no default authority, enable flag, external fetch or persistent state", async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches += 1; throw new Error("no external calls"); });
  const empty = new EvidenceAnalysisReadiness();
  await assert.rejects(empty.inspect(defaultInput, signal()), denied);
  const f = fixture(); const snapshot = await f.inspect();
  assert.equal(f.readiness.isCurrent(snapshot.id), true);
  assert.equal(new EvidenceAnalysisReadiness({ sources: f.sources, clock: f.clock }).isCurrent(snapshot.id), false);
  assert.equal(fetches, 0);
});

test("matching facts produce a bounded snapshot compatible with admission/send verification", async () => {
  const f = fixture();
  f.evidence.runtime.checkedAt = new Date(initial - 1000).toISOString();
  f.evidence.freeProject.validUntil = new Date(initial + 5000).toISOString();
  const snapshot = await f.inspect();
  assert.equal(snapshot.checkedAt, f.evidence.runtime.checkedAt);
  assert.equal(snapshot.validUntil, f.evidence.freeProject.validUntil);
  assert.equal(snapshot.runtime.counting, "count-accounted-0010-v1");
  assert.equal(f.calls.length, 3);
  for (const call of f.calls) assert.deepEqual(call, f.input);
  const permission = verifyAnalysisReadiness({ raw: snapshot, input: f.input, readiness: f.readiness,
    spending: { mode: "free_only" }, clock: f.clock, signal: signal() });
  permission.assertCurrent();
  assert.ok(!JSON.stringify(snapshot).includes("fixture-key-version"));
  assert.ok(!JSON.stringify(snapshot).includes("fixture-deployment"));
  f.setTime(initial + 5000);
  assert.equal(f.readiness.isCurrent(snapshot.id), false);
  assert.throws(permission.assertCurrent);
});

for (const name of names) {
  test(`missing/malformed ${name} evidence cannot issue readiness`, async () => {
    for (const raw of [null, {}, { ready: true }, { ...fixture().evidence[name], unexpected: "private" }]) {
      const f = fixture(); f.sources[name].inspect = async () => raw;
      await assert.rejects(f.inspect(), denied);
    }
  });
  test(`${name} must be fresh, same-day and valid for no longer than thirty seconds`, async () => {
    for (const [checked, expiry] of [[initial + 1, initial + 2000], [initial - 1, initial],
      [initial, initial], [initial, initial + 30_001], [initial - 86_400_000, initial + 1000]]) {
      const f = fixture();
      f.evidence[name].checkedAt = new Date(checked).toISOString(); f.evidence[name].validUntil = new Date(expiry).toISOString();
      await assert.rejects(f.inspect(), denied);
    }
  });
  test(`${name} replacement or revocation invalidates previously issued snapshots permanently`, async () => {
    const f = fixture(); const snapshot = await f.inspect();
    const old = f.evidence[name].id; f.evidence[name].id = "replacement";
    assert.equal(f.readiness.isCurrent(snapshot.id), false);
    f.evidence[name].id = old;
    assert.equal(f.readiness.isCurrent(snapshot.id), false);
  });
  test(`${name} guard must return synchronous exact true and must not leak failures`, async () => {
    for (const value of [false, 1, "true", Promise.resolve(true), Promise.reject(new Error("private-source-error"))]) {
      // Attach rejection handling immediately, including before the first await.
      void Promise.resolve(value).catch(() => undefined);
      const f = fixture(); f.sources[name].isCurrent = () => value as boolean;
      await assert.rejects(f.inspect(), denied);
    }
    const f = fixture(); f.sources[name].isCurrent = () => { throw new Error("secret/path/token"); };
    await assert.rejects(f.inspect(), denied);
  });
}

test("cross-deployment, cross-project and stale credential evidence are rejected", async () => {
  const changes = [
    (e: Evidence) => { e.approvedInput.deploymentRef = "other"; },
    (e: Evidence) => { e.freeProject.deploymentRef = "other"; },
    (e: Evidence) => { e.freeProject.projectRef = "other"; },
    (e: Evidence) => { e.freeProject.credentialRef = "old-key"; },
  ];
  for (const change of changes) { const f = fixture(); change(f.evidence); await assert.rejects(f.inspect(), denied); }
});

test("approval binds every manifest input field and does not infer synthesis from a hash", async () => {
  for (const override of [{ guideId: "other" }, { inputFingerprint: "b".repeat(64) }, { frameCount: 1 }, { model: "other" }, { promptVersion: "old" }]) {
    const f = fixture(); Object.assign(f.evidence.approvedInput.input, override);
    await assert.rejects(f.inspect(), denied);
  }
  for (const override of [{ scope: "user_video" }, { boundCoverage: "images-only" }, { inputTokenBound: 1001 }, { inputTokenBound: 0 }]) {
    const f = fixture(); Object.assign(f.evidence.approvedInput, override);
    await assert.rejects(f.inspect(), denied);
  }
});

test("unverified runtime, local/public storage and partial accounting are refused", async () => {
  for (const override of [{ repository: "local-json" }, { counting: undefined }, { dispatcher: "not-running" },
    { storage: "public" }, { storage: "local" }, { quotaAccounting: "this-key-only" }, { hostingAllowance: "unknown" }]) {
    const f = fixture(); Object.assign(f.evidence.runtime, override);
    await assert.rejects(f.inspect(), denied);
  }
});

test("only current free-only policy is accepted, with app and provider ceilings kept distinct", async () => {
  for (const override of [{ mode: "paid_capped" }, { paidFallback: true }, { model: "other" }]) {
    const f = fixture(); Object.assign(f.evidence.freeProject, override);
    await assert.rejects(f.inspect(), denied);
  }
  for (const change of [
    (e: AnalysisFreeProjectEvidence) => { e.providerLimits.requestsPerDay = 99; },
    (e: AnalysisFreeProjectEvidence) => { e.providerLimits.inputTokensPerMinute = 999; },
    (e: AnalysisFreeProjectEvidence) => { e.policy.guideLimit.requests = 0; },
    (e: AnalysisFreeProjectEvidence) => { Object.assign(e.policy.price, { model: "other" }); },
  ]) { const f = fixture(); change(f.evidence.freeProject); await assert.rejects(f.inspect(), denied); }
  const f = fixture();
  assert.ok(f.evidence.freeProject.policy.globalLimit.inputTokens > f.evidence.freeProject.providerLimits.inputTokensPerMinute);
  await f.inspect(); // Daily app input is not a provider per-minute quota.
});

test("sources and returned snapshots cannot mutate cached evidence or another source's input", async () => {
  const f = fixture(); const original = f.sources.runtime.inspect;
  f.sources.runtime.inspect = async (input, s) => { const result = await original(input, s); input.guideId = "mutated"; return result; };
  const snapshot = await f.inspect();
  snapshot.policy.globalLimit.requests = 0;
  snapshot.runtime.inputTokenBound = 0;
  assert.equal(f.readiness.isCurrent(snapshot.id), true);
  assert.equal(f.input.guideId, "synthetic-guide");
  assert.equal(f.evidence.freeProject.policy.globalLimit.requests, 100);
  // Guard callbacks receive copies as well, not the private cache records.
  f.sources.runtime.isCurrent = (e) => { e.projectRef = "mutated"; return true; };
  assert.equal(f.readiness.isCurrent(snapshot.id), true);
  assert.equal(f.readiness.isCurrent(snapshot.id), true);
});

test("clear revokes published evidence, including reentrant revocation during a guard", async () => {
  const f = fixture(); const snapshot = await f.inspect();
  f.sources.runtime.isCurrent = () => { f.readiness.clear(); return true; };
  assert.equal(f.readiness.isCurrent(snapshot.id), false);
  await assert.rejects(f.inspect(), denied);
});

test("expiry during a synchronous source guard is rejected before returning authority", async () => {
  const f = fixture(); const snapshot = await f.inspect();
  f.sources.freeProject.isCurrent = () => { f.setTime(initial + 20_000); return true; };
  assert.equal(f.readiness.isCurrent(snapshot.id), false);
});

test("invalid/backward clocks and UTC/Pacific day changes never refresh old authority", async () => {
  for (const time of [initial - 1, NaN, Infinity]) {
    const f = fixture(); const snapshot = await f.inspect(); f.setTime(time);
    assert.equal(f.readiness.isCurrent(snapshot.id), false);
    f.setTime(initial); assert.equal(f.readiness.isCurrent(snapshot.id), false);
  }
  for (const boundary of [Date.parse("2026-09-19T00:00:00Z"), Date.parse("2026-09-19T07:00:00Z")]) {
    const f = fixture(); f.setTime(boundary - 1000);
    for (const name of names) Object.assign(f.evidence[name], { checkedAt: new Date(boundary - 1000).toISOString(), validUntil: new Date(boundary + 1000).toISOString() });
    const snapshot = await f.inspect(); f.setTime(boundary);
    assert.equal(f.readiness.isCurrent(snapshot.id), false);
    await assert.rejects(f.inspect(), denied);
  }
});

test("pre-abort and malformed inputs never inspect a source or expose arbitrary reasons", async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort(new Error("private reason"));
  await assert.rejects(f.inspect(controller.signal), denied);
  await assert.rejects(f.readiness.inspect({ ...f.input, extra: "private" } as AnalysisAdmissionInput, signal()), denied);
  assert.equal(f.calls.length, 0);
});

test("timeout, caller abort and clear prevent late uncooperative sources publishing evidence", async () => {
  for (const action of ["timeout", "abort", "clear"]) {
    const f = fixture(defaultInput, action === "timeout" ? 20 : 5000);
    let complete!: (value: unknown) => void;
    f.sources.runtime.inspect = () => new Promise((resolve) => { complete = resolve; });
    const controller = new AbortController();
    const pending = f.inspect(controller.signal); const rejected = assert.rejects(pending, denied);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (action === "abort") controller.abort(new Error("secret"));
    if (action === "clear") f.readiness.clear();
    await rejected;
    complete(f.evidence.runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.sources.runtime.inspect = async () => f.evidence.runtime;
    const snapshot = await f.inspect(); assert.equal(f.readiness.isCurrent(snapshot.id), true);
  }
});

test("stuck sources retain bounded slots after caller timeout; settled work frees them", async () => {
  const f = fixture(defaultInput, 20); const releases: Array<(value: unknown) => void> = [];
  f.sources.runtime.inspect = () => new Promise((resolve) => releases.push(resolve));
  await Promise.all(Array.from({ length: 8 }, () => assert.rejects(f.inspect(), denied)));
  assert.equal(releases.length, 8);
  await assert.rejects(f.inspect(), denied); assert.equal(releases.length, 8);
  releases.forEach((resolve) => resolve(f.evidence.runtime));
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.sources.runtime.inspect = async () => f.evidence.runtime;
  await f.inspect();
});

test("bounded snapshot cache refuses overflow without evicting still-valid authority", async () => {
  const f = fixture();
  const snapshots = [];
  for (let i = 0; i < 64; i++) snapshots.push(await f.inspect());
  await assert.rejects(f.inspect(), denied);
  assert.equal(f.readiness.isCurrent(snapshots[0].id), true);
  f.readiness.clear(); await f.inspect();
});

test("invalid timeout configuration is rejected", () => {
  for (const timeoutMs of [0, -1, 5001, 0.5, NaN]) assert.throws(() => new EvidenceAnalysisReadiness({ timeoutMs }), denied);
});

test("composed readiness admits only valid synthetic work; denial leaves no reservation", async (t) => {
  const h = await createAnalysisHarness(t, 2);
  const input = { ...defaultInput, guideId: h.guideId, inputFingerprint: analysisManifest(h.guide).fingerprint };
  const f = fixture(input);
  const admission = new DurableAnalysisAdmission({ repository: h.repository, readiness: f.readiness, clock: f.clock });
  const command = { type: "request" as const, runId: randomUUID(), baseDraftRevision: 0,
    consentVersion: ANALYSIS_CONSENT_VERSION, provider: "gemini" as const, model: GEMINI_TEST_MODEL,
    promptVersion: GEMINI_PROMPT_VERSION, expectedInputFingerprint: input.inputFingerprint };
  f.sources.freeProject.isCurrent = () => false;
  await assert.rejects(admission.request(h.guideId, command, signal()), denied);
  assert.equal(await h.repository.getAnalysisFunding(h.guideId, command.runId), null);
  f.sources.freeProject.isCurrent = () => true;
  const reserve = h.repository.reserveAnalysisRequest.bind(h.repository);
  h.repository.reserveAnalysisRequest = async (...args) => {
    f.readiness.clear(); // Revoked after inspection, before the storage commit guard.
    return reserve(...args);
  };
  await assert.rejects(admission.request(h.guideId, command, signal()), denied);
  assert.equal(await h.repository.getAnalysisFunding(h.guideId, command.runId), null);
  h.repository.reserveAnalysisRequest = reserve;
  const accepted = await admission.request(h.guideId, command, signal());
  assert.equal(accepted?.runs[0].status, "queued");
  assert.ok(await h.repository.getAnalysisFunding(h.guideId, command.runId));
  assert.equal((await h.repository.getGuideById(h.guideId))?.status, "ready");
});
