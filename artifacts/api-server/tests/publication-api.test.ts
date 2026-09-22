import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import express from "express";
import request from "supertest";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { publicationPreparationFixture } from "./helpers/publication-preparation-fixture.js";
import { attemptFrameObjectKey, DELETION_PENDING } from "../src/processor/asset-lifecycle.js";
import { preparePublicationAssets } from "../src/processor/publication-preparation.js";
import { privacyAfterEdit } from "../src/processor/privacy-review.js";
import { createProcessorApp } from "../src/processor/server.js";
import { loadConfig } from "../src/processor/config.js";
import { createPublicationRouter, type PublicationAdmission } from "../src/processor/publication-api.js";
import { createPublicPublicationRouter } from "../src/processor/publication-public-api.js";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t: TestContext) {
  const token = randomBytes(32).toString("base64url"), h = await createAnalysisHarness(t, 1, { guideId: randomUUID(), editToken: token });
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map((s, index) => ({ ...s, id: `${h.guideId}-private-step-${index}`,
    representativeFrameKey: attemptFrameObjectKey(h.guideId, 1, 1, "frame") })));
  const guide = (await h.repository.getGuideById(h.guideId))!, f = await publicationPreparationFixture(h.repository, guide, h.root);
  let enabled = true, calls = 0;
  const admission: PublicationAdmission = { isAccepting: () => enabled, async request(id, command, signal) {
    calls++; signal.throwIfAborted(); return h.repository.executePublicationCommand(id, command);
  } };
  const config = loadConfig({ NODE_ENV: "test", DATA_DIR: h.root, SHOWME_STORAGE: "local" });
  const app = (withAdmission = false) => createProcessorApp({ config, repository: h.repository, storage: f.storage,
    ...(withAdmission ? { publicationAdmission: admission } : {}),
    pipeline: { async process() { assert.fail("no media processing"); }, async processClaimed() { assert.fail("no media processing"); } } });
  const body = { publicationId: f.job.id, baseDraftRevision: f.request.revision, inputFingerprint: f.request.inputFingerprint,
    reviewFingerprint: f.request.reviewFingerprint, originalSharingEnabled: false, publicSharing: true };
  const publish = async (job = f.job, real = false) => {
    const ready = await preparePublicationAssets({ ...f.options, jobId: job.id, expectedVersion: job.version, render: real ? undefined : f.fastRender });
    return (await h.repository.commitPublication(h.guideId, { id: ready.id, leaseId: ready.leaseId!, expectedVersion: ready.version }))!;
  };
  const url = `/api/guides/${h.guideId}`, auth = `Bearer ${token}`;
  const cancel = () => h.repository.executePublicationCommand(h.guideId, { type: "cancel", id: f.job.id });
  return { ...h, ...f, guide, token, auth, body, url, app, publish, cancel, admission, calls: () => calls, stop: () => { enabled = false; } };
}

test("owner status is authenticated and read-only; default server refuses new publication without changing state", async t => {
  const h = await fixture(t), app = h.app(), before = await readFile(h.repository.filePath);
  const status = await request(app).get(`${h.url}/publications`).set("Authorization", h.auth).expect(200).expect("Cache-Control", "no-store");
  assert.equal(status.body.publication.canRequest, false); assert.equal(status.body.publication.job.publicationId, h.job.id);
  assert.equal(status.body.publication.publicPath, null);
  await request(app).post(`${h.url}/publish`).set("Authorization", h.auth).send({ ...h.body, publicationId: randomUUID() }).expect(503);
  for (const auth of ["", `Bearer ${randomBytes(32).toString("base64url")}`]) {
    await request(app).get(`${h.url}/publications`).set("Authorization", auth).expect(404);
    await request(app).get(`${h.url}/publications/${h.job.id}?editToken=${h.token}`).set("Authorization", auth).expect(404);
    await request(app).post(`${h.url}/publish`).set("Authorization", auth).send(h.body).expect(404);
    await request(app).post(`${h.url}/unpublish`).set("Authorization", auth).send({ expectedHeadVersion: 0, expectedJobId: h.job.id }).expect(404);
  }
  assert.deepEqual(await readFile(h.repository.filePath), before); assert.equal(h.calls(), 0);
  for (const secret of [h.token, h.guide.originalObjectKey, h.guide.sourceFilename, h.job.batchId, h.job.contentFingerprint, "leaseId", "contentFingerprint"])
    assert.ok(!status.text.includes(secret));
});

