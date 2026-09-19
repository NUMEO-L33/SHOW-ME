import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ANALYSIS_MAX_POLLS, ANALYSIS_POLL_MS, AnalysisSession, analysisRecoveryKey, analysisSessionFailure,
  cancelAnalysisRun, getAnalysisAvailability, readAnalysisRun, requestAnalysis,
  type AnalysisStorage, type AnalysisTicket, type AnalysisTransport } from "./analysis-session.js";
import type { DraftSnapshot } from "./draft-client.js";
import type { AnalysisRunView, StoredAnalysis } from "./analysis-review.js";
import { ProcessorClientError } from "./processor-client.js";

const identity = { guideId: "guide", baseUrl: "http://127.0.0.1:1", editToken: "synthetic-key" };
const runId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const base: DraftSnapshot = { guideId: "guide", revision: 3, inputFingerprint: "a".repeat(64), persisted: true,
  updatedAt: "2026-09-18T00:00:00.000Z", document: { schemaVersion: 1, title: "합성", steps: [
    { id: "s0", sourceStepIds: ["s0"], activeFrameStepId: "s0", shortLabel: "원래", instruction: "기존 설명", elements: [], privacyReview: "pending" },
  ] } };
const consent = () => ({ base: structuredClone(base), externalProcessing: true, nonSensitive: true });
const ticket: AnalysisTicket = { version: 1, guideId: base.guideId, inputFingerprint: base.inputFingerprint,
  runId, baseDraftRevision: base.revision, consentVersion: "screen-analysis-v1" };
function view(status: AnalysisRunView["status"] = "queued"): AnalysisRunView {
  return { runId, status, model: "synthetic", baseDraftRevision: 3, appliedDraftRevision: null,
    cancellable: status === "queued" || status === "running", reviewRequired: status === "succeeded",
    errorCode: status === "failed" ? "AI_TIMEOUT" : null, inputTokens: 1, outputTokens: 2,
    createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:01.000Z",
    result: status === "succeeded" ? { schemaVersion: 1, steps: [{ stepId: "s0", shortLabel: "제안", instruction: "샘플 확인",
      action: "observe", target: null, privacy: [], reviewReasons: [], mergeWithNext: false }] } : null };
}
function harness(t: TestContext, overrides: Partial<AnalysisTransport> = {}, initialBase = base) {
  const records = new Map<string, string>();
  const calls = { latest: 0, start: 0, cancel: 0, read: 0 };
  let current: AnalysisRunView | null = null;
  const storage: AnalysisStorage = { getItem: k => records.get(k) ?? null, setItem: (k, v) => { records.set(k, v); }, removeItem: k => { records.delete(k); } };
  const api: AnalysisTransport = {
    availability: async () => ({ consentVersion: "screen-analysis-v1", startAvailable: true, reason: null }),
    latest: async () => { calls.latest++; return { inputFingerprint: base.inputFingerprint, frameIds: ["s0"], run: current }; },
    start: async () => { calls.start++; current = view(); return current; },
    read: async () => { calls.read++; if (!current) throw new ProcessorClientError("private", 404, "ANALYSIS_NOT_FOUND"); return current; },
    cancel: async () => { calls.cancel++; current = view("cancelled"); return current; }, ...overrides,
  };
  const session = new AnalysisSession(identity, initialBase, storage, () => {}, api);
  t.after(() => session.dispose());
  return { session, records, storage, api, calls, setRun: (v: AnalysisRunView | null) => { current = v; } };
}

test("capability remains closed even after checkboxes; recovery GET cannot start a run", async t => {
  const h = harness(t, { availability: async () => ({ consentVersion: "screen-analysis-v1", startAvailable: false, reason: "ANALYSIS_UNAVAILABLE" }) });
  await h.session.refresh(); await h.session.start(consent(), runId);
  assert.equal(h.session.state.canStart, false); assert.equal(h.calls.start, 0); assert.equal(h.records.size, 0);
});

test("both confirmations, the exact saved draft, and a current capability are required", async t => {
  const h = harness(t); await h.session.refresh();
  for (const value of [{ ...consent(), externalProcessing: false }, { ...consent(), nonSensitive: false },
    { ...consent(), base: { ...base, revision: 2 } }, { ...consent(), base: { ...base, document: { ...base.document, title: "stale" } } }]) {
    await h.session.start(value, runId);
  }
  assert.equal(h.calls.start, 0);
  h.session.updateBase({ ...base, persisted: false });
  await h.session.start(consent(), runId); assert.equal(h.calls.start, 0);
  h.session.updateBase({ ...base, revision: 0 });
  await h.session.start({ ...consent(), base: { ...base, revision: 0 } }, runId); assert.equal(h.calls.start, 0);
  h.session.updateBase(base); assert.equal(h.session.state.canStart, true);
});

