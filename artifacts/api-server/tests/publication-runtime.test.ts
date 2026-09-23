import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import request from "supertest";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { publicationPreparationFixture } from "./helpers/publication-preparation-fixture.js";
import { attemptFrameObjectKey, DELETION_PENDING } from "../src/processor/asset-lifecycle.js";
import { loadConfig } from "../src/processor/config.js";
import { testMediaPaths } from "./helpers/media-binaries.js";
import { DurablePublicationRuntime, createPublicationLifecycle, type ProcessorPublicationContext } from "../src/processor/publication-runtime.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { preparePublicationAssets } from "../src/processor/publication-preparation.js";
import { privateAssetWriterBusy } from "../src/processor/privacy-asset-session.js";
import { createProcessorApp } from "../src/processor/server.js";
import { startProcessor } from "../src/processor/index.js";
import { privacyAfterEdit } from "../src/processor/privacy-review.js";
import { StorageWriteSettledError } from "../src/processor/storage.js";

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function until(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 500; n++) { if (await check()) return; await delay(10); } assert.fail("fixture did not settle");
}
async function fixture(t: TestContext) {
  const token = "a".repeat(43), h = await createAnalysisHarness(t, 1, { guideId: randomUUID(), editToken: token });
  await h.repository.replaceSteps(h.guideId, h.guide.steps.map(s => ({ ...s,
    representativeFrameKey: attemptFrameObjectKey(h.guideId, 1, 1, "frame") })));
  const guide = (await h.repository.getGuideById(h.guideId))!, f = await publicationPreparationFixture(h.repository, guide, h.root);
  const context = { repository: h.repository, storage: f.storage,
    config: { ...loadConfig({ NODE_ENV: "test", DATA_DIR: h.root, SHOWME_STORAGE: "local" }), ...testMediaPaths(), port: 0 } };
  const runtime = (options: ConstructorParameters<typeof DurablePublicationRuntime>[1] = {}, repository = h.repository) =>
    new DurablePublicationRuntime({ ...context, repository }, { render: f.fastRender, ...options });
  return { ...h, ...f, guide, token, context, runtime };
}

test("explicit pass discovers persisted queued work after reopen, creates real PNGs and commits exactly once", async t => {
  const h = await fixture(t), reopened = new JsonGuideRepository(h.repository.filePath), runtime = h.runtime({ render: undefined }, reopened);
  const put = t.mock.method(h.storage, "putFile", h.storage.putFile.bind(h.storage));
  const before = await reopened.getGuideById(h.guideId);
  assert.equal(runtime.admission.isAccepting(), false); assert.equal(put.mock.callCount(), 0);
  const a = runtime.tick(), b = runtime.tick(); assert.equal(a, b);
  assert.equal((await a).published, 1); assert.equal(put.mock.callCount(), 2);
  const state = (await reopened.getPublicationState(h.guideId))!;
  assert.equal(state.head!.version, 1); assert.ok(await reopened.getAccessiblePublication({ slug: state.head!.publicSlug }));
  assert.deepEqual(await reopened.getGuideById(h.guideId), before);
  await runtime.tick(); await runtime.tick(); assert.equal(put.mock.callCount(), 2);
  assert.deepEqual(await runtime.stop(), { pendingIO: false }); assert.equal((await runtime.tick()).status, "stopped");
});