test("explicit confirmed publish admits one durable request, exposes assets only after atomic commit, and recovers by request ID", async t => {
  const h = await fixture(t); await h.cancel(); const app = h.app(true), body = { ...h.body, publicationId: randomUUID() };
  const response = await request(app).post(`${h.url}/publish`).set("Authorization", h.auth).send(body).expect(202);
  assert.equal(response.body.publication.state, "publishing"); assert.equal(response.body.publication.publicPath, null);
  assert.equal(h.calls(), 1);
  const job = (await h.repository.getPublicationJob(h.guideId, body.publicationId))!;
  const before = await readFile(h.repository.filePath); h.stop();
  await request(app).post(`${h.url}/publish`).set("Authorization", h.auth).send(body).expect(202);
  assert.deepEqual(await readFile(h.repository.filePath), before); assert.equal(h.calls(), 1);
  const published = await h.publish(job);
  const lookup = await request(app).get(`${h.url}/publications/${body.publicationId}`).set("Authorization", h.auth).expect(200);
  assert.equal(lookup.body.publication.job.status, "succeeded"); assert.equal(lookup.body.publication.publicPath, `/g/${published.head.publicSlug}`);
  const replay = await request(app).post(`${h.url}/publish`).set("Authorization", h.auth).send(body).expect(200);
  assert.equal(replay.body.publication.headVersion, 1); assert.equal(h.calls(), 1);
});

test("lost admission acknowledgement recovers stored request even when execution is unavailable", async t => {
  const h = await fixture(t); await h.cancel(); const app = h.app(true), body = { ...h.body, publicationId: randomUUID() };
  t.mock.method(h.admission, "request", async (guideId: string, command: Parameters<PublicationAdmission["request"]>[1]) => { await h.repository.executePublicationCommand(guideId, command); throw new Error(h.token); });
  const failed = await request(app).post(`${h.url}/publish`).set("Authorization", h.auth).send(body).expect(503);
  assert.ok(!failed.text.includes(h.token)); h.stop();
  const replay = await request(app).post(`${h.url}/publish`).set("Authorization", h.auth).send(body).expect(202);
  assert.equal(replay.body.publication.job.publicationId, body.publicationId);
});

test("publish rejects altered replays, unconfirmed sharing, original sharing, malformed and oversized bodies", async t => {
  const h = await fixture(t), app = h.app(true), before = await readFile(h.repository.filePath);
  for (const change of [{ baseDraftRevision: h.body.baseDraftRevision + 1 }, { inputFingerprint: "0".repeat(64) }, { reviewFingerprint: "0".repeat(64) }])
    await request(app).post(`${h.url}/publish`).set("Authorization", h.auth).send({ ...h.body, ...change }).expect(409);
  for (const body of [{ ...h.body, publicSharing: false }, { ...h.body, publicSharing: undefined }, { ...h.body, publicationId: "../x" },
    { ...h.body, rawObjectKey: h.guide.originalObjectKey }, { ...h.body, type: "claim" }])
    await request(app).post(`${h.url}/publish`).set("Authorization", h.auth).send(body).expect(400);
  await request(app).post(`${h.url}/publish`).set("Authorization", h.auth).send({ ...h.body, originalSharingEnabled: true }).expect(409);
  await request(app).post(`${h.url}/publish`).set("Authorization", h.auth).set("Content-Type", "text/plain").send("x").expect(415);
  await request(app).post(`${h.url}/publish`).set("Authorization", h.auth).set("Content-Type", "application/json").send("{").expect(400);
  await request(app).post(`${h.url}/publish`).set("Authorization", h.auth).send({ ...h.body, text: "x".repeat(5000) }).expect(413);
  await request(app).get(`${h.url}/publications?key=x`).set("Authorization", h.auth).expect(400);
  await request(app).post(`${h.url}/unpublish`).set("Authorization", h.auth).send({ type: "expire", expectedHeadVersion: 0, expectedJobId: h.job.id }).expect(400);
  assert.deepEqual(await readFile(h.repository.filePath), before);
});

