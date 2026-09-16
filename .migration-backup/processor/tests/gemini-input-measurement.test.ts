import assert from "node:assert/strict";
import { test } from "node:test";
import { auditGeminiInput } from "../src/gemini/input-bound.js";
import { GeminiInputMeasurements, verifyGeminiInputMeasurement, type MeteredGeminiInputCounter } from "../src/gemini/input-measurement.js";
import type { AnalysisInput } from "../src/gemini/request.js";

const start = Date.parse("2026-09-15T12:00:00.000Z");
const scope = { projectRef: "test-project", inputApprovalId: "test-approval", inputFingerprint: "a".repeat(64) };
function input(): AnalysisInput {
  const targets = [0, 1].map((position) => ({ stepId: `f-${position}`, position, timestampMs: position * 1000, width: 640, height: 360 }));
  return { targets, context: [], images: targets.map((f) => ({ stepId: f.stepId, mimeType: "image/jpeg", bytes: new Uint8Array([255, 216, 255, 217]) })) };
}
const lookup = () => ({ ...auditGeminiInput(input(), scope.inputApprovalId, scope.inputFingerprint), projectRef: scope.projectRef });
function harness() {
  let time = start; let calls = 0;
  const clock = () => new Date(time);
  // Deliberately fictional count executor; no account, DB or Google calls.
  const counter: MeteredGeminiInputCounter = { contract: "separately-metered-countTokens-v1", async execute() { calls++; return { totalTokens: 321 }; } };
  const cache = new GeminiInputMeasurements({ counter, clock });
  const signal = new AbortController().signal;
  const checked = (raw: unknown, maxInputTokens = 1000) => verifyGeminiInputMeasurement({ raw, input: lookup(), verifier: cache, maxInputTokens, clock, signal });
  return { cache, counter, signal, clock, checked, calls: () => calls, advance: (ms: number) => { time += ms; } };
}

test("measurement lookup is offline and a missing separately metered counter cannot measure", async () => {
  const h = harness(); assert.equal(await h.cache.inspect(lookup(), h.signal), null); assert.equal(h.calls(), 0);
  const empty = new GeminiInputMeasurements();
  await assert.rejects(empty.measure(input(), scope, h.signal), /ANALYSIS_UNAVAILABLE/);
  Object.assign(h.counter, { contract: "locked-send-v2" });
  await assert.rejects(h.cache.measure(input(), scope, h.signal), /ANALYSIS_UNAVAILABLE/);
  assert.equal(h.calls(), 0);
});

test("only explicit metered execution creates a fresh full-request measurement, not an upper-bound claim", async () => {
  const h = harness(); const record = await h.cache.measure(input(), scope, h.signal);
  assert.equal(h.calls(), 1); assert.equal(record.measuredInputTokens, 321);
  assert.ok(!("totalInputTokenUpperBound" in record)); assert.ok(!JSON.stringify(record).includes("bytes"));
  assert.deepEqual(await h.cache.inspect(lookup(), h.signal), record);
  h.checked(record).assertCurrent(); assert.equal(h.calls(), 1);
});

test("copied evidence IDs, altered counters, timestamps or project/approval cannot be laundered", async () => {
  const h = harness(); const record = await h.cache.measure(input(), scope, h.signal);
  for (const raw of [{ ...record, measuredInputTokens: 1 }, { ...record, projectRef: "other" },
    { ...record, inputApprovalId: "other" }, { ...record, inputFingerprint: "b".repeat(64) },
    { ...record, requestFingerprint: "b".repeat(64) }, { ...record, checkedAt: new Date(start + 1).toISOString() },
    { ...record, validUntil: new Date(start + 31_000).toISOString() }, { ...record, kind: "reviewed-exact-request" }]) {
    assert.throws(() => h.checked(raw), /ANALYSIS_UNAVAILABLE/);
  }
  record.measuredInputTokens = 2;
  assert.equal((await h.cache.inspect(lookup(), h.signal) as { measuredInputTokens: number }).measuredInputTokens, 321);
});

test("changed pixels or metadata miss the cache and cannot reuse a historical probe result", async () => {
  const h = harness(); await h.cache.measure(input(), scope, h.signal);
  const changed = input(); changed.images[0].bytes[3] = 0;
  const audit = { ...auditGeminiInput(changed, scope.inputApprovalId, scope.inputFingerprint), projectRef: scope.projectRef };
  assert.equal(await h.cache.inspect(audit, h.signal), null);
  assert.throws(() => h.checked({ status: "counted-synthetic-only", measuredInputTokens: 7199 }), /ANALYSIS_UNAVAILABLE/);
  assert.equal(await new GeminiInputMeasurements().inspect(lookup(), h.signal), null);
});

test("measured input is limited by the trusted upper bound and must not accept asynchronous truthiness", async () => {
  const h = harness(); const record = await h.cache.measure(input(), scope, h.signal);
  assert.throws(() => h.checked(record, 320), /ANALYSIS_UNAVAILABLE/);
  for (const max of [0, NaN, 320.5, Infinity]) assert.throws(() => h.checked(record, max), /ANALYSIS_UNAVAILABLE/);
  const verifier = { inspect: h.cache.inspect.bind(h.cache), isCurrent: (() => Promise.resolve(true)) as never };
  assert.throws(() => verifyGeminiInputMeasurement({ raw: record, input: lookup(), verifier, maxInputTokens: 1000, clock: h.clock, signal: h.signal }), /ANALYSIS_UNAVAILABLE/);
});

