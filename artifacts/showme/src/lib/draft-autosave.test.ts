import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DraftAutosave, type DraftAutosaveStatus } from "./draft-autosave.js";
import { type DraftSnapshot, type EditorDocument } from "./draft-client.js";
import { ProcessorClientError } from "./processor-client.js";

const initial: DraftSnapshot = {
  guideId: "synthetic", revision: 4, inputFingerprint: "a".repeat(64), persisted: true,
  updatedAt: "2026-09-17T00:00:00.000Z",
  document: { schemaVersion: 1, title: "처음 제목", intent: { goal: "처음 목적", audience: "", notes: "" },
    steps: [1, 2, 3].map(id => ({ id: String(id), activeFrameStepId: String(id), sourceStepIds: [String(id)],
      shortLabel: `${id}단계`, instruction: "샘플을 확인하세요.", elements: [], privacyReview: "pending" })) },
};
const edited = (title: string) => ({ ...structuredClone(initial.document), title });
const drain = async () => { await Promise.resolve(); await Promise.resolve(); };
function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const writes: { base: DraftSnapshot; document: EditorDocument; signal: AbortSignal;
    resolve: (saved: DraftSnapshot) => void; reject: (error: unknown) => void }[] = [];
  const saved: DraftSnapshot[] = [];
  const statuses: DraftAutosaveStatus[] = [];
  const autosave = new DraftAutosave({ initial, onSaved: value => saved.push(value), onStatus: value => statuses.push(value),
    write: (base, document, signal) => new Promise((resolve, reject) => writes.push({ base, document, signal, resolve, reject })),
  });
  t.after(() => autosave.dispose());
  const acknowledge = async (index: number) => {
    const write = writes[index];
    write.resolve({ ...write.base, revision: write.base.revision + 1, document: structuredClone(write.document),
      persisted: true, updatedAt: new Date().toISOString() });
    await drain();
  };
  return { autosave, writes, saved, statuses, acknowledge, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test("unchanged server drafts cause no writes; rapid typing saves once after a full quiet second", async t => {
  const h = harness(t);
  h.autosave.update(initial.document); h.tick(5_000);
  assert.equal(h.writes.length, 0);
  h.autosave.update(edited("수정")); h.tick(700);
  h.autosave.update(edited("수정 완료")); h.tick(999);
  assert.equal(h.writes.length, 0);
  h.tick(1); assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].document.title, "수정 완료");
  await h.acknowledge(0); h.tick(5_000);
  assert.equal(h.writes.length, 1);
  assert.equal(h.statuses.at(-1)?.saving, false);
});

test("identical renders do not postpone autosave, and caller mutation cannot change the queued document", t => {
  const h = harness(t);
  const document = edited("큐에 있는 제목");
  h.autosave.update(document); h.tick(500);
  h.autosave.update(structuredClone(document));
  document.title = "호출자가 뒤에서 수정";
  h.tick(500);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].document.title, "큐에 있는 제목");
});

test("typing and step removal during a delayed write stay queued and use its acknowledged revision", async t => {
  const h = harness(t);
  h.autosave.update(edited("먼저 저장")); h.tick(1_000);
  const latest = edited("더 새로운 제목");
  latest.steps = latest.steps.slice(1);
  latest.steps[0].instruction = "삭제 후 새로운 설명";
  latest.intent!.goal = "새 목적";
  h.autosave.update(latest); h.tick(2_000);
  assert.equal(h.writes.length, 1);
  await h.acknowledge(0); h.tick(0);
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].base.revision, 5);
  assert.deepEqual(h.writes[1].document, latest);
  await h.acknowledge(1);
  assert.deepEqual(h.saved.at(-1)?.document, latest);
});

test("a recent edit still receives a quiet second when the previous response arrives", async t => {
  const h = harness(t);
  h.autosave.update(edited("첫 요청")); h.tick(1_000);
  h.autosave.update(edited("후속 요청")); h.tick(200);
  await h.acknowledge(0); h.tick(799);
  assert.equal(h.writes.length, 1);
  h.tick(1); assert.equal(h.writes.length, 2);
});