test("authenticated HTTP admission flows through the scheduled executor to a public processed PNG and withdrawal", async t => {
  const h = await fixture(t); await h.repository.executePublicationCommand(h.guideId, { type: "cancel", id: h.job.id });
  const runtime = h.runtime({ pollMs: 20 }), app = createProcessorApp({ ...h.context, publicationAdmission: runtime.admission,
    pipeline: { async process() { assert.fail(); }, async processClaimed() { assert.fail(); } } });
  const body = { publicationId: randomUUID(), baseDraftRevision: h.request.revision, inputFingerprint: h.request.inputFingerprint,
    reviewFingerprint: h.request.reviewFingerprint, publicSharing: true, originalSharingEnabled: false };
  const auth = `Bearer ${h.token}`, url = `/api/guides/${h.guideId}`;
  await request(app).post(`${url}/publish`).set("Authorization", auth).send(body).expect(503);
  runtime.start(); runtime.start();
  try {
    await until(() => runtime.admission.isAccepting());
    await request(app).post(`${url}/publish`).set("Authorization", auth).send(body).expect(202);
    await until(async () => (await h.repository.getPublicationJob(h.guideId, body.publicationId))?.status === "succeeded");
    const owner = await request(app).get(`${url}/publications/${body.publicationId}`).set("Authorization", auth).expect(200);
    const slug = owner.body.publication.publicPath.split("/").at(-1), view = await request(app).get(`/api/public/guides/${slug}`).expect(200);
    await request(app).get(view.body.guide.steps[0].frameUrl).expect(200).expect("Content-Type", /image\/png/);
    await request(app).post(`${url}/unpublish`).set("Authorization", auth).send({ expectedHeadVersion: 1, expectedJobId: null }).expect(200);
    await request(app).get(`/api/public/guides/${slug}`).expect(404);
    await until(async () => (await h.repository.listPrivacyAssetBatches(h.guideId)).length === 0);
  } finally { await runtime.stop(); }
  runtime.start(); assert.equal(runtime.admission.isAccepting(), false);
});

test("competing executors cannot duplicate a writer or a commit", async t => {
  const h = await fixture(t), a = h.runtime(), b = h.runtime({}, new JsonGuideRepository(h.repository.filePath));
  const put = t.mock.method(h.storage, "putFile", h.storage.putFile.bind(h.storage));
  await Promise.all([a.tick(), b.tick()]);
  assert.equal(put.mock.callCount(), 2); assert.equal((await h.repository.getPublicationState(h.guideId))!.publications.length, 1);
  await Promise.all([a.stop(), b.stop()]);
});

for (const mode of ["withdraw", "delete", "edit"] as const)
test(`${mode} during preparation prevents the executor from publishing and preserves unrelated private state`, async t => {
  const h = await fixture(t); let changed = false;
  const runtime = h.runtime({ render: async (...args) => {
    if (!changed) {
      changed = true;
      if (mode === "withdraw") await h.repository.stopPublication(h.guideId, { type: "withdraw", expectedHeadVersion: 0, expectedJobId: h.job.id });
      if (mode === "delete") await h.repository.updateStatus(h.guideId, "failed", { errorCode: DELETION_PENDING });
      if (mode === "edit") {
        const document = { ...h.state.draft!.document, title: "new private title" };
        document.privacy = privacyAfterEdit(h.state.draft!.document, document);
        await h.repository.executeAnalysisCommand(h.guideId, { type: "save-editor-draft", expectedRevision: h.request.revision,
          expectedInputFingerprint: h.request.inputFingerprint, document });
      }
    }
    return h.fastRender(...args);
  } });
  assert.equal((await runtime.tick()).published, 0); assert.equal((await h.repository.getPublicationState(h.guideId))!.head, null);
  assert.ok(await h.repository.getGuideById(h.guideId)); await runtime.stop();
});

test("commit acknowledgement loss is read-only recovery, not another commit or upload", async t => {
  const h = await fixture(t), runtime = h.runtime(), commit = h.repository.commitPublication.bind(h.repository);
  const mock = t.mock.method(h.repository, "commitPublication", async (...args: Parameters<typeof commit>) => { await commit(...args); throw new Error("lost fixture ack"); });
  const put = t.mock.method(h.storage, "putFile", h.storage.putFile.bind(h.storage));
  assert.equal((await runtime.tick()).published, 1); await runtime.tick();
  assert.equal(mock.mock.callCount(), 1); assert.equal(put.mock.callCount(), 2);
  assert.equal((await h.repository.getPublicationState(h.guideId))!.head!.version, 1); await runtime.stop();
});

