import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";
import { OperationsReviewEvidenceSource } from "../src/processor/analysis-operations-source.js";
import { operationsActorRef, type AnalysisOperationsObservation } from "../src/processor/analysis-operations-store.js";
import { EvidenceAnalysisReadiness, type AnalysisApprovedInputEvidence, type AnalysisRuntimeEvidence } from "../src/processor/analysis-readiness.js";
import { GEMINI_TEST_MODEL, GEMINI_PROMPT_VERSION } from "../src/processor/gemini/request.js";
import { operationsReviewFixture } from "./helpers/operations-review-fixture.js";

const initial = Date.parse("2026-09-19T12:00:00.000Z");
const binding = { deploymentRef: "fixture-deployment", projectRef: "fixture-project", credentialRef: "fixture-key-version", storageRef: "fixture-storage" };
const input = { guideId: "synthetic-guide", inputFingerprint: "a".repeat(64), frameCount: 2, model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION } as const;
const signal = () => new AbortController().signal;
function fixture(timeoutMs?: number) {
  const limit = { requests: 100, inputTokens: 1000000, outputTokens: 1000000, costMicrousd: 1000000 };
  const review = operationsReviewFixture(new Date(initial - 60000), { version: "fixture", accountingOnly: true,
    price: { model: GEMINI_TEST_MODEL, version: "fixture", inputMicrousdPerMillionTokens: 100000, outputMicrousdPerMillionTokens: 200000 },
    maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 0, globalLimit: limit, guideLimit: limit });
  review.reviewerRef = operationsActorRef("fictional_operator");
  const observation: AnalysisOperationsObservation = { kind: "operations-db-observation", authorizesAnalysis: false,
    halted: false, observedAt: new Date(initial).toISOString(), entry: { deploymentRef: binding.deploymentRef, version: 1,
      commandId: randomUUID(), commandHash: "f".repeat(64), actorRef: review.reviewerRef, action: "put",
      createdAt: new Date(initial - 60000).toISOString(), review } };
  let now = initial; let reads = 0;
  const clock = () => new Date(now);
  const store = { async observe(deployment: string, s: AbortSignal) {
    assert.equal(deployment, binding.deploymentRef); s.throwIfAborted(); reads++; return structuredClone(observation);
  } };
  const options = { store, binding: { ...binding }, clock, timeoutMs };
  const source = new OperationsReviewEvidenceSource(options);
  return { source, store, options, observation, clock, reads: () => reads, setTime: (time: number) => { now = time; },
    inspect: (s = signal()) => source.inspect(input, s) };
}

test("DB-backed operations source reads every time, preserves manual dates and cannot authorize by itself", async (t) => {
  let fetches = 0; t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("forbidden"); });
  const f = fixture(); const first = await f.inspect();
  f.setTime(initial + 1000); f.observation.observedAt = f.clock().toISOString(); const second = await f.inspect();
  assert.equal(f.reads(), 2); assert.equal(fetches, 0); assert.notEqual(first.id, second.id);
  assert.equal(second.review.recordedAt, first.review.recordedAt); assert.equal(second.review.expiresAt, first.review.expiresAt);
  assert.equal(f.source.isCurrent(first), true); assert.equal(f.source.isCurrent(second), true);
  assert.equal(new OperationsReviewEvidenceSource(f.options).isCurrent(first), false);
  assert.equal("authorizesAnalysis" in first, false);
});

test("full receipt equality, cloned binding and independent return values prevent caller mutation", async () => {
  const f = fixture(); f.options.binding.storageRef = "foreign";
  const evidence = await f.inspect(); const original = structuredClone(evidence);
  evidence.review.checks.storageAccess = { status: "unknown" };
  assert.equal(f.source.isCurrent(evidence), false); assert.equal(f.source.isCurrent(original), true);
  assert.equal(f.source.isCurrent({ ...original, validUntil: new Date(initial + 31000).toISOString() }), false);
});