test("a changed reviewed draft cannot be admitted with stale approval", async t => {
  const h = await fixture(t); await h.cancel();
  const document = { ...h.state.draft!.document, title: "private changed title" };
  document.privacy = privacyAfterEdit(h.state.draft!.document, document);
  await h.repository.executeAnalysisCommand(h.guideId, { type: "save-editor-draft", expectedRevision: h.state.draft!.revision,
    expectedInputFingerprint: h.manifest.fingerprint, document });
  const before = await readFile(h.repository.filePath);
  await request(h.app(true)).post(`${h.url}/publish`).set("Authorization", h.auth).send({ ...h.body, publicationId: randomUUID() }).expect(409);
  assert.deepEqual(await readFile(h.repository.filePath), before);
});

test("public DTO and real PNG contain only the current processed publication, never raw metadata or edit authority", async t => {
  const h = await fixture(t), app = h.app();
  await request(app).get(`/api/public/guides/${h.guide.slug}`).expect(404);
  const p = await h.publish(h.job, true), url = `/api/public/guides/${p.head.publicSlug}`;
  const response = await request(app).get(url).set("If-None-Match", "*").expect(200).expect("Cache-Control", "no-store")
    .expect("Referrer-Policy", "no-referrer").expect("X-Content-Type-Options", "nosniff").expect("X-Robots-Tag", /noindex/);
  assert.equal(response.headers.etag, undefined);
  assert.equal(response.body.guide.steps[0].id, "step-1");
  assert.deepEqual(Object.keys(response.body.guide).sort(), ["publicationId", "title", "publishedAt", "expiresAt", "originalSharingEnabled", "steps"].sort());
  for (const secret of [h.guideId, h.token, h.guide.originalObjectKey, h.guide.sourceFilename, h.job.batchId, "sourceKey", "inputFingerprint", "reviewFingerprint", "leaseId"])
    assert.ok(!response.text.includes(secret));
  for (const path of [response.body.guide.steps[0].frameUrl, response.body.guide.steps[0].thumbnailUrl]) {
    const image = await request(app).get(path).set("If-None-Match", "*").expect(200).expect("Content-Type", /image\/png/).expect("Cache-Control", "no-store");
    assert.equal(image.headers.etag, undefined); assert.ok(Buffer.isBuffer(image.body)); assert.ok(!image.body.equals(h.source));
    await request(app).head(path).expect(200); await request(app).get(`${path}?key=x`).expect(404);
    await request(app).get(path).set("Range", "bytes=0-10").expect(404);
  }
  await request(app).get(`${url}?editToken=${h.token}`).expect(404);
  const frame = response.body.guide.steps[0].frameUrl as string;
  for (const invalid of [h.guide.steps[0].id, "step-0", "step-01", "step-2", "step-1000"])
    await request(app).get(frame.replace("/step-1/", `/${invalid}/`)).expect(404);
});

test("unpublish removes public authority immediately, keeps deletion asynchronous, and old commands cannot revoke new work", async t => {
  const h = await fixture(t), p = await h.publish(), app = h.app(true), publicUrl = `/api/public/guides/${p.head.publicSlug}`;
  const view = await request(app).get(publicUrl).expect(200), image = view.body.guide.steps[0].frameUrl;
  const body = { expectedHeadVersion: 1, expectedJobId: null };
  await request(app).post(`${h.url}/unpublish`).set("Authorization", h.auth).send(body).expect(200);
  await request(app).get(publicUrl).expect(404); await request(app).get(image).set("If-Modified-Since", new Date().toUTCString()).expect(404);
  const retained = await h.storage.openRead(p.publication.images[0].frame.key); retained.destroy();
  const replacement = { ...h.body, publicationId: randomUUID() };
  await request(app).post(`${h.url}/publish`).set("Authorization", h.auth).send(replacement).expect(202);
  await request(app).post(`${h.url}/unpublish`).set("Authorization", h.auth).send(body).expect(409);
  assert.equal((await h.repository.getPublicationJob(h.guideId, replacement.publicationId))!.status, "queued");
});

