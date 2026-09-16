import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test, type TestContext } from "node:test";

import { analysisManifest, ANALYSIS_LIMITS } from "../src/processor/analysis-contract.js";
import { AnalysisImageError, createPrivateAnalysisImageLoader, type ApprovedSyntheticImages } from "../src/processor/analysis-images.js";
import { attemptFrameObjectKey } from "../src/processor/asset-lifecycle.js";
import type { GuideWithSteps } from "../src/processor/domain.js";
import { syntheticAnalysisInput } from "../src/processor/gemini/synthetic.js";
import { LocalStorage, type Storage } from "../src/processor/storage.js";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { testMediaPaths } from "./helpers/media-binaries.js";

const now = new Date("2026-09-15T12:00:00.000Z");
const { ffmpegPath } = testMediaPaths();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let synthetic: ReturnType<typeof syntheticAnalysisInput> | undefined;
async function fixture(context: TestContext) {
  const h = await createAnalysisHarness(context);
  const input = await (synthetic ??= syntheticAnalysisInput());
  const guide = structuredClone(h.guide);
  guide.steps.forEach((step) => { step.representativeFrameKey = attemptFrameObjectKey(guide.id, 1, step.position + 1, "frame"); });
  const approval: ApprovedSyntheticImages = { id: "synthetic-approval", scope: "approved_synthetic", guideId: guide.id,
    inputFingerprint: analysisManifest(guide).fingerprint, createdAt: now.toISOString(), expiresAt: new Date(now.valueOf() + 60_000).toISOString(),
    images: guide.steps.map((step, i) => ({ stepId: step.id, sha256: sha256(input.images[i].bytes) })) };
  const objectRoot = join(h.root, "objects");
  for (const step of guide.steps) {
    const destination = join(objectRoot, step.representativeFrameKey!);
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, input.images[step.position].bytes);
  }
  let activeGuide: GuideWithSteps | null = guide; let current: unknown = true; let at = now.valueOf();
  const repository = { async getGuideById(id: string) { assert.equal(id, guide.id); return activeGuide && structuredClone(activeGuide); } };
  const storage = new LocalStorage(objectRoot);
  const make = (overrides: Partial<Parameters<typeof createPrivateAnalysisImageLoader>[0]> = {}) => createPrivateAnalysisImageLoader({
    repository, storage, approval, ffmpegPath, isApprovalCurrent: () => current as boolean, clock: () => new Date(at), ...overrides,
  });
  const load = (loader = make(), signal = new AbortController().signal, stepId = "step-0", fingerprint = approval.inputFingerprint) =>
    loader(guide.id, stepId, signal, fingerprint);
  return { ...h, guide, approval, input, objectRoot, repository, storage, make, load,
    setGuide: (value: GuideWithSteps | null) => { activeGuide = value; },
    setCurrent: (value: unknown) => { current = value; }, setTime: (value: number) => { at = value; } };
}
const safeError = (error: unknown) => error instanceof AnalysisImageError && error.message === "ANALYSIS_IMAGE_UNAVAILABLE" && error.cause === undefined;

test("private loader reads real approved synthetic JPEGs through LocalStorage without changing source state", async (context) => {
  const h = await fixture(context); const before = await readFile(join(h.root, "guides.json"));
  const loader = h.make();
  for (let i = 0; i < 2; i += 1) assert.deepEqual(Buffer.from(await h.load(loader, undefined, `step-${i}`)), Buffer.from(h.input.images[i].bytes));
  assert.deepEqual(await readFile(join(h.root, "guides.json")), before);
  const bytes = await h.load(loader); bytes[0] = 0;
  assert.equal((await h.load(loader))[0], 255);
});