test("missing, halted, incomplete, revoked and malformed DB observations fail closed and invalidate old receipts", async () => {
  for (const mode of ["missing", "halted", "pending", "revoked", "unknown", "extra", "projection", "author"]) {
    const f = fixture(); const first = await f.inspect(); const entry = f.observation.entry!;
    if (mode === "missing") f.observation.entry = null;
    if (mode === "halted") f.observation.halted = true;
    if (mode === "pending") entry.review.state = "pending";
    if (mode === "revoked") { entry.review.state = "revoked"; entry.action = "revoke"; }
    if (mode === "unknown") entry.review.checks.storageAccess = { status: "unknown" };
    if (mode === "extra") Object.assign(f.observation, { ready: true });
    if (mode === "projection") entry.version = 2;
    if (mode === "author") entry.actorRef = "foreign";
    await assert.rejects(f.inspect(), /^AnalysisAdmissionError: ANALYSIS_UNAVAILABLE$/);
    assert.equal(f.source.isCurrent(first), false);
  }
});

test("all deployment/project/key/storage bindings are checked; observed version or content change invalidates old receipts", async () => {
  for (const field of Object.keys(binding) as Array<keyof typeof binding>) {
    const f = fixture(); f.observation.entry!.review[field] = "foreign";
    await assert.rejects(f.inspect(), /ANALYSIS_UNAVAILABLE/);
  }
  for (const versionChange of [true, false]) {
    const f = fixture(); const first = await f.inspect();
    if (versionChange) { f.observation.entry!.version++; f.observation.entry!.review.revision++; }
    else f.observation.entry!.review.policy.version = "changed-without-version";
    const next = await f.inspect(); assert.equal(f.source.isCurrent(first), false); assert.equal(f.source.isCurrent(next), true);
  }
});

test("DB drift, impossible chronology, manual expiry and observation age are rejected", async () => {
  for (const mode of ["ahead", "behind", "future-entry", "future-review", "expired", "long-read"]) {
    const f = fixture();
    if (mode === "ahead") f.observation.observedAt = new Date(initial + 5001).toISOString();
    if (mode === "behind") f.observation.observedAt = new Date(initial - 5001).toISOString();
    if (mode === "future-entry") f.observation.entry!.createdAt = new Date(initial + 1).toISOString();
    if (mode === "future-review") f.observation.entry!.review.recordedAt = new Date(initial + 1).toISOString();
    if (mode === "expired") f.observation.entry!.review.expiresAt = new Date(initial).toISOString();
    if (mode === "long-read") f.store.observe = async () => { f.setTime(initial + 30000); f.observation.observedAt = f.clock().toISOString(); return f.observation; };
    await assert.rejects(f.inspect(), /ANALYSIS_UNAVAILABLE/);
  }
  const f = fixture(); f.observation.entry!.review.expiresAt = new Date(initial + 10).toISOString();
  const e = await f.inspect(); assert.equal(e.validUntil, f.observation.entry!.review.expiresAt);
  f.setTime(initial + 10); assert.equal(f.source.isCurrent(e), false);
});

test("expiry, UTC/Pacific reset and clock rollback invalidate locally cached receipts permanently", async () => {
  for (const start of [initial, Date.parse("2026-09-20T00:00:00Z") - 1000, Date.parse("2026-09-20T07:00:00Z") - 1000]) {
    const f = fixture(); f.setTime(start); f.observation.observedAt = f.clock().toISOString();
    // Retain the original manual observation and extend nothing beyond its original expiry.
    const e = await f.inspect(); f.setTime(start + (start === initial ? 30000 : 1000));
    assert.equal(f.source.isCurrent(e), false);
  }
  const f = fixture(); const e = await f.inspect(); f.setTime(initial - 1);
  assert.equal(f.source.isCurrent(e), false); f.setTime(initial); assert.equal(f.source.isCurrent(e), false);
});

test("failed refresh cannot preserve older approval or leak private errors", async () => {
  const f = fixture(); const e = await f.inspect(); f.store.observe = async () => { throw new Error("private database credentials"); };
  await assert.rejects(f.inspect(), /^AnalysisAdmissionError: ANALYSIS_UNAVAILABLE$/);
  assert.equal(f.source.isCurrent(e), false);
});