test("republish keeps the URL and deadline but rejects every previous publication image ID", async t => {
  const h = await fixture(t), first = await h.publish(), app = h.app(true), publicUrl = `/api/public/guides/${first.head.publicSlug}`;
  const before = await request(app).get(publicUrl).expect(200), oldImage = before.body.guide.steps[0].frameUrl;
  const body = { ...h.body, publicationId: randomUUID() };
  await request(app).post(`${h.url}/publish`).set("Authorization", h.auth).send(body).expect(202);
  const second = await h.publish((await h.repository.getPublicationJob(h.guideId, body.publicationId))!);
  assert.equal(second.head.expiresAt, first.head.expiresAt);
  await request(app).get(oldImage).expect(404);
  const after = await request(app).get(publicUrl).expect(200);
  assert.equal(after.body.guide.publicationId, second.publication.id); await request(app).get(after.body.guide.steps[0].frameUrl).expect(200);
});

test("private expiry keeps public viewing and withdrawal; exact publication expiry denies GET and HEAD before cleanup", async t => {
  const h = await fixture(t), p = await h.publish(), app = h.app(), publicUrl = `/api/public/guides/${p.head.publicSlug}`;
  const guide = (await h.repository.getGuideById(h.guideId))!;
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(guide.updatedAt) + 7 * 86400_000 });
  assert.ok(await h.repository.expirePrivateDraft(h.guideId, { expectedUpdatedAt: guide.updatedAt, updatedBefore: guide.updatedAt }));
  const view = await request(app).get(publicUrl).expect(200), image = view.body.guide.steps[0].frameUrl;
  const owner = await request(app).get(`${h.url}/publications`).set("Authorization", h.auth).expect(200);
  assert.equal(owner.body.publication.canRequest, false); assert.equal(owner.body.publication.canWithdraw, true);
  t.mock.timers.setTime(Date.parse(p.head.expiresAt));
  await request(app).get(publicUrl).expect(404); await request(app).get(image).expect(404); await request(app).head(image).expect(404);
  const expired = await request(app).get(`${h.url}/publications`).set("Authorization", h.auth).expect(200);
  assert.equal(expired.body.publication.state, "expired"); assert.equal(expired.body.publication.publicPath, null);
  await request(app).post(`${h.url}/unpublish`).set("Authorization", h.auth).send({ expectedHeadVersion: 1, expectedJobId: null }).expect(200);
});

for (const phase of ["open", "read"] as const)
test(`withdrawal during storage ${phase} sends zero processed or original image bytes`, async t => {
  const h = await fixture(t), p = await h.publish(), app = h.app(), publicUrl = `/api/public/guides/${p.head.publicSlug}`;
  const view = await request(app).get(publicUrl).expect(200), open = h.storage.openRead.bind(h.storage);
  t.mock.method(h.storage, "openRead", async (key: string) => {
    const original = await open(key);
    const stop = () => h.repository.stopPublication(h.guideId, { type: "withdraw", expectedHeadVersion: 1, expectedJobId: null });
    if (phase === "open") { await stop(); return original; }
    return Readable.from((async function* () { for await (const chunk of original) { yield chunk; await stop(); } })());
  });
  const denied = await request(app).get(view.body.guide.steps[0].frameUrl).expect(404);
  assert.match(denied.headers["content-type"], /json/); assert.ok(!denied.text.includes("source"));
});

test("wrong, truncated, excessive, and failing stored bytes are never served or replaced with source pixels", async t => {
  const h = await fixture(t), p = await h.publish(), app = h.app();
  const view = await request(app).get(`/api/public/guides/${p.head.publicSlug}`).expect(200);
  for (const variant of ["wrong", "short", "long", "failure"] as const) {
    const mock = t.mock.method(h.storage, "openRead", async (key: string) => {
      assert.equal(key, p.publication.images[0].frame.key);
      if (variant === "failure") throw new Error(`private ${h.token}`);
      return Readable.from([Buffer.alloc(variant === "long" ? p.publication.images[0].frame.size + 1 : variant === "short" ? 1 : p.publication.images[0].frame.size)]);
    });
    const response = await request(app).get(view.body.guide.steps[0].frameUrl).expect(503);
    assert.match(response.headers["content-type"], /json/); assert.ok(!response.text.includes(h.token)); assert.equal(mock.mock.callCount(), 1); mock.mock.restore();
  }
});

