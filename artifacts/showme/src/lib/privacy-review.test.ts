import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { privacyAfterEdit, editableContent } from "./privacy-ledger.js";
import { privacyAfterEdit as serverInvalidation } from "../../../api-server/src/processor/privacy-review.js";
import { editorDocumentSchema, draftDocument, type DraftSnapshot, type EditorDocument } from "./draft-client.js";
import { DraftAutosave } from "./draft-autosave.js";
import { privacyWrite, requestPrivacyReview, type PrivacyReview } from "./privacy-review.js";
const hash = "a".repeat(64), identity = { baseUrl: "http://127.0.0.1:1", guideId: "fixture", editToken: "fixture-key" };
const document: EditorDocument = { schemaVersion: 2, title: "합성 안내", steps: [{ id: "s0", activeFrameStepId: "s0", sourceStepIds: ["s0"],
  shortLabel: "단계", instruction: "합성 설명", elements: [], privacyReview: "pending" }], privacy: { policyVersion: "privacy-review-v1",
  titleFingerprint: hash, steps: [{ stepId: "s0", sourceFingerprint: hash, imageFingerprint: hash, textFingerprint: hash,
    candidates: [{ id: hash, status: "masked", maskId: "m" }] }], lastMutation: null } };
const base: DraftSnapshot = { guideId: identity.guideId, revision: 1, inputFingerprint: hash, persisted: true,
  updatedAt: "2026-09-20T00:00:00.000Z", document };
const review: PrivacyReview = { guideId: identity.guideId, revision: 1, inputFingerprint: hash, fingerprint: hash,
  titleFingerprint: hash, titleConfirmed: true, complete: true, publicationEnabled: false,
  steps: [{ stepId: "s0", frameStepId: "s0", sourceFingerprint: hash, imageFingerprint: hash, textFingerprint: hash,
    imageConfirmed: true, textConfirmed: true, candidates: [] }] };
test("v1 remains readable but cannot carry fabricated review; v2 requires a bounded unique ledger", () => {
  const legacy = { ...document, schemaVersion: 1 }; delete legacy.privacy;
  assert.equal(editorDocumentSchema.parse(legacy).privacy, undefined);
  assert.throws(() => editorDocumentSchema.parse({ ...document, schemaVersion: 1 }));
  assert.throws(() => editorDocumentSchema.parse({ ...legacy, schemaVersion: 2 }));
  assert.throws(() => editorDocumentSchema.parse({ ...document, privacy: { ...document.privacy, steps: [document.privacy!.steps[0], document.privacy!.steps[0]] } }));
});

test("browser and server invalidate the same checks for all editor transformations", () => {
  const mutations: Array<(d: EditorDocument) => void> = [
    d => { d.title = "다른 제목"; }, d => { d.steps[0].instruction = "다른 문구"; }, d => { d.steps[0].shortLabel = "다른 이름"; },
    d => { d.steps[0].activeFrameStepId = "new"; d.steps[0].sourceStepIds.push("new"); }, d => { d.steps = []; },
    d => { d.steps[0].elements.push({ id: "m", type: "privacy-mask", enabled: true, visible: false, zIndex: 0, bounds: { x: 0, y: 0, width: 5, height: 5 } }); },
    d => { d.steps[0].elements.push({ id: "tap", type: "tap", visible: true, zIndex: 10, radius: 5, center: { x: 50, y: 50 } }); },
  ];
  for (const mutate of mutations) {
    const next = structuredClone(document); mutate(next);
    assert.deepEqual(privacyAfterEdit(document, next), serverInvalidation(document, next));
  }
  assert.equal(document.privacy!.steps[0].imageFingerprint, hash);
});

test("document reconstruction keeps review metadata and clears only changed text", () => {
  const step = document.steps[0];
  const next = draftDocument(document.title, [{ ...step, draft: step, screen: "frame", target: { x: 50, y: 50 },
    targetVisible: false, privacyCount: 0, privacyEnabled: false, instruction: "새 설명" }], { goal: "", audience: "", notes: "" }, document);
  assert.equal(next.schemaVersion, 2); assert.equal(next.privacy!.steps[0].textFingerprint, null);
  assert.equal(next.privacy!.steps[0].imageFingerprint, hash);
});