test("clear, timeout and abort reject late results; uncooperative reads retain their bounded slot", async () => {
  for (const mode of ["clear", "timeout", "abort"]) {
    const f = fixture(20); let finish!: (o: AnalysisOperationsObservation) => void; let calls = 0;
    f.store.observe = () => { calls++; return new Promise((r) => { finish = r; }); };
    const controller = new AbortController(); const pending = f.inspect(controller.signal);
    const rejected = assert.rejects(pending, /ANALYSIS_UNAVAILABLE/); await new Promise((r) => setImmediate(r));
    if (mode === "clear") f.source.clear(); if (mode === "abort") controller.abort();
    await rejected; await assert.rejects(f.inspect(), /ANALYSIS_UNAVAILABLE/); assert.equal(calls, 1);
    finish(f.observation); await new Promise((r) => setImmediate(r));
    f.store.observe = async () => f.observation; const next = await f.inspect(); assert.equal(f.source.isCurrent(next), true);
  }
});

test("source evidence composes with existing readiness and a failed DB refresh invalidates its snapshot", async () => {
  const f = fixture(); const stamp = { id: "fixture", deploymentRef: binding.deploymentRef,
    checkedAt: f.clock().toISOString(), validUntil: new Date(initial + 20000).toISOString() };
  const runtime: AnalysisRuntimeEvidence = { ...stamp, ...binding, kind: "checked-analysis-runtime", repository: "postgres-0008",
    dispatcher: "durable-accounted-v1", counting: "count-accounted-0010-v1", storage: "replit", quotaAccounting: "app-project-atomic" };
  const approvedInput: AnalysisApprovedInputEvidence = { ...stamp, kind: "reviewed-analysis-input", input, scope: "approved_synthetic",
    inputApprovalId: "fixture", boundReviewId: "fixture", inputTokenBound: 1000, boundCoverage: "all-batches-system-schema-metadata-targets-context-envelope" };
  // Runtime and input are fictional here; only the operations source is the production implementation.
  const readiness = new EvidenceAnalysisReadiness({ clock: f.clock, sources: { operations: f.source,
    runtime: { async inspect() { return runtime; }, isCurrent: (e) => isDeepStrictEqual(e, runtime) },
    approvedInput: { async inspect() { return approvedInput; }, isCurrent: (e) => isDeepStrictEqual(e, approvedInput) } } });
  const snapshot = await readiness.inspect(input, signal()); assert.equal(readiness.isCurrent(snapshot.id), true);
  f.observation.halted = true; await assert.rejects(f.inspect(), /ANALYSIS_UNAVAILABLE/);
  assert.equal(readiness.isCurrent(snapshot.id), false);
});

test("invalid configuration/input, pre-abort and bounded receipt capacity cannot create authority", async () => {
  const f = fixture();
  for (const timeoutMs of [0, 4001, NaN]) assert.throws(() => new OperationsReviewEvidenceSource({ ...f.options, timeoutMs }), /ANALYSIS_UNAVAILABLE/);
  assert.throws(() => new OperationsReviewEvidenceSource({ ...f.options, binding: { ...binding, deploymentRef: "" } }), /ANALYSIS_UNAVAILABLE/);
  await assert.rejects(f.source.inspect({ ...input, frameCount: 0 }, signal()), /ANALYSIS_UNAVAILABLE/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.inspect(controller.signal), /ANALYSIS_UNAVAILABLE/);
  assert.equal(f.reads(), 0);
  for (let i = 0; i < 64; i++) await f.inspect();
  await assert.rejects(f.inspect(), /ANALYSIS_UNAVAILABLE/); assert.equal(f.reads(), 64);
  for (const path of ["src/processor/server.ts", "src/processor/index.ts"]) assert.ok(!(await readFile(path, "utf8")).includes("analysis-operations-source"));
});