test("client paths, URLs, wrong guides, steps or manifest identities never reach storage", async (context) => {
  const h = await fixture(context); let opens = 0;
  const loader = h.make({ storage: { async openRead() { opens += 1; throw new Error("private-key"); } } });
  for (const [guideId, stepId, fingerprint] of [
    ["../other", "step-0", h.approval.inputFingerprint], ["https://example.test/private", "step-0", h.approval.inputFingerprint],
    ["other-guide", "step-0", h.approval.inputFingerprint], [h.guide.id, "../source.mp4", h.approval.inputFingerprint],
    [h.guide.id, "unknown", h.approval.inputFingerprint], [h.guide.id, "step-0", "0".repeat(64)],
  ]) await assert.rejects(loader(guideId, stepId, new AbortController().signal, fingerprint), safeError);
  assert.equal(opens, 0);
});

test("only the canonical current-attempt representative key is readable, even with a matching approval hash", async (context) => {
  const h = await fixture(context); let opens = 0;
  for (const key of ["guides/other/attempts/1/frames/frame-001.jpg", "guides/analysis-guide/source.mp4",
    "guides/analysis-guide/attempts/2/frames/frame-001.jpg", "guides/analysis-guide/attempts/1/frames/frame-001-thumb.jpg",
    "guides/analysis-guide/../private.jpg", "https://example.test/frame.jpg"]) {
    h.guide.steps[0].representativeFrameKey = key;
    const approval = { ...h.approval, inputFingerprint: analysisManifest(h.guide).fingerprint };
    const loader = h.make({ approval, storage: { async openRead() { opens += 1; throw new Error("unexpected read"); } } });
    await assert.rejects(h.load(loader, undefined, "step-0", approval.inputFingerprint), safeError);
  }
  assert.equal(opens, 0);
});

test("approval must cover all target/context frames and cannot be changed by mutating the caller's object", async (context) => {
  const h = await fixture(context);
  await assert.rejects(h.load(h.make({ approval: { ...h.approval, images: h.approval.images.slice(0, 1) } })), safeError);
  const loader = h.make(); h.approval.images[0].sha256 = "0".repeat(64);
  assert.ok(await h.load(loader));
  assert.throws(() => h.make({ approval: { ...h.approval, images: [h.approval.images[0], h.approval.images[0]] } }), safeError);
  assert.throws(() => h.make({ approval: { ...h.approval, scope: "user-video" } as never }), safeError);
  assert.throws(() => h.make({ timeoutMs: 5001 }), safeError);
});

test("missing, deleted, failed or reprocessed guides are rejected before any image read", async (context) => {
  const h = await fixture(context); let opens = 0;
  const loader = h.make({ storage: { async openRead() { opens += 1; throw new Error("unexpected read"); } } });
  for (const guide of [null, { ...h.guide, status: "failed" as const }, { ...h.guide, errorCode: "DELETION_PENDING" },
    { ...h.guide, processingAttemptId: "new-attempt" }, { ...h.guide, processingAttemptCount: 2 }, { ...h.guide, id: "other" }]) {
    h.setGuide(guide); await assert.rejects(h.load(loader), safeError);
  }
  assert.equal(opens, 0);
});

test("replacing an object at the same key fails its approved content hash", async (context) => {
  const h = await fixture(context);
  const storage = { async openRead() { return Readable.from([h.input.images[1].bytes]); } };
  await assert.rejects(h.load(h.make({ storage })), safeError);
});

test("fake headers, truncated JPEGs, extra images and wrong dimensions fail despite matching content approval", async (context) => {
  const h = await fixture(context); const valid = Buffer.from(h.input.images[0].bytes);
  const cases = [Buffer.from([255, 216, 255, 217]), valid.subarray(0, valid.length - 2), Buffer.concat([valid, valid]),
    Buffer.concat([valid, Buffer.from("private trailing text")])];
  for (const bytes of cases) {
    const approval = structuredClone(h.approval); approval.images[0].sha256 = sha256(bytes);
    await assert.rejects(h.load(h.make({ approval, storage: { async openRead() { return Readable.from([bytes]); } } })), safeError);
  }
  h.guide.steps[0].frameWidth = 639;
  const approval = { ...h.approval, inputFingerprint: analysisManifest(h.guide).fingerprint };
  await assert.rejects(h.load(h.make({ approval }), undefined, "step-0", approval.inputFingerprint), safeError);
});

