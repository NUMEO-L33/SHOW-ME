import assert from "node:assert/strict";
import { test } from "node:test";
import { draftDocument, draftSteps, getDraft, putDraft, draftFailure, type DraftSnapshot } from "./draft-client.js";
import { ProcessorClientError, type ProcessorGuide } from "./processor-client.js";

const identity = { guideId: "guide", baseUrl: "http://127.0.0.1:1", editToken: "synthetic-key" };
const intent = { goal: "사진 보내기", audience: "처음 사용자", notes: "추측 금지" };
const snapshot: DraftSnapshot = {
  guideId: "guide", revision: 0, inputFingerprint: "a".repeat(64), persisted: false, updatedAt: null,
  document: { schemaVersion: 1, title: "사진 안내", intent, steps: [0, 1, 2].map(i => ({ id: `step-${i}`,
    activeFrameStepId: `step-${i}`, sourceStepIds: [`step-${i}`], shortLabel: `${i + 1}단계`, instruction: "확인하세요.", elements: [], privacyReview: "pending" })) },
};
const media: ProcessorGuide = { id: "guide", title: "source", status: "ready", progress: 100, statusMessage: "ready",
  steps: [0, 1, 2].map(i => ({ id: `step-${i}`, screen: "frame", frameUrl: `http://127.0.0.1:1/frames/${i}?ticket=private`,
    shortLabel: "placeholder", instruction: "placeholder", target: { x: 50, y: 50 }, privacyCount: 0, privacyEnabled: false })) };

test("draft adapter binds server frame IDs, hides unknown tap positions and never persists signed URLs", () => {
  const steps = draftSteps(snapshot.document, media);
  assert.equal(steps[0].targetVisible, false);
  steps[0].instruction = "샘플을 여세요.";
  steps[0].target = { x: 25, y: 60 }; steps[0].targetVisible = true;
  const document = draftDocument("편집 제목", steps, intent);
  assert.equal(document.steps[0].instruction, "샘플을 여세요.");
  assert.deepEqual(document.steps[0].elements[0], { id: "step-0:tap", type: "tap", center: { x: 25, y: 60 }, radius: 5, zIndex: 10, visible: true });
  assert.doesNotMatch(JSON.stringify(document), /ticket|http|frameUrl|thumbnail/);
  assert.deepEqual(draftSteps(document, media)[0].target, { x: 25, y: 60 });
  assert.equal(snapshot.document.steps[0].elements.length, 0);
});

test("editing text preserves hidden pointers, other elements and their order", () => {
  const document = structuredClone(snapshot.document);
  document.steps[0].elements = [
    { id: "mask", type: "privacy-mask", bounds: { x: 0, y: 0, width: 10, height: 10 }, enabled: false, visible: false, zIndex: 2 },
    { id: "first", type: "tap", center: { x: 20, y: 30 }, radius: 7, visible: false, zIndex: 3 },
    { id: "second", type: "tap", center: { x: 70, y: 80 }, radius: 6, visible: true, zIndex: 4 },
  ];
  const steps = draftSteps(document, media);
  assert.deepEqual(draftDocument(document.title, steps, intent), document);
  steps[0].instruction = "수정한 설명";
  steps[0].targetVisible = true;
  steps[0].target = { x: 10, y: 15 };
  const saved = draftDocument(document.title, steps, intent);
  assert.deepEqual(saved.steps[0].elements[0], document.steps[0].elements[0]);
  assert.deepEqual(saved.steps[0].elements[2], document.steps[0].elements[2]);
  assert.deepEqual(saved.steps[0].elements[1], { ...document.steps[0].elements[1], center: { x: 10, y: 15 }, visible: true });
});

test("merged and removed steps restore their selected source frame instead of using the displayed step ID", () => {
  const document = structuredClone(snapshot.document);
  document.steps = [{ ...document.steps[1], id: "step-0", sourceStepIds: ["step-0", "step-1"] }];
  const steps = draftSteps(document, media);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].frameUrl, media.steps[1].frameUrl);
  assert.deepEqual(draftDocument(document.title, steps, intent), document);
});

test("foreign frames and duplicate sources fail closed; plain-text lengths are enforced before saving", () => {
  const changed = structuredClone(snapshot.document);
  changed.steps[0].activeFrameStepId = "foreign";
  assert.throws(() => draftSteps(changed, media));
  const duplicate = structuredClone(snapshot.document);
  duplicate.steps[1].sourceStepIds.push("step-0");
  assert.throws(() => draftSteps(duplicate, media));
  const steps = draftSteps(snapshot.document, media);
  assert.throws(() => draftDocument("", steps, intent));
  assert.throws(() => draftDocument("<script>", steps, intent));
  steps[0].instruction = "a".repeat(501);
  assert.throws(() => draftDocument("valid", steps, intent));
});

test("private draft GET/PUT use bearer, deadline and no redirect; response must acknowledge the exact revision and content", async t => {
  const mock = t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    assert.equal(options.redirect, "error");
    assert.equal((options.headers as Record<string, string>).Authorization, "Bearer synthetic-key");
    assert.ok(options.signal);
    if (options.method === "GET") return Response.json({ draft: snapshot });
    assert.deepEqual(JSON.parse(options.body as string), { expectedRevision: 0, inputFingerprint: snapshot.inputFingerprint, document: snapshot.document });
    return Response.json({ draft: { ...snapshot, persisted: true, revision: 1, updatedAt: new Date().toISOString() } });
  });
  assert.deepEqual(await getDraft(identity), snapshot);
  assert.equal((await putDraft(identity, snapshot, snapshot.document)).revision, 1);
  assert.equal(mock.mock.callCount(), 2);
});

test("HTTP 200 with unconfirmed or wrong draft is never counted as saved", async t => {
  for (const value of [null, { ...snapshot, persisted: true, revision: 5 }, { ...snapshot, persisted: true, revision: 1, document: { ...snapshot.document, title: "wrong" } }]) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ draft: value }));
    await assert.rejects(putDraft(identity, snapshot, snapshot.document), (error: unknown) => error instanceof ProcessorClientError && error.code === "INVALID_RESPONSE");
    mock.mock.restore();
  }
});

test("conflict and failed writes remain errors without leaking private error text or performing automatic overwrites", async t => {
  for (const status of [400, 401, 404, 409, 503]) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "private-host/token=secret", code: "DRAFT_CONFLICT" }, { status }));
    await assert.rejects(putDraft(identity, snapshot, snapshot.document), (error: unknown) => {
      assert.ok(error instanceof ProcessorClientError);
      assert.equal(error.status, status);
      assert.doesNotMatch(draftFailure(error), /private-host|secret/);
      return true;
    });
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
});

test("a stalled draft response body is bounded by the request deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reading = false;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => ({ ok: true,
    json: () => new Promise((_resolve, reject) => { reading = true; options.signal?.addEventListener("abort", () => reject(new DOMException("secret", "AbortError"))); }),
  } as Response));
  const pending = getDraft(identity);
  const result = assert.rejects(pending, (error: unknown) => error instanceof ProcessorClientError && error.code === "REQUEST_TIMEOUT");
  await Promise.resolve();
  assert.equal(reading, true);
  t.mock.timers.tick(15_000);
  await result;
});
