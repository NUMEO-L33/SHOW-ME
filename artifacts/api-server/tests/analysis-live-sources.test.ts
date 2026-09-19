import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Readable } from "node:stream";
import { LocalAnalysisEvidence } from "../src/processor/analysis-local-evidence.js";
import { FixedSyntheticInputSource, type SyntheticInputGrant } from "../src/processor/analysis-synthetic-input.js";
import { createFixedSyntheticAnalysisRuntime } from "../src/processor/analysis-synthetic-runtime.js";
import { analysisManifest } from "../src/processor/analysis-contract.js";
import { attemptFrameObjectKey } from "../src/processor/asset-lifecycle.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "../src/processor/gemini/request.js";
import { SYNTHETIC_COUNT_LIMITS } from "../src/processor/gemini/count-policy.js";
import { syntheticAnalysisInput } from "../src/processor/gemini/synthetic.js";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { testMediaPaths } from "./helpers/media-binaries.js";

const input = { guideId: "guide", frameCount: 2, inputFingerprint: "a".repeat(64), model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION } as const;
const signal = () => new AbortController().signal;
const now = new Date("2026-09-19T06:00:00.000Z");
type Receipt = { id: string; checkedAt: string; validUntil: string; value: number };

test("local evidence binds complete receipts and expires without refreshing old observations", async () => {
  let at = now.valueOf(); let reads = 0; let permitted = true;
  const source = new LocalAnalysisEvidence<Receipt>({ clock: () => new Date(at), current: () => { assert.ok(permitted); },
    read: async () => { reads++; return { value: 1 }; } });
  const receipt = await source.inspect(input, signal()); assert.equal(reads, 1); assert.equal(source.isCurrent(receipt), true);
  assert.equal(source.isCurrent({ ...receipt, value: 2 }), false);
  at += 30_000; assert.equal(source.isCurrent(receipt), false);
  const next = await source.inspect(input, signal()); assert.equal(reads, 2);
  at--; assert.equal(source.isCurrent(next), false);
  at++; const last = await source.inspect(input, signal()); permitted = false; assert.equal(source.isCurrent(last), false);
});

test("aborted or cleared late reads cannot issue evidence or release a still occupied slot", async () => {
  let resolve!: (value: { value: number }) => void; let calls = 0;
  const source = new LocalAnalysisEvidence<Receipt>({ current: () => {}, read: async () => {
    calls++; return new Promise((done) => { resolve = done; });
  } });
  const controller = new AbortController(); const pending = source.inspect(input, controller.signal);
  await delay(0); controller.abort(); await assert.rejects(pending, /ANALYSIS_UNAVAILABLE/);
  await assert.rejects(source.inspect(input, signal())); assert.equal(calls, 1);
  resolve({ value: 1 }); await delay(0);
  const next = source.inspect(input, signal()); await delay(0); source.clear(); resolve({ value: 2 });
  await assert.rejects(next, /ANALYSIS_UNAVAILABLE/); assert.equal(calls, 2);
});

test("failed reads invalidate earlier receipts and expose no source details", async () => {
  let bad = false;
  const source = new LocalAnalysisEvidence<Receipt>({ current: () => {}, read: async () => {
    if (bad) throw new Error("private connection details"); return { value: 1 };
  } });
  const receipt = await source.inspect(input, signal()); bad = true;
  await assert.rejects(source.inspect(input, signal()), (error: Error) => error.message === "ANALYSIS_UNAVAILABLE" && !error.cause);
  assert.equal(source.isCurrent(receipt), false);
});

