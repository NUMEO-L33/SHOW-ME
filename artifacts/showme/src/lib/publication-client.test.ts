import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getPublicationStatus, publishGuide, unpublishGuide, publicationStatusSchema, publicationFailure, type PublicationStatus } from "./publication-client.js";
const identity = { baseUrl: "http://127.0.0.1:1", guideId: randomUUID(), editToken: "a".repeat(43) };
const publicationId = randomUUID();
const body = { publicationId, baseDraftRevision: 1, inputFingerprint: "a".repeat(64), reviewFingerprint: "b".repeat(64),
  publicSharing: true as const, originalSharingEnabled: false as const };
const queued: PublicationStatus = { state: "publishing", headVersion: 0, pendingJobId: publicationId, activePublicationId: null, publicPath: null,
  firstPublishedAt: null, expiresAt: null, canRequest: false, canWithdraw: true, job: { publicationId, status: "queued", baseDraftRevision: 1,
    errorCode: null, createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z" } };

test("publication client sends explicit confirmation and fixed identity only to the same-origin private API", async t => {
  const seen: Array<{ url: string; options: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options: RequestInit = {}) => {
    seen.push({ url: String(url), options }); return new Response(JSON.stringify({ publication: queued }), { status: 202 });
  });
  assert.deepEqual(await publishGuide(identity, body), queued);
  assert.deepEqual(await getPublicationStatus(identity, publicationId), queued);
  assert.equal(seen[0].url, `${identity.baseUrl}/api/guides/${identity.guideId}/publish`);
  assert.deepEqual(JSON.parse(seen[0].options.body as string), body); assert.equal(seen[0].options.redirect, "error");
  assert.equal(seen[0].options.mode, "same-origin"); assert.equal(seen[0].options.cache, "no-store");
  assert.equal(seen[0].options.referrerPolicy, "no-referrer");
  assert.equal((seen[0].options.headers as Record<string, string>).Authorization, `Bearer ${identity.editToken}`);
  assert.ok(!seen.some(s => s.url.includes(identity.editToken)));
});

test("unpublish uses both observed versions without silently rebasing after conflict", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++; assert.deepEqual(JSON.parse(options.body as string), { expectedHeadVersion: 1, expectedJobId: publicationId });
    return new Response(JSON.stringify({ code: "PUBLICATION_CONFLICT", error: identity.editToken }), { status: 409 });
  });
  try { await unpublishGuide(identity, { expectedHeadVersion: 1, expectedJobId: publicationId }); assert.fail(); }
  catch (error) { assert.ok(!String(error).includes(identity.editToken)); assert.match(publicationFailure(error), /최신 상태/); }
  assert.equal(calls, 1);
});

test("malformed, foreign, unsolicited key and wrong-job responses cannot become a share link", async t => {
  for (const changed of [{ ...queued, publicPath: "https://foreign.invalid/g/x" }, { ...queued, rawKey: "secret" },
    { ...queued, job: { ...queued.job!, publicationId: randomUUID() } }, { ...queued, state: "published" }]) {
    const mock = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ publication: changed })));
    await assert.rejects(getPublicationStatus(identity, publicationId), /게시 응답/); mock.mock.restore();
  }
  const published = { ...queued, pendingJobId: null, activePublicationId: publicationId, publicPath: `/g/${"A".repeat(32)}`, state: "published",
    headVersion: 1, firstPublishedAt: "2026-09-21T00:00:00.000Z", expiresAt: "2026-10-06T00:00:00.000Z" };
  assert.equal(publicationStatusSchema.safeParse(published).success, true);
  assert.equal(publicationStatusSchema.safeParse({ ...published, expiresAt: "2026-10-07T00:00:00.000Z" }).success, false);
});

test("invalid identities, unconfirmed public sharing and foreign destinations make no request", async t => {
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not send"); });
  assert.throws(() => publishGuide(identity, { ...body, publicSharing: false } as unknown as typeof body));
  assert.throws(() => getPublicationStatus(identity, "../private"));
  await assert.rejects(getPublicationStatus({ ...identity, guideId: "../private" }));
  await assert.rejects(publishGuide({ ...identity, baseUrl: "https://foreign.invalid" }, body));
  const abort = new AbortController(); abort.abort(); await assert.rejects(getPublicationStatus(identity, publicationId, abort.signal));
  assert.equal(calls, 0);
});

test("uncertain publication request is never retried or replaced by a new ID", async t => {
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("network unavailable"); });
  await assert.rejects(publishGuide(identity, body)); assert.equal(calls, 1);
  assert.match(publicationFailure(new Error()), /같은 요청/);
});
