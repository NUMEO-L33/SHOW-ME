import assert from "node:assert/strict";
import { test } from "node:test";
import { analysisReviewFailure, applyAnalysisPreview, getStoredAnalysis, parseStoredAnalysis, type AnalysisPreview, type StoredAnalysis } from "./analysis-review.js";
import { putDraft, type DraftSnapshot } from "./draft-client.js";
import { ProcessorClientError } from "./processor-client.js";

const identity = { guideId: "guide", baseUrl: "http://127.0.0.1:1", editToken: "synthetic-key" };
const base: DraftSnapshot = { guideId: "guide", revision: 3, persisted: true, updatedAt: "2026-09-18T00:00:00.000Z", inputFingerprint: "a".repeat(64),
  document: { schemaVersion: 1, title: "사람이 정한 제목", intent: { goal: "합성 테스트", audience: "검토자", notes: "유지" },
    steps: [0, 1, 2].map(i => ({ id: `step-${i}`, activeFrameStepId: `step-${i}`, sourceStepIds: [`step-${i}`],
      shortLabel: `현재 ${i}`, instruction: "사람이 편집한 설명", elements: [
        { id: `step-${i}:ai-tap`, type: "privacy-mask", bounds: { x: 10, y: 10, width: 10, height: 10 }, enabled: false, zIndex: 20, visible: false },
        { id: "tap", type: "tap", center: { x: 10, y: 20 }, radius: 5, visible: true, zIndex: 10 },
      ], privacyReview: "pending" })) } };
const analysis: StoredAnalysis = { inputFingerprint: base.inputFingerprint, frameIds: ["step-0", "step-1", "step-2", "step-3"],
  run: { runId: "00000000-0000-4000-8000-000000000001", status: "succeeded", model: "synthetic", baseDraftRevision: 1, appliedDraftRevision: null,
    cancellable: false, reviewRequired: true, errorCode: null, inputTokens: 100, outputTokens: 50,
    createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:01.000Z",
    result: { schemaVersion: 1, steps: [0, 1, 2, 3].map(i => ({ stepId: `step-${i}`, shortLabel: `AI ${i}`, instruction: "샘플 버튼을 누르세요.", action: "tap",
      target: { x: 50, y: 65 }, privacy: [{ kind: "other", bounds: { x: 0, y: 0, width: 5, height: 5 } }], reviewReasons: [], mergeWithNext: false })) } } };
const preview = (): AnalysisPreview => ({ base: structuredClone(base), analysis: structuredClone(analysis) });

test("stored result lookup is one authenticated same-origin GET, with no video, retry or analysis start", async t => {
  const mock = t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/guides/guide/analysis");
    assert.equal(new URL(url).search, "");
    assert.equal((options.headers as Record<string, string>)["X-ShowMe-Input-Fingerprint"], base.inputFingerprint);
    assert.equal(options.method, "GET"); assert.equal(options.body, undefined);
    assert.equal(options.redirect, "error"); assert.equal(options.mode, "same-origin");
    assert.equal(options.cache, "no-store"); assert.equal(options.referrerPolicy, "no-referrer");
    assert.equal((options.headers as Record<string, string>).Authorization, "Bearer synthetic-key");
    return Response.json(analysis);
  });
  assert.deepEqual(await getStoredAnalysis(identity, base), preview());
  assert.equal(mock.mock.callCount(), 1);
  await assert.rejects(getStoredAnalysis({ ...identity, guideId: "other" }, base));
  assert.equal(mock.mock.callCount(), 1);
});

test("only explicitly selected unmerged steps change; title, intent, masks, order and deletions survive", () => {
  const before = structuredClone(base);
  const value = preview();
  value.analysis.run!.result!.steps[0].mergeWithNext = true;
  const applied = applyAnalysisPreview(value, base, base.document, ["step-0"]);
  assert.equal(applied.title, base.document.title); assert.deepEqual(applied.intent, base.document.intent);
  assert.deepEqual(applied.steps.map(step => step.id), ["step-0", "step-1", "step-2"]);
  assert.deepEqual(applied.steps.slice(1), base.document.steps.slice(1));
  assert.equal(applied.steps[0].instruction, "샘플 버튼을 누르세요.");
  assert.deepEqual(applied.steps[0].elements[0], base.document.steps[0].elements[0]);
  assert.equal(applied.steps[0].elements.length, 2); // no unreviewed privacy candidates inserted
  assert.deepEqual(applied.steps[0].elements[1], { id: "step-0:ai-tap-1", type: "tap", center: { x: 50, y: 65 }, radius: 5, zIndex: 10, visible: true });
  assert.equal(applied.steps[0].privacyReview, "pending");
  assert.deepEqual(base, before);
});

test("non-tap and unknown/null actions never invent coordinates and remove old click markers", () => {
  for (const action of ["wait", "observe", "unknown", "tap"] as const) {
    const value = preview();
    Object.assign(value.analysis.run!.result!.steps[0], { action, target: null, reviewReasons: ["unclear_action"] });
    const applied = applyAnalysisPreview(value, base, base.document, ["step-0"]);
    assert.deepEqual(applied.steps[0].elements, [base.document.steps[0].elements[0]]);
  }
});

