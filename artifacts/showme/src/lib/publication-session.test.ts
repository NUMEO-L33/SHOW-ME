import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PublicationSession, canPublishSnapshot } from "./publication-session.js";
import type { DraftSnapshot } from "./draft-client.js";
import type { PrivacyReview } from "./privacy-review.js";
import type { PublicationStatus } from "./publication-client.js";

const identity = { baseUrl: "http://127.0.0.1:1", guideId: randomUUID(), editToken: "a".repeat(43) };
const hash = "a".repeat(64), time = "2026-09-22T00:00:00.000Z";
const base: DraftSnapshot = { guideId: identity.guideId, revision: 1, inputFingerprint: hash, persisted: true, updatedAt: time,
  document: { schemaVersion: 1, title: "합성 제목", steps: [{ id: "s", activeFrameStepId: "f", sourceStepIds: ["f"], shortLabel: "합성 단계",
    instruction: "합성 설명", elements: [], privacyReview: "pending" }] } };
const review: PrivacyReview = { guideId: identity.guideId, revision: 1, inputFingerprint: hash, fingerprint: hash,
  titleFingerprint: hash, titleConfirmed: true, complete: true, publicationEnabled: false, steps: [{ stepId: "s", frameStepId: "f",
    sourceFingerprint: hash, imageFingerprint: hash, textFingerprint: hash, imageConfirmed: true, textConfirmed: true, candidates: [] }] };
const ready: PublicationStatus = { state: "unpublished", headVersion: 0, pendingJobId: null, activePublicationId: null, publicPath: null,
  firstPublishedAt: null, expiresAt: null, canRequest: true, canWithdraw: false, job: null };
function queued(id: string): PublicationStatus { return { ...ready, state: "publishing", pendingJobId: id, canRequest: false, canWithdraw: true,
  job: { publicationId: id, status: "queued", baseDraftRevision: 1, errorCode: null, createdAt: time, updatedAt: time } }; }
function journal() { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } }; }
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };

test("publish eligibility requires the exact persisted and fully reviewed draft; editing and partial confirmation block it", () => {
  assert.equal(canPublishSnapshot(base, review, false), true);
  for (const [b, r, blocked] of [[base, review, true], [{ ...base, persisted: false }, review, false], [base, null, false],
    [base, { ...review, revision: 2 }, false], [base, { ...review, complete: false }, false],
    [base, { ...review, steps: [{ ...review.steps[0], frameStepId: "foreign" }] }, false]] as Array<[DraftSnapshot, PrivacyReview | null, boolean]>)
    assert.equal(canPublishSnapshot(b, r, blocked), false);
});
test("no publication without explicit consent, saved state, or available server admission", async t => {
  let writes = 0; t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    if (options.method === "POST") writes++; return Response.json({ publication: ready });
  });
  const session = new PublicationSession(identity, journal()); await session.refresh();
  await session.publish(base, review, false, false); await session.publish(base, review, true, true);
  await session.publish({ ...base, guideId: randomUUID() }, review, false, true);
  assert.equal(writes, 0); session.dispose();
});
test("request ID is persisted before POST and a rapid double click sends once", async t => {
  const storage = journal(), pending = gate(); let writes = 0, id = "";
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    if (options.method !== "POST") return Response.json({ publication: ready });
    writes++; const body = JSON.parse(options.body as string); id = body.publicationId;
    assert.equal([...storage.data.values()][0], id); assert.equal(body.originalSharingEnabled, false); assert.equal(body.reviewFingerprint, hash);
    await pending.promise; return Response.json({ publication: queued(id) });
  });
  const session = new PublicationSession(identity, storage); await session.refresh();
  const a = session.publish(base, review, false, true), b = session.publish(base, review, false, true);
  pending.release(); await Promise.all([a, b]); assert.equal(writes, 1); assert.equal(session.state.status?.pendingJobId, id);
  assert.equal(session.newRequestBlocked, true); session.dispose();
});
test("lost POST followed by 404 keeps the same ID across reload without another mutation", async t => {
  const storage = journal(); let writes = 0, target = "";
  const mock = t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    if (options.method === "POST") { writes++; throw new Error("private raw error"); }
    return Response.json({ publication: ready });
  });
  const first = new PublicationSession(identity, storage); await first.refresh(); await first.publish(base, review, false, true); first.dispose(); mock.mock.restore();
  const id = [...storage.data.values()][0];
  t.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    target = String(url); if (options.method === "POST") writes++; return Response.json({}, { status: 404 });
  });
  const second = new PublicationSession(identity, storage); await second.refresh(); await second.publish(base, review, false, true);
  assert.ok(target.endsWith(`/publications/${id}`)); assert.equal(writes, 1); assert.equal(storage.data.size, 1);
  assert.equal(second.state.unresolved, true); assert.ok(!second.state.error.includes("private raw")); second.dispose();
});
test("unavailable, dishonest or occupied recovery storage prevents a new POST", async t => {
  let writes = 0; t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    if (options.method === "POST") writes++; return Response.json({ publication: ready });
  });
  for (const storage of [{ getItem() { throw new Error(); }, setItem() {}, removeItem() {} },
    { getItem() { return null; }, setItem() {}, removeItem() {} }, journal()]) {
    const s = new PublicationSession(identity, storage); await s.refresh();
    if ("data" in storage) storage.data.set(`showme:publication-request:${identity.guideId}`, randomUUID());
    await s.publish(base, review, false, true); s.dispose();
  }
  assert.equal(writes, 0);
});
test("terminal recovery releases only its own ID, while withdrawal conflicts never rebase silently", async t => {
  const storage = journal(), id = randomUUID(); storage.setItem(`showme:publication-request:${identity.guideId}`, id);
  const finished: PublicationStatus = { ...ready, job: { ...queued(id).job!, status: "cancelled" } };
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ publication: finished }));
  const s = new PublicationSession(identity, storage); await s.refresh(); assert.equal(storage.data.size, 0); assert.equal(s.newRequestBlocked, false);
  mock.mock.restore(); let posts = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    if (options.method !== "POST") return Response.json({ publication: queued(id) });
    posts++; assert.deepEqual(JSON.parse(options.body as string), { expectedHeadVersion: 0, expectedJobId: id });
    return Response.json({}, { status: 409 });
  });
  await s.refresh(); await s.withdraw(); await s.withdraw(); assert.equal(posts, 1); assert.match(s.state.error, /최신 상태/); s.dispose();
});
test("dispose during a POST ignores late completion and preserves recovery evidence", async t => {
  const storage = journal(), pending = gate(); let id = "";
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    if (options.method !== "POST") return Response.json({ publication: ready });
    id = JSON.parse(options.body as string).publicationId; await pending.promise; return Response.json({ publication: queued(id) });
  });
  const s = new PublicationSession(identity, storage); await s.refresh(); const action = s.publish(base, review, false, true);
  s.dispose(); pending.release(); await action; assert.equal([...storage.data.values()][0], id); assert.equal(s.state.status?.state, "unpublished");
});
