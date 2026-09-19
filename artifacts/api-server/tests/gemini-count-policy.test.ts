import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedCountBody, boundedCountPolicySchema, SYNTHETIC_COUNT_LIMITS } from "../src/processor/gemini/count-policy.js";
import { buildTokenCountRequest } from "../src/processor/gemini/count-request.js";
import { auditGeminiInput } from "../src/processor/gemini/input-bound.js";
import type { AnalysisInput } from "../src/processor/gemini/request.js";

function input(): AnalysisInput {
  return { targets: [{ stepId: "one", position: 0, timestampMs: 0, width: 640, height: 360 }], context: [],
    images: [{ stepId: "one", mimeType: "image/jpeg", bytes: new Uint8Array([255, 216, 255, 217]) }] };
}
test("count policy bounds the serialized whole request but does not invent token evidence", () => {
  const i = input(); const body = boundedCountBody(i, SYNTHETIC_COUNT_LIMITS);
  assert.deepEqual(JSON.parse(body), buildTokenCountRequest(i));
  const length = Buffer.byteLength(body, "utf8");
  assert.equal(boundedCountBody(i, { ...SYNTHETIC_COUNT_LIMITS, maxRequestBytes: length }), body);
  assert.throws(() => boundedCountBody(i, { ...SYNTHETIC_COUNT_LIMITS, maxRequestBytes: length - 1 }));
  assert.equal(auditGeminiInput(i, "fixture", "a".repeat(64)).verifiedInputTokenUpperBound, null);
});
test("image count, individual bytes, total bytes and malformed media fail before counting", () => {
  const i = input(); i.targets.push({ ...i.targets[0], stepId: "two", position: 1 });
  i.images.push({ ...i.images[0], stepId: "two" });
  assert.throws(() => boundedCountBody(i, { ...SYNTHETIC_COUNT_LIMITS, maxImages: 1 }));
  assert.throws(() => boundedCountBody(i, { ...SYNTHETIC_COUNT_LIMITS, maxTotalImageBytes: 7 }));
  i.images[0].bytes = new Uint8Array([255, 216, 255, 0, 217]);
  assert.throws(() => boundedCountBody(i, { ...SYNTHETIC_COUNT_LIMITS, maxImageBytes: 4 }));
  i.images[0].mimeType = "image/png" as never; assert.throws(() => boundedCountBody(i, SYNTHETIC_COUNT_LIMITS));
});
test("count approval cannot lift hard ceilings, permit retries or add enable flags", () => {
  for (const change of [{ maxImages: 7 }, { maxImageBytes: 2097153 }, { maxTotalImageBytes: 12582913 },
    { maxRequestBytes: 18874369 }, { timeoutMs: 20001 }, { attemptsPerSlot: 2 }, { maxImages: 0 }, { enabled: true }]) {
    assert.equal(boundedCountPolicySchema.safeParse({ ...SYNTHETIC_COUNT_LIMITS, ...change }).success, false);
  }
});