test("newly drawn mask key order cannot revoke a successful candidate acknowledgement or cause an autosave loop", () => {
  const live = structuredClone(document);
  live.steps[0].elements = [{ id: "m", type: "privacy-mask", enabled: true, visible: true, zIndex: 20,
    bounds: { x: 20, y: 30, width: 30, height: 15 } }];
  const stored = editorDocumentSchema.parse(live);
  assert.notEqual(JSON.stringify(live.steps[0].elements), JSON.stringify(stored.steps[0].elements));
  assert.deepEqual(privacyAfterEdit(stored, live), stored.privacy);
  assert.deepEqual(serverInvalidation(stored, live), stored.privacy);
  const step = live.steps[0];
  const rebuilt = draftDocument(stored.title, [{ ...step, draft: step, screen: "frame", target: { x: 50, y: 50 },
    targetVisible: false, privacyCount: 0, privacyEnabled: false }], { goal: "", audience: "", notes: "" }, stored);
  assert.deepEqual(rebuilt, stored);
});

test("trimmed text is normalized before invalidation so whitespace-only input cannot cause a false save failure", () => {
  const stored = editorDocumentSchema.parse(document), step = stored.steps[0];
  const rebuilt = draftDocument(` ${stored.title} `, [{ ...step, draft: step, shortLabel: ` ${step.shortLabel} `,
    instruction: ` ${step.instruction} `, screen: "frame", target: { x: 50, y: 50 }, targetVisible: false,
    privacyCount: 0, privacyEnabled: false }], { goal: "", audience: "", notes: "" }, stored);
  assert.deepEqual(rebuilt, stored);
});

test("privacy reads and writes use only authenticated same-origin API with exact response identity", async t => {
  const command = privacyWrite(base, review, { type: "title", confirmed: false });
  const saved = structuredClone(base); saved.revision++; saved.document.privacy!.lastMutation = { id: command.mutationId, fingerprint: hash, baseRevision: 1 };
  saved.document.privacy!.titleFingerprint = null;
  const mock = t.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    assert.equal(String(url), "http://127.0.0.1:1/api/guides/fixture/draft/privacy");
    assert.equal(options.redirect, "error"); assert.equal((options.headers as Record<string, string>).Authorization, "Bearer fixture-key");
    if (options.method === "GET") return Response.json({ draft: base, review });
    assert.deepEqual(JSON.parse(options.body as string), command);
    return Response.json({ draft: saved, review: { ...review, revision: 2, titleConfirmed: false, complete: false } });
  });
  assert.equal((await requestPrivacyReview(identity, base)).review.complete, true);
  assert.equal((await requestPrivacyReview(identity, base, command)).draft.revision, 2);
  assert.equal(mock.mock.callCount(), 2);
  assert.throws(() => privacyWrite({ ...base, revision: 2 }, review, { type: "title", confirmed: true }));
});

test("foreign frames, changed content, malformed success and public activation are not acknowledged", async t => {
  for (const value of [
    { draft: { ...base, document: { ...document, title: "Unexpected" } }, review },
    { draft: base, review: { ...review, publicationEnabled: true } },
    { draft: base, review: { ...review, steps: [{ ...review.steps[0], frameStepId: "foreign" }] } },
    { draft: base, review: { ...review, titleConfirmed: false } },
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json(value));
    await assert.rejects(requestPrivacyReview(identity, base)); mock.mock.restore();
  }
});

test("privacy acknowledgement advances autosave without rewriting inputs; changed or failed edits refuse it", () => {
  let savedCount = 0;
  const autosave = new DraftAutosave({ initial: base, write: async () => { throw new Error("unused"); },
    onSaved: () => { savedCount++; }, onStatus: () => {} });
  autosave.update(base.document);
  const saved = structuredClone(base); saved.revision++; saved.document.privacy!.lastMutation = { id: randomUUID(), fingerprint: hash, baseRevision: 1 };
  assert.equal(editableContent(saved.document), editableContent(base.document));
  assert.equal(autosave.acceptPrivacySave(base, saved), true); assert.equal(savedCount, 1);
  assert.equal(autosave.acceptPrivacySave(base, saved), false);
  autosave.update({ ...saved.document, title: "아직 저장하지 않은 제목" });
  assert.equal(autosave.acceptPrivacySave(saved, { ...saved, revision: 3 }), false);
  autosave.dispose();
});
