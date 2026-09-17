import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_INTENT, INTENT_LIMITS, readGuideIntent, titleForGuide, validateGuideIntent } from "./guide-intent.js";
import { parsePersistedActiveJob, saveJobIntent, type ActiveJob } from "./job-recovery.js";
import { recoverableCredentialKey } from "./processor-client.js";

const job: ActiveJob = {
  guideId: "synthetic-guide", editToken: "synthetic-test-credential", baseUrl: "http://127.0.0.1:1",
  phase: "processing", startedAt: 123, intent: { ...EMPTY_INTENT },
};

test("intent requires a nonblank goal, but audience and notes are optional", () => {
  assert.ok(validateGuideIntent({ ...EMPTY_INTENT, goal: " \n " }));
  assert.equal(validateGuideIntent({ ...EMPTY_INTENT, goal: "사진 보내기" }), null);
  for (const [key, limit] of Object.entries(INTENT_LIMITS)) {
    assert.ok(validateGuideIntent({ goal: "목적", audience: "", notes: "", [key]: "a".repeat(limit + 1) }));
  }
});

test("stored intent is normalized and bounded; malformed or legacy intent is empty", () => {
  for (const value of [null, undefined, [], 42, "hello", { goal: 4, notes: {} }]) {
    assert.deepEqual(readGuideIntent(value), EMPTY_INTENT);
  }
  assert.deepEqual(readGuideIntent({ goal: " 목적 ", audience: " 대상 ", notes: " 요청 " }), { goal: "목적", audience: "대상", notes: "요청" });
  assert.equal(readGuideIntent({ notes: "x".repeat(5000) }).notes.length, 1000);
});

test("real guide titles use intent then server filename title, never the banking example", () => {
  assert.equal(titleForGuide({ ...EMPTY_INTENT, goal: " 사진 보내기 " }, "file"), "사진 보내기");
  assert.equal(titleForGuide(EMPTY_INTENT, "synthetic scenes"), "synthetic scenes");
  assert.equal(titleForGuide(EMPTY_INTENT), "새 화면 안내서");
});

test("legacy recovery records keep their credentials and default to an empty intent", () => {
  const legacy = { ...job, intent: undefined, fileName: "synthetic.mp4" };
  const restored = parsePersistedActiveJob(JSON.stringify(legacy));
  assert.equal(restored?.editToken, job.editToken);
  assert.deepEqual(restored?.intent, EMPTY_INTENT);
  for (const malformed of [null, "null", "[]", "42", "{bad", "{}"])
    assert.equal(parsePersistedActiveJob(malformed), null);
});

test("intent survives refresh as part of its guide's recovery record, without changing job identity", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  values.set(recoverableCredentialKey("other-guide"), "unrelated");
  const intent = { goal: "사진 보내기", audience: "부모님", notes: "쉽게 설명" };
  const next = saveJobIntent(storage, job, "synthetic.mp4", intent);
  const restored = parsePersistedActiveJob(storage.getItem(recoverableCredentialKey(job.guideId)));
  assert.deepEqual(restored, { ...next, fileName: "synthetic.mp4", deletionMissingGraceUntil: undefined });
  assert.equal(next.editToken, job.editToken);
  assert.equal(next.phase, job.phase);
  assert.equal(next.startedAt, job.startedAt);
  assert.deepEqual(job.intent, EMPTY_INTENT);
  assert.equal(values.get(recoverableCredentialKey("other-guide")), "unrelated");
});

test("a failed intent save preserves the previous credential and does not report a new value", () => {
  const original = JSON.stringify({ ...job, fileName: "synthetic.mp4" });
  let stored = original;
  let writeCount = 0;
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { if (++writeCount === 1) throw new Error("quota"); stored = value; },
    removeItem: () => { throw new Error("must not remove existing record"); },
  };
  assert.throws(() => saveJobIntent(storage, job, "synthetic.mp4", { ...EMPTY_INTENT, goal: "new" }));
  assert.equal(stored, original);
  assert.deepEqual(job.intent, EMPTY_INTENT);
});