test("the exact UUID is persisted before POST and a double click cannot submit again", async t => {
  let finish!: (value: AnalysisRunView) => void;
  let posts = 0;
  const h = harness(t, { start: async (_id, _base, _frames, sent) => {
    posts++; assert.deepEqual(JSON.parse(h.records.get(analysisRecoveryKey(base.guideId))!), sent);
    assert.deepEqual(Object.keys(sent).sort(), Object.keys(ticket).sort());
    return new Promise(resolve => { finish = resolve; });
  } });
  await h.session.refresh();
  const first = h.session.start(consent(), runId); await h.session.start(consent(), otherId);
  assert.equal(posts, 1); assert.equal(h.session.state.phase, "starting");
  finish(view()); await first; assert.equal(h.session.state.phase, "queued");
  assert.ok(!JSON.stringify([...h.records.values()]).includes(identity.editToken));
});

test("unavailable or dishonest browser storage prevents any POST", async t => {
  for (const fail of [true, false]) {
    const h = harness(t); await h.session.refresh();
    h.storage.setItem = () => { if (fail) throw new Error("private-storage-detail"); };
    await h.session.start(consent(), runId);
    assert.equal(h.calls.start, 0); assert.equal(h.session.state.phase, "error");
    assert.doesNotMatch(h.session.state.message!, /private-storage-detail/);
  }
});

test("lost POST then 404 retains the same UUID through reload and cannot create a new run", async t => {
  let posts = 0;
  const h = harness(t, { start: async () => { posts++; throw new ProcessorClientError("private", undefined, "REQUEST_TIMEOUT"); } });
  await h.session.refresh(); await h.session.start(consent(), runId);
  assert.equal(h.session.state.phase, "uncertain"); h.session.dispose();
  const restored = new AnalysisSession(identity, base, h.storage, () => {}, h.api); t.after(() => restored.dispose());
  await restored.refresh(); await restored.start(consent(), otherId);
  assert.equal(restored.state.phase, "uncertain"); assert.equal(posts, 1);
  assert.deepEqual(JSON.parse(h.records.get(analysisRecoveryKey(base.guideId))!), ticket);
  h.setRun(view("running")); await restored.refresh(); assert.equal(restored.state.phase, "running");
  h.setRun(view("succeeded")); await restored.refresh();
  assert.equal(restored.state.phase, "succeeded"); assert.equal(h.records.size, 0);
});

test("explicit unavailable rejects before admission and does not retain a phantom active task", async t => {
  const h = harness(t, { start: async () => { throw new ProcessorClientError("private", 503, "ANALYSIS_UNAVAILABLE"); } });
  await h.session.refresh(); await h.session.start(consent(), runId);
  assert.equal(h.records.size, 0); assert.equal(h.session.state.phase, "error"); assert.equal(h.session.state.canStart, false);
  assert.match(h.session.state.message!, /시작하지 않았/);
});

test("admission timeout and internal failure are not definitive rejections", async t => {
  for (const code of ["ANALYSIS_ADMISSION_TIMEOUT", "ANALYSIS_INTERNAL_ERROR", "INVALID_RESPONSE"]) {
    const h = harness(t, { start: async () => { throw new ProcessorClientError("private", 503, code); } });
    await h.session.refresh(); await h.session.start(consent(), runId);
    assert.equal(h.session.state.phase, "uncertain"); assert.equal(h.records.size, 1);
  }
});

test("corrupt, other-media and another-tab recovery records block new submissions without erasure", async t => {
  for (const raw of ["bad-json", JSON.stringify({ ...ticket, inputFingerprint: "b".repeat(64) }), JSON.stringify(ticket)]) {
    const h = harness(t); h.records.set(analysisRecoveryKey(base.guideId), raw);
    await h.session.refresh(); await h.session.start(consent(), otherId);
    assert.equal(h.calls.start, 0); assert.equal(h.records.get(analysisRecoveryKey(base.guideId)), raw);
  }
  const h = harness(t); await h.session.refresh();
  h.records.set(analysisRecoveryKey(base.guideId), JSON.stringify(ticket));
  await h.session.start(consent(), otherId); assert.equal(h.calls.start, 0);
});

test("cancellation is not complete until the server responds; a lost cancel is recoverable", async t => {
  let fail = true;
  const h = harness(t, { cancel: async () => { if (fail) throw new Error("private"); return view("cancelled"); } });
  h.setRun(view("running")); await h.session.refresh();
  await h.session.cancel(); assert.equal(h.session.state.phase, "uncertain");
  assert.match(h.session.state.message!, /취소 완료를 확인하지 못/);
  fail = false; await h.session.refresh(); await h.session.cancel();
  assert.equal(h.session.state.phase, "cancelled"); assert.equal(h.calls.start, 0);
});

