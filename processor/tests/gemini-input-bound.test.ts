import assert from "node:assert/strict";
import { test } from "node:test";
import { auditGeminiInput, verifyGeminiInputBound } from "../src/gemini/input-bound.js";
import type { AnalysisInput } from "../src/gemini/request.js";
import { inputBoundFixture } from "./helpers/input-bound-fixture.js";

const at = new Date("2026-09-15T12:00:00.000Z");
function input(): AnalysisInput {
  const frames = Array.from({ length: 6 }, (_, position) => ({ stepId: `frame-${position}`, position, timestampMs: position * 1000, width: 640, height: 360 }));
  return { targets: frames.slice(1, 5), context: [frames[0], frames[5]], images: frames.map((f) => ({ stepId: f.stepId, mimeType: "image/jpeg", bytes: new Uint8Array([255, 216, 255, 217]) })) };
}
const audit = () => auditGeminiInput(input(), "approval", "a".repeat(64));

test("offline audit includes prompt, schema, metadata, all targets and context but does not pretend to count tokens", () => {
  const report = audit();
  assert.equal(report.targetCount, 4); assert.equal(report.contextCount, 2); assert.equal(report.imageBytes, 24);
  assert.ok(report.systemInstructionBytes > 0); assert.ok(report.responseSchemaBytes > 0); assert.ok(report.metadataBytes > 0);
  assert.ok(report.requestBytes > report.systemInstructionBytes + report.responseSchemaBytes + report.metadataBytes);
  assert.equal(report.approximateImageTokens, 6720); assert.equal(report.verifiedInputTokenUpperBound, null);
  assert.ok(!JSON.stringify(report).includes("base64")); assert.match(report.requestFingerprint, /^[a-f0-9]{64}$/);
});

test("the audited fingerprint changes for context pixels, target pixels and metadata, without returning image data", () => {
  for (const position of [0, 1, 5]) {
    const changed = input(); changed.images[position].bytes[3] = 0;
    assert.notEqual(auditGeminiInput(changed, "approval", "a".repeat(64)).requestFingerprint, audit().requestFingerprint);
  }
  const changed = input(); changed.context[0].width = 639;
  assert.notEqual(auditGeminiInput(changed, "approval", "a".repeat(64)).requestFingerprint, audit().requestFingerprint);
});

test("exact-request evidence is accepted only with the complete accounting scope and adequate reserved bound", async () => {
  const verifier = inputBoundFixture(() => at); const report = audit(); const signal = new AbortController().signal;
  const raw = await verifier.inspect(report, signal);
  const checked = verifyGeminiInputBound({ raw, audit: report, verifier, clock: () => at, signal, maxInputTokens: 1000 });
  assert.equal(checked.evidence.totalInputTokenUpperBound, 1000); checked.assertCurrent();
  assert.throws(() => verifyGeminiInputBound({ raw, audit: report, verifier, clock: () => at, signal, maxInputTokens: 999 }), /ANALYSIS_UNAVAILABLE/);
});

test("estimates, images-only claims, wrong approvals or old request hashes cannot become upper-bound evidence", async () => {
  const verifier = inputBoundFixture(() => at); const report = audit(); const signal = new AbortController().signal;
  const raw = await verifier.inspect(report, signal) as Record<string, unknown>;
  for (const evidence of [null, report, { ...raw, kind: "estimated" }, { ...raw, includes: "images-only" },
    { ...raw, inputApprovalId: "other" }, { ...raw, inputFingerprint: "b".repeat(64) }, { ...raw, requestFingerprint: "c".repeat(64) },
    { ...raw, model: "gemini-3.8-flash" }, { ...raw, totalInputTokenUpperBound: 0 }, { ...raw, paidFallback: true }]) {
    assert.throws(() => verifyGeminiInputBound({ raw: evidence, audit: report, verifier, clock: () => at, signal, maxInputTokens: 1000 }), /ANALYSIS_UNAVAILABLE/);
  }
});

test("input evidence expires, is revoked and rejects asynchronous truthy checks before launch", async () => {
  const verifier = inputBoundFixture(() => at); const report = audit(); const controller = new AbortController();
  const raw = await verifier.inspect(report, controller.signal);
  const checked = verifyGeminiInputBound({ raw, audit: report, verifier, clock: () => at, signal: controller.signal, maxInputTokens: 1000 });
  assert.throws(() => checked.assertCurrent(new Date(at.valueOf() + 20_000)), /ANALYSIS_UNAVAILABLE/);
  assert.throws(() => checked.assertCurrent(new Date(at.valueOf() - 1)), /ANALYSIS_UNAVAILABLE/);
  verifier.isCurrent = () => false; assert.throws(() => checked.assertCurrent(), /ANALYSIS_UNAVAILABLE/);
  verifier.isCurrent = (() => Promise.resolve(true)) as never; assert.throws(() => checked.assertCurrent(), /ANALYSIS_UNAVAILABLE/);
  verifier.isCurrent = () => true; controller.abort(); assert.throws(() => checked.assertCurrent(), /ANALYSIS_UNAVAILABLE/);
});

test("input evidence cannot cross UTC or Pacific reset even during its short lifetime", async () => {
  for (const reset of ["2026-09-15T00:00:00.000Z", "2026-09-15T07:00:00.000Z"]) {
    const before = new Date(Date.parse(reset) - 1000); const verifier = inputBoundFixture(() => before);
    const report = audit(); const signal = new AbortController().signal; const raw = await verifier.inspect(report, signal);
    const checked = verifyGeminiInputBound({ raw, audit: report, verifier, clock: () => before, signal, maxInputTokens: 1000 });
    assert.throws(() => checked.assertCurrent(new Date(reset)), /ANALYSIS_UNAVAILABLE/);
  }
});