test("reverting while a different write is in flight saves the reverted value after acknowledgement", async t => {
  const h = harness(t);
  h.autosave.update(edited("임시 변경")); h.tick(1_000);
  h.autosave.update(initial.document); h.tick(1_000);
  await h.acknowledge(0); h.tick(0);
  assert.deepEqual(h.writes[1].document, initial.document);
  assert.equal(h.writes[1].base.revision, 5);
});

test("failed or lost acknowledgements pause automatic writes; explicit retry replays the exact request first", async t => {
  const h = harness(t);
  h.autosave.update(edited("승인 응답 유실")); h.tick(1_000);
  h.autosave.update(edited("대기 중인 새 편집"));
  h.writes[0].reject(new TypeError("https://private.invalid/token=secret")); await drain();
  h.tick(60_000);
  h.autosave.update(edited("실패 후에도 보존할 편집")); h.tick(60_000);
  assert.equal(h.writes.length, 1);
  assert.equal(h.saved.length, 0);
  assert.doesNotMatch(JSON.stringify(h.statuses), /private.invalid|secret/);
  h.autosave.retry(); h.autosave.retry();
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.writes[1].base, h.writes[0].base);
  assert.deepEqual(h.writes[1].document, h.writes[0].document);
  await h.acknowledge(1); h.tick(0);
  assert.equal(h.writes[2].document.title, "실패 후에도 보존할 편집");
  assert.equal(h.writes[2].base.revision, 5);
});

test("conflict/access failures never auto-retry or adopt another tab's revision", async t => {
  const h = harness(t);
  h.autosave.update(edited("내 변경")); h.tick(1_000);
  h.writes[0].reject(new ProcessorClientError("private", 409)); await drain();
  h.autosave.update(edited("계속 편집")); h.tick(60_000);
  assert.equal(h.writes.length, 1);
  assert.equal(h.saved.length, 0);
  assert.match(h.statuses.at(-1)!.error!, /충돌/);
});

test("invalid intermediate input makes no request and resumes after the input is corrected", async t => {
  const h = harness(t);
  h.autosave.update(null, "제목을 입력하세요."); h.tick(1_000);
  assert.equal(h.writes.length, 0);
  assert.equal(h.statuses.at(-1)?.error, "제목을 입력하세요.");
  h.autosave.update(edited("유효한 제목")); h.tick(1_000);
  assert.equal(h.writes.length, 1);
  await h.acknowledge(0);
  assert.equal(h.statuses.at(-1)?.error, null);
});

test("IME composition and explicit loading suspend sends until a full quiet second after resume", t => {
  const h = harness(t);
  h.autosave.update(edited("ㅎ")); h.tick(400);
  h.autosave.suspend(true); h.autosave.update(edited("한글")); h.tick(10_000);
  h.autosave.retry(); assert.equal(h.writes.length, 0);
  h.autosave.suspend(false); h.tick(999); assert.equal(h.writes.length, 0);
  h.tick(1); assert.equal(h.writes[0].document.title, "한글");
});

test("failed explicit reload leaves edits paused until the user retries", t => {
  const h = harness(t);
  h.autosave.update(edited("유지할 입력"));
  h.autosave.pause(new Error("private"));
  h.autosave.suspend(false); h.autosave.update(edited("계속 유지할 입력")); h.tick(10_000);
  assert.equal(h.writes.length, 0);
  h.autosave.retry(); assert.equal(h.writes[0].document.title, "계속 유지할 입력");
});

test("deletion/unmount cancels pending timers and aborts in-flight writes, ignoring late completion", async t => {
  const h = harness(t);
  h.autosave.update(edited("진행 중")); h.tick(1_000);
  h.autosave.update(edited("예약됨"));
  const statusesBefore = h.statuses.length;
  h.autosave.dispose(); assert.equal(h.writes[0].signal.aborted, true);
  await h.acknowledge(0); h.tick(10_000); h.autosave.retry();
  assert.equal(h.writes.length, 1); assert.equal(h.saved.length, 0);
  assert.equal(h.statuses.length, statusesBefore);
});

test("unmount before the debounce expires performs no write", t => {
  const h = harness(t);
  h.autosave.update(edited("전송하지 않음")); h.tick(999);
  h.autosave.dispose(); h.tick(10_000);
  assert.equal(h.writes.length, 0);
});