test("failed replacement commit keeps the previous public snapshot and cleans only the failed output", async t => {
  const h = await fixture(t), runtime = h.runtime(); await runtime.tick();
  const first = (await h.repository.getPublicationState(h.guideId))!;
  await h.repository.executePublicationCommand(h.guideId, { type: "request", id: randomUUID(),
    expectedDraftRevision: h.request.revision, expectedInputFingerprint: h.request.inputFingerprint,
    expectedReviewFingerprint: h.request.reviewFingerprint, originalSharingEnabled: false });
  t.mock.method(h.repository, "commitPublication", async () => { throw new Error("synthetic DB failure"); });
  await runtime.tick(); // Cursor wrap; a new UUID may sort before the previous one.
  await runtime.tick();
  const state = (await h.repository.getPublicationState(h.guideId))!;
  assert.deepEqual(state.head, first.head); assert.equal(state.publications.length, 1);
  assert.ok(await h.repository.getAccessiblePublication({ slug: first.head!.publicSlug })); await runtime.stop();
});

test("a new runtime never commits or re-renders a previously running assets-ready lease", async t => {
  const h = await fixture(t), ready = await preparePublicationAssets({ ...h.options, render: h.fastRender });
  const runtime = h.runtime({}, new JsonGuideRepository(h.repository.filePath));
  const put = t.mock.method(h.storage, "putFile", async () => assert.fail("must not replay writes"));
  await runtime.tick(); assert.equal((await h.repository.getPublicationState(h.guideId))!.head, null);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(ready.leaseExpiresAt!) });
  await runtime.tick(); assert.equal(put.mock.callCount(), 0);
  assert.equal((await h.repository.getPublicationJob(h.guideId, h.job.id))!.status, "failed");
  assert.equal((await h.repository.listPrivacyAssetBatches(h.guideId)).length, 0); await runtime.stop();
});

test("stop during an uncooperative put returns pending, never publishes, and late settlement retains cleanup ownership", async t => {
  const h = await fixture(t), entered = gate(), release = gate(), runtime = h.runtime({ shutdownTimeoutMs: 30 });
  const put = h.storage.putFile.bind(h.storage);
  const mock = t.mock.method(h.storage, "putFile", async (...args: Parameters<typeof put>) => { entered.resolve(); await release.promise; await put(...args); });
  try {
    const pass = runtime.tick(); await entered.promise;
    assert.equal((await runtime.stop()).pendingIO, true); assert.equal((await pass).status, "stopped");
    assert.equal((await h.repository.listPrivacyAssetBatches(h.guideId))[0].writerSettled, false);
    assert.equal((await runtime.tick()).status, "stopped"); assert.equal(mock.mock.callCount(), 1);
  } finally { release.resolve(); await until(() => !privateAssetWriterBusy() && !runtime.getStatus().pendingIO); }
  assert.equal((await h.repository.getPublicationState(h.guideId))!.head, null);
  assert.equal((await h.repository.listPrivacyAssetBatches(h.guideId)).length, 0);
});

test("timed-out repository scan holds the lane, does not create new queries and cannot later begin a writer", async t => {
  const h = await fixture(t), entered = gate(), release = gate(), runtime = h.runtime({ timeoutMs: 200 });
  const scan = h.repository.listPublicationRecovery.bind(h.repository);
  const mock = t.mock.method(h.repository, "listPublicationRecovery", async (...args: Parameters<typeof scan>) => {
    if (args[0].kind === "queued") { entered.resolve(); await release.promise; }
    return scan(...args);
  });
  try {
    const pending = runtime.tick(); await entered.promise; assert.equal((await pending).status, "degraded");
    const count = mock.mock.callCount(); assert.equal((await runtime.tick()).status, "busy"); assert.equal(mock.mock.callCount(), count);
  } finally { release.resolve(); await until(() => !runtime.getStatus().pendingIO); }
  assert.equal((await h.repository.getPublicationJob(h.guideId, h.job.id))!.status, "queued"); await runtime.stop();
});