test("expiry, revocation and a backward clock invalidate already checked evidence", async () => {
  const h = harness(); const record = await h.cache.measure(input(), scope, h.signal); const checked = h.checked(record);
  h.advance(30_000); assert.throws(() => checked.assertCurrent(), /ANALYSIS_UNAVAILABLE/);
  assert.equal(await h.cache.inspect(lookup(), h.signal), null);
  const newer = await h.cache.measure(input(), scope, h.signal); h.cache.clear();
  assert.throws(() => h.checked(newer), /ANALYSIS_UNAVAILABLE/);
  await h.cache.measure(input(), scope, h.signal); h.advance(-1);
  await assert.rejects(h.cache.inspect(lookup(), h.signal), /ANALYSIS_UNAVAILABLE/);
});

test("a measurement cannot cross UTC or Pacific midnight, including while a count is in flight", async () => {
  for (const reset of ["2026-09-16T00:00:00.000Z", "2026-09-16T07:00:00.000Z"]) {
    let time = Date.parse(reset) - 1;
    const counter: MeteredGeminiInputCounter = { contract: "separately-metered-countTokens-v1", async execute() { return { totalTokens: 10 }; } };
    const cache = new GeminiInputMeasurements({ counter, clock: () => new Date(time) });
    const signal = new AbortController().signal; const record = await cache.measure(input(), scope, signal);
    time++; assert.equal(cache.isCurrent(record), false);
    time = Date.parse(reset) - 1;
    const active = new GeminiInputMeasurements({ counter: { ...counter, async execute() { time++; return { totalTokens: 10 }; } }, clock: () => new Date(time) });
    await assert.rejects(active.measure(input(), scope, signal), /ANALYSIS_UNAVAILABLE/);
  }
});

test("invalid or failed count responses cannot issue evidence or expose arbitrary errors", async () => {
  for (const result of [{ totalTokens: 0 }, { totalTokens: -1 }, { totalTokens: 1.5 }, { totalTokens: "1" },
    { totalTokens: Number.MAX_SAFE_INTEGER + 1 }, { totalTokens: 100, untrusted: true }]) {
    const h = harness(); h.counter.execute = async () => result as never;
    await assert.rejects(h.cache.measure(input(), scope, h.signal), /ANALYSIS_UNAVAILABLE/);
    assert.equal(await h.cache.inspect(lookup(), h.signal), null);
  }
  const h = harness(); h.counter.execute = async () => { throw new Error("private-service-details"); };
  await assert.rejects(h.cache.measure(input(), scope, h.signal), (error) => String(error).includes("ANALYSIS_UNAVAILABLE") && !String(error).includes("private-service"));
});

test("mutating the source input cannot change an in-flight request; executor mutation cannot issue evidence", async () => {
  const h = harness(); const original = input();
  h.counter.execute = async (received) => { assert.equal(received.images[0].bytes[3], 217); return { totalTokens: 321 }; };
  const operation = h.cache.measure(original, scope, h.signal); original.images[0].bytes[3] = 0;
  await operation;
  h.counter.execute = async (received) => { received.images[0].bytes[3] = 0; return { totalTokens: 321 }; };
  await assert.rejects(h.cache.measure(input(), scope, h.signal), /ANALYSIS_UNAVAILABLE/);
  assert.equal(await h.cache.inspect(lookup(), h.signal), null);
});

test("clear revokes a pending measure and an ignored abort cannot issue late evidence or overlap another count", async () => {
  const h = harness(); let finish!: (value: { totalTokens: number }) => void;
  h.counter.execute = () => new Promise((resolve) => { finish = resolve; });
  const operation = h.cache.measure(input(), scope, h.signal);
  await new Promise((resolve) => setImmediate(resolve)); h.cache.clear();
  await assert.rejects(operation, /ANALYSIS_UNAVAILABLE/);
  await assert.rejects(h.cache.measure(input(), scope, h.signal), /ANALYSIS_UNAVAILABLE/);
  finish({ totalTokens: 321 }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await h.cache.inspect(lookup(), h.signal), null);
});

test("deadline includes ignored counter work and a second simultaneous request fails before the counter", async () => {
  let finish!: (value: { totalTokens: number }) => void; let calls = 0;
  const cache = new GeminiInputMeasurements({ timeoutMs: 30, counter: {
    contract: "separately-metered-countTokens-v1", execute: () => { calls++; return new Promise((resolve) => { finish = resolve; }); },
  } });
  const signal = new AbortController().signal;
  const first = cache.measure(input(), scope, signal);
  await assert.rejects(cache.measure(input(), scope, signal), /ANALYSIS_UNAVAILABLE/);
  await assert.rejects(first, /ANALYSIS_UNAVAILABLE/); assert.equal(calls, 1);
  finish({ totalTokens: 321 }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await cache.inspect(lookup(), signal), null);
});

test("aborted input or revocation before executor scheduling prevents any count", async () => {
  const h = harness(); const controller = new AbortController(); controller.abort();
  await assert.rejects(h.cache.measure(input(), scope, controller.signal), /ANALYSIS_UNAVAILABLE/);
  const operation = h.cache.measure(input(), scope, h.signal); h.cache.clear();
  await assert.rejects(operation, /ANALYSIS_UNAVAILABLE/); assert.equal(h.calls(), 0);
});