test("missing JPEG tables are rejected instead of relying on decoder repair defaults", async (context) => {
  const h = await fixture(context); const valid = Buffer.from(h.input.images[0].bytes);
  const table = valid.indexOf(Buffer.from([255, 219])); assert.ok(table >= 0);
  const length = valid.readUInt16BE(table + 2);
  const bytes = Buffer.concat([valid.subarray(0, table), valid.subarray(table + 2 + length)]);
  const approval = structuredClone(h.approval); approval.images[0].sha256 = sha256(bytes);
  await assert.rejects(h.load(h.make({ approval, storage: { async openRead() { return Readable.from([bytes]); } } })), safeError);
});

test("EXIF and progressive images stay outside the accepted pipeline JPEG profile", async (context) => {
  const h = await fixture(context); const valid = Buffer.from(h.input.images[0].bytes);
  const progressive = Buffer.from(valid); const frame = progressive.indexOf(Buffer.from([255, 192]));
  assert.ok(frame >= 0); progressive[frame + 1] = 194;
  const exif = Buffer.concat([valid.subarray(0, 2), Buffer.from([255, 225, 0, 8, 69, 120, 105, 102, 0, 0]), valid.subarray(2)]);
  for (const bytes of [progressive, exif]) {
    const approval = structuredClone(h.approval); approval.images[0].sha256 = sha256(bytes);
    await assert.rejects(h.load(h.make({ approval, storage: { async openRead() { return Readable.from([bytes]); } } })), safeError);
  }
});

test("an approved valid JPEG exactly at the 2 MiB boundary is accepted", async (context) => {
  const h = await fixture(context); const valid = Buffer.from(h.input.images[0].bytes);
  let remaining = ANALYSIS_LIMITS.maxImageBytes - valid.length;
  const comments: Buffer[] = [];
  while (remaining > 0) {
    let size = Math.min(65_537, remaining);
    if (remaining - size > 0 && remaining - size < 4) size -= 4;
    const comment = Buffer.alloc(size); comment[0] = 255; comment[1] = 254; comment.writeUInt16BE(size - 2, 2);
    comments.push(comment); remaining -= size;
  }
  const bytes = Buffer.concat([valid.subarray(0, 2), ...comments, valid.subarray(2)]);
  const approval = structuredClone(h.approval); approval.images[0].sha256 = sha256(bytes);
  const loader = h.make({ approval, storage: { async openRead() { return Readable.from([bytes]); } } });
  assert.equal((await h.load(loader)).byteLength, ANALYSIS_LIMITS.maxImageBytes);
});

test("structurally framed JPEG with corrupt Huffman data fails actual local decoding", async (context) => {
  const h = await fixture(context); const bytes = Buffer.from(h.input.images[0].bytes);
  const table = bytes.indexOf(Buffer.from([255, 196])); assert.ok(table >= 0);
  bytes.fill(255, table + 5, table + 21);
  const approval = structuredClone(h.approval); approval.images[0].sha256 = sha256(bytes);
  await assert.rejects(h.load(h.make({ approval, storage: { async openRead() { return Readable.from([bytes]); } } })), safeError);
});

test("streamed size and type limits stop and close the source before returning bytes", async (context) => {
  const h = await fixture(context);
  for (const chunks of [[Buffer.alloc(ANALYSIS_LIMITS.maxImageBytes), Buffer.from([1])], ["not bytes"], [{ private: "object" }]]) {
    const source = Readable.from(chunks);
    await assert.rejects(h.load(h.make({ storage: { async openRead() { return source; } } })), safeError);
    assert.equal(source.destroyed, true);
  }
});