test("timed out storage retains bounded slots, destroys late streams, and can recover without new authority", { timeout: 15_000 }, async t => {
  const h = await fixture(t), p = await h.publish(), app = express();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  app.use("/api/public/guides", createPublicPublicationRouter({ repository: h.repository, storage: h.storage, timeoutMs: 30 }));
  const view = await request(app).get(`/api/public/guides/${p.head.publicSlug}`).expect(200), path = view.body.guide.steps[0].frameUrl;
  const gate = deferred<void>(), opened = deferred<void>(), streams: Readable[] = [];
  let opening = 0;
  t.after(() => gate.resolve());
  const mock = t.mock.method(h.storage, "openRead", async () => {
    if (++opening === 4) opened.resolve();
    await gate.promise; const stream = Readable.from([Buffer.from("late")]); streams.push(stream); return stream;
  });
  const pending = Array.from({ length: 4 }, () => request(app).get(path).expect(503).then(response => response));
  // Expire only after all four reads entered storage, not after an assumed
  // 30 ms of JSON repository/OS scheduling on a resource-constrained host.
  await opened.promise; t.mock.timers.tick(31); await Promise.all(pending);
  assert.equal(mock.mock.callCount(), 4);
  await request(app).get(path).expect(503); assert.equal(mock.mock.callCount(), 4);
  gate.resolve(); for (let n = 0; n < 50 && streams.length < 4; n++) await delay(5);
  await delay(5); assert.equal(streams.length, 4); assert.ok(streams.every(s => s.destroyed)); mock.mock.restore();
  await request(app).get(path).expect(200);
});

test("owner API bounds non-cooperative admission and later resolves the same durable identity", async t => {
  const h = await fixture(t); await h.cancel(); const gate = deferred<void>(), accepted = deferred<void>();
  const app = express(), body = { ...h.body, publicationId: randomUUID() };
  t.after(() => gate.resolve());
  // Trigger the deadline only AFTER the durable write, not after an assumed
  // 30 ms of filesystem scheduling on a loaded machine.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  app.use(h.url, createPublicationRouter({ repository: h.repository, timeoutMs: 30,
    authenticate: async () => (await h.repository.getGuideById(h.guideId))!,
    admission: { isAccepting: () => true, async request(id, command) { await h.repository.executePublicationCommand(id, command); accepted.resolve(); await gate.promise; return h.repository.getPublicationJob(id, command.id); } } }));
  const pending = request(app).post(`${h.url}/publish`).send(body).expect(503).then(response => response);
  await accepted.promise; t.mock.timers.tick(31); await pending;
  gate.resolve();
  const recovered = await request(app).get(`${h.url}/publications/${body.publicationId}`).expect(200);
  assert.equal(recovered.body.publication.job.publicationId, body.publicationId);
});

test("deletion after status lookup prevents a stale owner response and public errors never leak storage details", async t => {
  const h = await fixture(t), app = h.app(), get = h.repository.getPublicationOwnerStatus.bind(h.repository);
  t.mock.method(h.repository, "getPublicationOwnerStatus", async (...args: Parameters<typeof get>) => {
    const value = await get(...args); await h.repository.updateStatus(h.guideId, "failed", { errorCode: DELETION_PENDING }); return value;
  });
  await request(app).get(`${h.url}/publications`).set("Authorization", h.auth).expect(404);
  t.mock.method(h.repository, "getAccessiblePublication", async () => { throw new Error(h.token); });
  const response = await request(app).get(`/api/public/guides/${"A".repeat(32)}`).expect(503);
  assert.ok(!response.text.includes(h.token));
});

test("HTTP throttling is separate for mutation and lookup and makes no excess admission", async t => {
  const h = await fixture(t), app = h.app(), post = () => request(app).post(`${h.url}/publish`).set("Authorization", h.auth).send(h.body);
  for (let i = 0; i < 20; i++) await post().expect(202);
  await post().expect(429).expect("Cache-Control", "no-store");
  await request(app).get(`${h.url}/publications`).set("Authorization", h.auth).expect(200); assert.equal(h.calls(), 0);
});