test("fixed synthetic source uses exact bundled pixels, binds the manifest and supports permanent revocation", async (t) => {
  const h = await createAnalysisHarness(t); const guide = structuredClone(h.guide);
  for (const step of guide.steps) step.representativeFrameKey = attemptFrameObjectKey(guide.id, 1, step.position + 1, "frame");
  const fixture = await syntheticAnalysisInput(); let corrupt = false; let reads = 0; let at = now.valueOf();
  let currentGuide: typeof guide | null = guide;
  const grant: SyntheticInputGrant = { kind: "fixed-synthetic-screens-v1", approvalId: "fixture-only", deploymentRef: "test",
    input: { ...input, guideId: guide.id, inputFingerprint: analysisManifest(guide).fingerprint },
    createdAt: now.toISOString(), expiresAt: new Date(at + 60_000).toISOString(), inputTokenLimit: 1000, countPolicy: SYNTHETIC_COUNT_LIMITS };
  const source = new FixedSyntheticInputSource({ grant, clock: () => new Date(at), ffmpegPath: testMediaPaths().ffmpegPath,
    repository: { async getGuideById(id) { assert.equal(id, guide.id); return currentGuide && structuredClone(currentGuide); } },
    storage: { async openRead(key) { reads++; const index = guide.steps.findIndex((s) => s.representativeFrameKey === key); assert.ok(index >= 0);
      const bytes = Buffer.from(fixture.images[index].bytes); if (corrupt) bytes[20] ^= 1; return Readable.from(bytes); } } });
  await assert.rejects(source.loadImage(guide.id, "step-0", signal(), grant.input.inputFingerprint));
  const evidence = await source.inspect(grant.input, signal()); assert.equal(reads, 0); assert.equal(source.isCurrent(evidence), true);
  assert.deepEqual(Buffer.from(await source.loadImage(guide.id, "step-0", signal(), grant.input.inputFingerprint)), Buffer.from(fixture.images[0].bytes));
  corrupt = true; await assert.rejects(source.loadImage(guide.id, "step-0", signal(), grant.input.inputFingerprint), /ANALYSIS_IMAGE_UNAVAILABLE/);
  corrupt = false; const before = reads;
  await assert.rejects(source.loadImage("other", "step-0", signal(), grant.input.inputFingerprint)); assert.equal(reads, before);
  await assert.rejects(source.inspect({ ...grant.input, inputFingerprint: "b".repeat(64) }, signal()));
  assert.equal(source.isCurrent(evidence), false);
  currentGuide = null; await assert.rejects(source.inspect(grant.input, signal())); currentGuide = guide;
  const next = await source.inspect(grant.input, signal()); source.revoke(); assert.equal(source.isCurrent(next), false);
  await assert.rejects(source.inspect(grant.input, signal())); await assert.rejects(source.loadImage(guide.id, "step-0", signal(), grant.input.inputFingerprint));
});

test("synthetic grant rejects extra images, alternate scope, caller hashes and long-lived approval", () => {
  const grant = { kind: "fixed-synthetic-screens-v1", approvalId: "fixture-only", deploymentRef: "test", input,
    createdAt: now.toISOString(), expiresAt: new Date(now.valueOf() + 60_000).toISOString(), inputTokenLimit: 1000, countPolicy: SYNTHETIC_COUNT_LIMITS };
  for (const change of [{ input: { ...input, frameCount: 3 } }, { scope: "user_video" }, { images: [] },
    { expiresAt: new Date(now.valueOf() + 86_400_001).toISOString() }]) {
    assert.throws(() => new FixedSyntheticInputSource({ grant: { ...grant, ...change } as SyntheticInputGrant,
      repository: { getGuideById: async () => { throw new Error("must not read"); } }, storage: { openRead: async () => { throw new Error("must not read"); } }, ffmpegPath: "unused" }));
  }
});

test("runtime is dormant by default: no DB, storage or AI calls, and shutdown owns no pool", async () => {
  const grant: SyntheticInputGrant = { kind: "fixed-synthetic-screens-v1", approvalId: "fixture-only", deploymentRef: "test", input,
    createdAt: now.toISOString(), expiresAt: new Date(now.valueOf() + 60_000).toISOString(), inputTokenLimit: 1000, countPolicy: SYNTHETIC_COUNT_LIMITS };
  let calls = 0;
  const runtime = createFixedSyntheticAnalysisRuntime({ pool: { connect: async () => { calls++; throw new Error("must not connect"); },
    query: async () => { calls++; throw new Error("must not query"); } } as never,
    config: { deploymentRef: "test", projectRef: "test", credentialRef: "test", bucketId: "fixture", prefix: "showme" },
    grant, migrationsFolder: "unused", ffmpegPath: "unused", storageClient: {} as never,
    fetch: async () => { calls++; throw new Error("must not send"); } });
  assert.equal(await runtime.tick(), "disabled"); assert.equal(runtime.getStatus().running, false);
  await runtime.stop(); assert.equal(await runtime.tick(), "disabled"); assert.equal(calls, 0);
});
