import assert from "node:assert/strict";
import { test } from "node:test";
import { checkArguments, singleSendTransport, assertRecoveryGuide } from "../../artifacts/api-server/scripts/check-live-synthetic.mjs";

const env = { REPL_ID: "00000000-0000-4000-8000-000000000000", GEMINI_API_KEY: "fictional-synthetic-key" };
const args = ["--run-synthetic", "--evidence=./fictional.json"];
test("live synthetic check requires explicit opt-in, development, and a key without printing it", () => {
  assert.ok(checkArguments(args, env).endsWith("fictional.json"));
  assert.equal(checkArguments(["--run-synthetic", "--evidence-stdin"], env), null);
  for (const changed of [{ REPLIT_DEPLOYMENT: "1" }, { NODE_ENV: "production" }, { REPL_ID: "wrong" },
    { GEMINI_API_KEY: "" }, { GEMINI_API_KEY: "key\nnotallowed" }, { SHOWME_ANALYSIS_MODE: "fixed-synthetic" }]) {
    assert.throws(() => checkArguments(args, { ...env, ...changed }), /^Error: LIVE_SYNTHETIC_CHECK_FAILED$/);
  }
  for (const invalid of [[], ["--run-synthetic"], [...args, "--retry"], ["--run-user-video", args[1]]]) assert.throws(() => checkArguments(invalid, env));
});
test("live synthetic transport permits exactly one count and generation, never redirects or other models", async () => {
  const model = "test-model", base = `https://generativelanguage.googleapis.com/v1beta/models/${model}`;
  const calls = [], reports = [];
  const transport = singleSendTransport(async (url, options) => { calls.push({ url, options }); return new Response("{}", { status: 200 }); }, model,
    (operation, status) => reports.push({ operation, status }));
  await assert.rejects(transport.fetch(`${base}:generateContent`, { method: "POST" }));
  await assert.rejects(transport.fetch("https://wrong.invalid/", { method: "POST" }));
  await assert.rejects(transport.fetch(`${base}:countTokens`, { method: "GET" }));
  assert.equal(calls.length, 0);
  await transport.fetch(`${base}:countTokens`, { method: "POST" });
  await transport.fetch(`${base}:generateContent`, { method: "POST" });
  await assert.rejects(transport.fetch(`${base}:countTokens`, { method: "POST" }));
  await assert.rejects(transport.fetch(`${base}:generateContent`, { method: "POST" }));
  assert.equal(calls.length, 2); assert.ok(calls.every(c => c.options.redirect === "error"));
  assert.deepEqual(reports, [{ operation: "count", status: 200 }, { operation: "generate", status: 200 }]);
});
test("an uncertain transport failure consumes its slot and cannot be retried", async () => {
  let calls = 0;
  const transport = singleSendTransport(async () => { calls++; throw new Error("fictional transport failure"); }, "test");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/test:countTokens";
  await assert.rejects(transport.fetch(url, { method: "POST" }));
  await assert.rejects(transport.fetch(url, { method: "POST" }));
  assert.equal(calls, 1);
});
test("cleanup recovery refuses unrelated or changed media and object keys", () => {
  const id = env.REPL_ID, journal = { guideId: id };
  const guide = { id, sourceFilename: "showme-fixed-synthetic-acceptance.mp4", sourceSizeBytes: 1,
    originalObjectKey: `guides/${id}/source/${"0".repeat(64)}.mp4`, processingAttemptCount: 1,
    steps: [{ position: 0, representativeFrameKey: `guides/${id}/attempts/1/frames/frame-001.jpg`,
      thumbnailFrameKey: `guides/${id}/attempts/1/frames/frame-001-thumb.jpg` }] };
  assert.doesNotThrow(() => assertRecoveryGuide(journal, guide));
  for (const changed of [{ id: "other" }, { sourceFilename: "personal.mp4" }, { sourceSizeBytes: 100 },
    { originalObjectKey: "other/source.mp4" }, { processingAttemptCount: 2 },
    { steps: [{ ...guide.steps[0], representativeFrameKey: "other/frame.jpg" }] }]) {
    assert.throws(() => assertRecoveryGuide(journal, { ...guide, ...changed }));
  }
});