for (const outcome of ["settled", "unknown"] as const)
test(`${outcome} storage errors cannot release the writer slot while a concurrent DB monitor is still pending`, async t => {
  const h = await fixture(t), monitorEntered = gate(), release = gate(), runtime = h.runtime({ timeoutMs: 1000, shutdownTimeoutMs: 30 });
  const execute = h.repository.executePublicationCommand.bind(h.repository); let putStarted = false;
  t.mock.method(h.repository, "executePublicationCommand", async (...args: Parameters<typeof execute>) => {
    if (putStarted && args[1].type === "check-writer") { monitorEntered.resolve(); await release.promise; }
    return execute(...args);
  });
  t.mock.method(h.storage, "putFile", async () => {
    putStarted = true; await monitorEntered.promise;
    // Only the explicitly settled fixture supplies evidence of no future writes.
    throw outcome === "settled" ? new StorageWriteSettledError() : new Error("synthetic write failure");
  });
  try {
    const pending = runtime.tick(); await monitorEntered.promise; await delay(20);
    assert.equal(privateAssetWriterBusy(), true); assert.equal((await runtime.stop()).pendingIO, true);
    assert.equal((await pending).status, "stopped");
  } finally { release.resolve(); await until(() => !runtime.getStatus().pendingIO); }
  assert.equal((await h.repository.getPublicationState(h.guideId))!.head, null);
  const batches = await h.repository.listPrivacyAssetBatches(h.guideId);
  if (outcome === "settled") assert.deepEqual(batches, []);
  else {
    assert.equal(batches.length, 1); assert.equal(batches[0].status, "cleanup");
    assert.equal(batches[0].writerSettled, false); assert.equal(await h.repository.deleteGuide(h.guideId), false);
  }
});

test("bounded admission retains timed-out write slots, copies input and recovers accepted work by the same ID", async t => {
  const h = await fixture(t); await h.repository.executePublicationCommand(h.guideId, { type: "cancel", id: h.job.id });
  const runtime = h.runtime({ pollMs: 60_000, admissionTimeoutMs: 20 }); runtime.start(); await runtime.tick();
  const entered = gate(), release = gate(), execute = h.repository.executePublicationCommand.bind(h.repository), id = randomUUID();
  let count = 0;
  t.mock.method(h.repository, "executePublicationCommand", async (...args: Parameters<typeof execute>) => {
    if (args[1].type === "request") { count++; if (count === 16) entered.resolve(); await release.promise; }
    return execute(...args);
  });
  const command = { type: "request" as const, id, expectedDraftRevision: h.request.revision,
    expectedInputFingerprint: h.request.inputFingerprint, expectedReviewFingerprint: h.request.reviewFingerprint, originalSharingEnabled: false };
  try {
    const pending = Array.from({ length: 16 }, () => runtime.admission.request(h.guideId, command, new AbortController().signal).then(() => assert.fail(), () => undefined));
    command.expectedDraftRevision++;
    await entered.promise; await Promise.all(pending); assert.equal(runtime.getStatus().pendingAdmissions, 16);
    await assert.rejects(runtime.admission.request(h.guideId, command, new AbortController().signal)); assert.equal(count, 16);
  } finally { release.resolve(); await until(() => runtime.getStatus().pendingAdmissions === 0); await runtime.stop(); }
  const accepted = (await h.repository.getPublicationJob(h.guideId, id))!;
  assert.equal(accepted.revision, h.request.revision); assert.equal(accepted.status, "queued");
  const restarted = h.runtime(); assert.equal((await restarted.tick()).published, 1); await restarted.stop();
});

test("queued discovery is read-only, excludes running jobs and returns bounded stable cursor identities", async t => {
  const h = await fixture(t), bytes = await readFile(h.repository.filePath);
  const rows = await h.repository.listPublicationRecovery({ kind: "queued", limit: 1 });
  assert.deepEqual(rows, [{ guideId: h.guideId, id: h.job.id, version: 1, batchId: h.job.batchId }]);
  assert.deepEqual(await h.repository.listPublicationRecovery({ kind: "queued", after: rows[0].batchId }), []);
  assert.deepEqual(await readFile(h.repository.filePath), bytes);
  await h.repository.executePublicationCommand(h.guideId, { type: "claim", id: h.job.id, expectedVersion: 1, leaseId: randomUUID() });
  assert.deepEqual(await h.repository.listPublicationRecovery({ kind: "queued" }), []);
});

