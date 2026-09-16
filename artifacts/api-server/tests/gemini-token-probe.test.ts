import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GeminiError } from "../src/processor/gemini/provider.js";
import { GEMINI_TEST_MODEL } from "../src/processor/gemini/request.js";
import { prepareSyntheticTokenProbe, reserveTokenProbeAttempt, runTokenProbe, tokenProbeMode, TOKEN_PROBE_ENDPOINT } from "../src/processor/gemini/token-probe.js";

const flags = ["--live", "--confirm-free-project", "--approve-synthetic-images"];
const env = { GEMINI_API_KEY: "AQ.synthetic-test-not-a-real-key" };
const hasCode = (code: string) => (error: unknown) => error instanceof GeminiError && error.code === code;
const reserve = async () => {};

test("token probe defaults offline and requires all fresh confirmations, not historical env flags", () => {
  assert.equal(tokenProbeMode([], {}), "dry-run");
  assert.equal(tokenProbeMode(flags, env), "live");
  for (const args of [["--live"], flags.slice(1), [...flags, "--live"], [...flags, "--model", GEMINI_TEST_MODEL],
    ["--file", "private.jpg"], ["--url", "https://example.com"]]) {
    assert.throws(() => tokenProbeMode(args, { ...env, SHOWME_GEMINI_FREE_TIER_CONFIRMED: "true" }), hasCode("GEMINI_DISABLED"));
  }
  for (const key of [undefined, "", "bad\nkey-value", "a".repeat(4097)]) {
    assert.throws(() => tokenProbeMode(flags, { GEMINI_API_KEY: key }), hasCode("GEMINI_KEY_MISSING"));
  }
});

test("six synthetic frames include four targets, both context frames and the complete exact request", async () => {
  const { body, report } = await prepareSyntheticTokenProbe();
  const parsed = JSON.parse(body);
  assert.deepEqual(Object.keys(parsed), ["generateContentRequest"]);
  const { model, ...request } = parsed.generateContentRequest;
  assert.equal(model, `models/${GEMINI_TEST_MODEL}`);
  assert.ok(request.systemInstruction.parts[0].text.includes("Korean"));
  assert.ok(request.generationConfig.responseJsonSchema.properties.steps);
  assert.equal(request.generationConfig.maxOutputTokens, 8192);
  const parts = request.contents[0].parts;
  assert.deepEqual(JSON.parse(parts[0].text).targetIds, [1, 2, 3, 4].map((n) => `token-probe-${n}`));
  const images = parts.filter((p: { inlineData?: unknown }) => p.inlineData);
  assert.equal(images.length, 6);
  assert.equal(new Set(images.map((p: { inlineData: { data: string } }) => p.inlineData.data)).size, 2);
  for (const image of images) {
    const bytes = Buffer.from(image.inlineData.data, "base64");
    assert.equal(bytes.readUInt16BE(0), 0xffd8); assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9);
  }
  assert.equal(report.requestFingerprint, createHash("sha256").update(JSON.stringify([GEMINI_TEST_MODEL, JSON.stringify(request)])).digest("hex"));
  assert.equal(report.countRequestFingerprint, createHash("sha256").update(body).digest("hex"));
  assert.equal(report.targetCount, 4); assert.equal(report.contextCount, 2);
  assert.equal(report.verifiedInputTokenUpperBound, null); assert.equal(report.measuredInputTokens, null);
  assert.equal(report.enablesAnalysis, false); assert.equal(report.projectVerifiedAutomatically, false);
  assert.ok(!JSON.stringify(report).includes("inlineData"));
});

test("dry run cannot call Google or reserve a live slot", async () => {
  const report = await runTokenProbe([], env, {
    fetch: async () => { assert.fail("network prohibited"); }, reserve: async () => { assert.fail("reservation prohibited"); },
  });
  assert.equal(report.networkCalls, 0); assert.equal(report.status, "prepared-not-sent");
  assert.equal(report.freeProjectEvidence, "not-checked");
  assert.ok(!JSON.stringify(report).includes(env.GEMINI_API_KEY));
});