test("revoked, asynchronous, expired, future and backwards-clock approvals fail closed", async (context) => {
  const h = await fixture(context); const loader = h.make();
  for (const value of [() => false, () => "true", () => Promise.resolve(true), () => Promise.reject(new Error("private approval failure"))]) {
    h.setCurrent(value()); await assert.rejects(h.load(loader), safeError);
  }
  h.setCurrent(true);
  for (const at of [now.valueOf() - 1, now.valueOf() + 60_000, NaN]) { h.setTime(at); await assert.rejects(h.load(loader), safeError); }
  h.setTime(now.valueOf());
  const backwards = h.make({ repository: { async getGuideById() { h.setTime(now.valueOf() - 1); return h.guide; } } });
  await assert.rejects(h.load(backwards), safeError);
});

test("a changed guide or revoked approval during image reading is rechecked before release", async (context) => {
  const h = await fixture(context);
  for (const change of [() => h.setGuide(null), () => h.setCurrent(false)]) {
    h.setGuide(h.guide); h.setCurrent(true);
    const storage = { async openRead() { return Readable.from((async function* () {
      yield h.input.images[0].bytes; change();
    })()); } };
    await assert.rejects(h.load(h.make({ storage })), safeError);
  }
  h.setCurrent(true); h.setGuide(h.guide);
  let reads = 0;
  const loader = h.make({ repository: { async getGuideById() { reads += 1; return reads === 1 ? h.guide : null; } } });
  await assert.rejects(h.load(loader), safeError); assert.equal(reads, 2);
});

test("abort before reading performs no storage I/O and sanitizes the abort reason", async (context) => {
  const h = await fixture(context); const controller = new AbortController(); controller.abort(new Error("private edit key"));
  let reads = 0;
  await assert.rejects(h.load(h.make({ storage: { async openRead() { reads += 1; throw new Error("private path"); } } }), controller.signal), safeError);
  assert.equal(reads, 0);
});

test("timeout closes a late SDK stream and observes late stream errors", async (context) => {
  const h = await fixture(context); let release!: (value: Readable) => void;
  const storage: Pick<Storage, "openRead"> = { openRead() { return new Promise((resolve) => { release = resolve; }); } };
  await assert.rejects(h.load(h.make({ storage, timeoutMs: 30 })), safeError);
  const late = new PassThrough(); release(late);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(late.destroyed, true);
  late.emit("error", new Error("private SDK key"));
});

test("abort interrupts a stalled stream without waiting for an uncooperative producer", async (context) => {
  const h = await fixture(context); const source = new PassThrough(); const controller = new AbortController();
  let entered!: () => void; const opened = new Promise<void>((resolve) => { entered = resolve; });
  const pending = h.load(h.make({ storage: { async openRead() { entered(); return source; } } }), controller.signal);
  await opened; controller.abort("private reason"); await assert.rejects(pending, safeError);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(source.destroyed, true);
});

test("late repository completion cannot start storage work after timeout", async (context) => {
  const h = await fixture(context); let release!: (value: GuideWithSteps) => void; let reads = 0;
  const loader = h.make({ timeoutMs: 30, repository: { getGuideById() { return new Promise((resolve) => { release = resolve; }); } },
    storage: { async openRead() { reads += 1; throw new Error("private path"); } } });
  await assert.rejects(h.load(loader), safeError); release(h.guide);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(reads, 0);
});

test("storage and decoder failures expose no private paths or inner error details", async (context) => {
  const h = await fixture(context);
  await assert.rejects(h.load(h.make({ storage: { async openRead() { throw new Error("private/path edit-token secret"); } } })), safeError);
  await assert.rejects(h.load(h.make({ ffmpegPath: join(h.root, "missing-private-binary") })), safeError);
});

test("private image reader remains absent from startup and HTTP registration", async () => {
  for (const path of ["src/processor/index.ts", "src/processor/server.ts"]) {
    assert.ok(!(await readFile(path, "utf8")).includes("analysis-images"));
  }
});