test("merged steps cannot be selected and are preserved when another step is applied", () => {
  const value = preview();
  value.base.document.steps[1].sourceStepIds = ["step-1", "step-2"];
  value.base.document.steps.splice(2, 1);
  assert.throws(() => applyAnalysisPreview(value, value.base, value.base.document, ["step-1"]));
  const applied = applyAnalysisPreview(value, value.base, value.base.document, ["step-0"]);
  assert.deepEqual(applied.steps[1], value.base.document.steps[1]);
});

test("stale guide, media, revision, unsaved input or unpersisted draft prevents application", () => {
  for (const current of [{ ...base, guideId: "other" }, { ...base, inputFingerprint: "b".repeat(64) },
    { ...base, revision: 4 }, { ...base, persisted: false }, { ...base, document: { ...base.document, title: "new" } }]) {
    assert.throws(() => applyAnalysisPreview(preview(), current, base.document, ["step-0"]), (e: unknown) => e instanceof ProcessorClientError && e.status === 409);
  }
  assert.throws(() => applyAnalysisPreview(preview(), base, { ...base.document, title: "unsaved" }, ["step-0"]));
  for (const ids of [[], ["unknown"], ["step-0", "step-0"], ["step-3"]]) assert.throws(() => applyAnalysisPreview(preview(), base, base.document, ids));
});

test("wrong fingerprints, foreign/duplicate/missing frames and malformed model suggestions fail closed", () => {
  const variants: Array<(v: StoredAnalysis) => void> = [
    v => { v.inputFingerprint = "b".repeat(64); }, v => { v.frameIds[0] = "foreign"; }, v => { v.frameIds[0] = v.frameIds[1]; },
    v => { v.run!.result!.steps.pop(); }, v => { v.run!.result!.steps[0].stepId = "foreign"; },
    v => { v.run!.result!.steps[0].stepId = "step-1"; }, v => { v.run!.result!.steps[0].target!.x = 101; },
    v => { v.run!.result!.steps[0].instruction = "<script>"; }, v => { v.run!.result!.steps[0].action = "wait"; },
    v => { v.run!.result!.steps[0].target = null; }, v => { v.run!.result!.steps.at(-1)!.mergeWithNext = true; },
    v => { v.run!.reviewRequired = false; }, v => { v.run!.cancellable = true; },
  ];
  for (const mutate of variants) { const value = structuredClone(analysis); mutate(value); assert.throws(() => parseStoredAnalysis(value, base)); }
});

test("absent, active, failed and cancelled runs are readable but never applicable", () => {
  for (const status of [null, "queued", "running", "failed", "cancelled"] as const) {
    const value = preview();
    value.analysis.run = status === null ? null : { ...analysis.run!, status, result: null, reviewRequired: false,
      cancellable: status === "queued" || status === "running", errorCode: status === "failed" ? "AI_TIMEOUT" : null };
    assert.deepEqual(parseStoredAnalysis(value.analysis, base), value.analysis);
    assert.throws(() => applyAnalysisPreview(value, base, base.document, ["step-0"]));
  }
});

test("selected changes use the existing draft CAS; a server conflict is not retried or treated as saved", async t => {
  const applied = applyAnalysisPreview(preview(), base, base.document, ["step-0"]);
  const mock = t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    assert.equal(options.method, "PUT");
    assert.deepEqual(JSON.parse(options.body as string), { expectedRevision: 3, inputFingerprint: base.inputFingerprint, document: applied });
    return Response.json({ error: "private-key", code: "DRAFT_CONFLICT" }, { status: 409 });
  });
  await assert.rejects(putDraft(identity, base, applied), (error: unknown) => error instanceof ProcessorClientError && error.status === 409);
  assert.equal(mock.mock.callCount(), 1);
  assert.equal(applied.steps[0].instruction, "샘플 버튼을 누르세요.");
});

test("lookup failure hides private error content and never retries", async t => {
  for (const status of [401, 403, 404, 409, 429, 503]) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "private-token/provider-body" }, { status }));
    await assert.rejects(getStoredAnalysis(identity, base), (e: unknown) => {
      assert.doesNotMatch(analysisReviewFailure(e), /private-token|provider-body/); return true;
    });
    assert.equal(mock.mock.callCount(), 1); mock.mock.restore();
  }
});

test("foreign destinations and pre-cancelled lookups cannot receive a credential", async t => {
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json(analysis));
  await assert.rejects(getStoredAnalysis({ ...identity, baseUrl: "https://foreign.example" }, base),
    (e: unknown) => e instanceof ProcessorClientError && e.code === "PRIVATE_DESTINATION_BLOCKED");
  const abort = new AbortController(); abort.abort();
  await assert.rejects(getStoredAnalysis(identity, base, abort.signal), { name: "AbortError" });
  assert.equal(mock.mock.callCount(), 0);
});

test("lookup body deadline and cancellation prevent an unbounded wait", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => ({ ok: true,
    json: () => new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new DOMException("private", "AbortError")))),
  } as Response));
  const deadline = assert.rejects(getStoredAnalysis(identity, base), (e: unknown) => e instanceof ProcessorClientError && e.code === "REQUEST_TIMEOUT");
  await Promise.resolve(); t.mock.timers.tick(15_000); await deadline;
  const abort = new AbortController();
  const cancelled = assert.rejects(getStoredAnalysis(identity, base, abort.signal));
  await Promise.resolve(); abort.abort(); await cancelled;
});