test("approved probe reserves before a single countTokens request, key only in header and redirects disabled", async () => {
  let reserved = false; let calls = 0;
  const report = await runTokenProbe(flags, env, {
    reserve: async () => { reserved = true; },
    fetch: async (url, init) => {
      assert.equal(reserved, true); calls += 1; assert.equal(url, TOKEN_PROBE_ENDPOINT);
      assert.equal(init?.redirect, "error"); assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), env.GEMINI_API_KEY);
      assert.ok(!String(url).includes(env.GEMINI_API_KEY)); assert.ok(!String(init?.body).includes(env.GEMINI_API_KEY));
      return Response.json({ totalTokens: 7350, ignoredField: env.GEMINI_API_KEY });
    },
  });
  assert.equal(calls, 1); assert.equal(report.measuredInputTokens, 7350);
  assert.equal(report.verifiedInputTokenUpperBound, null); assert.equal(report.enablesAnalysis, false);
  assert.equal(report.freeProjectEvidence, "operator-confirmation-only");
  assert.ok(!JSON.stringify(report).includes(env.GEMINI_API_KEY));
});

test("HTTP failures never retry, switch model, or leak a provider body", async () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(runTokenProbe(flags, env, { reserve, fetch: async () => {
      calls += 1; return new Response(env.GEMINI_API_KEY, { status });
    } }), (error: unknown) => error instanceof GeminiError && error.httpStatus === status && !String(error).includes(env.GEMINI_API_KEY));
    assert.equal(calls, 1);
  }
});

test("invalid, unsafe or oversized counts fail without retaining response contents", async () => {
  for (const value of [null, {}, { totalTokens: 0 }, { totalTokens: -1 }, { totalTokens: 1.5 },
    { totalTokens: "7350" }, { totalTokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(runTokenProbe(flags, env, { reserve, fetch: async () => Response.json(value) }), hasCode("GEMINI_RESPONSE_INVALID"));
  }
  for (const response of [new Response("not json"), new Response("x".repeat(65537)),
    new Response("{}", { headers: { "content-length": "999999" } })]) {
    await assert.rejects(runTokenProbe(flags, env, { reserve, fetch: async () => response }), hasCode("GEMINI_RESPONSE_INVALID"));
  }
});

test("a reservation failure or cancellation stops the network call", async () => {
  const controller = new AbortController(); let calls = 0;
  const fetch = async () => { calls += 1; return Response.json({ totalTokens: 1 }); };
  await assert.rejects(runTokenProbe(flags, env, { fetch, reserve: async () => { throw new GeminiError("GEMINI_LOCAL_LIMIT"); } }), hasCode("GEMINI_LOCAL_LIMIT"));
  await assert.rejects(runTokenProbe(flags, env, { fetch, signal: controller.signal, reserve: async () => { controller.abort(); } }), hasCode("GEMINI_CANCELLED"));
  await assert.rejects(runTokenProbe(flags, env, { fetch, signal: controller.signal, reserve }), hasCode("GEMINI_CANCELLED"));
  assert.equal(calls, 0);
});

test("an unresponsive fetch times out and a late response is cancelled without retry", async () => {
  let cancelled = false; let calls = 0; let finish!: (response: Response) => void;
  await assert.rejects(runTokenProbe(flags, env, { timeoutMs: 50, reserve, fetch: () => {
    calls += 1; return new Promise<Response>((resolve) => { finish = resolve; });
  } }), hasCode("GEMINI_TIMEOUT"));
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(cancelled, true);
});

test("a hanging response body is cancelled on deadline", async () => {
  let cancelled = false;
  await assert.rejects(runTokenProbe(flags, env, { timeoutMs: 50, reserve, fetch: async () =>
    new Response(new ReadableStream({ cancel() { cancelled = true; } })) }), hasCode("GEMINI_TIMEOUT"));
  assert.equal(cancelled, true);
});

test("Pacific-day local attempt is durable, concurrent-safe and not reset by key or request changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "showme-token-probe-"));
  try {
    const at = new Date("2026-09-15T06:59:59.000Z"); const signal = new AbortController().signal;
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => reserveTokenProbeAttempt(root, "a".repeat(64), signal, at)));
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    await assert.rejects(reserveTokenProbeAttempt(root, "b".repeat(64), signal, at), hasCode("GEMINI_LOCAL_LIMIT"));
    const slot = JSON.parse(await readFile(join(root, "2026-09-14/attempt.reserved"), "utf8"));
    assert.equal(slot.fingerprint, "a".repeat(64)); assert.equal(slot.model, GEMINI_TEST_MODEL);
    await reserveTokenProbeAttempt(root, "b".repeat(64), signal, new Date("2026-09-15T07:00:00.000Z"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