test("a changed capability does not hide the cancellation of an already stored run", async t => {
  const h = harness(t, { availability: async () => { throw new Error("private"); } });
  h.setRun(view("running")); await h.session.refresh();
  assert.equal(h.session.state.run?.cancellable, true); assert.equal(h.session.state.canStart, false);
  await h.session.cancel(); assert.equal(h.session.state.phase, "cancelled");
});

test("polling is bounded, visibility pauses it, terminal status stops it, and no POST is automatic", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t); h.setRun(view("running")); await h.session.refresh();
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  h.session.setVisible(false); t.mock.timers.tick(ANALYSIS_POLL_MS * 5); await flush(); assert.equal(h.calls.latest, 1);
  h.session.setVisible(true);
  for (let i = 0; i < ANALYSIS_MAX_POLLS; i++) { t.mock.timers.tick(ANALYSIS_POLL_MS); await flush(); }
  assert.equal(h.calls.latest, 1 + ANALYSIS_MAX_POLLS); assert.equal(h.session.state.pollingPaused, true);
  t.mock.timers.tick(ANALYSIS_POLL_MS * 5); await flush(); assert.equal(h.calls.latest, 1 + ANALYSIS_MAX_POLLS);
  h.setRun(view("succeeded")); await h.session.refresh(); t.mock.timers.tick(ANALYSIS_POLL_MS * 5); await flush();
  assert.equal(h.calls.latest, 2 + ANALYSIS_MAX_POLLS); assert.equal(h.calls.start, 0); assert.equal(h.calls.cancel, 0);
});

test("disposing during a request ignores late results and preserves pending recovery", async t => {
  let finish!: (value: AnalysisRunView) => void;
  const h = harness(t, { start: async () => new Promise(resolve => { finish = resolve; }) });
  await h.session.refresh(); const starting = h.session.start(consent(), runId);
  h.session.dispose(); finish(view("succeeded")); await starting;
  assert.equal(h.records.size, 1); assert.notEqual(h.session.state.phase, "succeeded");
});

test("HTTP lifecycle uses owner header, exact media, one ID and no image/text body", async t => {
  const calls: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    calls.push(options); assert.equal(options.mode, "same-origin"); assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store"); assert.equal(options.referrerPolicy, "no-referrer");
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer synthetic-key");
    assert.equal(new Headers(options.headers).get("X-ShowMe-Input-Fingerprint"), base.inputFingerprint);
    return Response.json({ run: view() });
  });
  await requestAnalysis(identity, base, ["s0"], ticket);
  await readAnalysisRun(identity, base, ["s0"], runId);
  await cancelAnalysisRun(identity, base, ["s0"], runId);
  assert.deepEqual(calls.map(c => c.method), ["POST", "GET", "POST"]);
  assert.deepEqual(JSON.parse(calls[0].body as string), { runId, baseDraftRevision: 3, consentVersion: "screen-analysis-v1", externalProcessing: true });
  assert.equal(calls[1].body, undefined); assert.equal(calls[2].body, undefined);
});

test("foreign URLs, aborted operations, wrong run/revision and invalid capability fail closed", async t => {
  const mocked = t.mock.method(globalThis, "fetch", async () => Response.json({ run: view() }));
  const foreign = { ...identity, baseUrl: "https://foreign.example" };
  for (const call of [() => getAnalysisAvailability(foreign, base), () => requestAnalysis(foreign, base, ["s0"], ticket),
    () => readAnalysisRun(foreign, base, ["s0"], runId), () => cancelAnalysisRun(foreign, base, ["s0"], runId)]) await assert.rejects(call);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(requestAnalysis(identity, base, ["s0"], ticket, abort.signal));
  assert.equal(mocked.mock.callCount(), 0);
  await assert.rejects(readAnalysisRun(identity, base, ["s0"], otherId));
  await assert.rejects(getAnalysisAvailability(identity, base));
  mocked.mock.restore();
  t.mock.method(globalThis, "fetch", async () => Response.json({ run: { ...view(), baseDraftRevision: 99 } }));
  await assert.rejects(requestAnalysis(identity, base, ["s0"], ticket));
});

test("draft edits during processing never get overwritten by session results; errors hide raw contents", async t => {
  const h = harness(t); await h.session.refresh(); await h.session.start(consent(), runId);
  const edited = structuredClone(base); edited.revision++; edited.document.steps[0].instruction = "내 편집";
  h.session.updateBase(edited); h.setRun(view("succeeded")); await h.session.refresh();
  assert.equal(edited.document.steps[0].instruction, "내 편집"); assert.equal(base.document.steps[0].instruction, "기존 설명");
  for (const status of [400, 401, 404, 409, 429, 500, 503]) assert.doesNotMatch(analysisSessionFailure(new ProcessorClientError("private-token/provider-body", status)), /private-token|provider-body/);
});
