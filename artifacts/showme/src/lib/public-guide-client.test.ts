import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getPublicGuide, getPublicFrame, parsePublicGuide, publicGuideFailure } from "./public-guide-client.js";
import { boundedRequest, boundedPublicRequest, ProcessorClientError } from "./processor-client.js";
const origin = "http://127.0.0.1:1", slug = "a".repeat(32), id = randomUUID();
const prefix = `/api/public/guides/${slug}/assets/${id}/step-1`;
const guide = { publicationId: id, title: "공개 합성 안내", publishedAt: "2026-09-22T00:00:00.000Z", expiresAt: "2026-10-07T00:00:00.000Z",
  originalSharingEnabled: false as const, steps: [{ id: "step-1", shortLabel: "첫 단계", instruction: "합성 버튼을 누르세요", taps: [], width: 640, height: 360,
    frameUrl: `${prefix}/frame`, thumbnailUrl: `${prefix}/thumbnail` }] };

test("public reads use same origin, no-store and redirect rejection without an editor credential", async t => {
  const seen: RequestInit[] = []; t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    seen.push(options); return Response.json({ guide });
  });
  assert.deepEqual(await getPublicGuide(origin, slug), guide);
  assert.equal(seen[0].method, "GET"); assert.equal(seen[0].headers, undefined);
  assert.equal(seen[0].cache, "no-store"); assert.equal(seen[0].redirect, "error"); assert.equal(seen[0].referrerPolicy, "no-referrer");
});
test("public transport cannot widen private credential paths or reach foreign or unrelated destinations", async t => {
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ guide }); });
  await assert.rejects(boundedRequest(`${origin}/api/public/guides/${slug}`, { headers: { Authorization: "secret" } }, async r => r));
  for (const url of [`${origin}/api/guides/${id}`, `${origin}/api/public/guides/${slug}?token=secret`, `https://foreign.invalid/api/public/guides/${slug}`])
    await assert.rejects(boundedPublicRequest(url, undefined, async r => r));
  assert.throws(() => getPublicGuide(origin, "../private")); assert.equal(calls, 0);
});
test("only exact snapshot image paths and allowlisted fields pass; original, query and older snapshot paths fail", () => {
  assert.deepEqual(parsePublicGuide({ guide }, slug), guide);
  for (const modified of [{ ...guide, editToken: "private" }, { ...guide, originalSharingEnabled: true }, { ...guide, steps: [] },
    ...["https://foreign.invalid/frame", `${prefix}/frame?asset_token=x`, `/api/guides/${id}/assets/private/frame`, `${prefix.replace(id, randomUUID())}/frame`]
      .map(frameUrl => ({ ...guide, steps: [{ ...guide.steps[0], frameUrl }] }))]) assert.throws(() => parsePublicGuide({ guide: modified }, slug));
  assert.throws(() => parsePublicGuide({ guide: { ...guide, steps: [{ ...guide.steps[0], id: "private-id" }] } }, slug));
});
test("image fetch accepts bounded PNG only and never fetches a thumbnail or original as fallback", async t => {
  let calls = 0; const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const mock = t.mock.method(globalThis, "fetch", async (url: unknown) => { calls++; assert.equal(String(url), `${origin}${prefix}/frame`);
    return new Response(signature, { headers: { "Content-Type": "image/png" } }); });
  assert.equal((await getPublicFrame(origin, slug, guide, 0)).type, "image/png"); mock.mock.restore();
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("not png", { headers: { "Content-Type": "image/png" } }); });
  await assert.rejects(getPublicFrame(origin, slug, guide, 0)); assert.equal(calls, 2);
  assert.throws(() => getPublicFrame(origin, slug, guide, 1));
});
test("oversized metadata and images, withdrawn links and cancelled requests are rejected without retry", async t => {
  let calls = 0;
  const mock = t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("x", { headers: { "Content-Length": "99999999" } }); });
  await assert.rejects(getPublicGuide(origin, slug)); await assert.rejects(getPublicFrame(origin, slug, guide, 0)); mock.mock.restore();
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ error: "private inner" }, { status: 404 }); });
  await assert.rejects(getPublicGuide(origin, slug), error => { assert.match(publicGuideFailure(error), /중지/); assert.ok(!String(error).includes("private inner")); return true; });
  const abort = new AbortController(); abort.abort(); await assert.rejects(getPublicGuide(origin, slug, abort.signal)); assert.equal(calls, 3);
  assert.match(publicGuideFailure(new ProcessorClientError("raw", 503)), /다시/);
});
