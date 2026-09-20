import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { addMask, editMask, masksFor, getPrivacyPreview } from "./privacy-masks.js";
import { draftDocument, type EditorStep, type DraftSnapshot } from "./draft-client.js";
const step: EditorStep = { id: "step", activeFrameStepId: "frame", sourceStepIds: ["frame"], shortLabel: "확인", instruction: "테스트",
  elements: [], privacyReview: "pending" };
const base: DraftSnapshot = { guideId: "guide", revision: 1, inputFingerprint: "a".repeat(64), persisted: true, updatedAt: null,
  document: { schemaVersion: 1, title: "합성", steps: [step] } };
const identity = { guideId: "guide", baseUrl: "http://127.0.0.1:1", editToken: "fictional" };

test("mask edits are immutable, bounded, frame-bound and never approve privacy", () => {
  const a = addMask(step, "mask"), b = editMask(a, "mask", { x: 99, y: -10, width: 40, height: 150 });
  assert.equal(step.elements.length, 0); assert.equal(masksFor(a).length, 1);
  assert.deepEqual(masksFor(b)[0].bounds, { x: 60, y: 0, width: 40, height: 100 });
  assert.equal(b.activeFrameStepId, "frame"); assert.equal(b.privacyReview, "pending");
  assert.deepEqual(editMask(b, "mask", { width: NaN }), b);
  assert.equal(masksFor(editMask(b, "mask", "toggle"))[0].enabled, false);
  assert.equal(editMask(b, "mask", "remove").elements.length, 0);
  assert.deepEqual(addMask(a, "mask"), a);
  let max = step; for (let i = 0; i < 25; i++) max = addMask(max, `mask-${i}`);
  assert.equal(masksFor(max).length, 20);
});

test("existing automatic save document preserves exact masks and tap elements", () => {
  const draft = addMask(step, "mask");
  const document = draftDocument("합성", [{ id: "step", draft, screen: "frame", shortLabel: "확인", instruction: "테스트",
    privacyCount: 0, privacyEnabled: false, targetVisible: false, target: { x: 50, y: 50 } }], { goal: "", audience: "", notes: "" });
  assert.deepEqual(document.steps[0], draft);
});

test("preview uses owner headers, same-origin/no redirects and no request body or automatic AI call", async t => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const mock = t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/guides/guide/privacy-preview/step/frame"); assert.equal(new URL(url).search, "");
    assert.equal(options.method, "GET"); assert.equal(options.body, undefined); assert.equal(options.redirect, "error");
    assert.equal(options.mode, "same-origin"); assert.equal(options.cache, "no-store");
    assert.equal((options.headers as Record<string, string>)["X-ShowMe-Draft-Revision"], "1");
    return new Response(png, { headers: { "Content-Type": "image/png", "X-ShowMe-Draft-Revision": "1", "X-ShowMe-Privacy-Render": "opaque-tiles-v1" } });
  });
  assert.equal((await getPrivacyPreview(identity, base, "step", "frame")).size, 8);
  await assert.rejects(getPrivacyPreview(identity, { ...base, persisted: false }, "step", "frame"));
  await assert.rejects(getPrivacyPreview({ ...identity, baseUrl: "https://foreign.invalid" }, base, "step", "frame"));
  assert.equal(mock.mock.callCount(), 1);
});

test("stale/missing render acknowledgement and source JPEG fallback are rejected", async t => {
  for (const response of [new Response("source", { status: 503 }), new Response("source", { headers: { "Content-Type": "image/jpeg" } }),
    new Response("source", { headers: { "Content-Type": "image/png", "X-ShowMe-Draft-Revision": "1", "X-ShowMe-Privacy-Render": "opaque-tiles-v1" } })]) {
    t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(getPrivacyPreview(identity, base, "step", "frame")); t.mock.restoreAll();
  }
});

test("UI invalidates old preview after edits and releases object URLs without declaring public safety", async () => {
  const source = await readFile(new URL("../components/privacy-editor.tsx", import.meta.url), "utf8");
  for (const text of ["preview?.key === key", "URL.revokeObjectURL", "request.current?.abort()", "원본으로 대신 표시하지 않습니다", "공개 승인을 뜻하지 않습니다", "자동 탐지 결과나 안전 판정이 아닙니다"])
    assert.ok(source.includes(text));
});