test("lifecycle is opt-in, rejects mismatched resources, gates start/stop and surfaces uncertain shutdown", async () => {
  const context = { repository: {}, storage: {}, config: {} } as ProcessorPublicationContext;
  assert.equal(await createPublicationLifecycle(context), undefined); let starts = 0, stops = 0;
  const factory = () => ({ ...context, admission: { isAccepting: () => true, async request() { return null; } },
    start() { starts++; }, async stop() { stops++; return { pendingIO: false }; } });
  await assert.rejects(createPublicationLifecycle(context, () => ({ ...factory(), storage: {} as never }))); assert.equal(stops, 1);
  const lifecycle = (await createPublicationLifecycle(context, factory))!;
  assert.equal(lifecycle.admission.isAccepting(), false); lifecycle.start(); lifecycle.start(); assert.equal(starts, 1);
  assert.equal(lifecycle.admission.isAccepting(), true); await Promise.all([lifecycle.stop(), lifecycle.stop()]); lifecycle.start();
  assert.equal(stops, 2); assert.equal(lifecycle.admission.isAccepting(), false);
  await assert.rejects(lifecycle.admission.request("x", {} as never, new AbortController().signal));
  const uncertain = (await createPublicationLifecycle(context, () => ({ ...factory(), async stop() { return { pendingIO: true }; } })))!;
  await assert.rejects(uncertain.stop(), /PUBLICATION_STOP_PENDING/);
});

test("invalid executor bounds and pre-aborted admission do not touch persisted work", async t => {
  const h = await fixture(t), before = await readFile(h.repository.filePath);
  for (const options of [{ pollMs: 0 }, { timeoutMs: 120_001 }, { timeoutMs: 1, preparationTimeoutMs: 2 },
    { admissionTimeoutMs: 5001 }, { shutdownTimeoutMs: 5001 }]) assert.throws(() => h.runtime(options), RangeError);
  const runtime = h.runtime(), abort = new AbortController(); abort.abort();
  await assert.rejects(runtime.admission.request(h.guideId, { type: "request", id: randomUUID(),
    expectedDraftRevision: h.request.revision, expectedInputFingerprint: h.request.inputFingerprint,
    expectedReviewFingerprint: h.request.reviewFingerprint, originalSharingEnabled: false }, abort.signal));
  assert.deepEqual(await readFile(h.repository.filePath), before); await runtime.stop();
});

for (const failure of [false, true])
test(`processor publication lifecycle startup ${failure ? "failure" : "success"} closes gates before DB resources`, async t => {
  const root = await mkdtemp(join(tmpdir(), "showme-publication-bootstrap-")); t.after(() => rm(root, { recursive: true, force: true }));
  const config = { ...loadConfig({ NODE_ENV: "test", DATA_DIR: root, SHOWME_STORAGE: "local" }), ...testMediaPaths(), port: 0,
    ...(failure ? { ffmpegPath: join(root, "missing-ffmpeg") } : {}) };
  const events: string[] = [];
  const start = startProcessor(config, { createPublication: context => {
    context.repository.close = async () => { events.push("db-close"); };
    return { ...context, admission: { isAccepting: () => true, async request() { assert.fail(); } },
      start() { events.push("start"); }, async stop() { events.push("stop"); return { pendingIO: false }; } };
  } });
  if (failure) { await assert.rejects(start); assert.deepEqual(events, ["stop", "db-close"]); }
  else { const processor = await start; t.after(() => processor.close()); assert.deepEqual(events, ["start"]);
    await Promise.all([processor.close(), processor.close()]); assert.deepEqual(events, ["start", "stop", "db-close"]); }
});
