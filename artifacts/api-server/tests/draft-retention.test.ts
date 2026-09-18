import assert from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { analysisManifest, initialDraft } from "../src/processor/analysis-contract.js";
import { DELETION_PENDING, DELETION_PENDING_ACTIVE, UPLOAD_CANCELLATION_TOMBSTONE } from "../src/processor/asset-lifecycle.js";
import { cleanupPrivateAssetLifecycle } from "../src/processor/index.js";
import { PostgresGuideRepository, type ProcessorDatabase } from "../src/processor/repository.js";
import { LocalStorage } from "../src/processor/storage.js";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-09-18T12:00:00.000Z");
const lifecycleCodes = [DELETION_PENDING, DELETION_PENDING_ACTIVE, UPLOAD_CANCELLATION_TOMBSTONE];
const expiryOptions = { maxSteps: 8, activeGraceMs: 60_000, abandonedDraftGraceMs: 7 * DAY };
function saveCommand(h: Awaited<ReturnType<typeof createAnalysisHarness>>) {
  const manifest = analysisManifest(h.guide);
  return { type: "save-editor-draft" as const, expectedRevision: 0,
    expectedInputFingerprint: manifest.fingerprint,
    document: { ...initialDraft(manifest), title: "synthetic recent edit" } };
}

test("recent successful editing protects the original and draft until seven days after saving", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW - 8 * DAY });
  const h = await createAnalysisHarness(t, 1);
  const storage = new LocalStorage(join(h.root, "objects"));
  const fixture = join(h.root, "synthetic.bin");
  await writeFile(fixture, "synthetic bytes, not a recording");
  await storage.putFile(h.guide.originalObjectKey, fixture);
  t.mock.timers.setTime(NOW);
  const saved = await h.repository.executeAnalysisCommand(h.guideId, saveCommand(h));
  assert.equal(saved?.draft?.revision, 1);
  assert.equal((await h.repository.getGuideById(h.guideId))?.updatedAt, saved!.draft!.updatedAt);

  t.mock.timers.setTime(NOW + 7 * DAY - 1);
  await cleanupPrivateAssetLifecycle(h.repository, storage, { ...expiryOptions, now: Date.now() });
  assert.ok(await h.repository.getGuideById(h.guideId));
  await access(join(storage.root, h.guide.originalObjectKey));
  t.mock.timers.setTime(NOW + 7 * DAY);
  await cleanupPrivateAssetLifecycle(h.repository, storage, { ...expiryOptions, now: Date.now() });
  assert.equal(await h.repository.getGuideById(h.guideId), null);
  assert.equal(await h.repository.getAnalysisState(h.guideId), null);
  await assert.rejects(access(join(storage.root, h.guide.originalObjectKey)));
});

test("reads, rejected writes and lost-ack replays do not renew retention", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW - DAY });
  const h = await createAnalysisHarness(t, 1);
  const command = saveCommand(h);
  await h.repository.executeAnalysisCommand(h.guideId, command);
  const saved = await h.repository.getGuideById(h.guideId);
  t.mock.timers.setTime(NOW);
  await h.repository.getAnalysisState(h.guideId);
  await h.repository.executeAnalysisCommand(h.guideId, command);
  assert.equal(await h.repository.executeAnalysisCommand(h.guideId, {
    ...command, document: { ...command.document, title: "conflicting edit" },
  }), null);
  await assert.rejects(h.repository.executeAnalysisCommand(h.guideId, {
    ...command, expectedRevision: 1, document: { ...command.document, title: "" },
  }));
  assert.deepEqual(await h.repository.getGuideById(h.guideId), saved);
  assert.equal((await h.repository.getAnalysisState(h.guideId))?.draft?.updatedAt, saved?.updatedAt);
});

test("a save after expiry selection invalidates the stale deletion claim", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW - 8 * DAY });
  const h = await createAnalysisHarness(t, 1);
  const select = h.repository.listExpiredDrafts.bind(h.repository);
  t.mock.timers.setTime(NOW);
  t.mock.method(h.repository, "listExpiredDrafts", async (...args: Parameters<typeof select>) => {
    const candidates = await select(...args);
    assert.equal(candidates.length, 1);
    assert.ok(await h.repository.executeAnalysisCommand(h.guideId, saveCommand(h)));
    return candidates;
  });
  const storage = new LocalStorage(join(h.root, "objects"));
  t.mock.method(storage, "delete", async () => assert.fail("freshly saved media must not be deleted"));
  await cleanupPrivateAssetLifecycle(h.repository, storage, { ...expiryOptions, now: NOW });
  assert.equal((await h.repository.getGuideById(h.guideId))?.status, "ready");
  assert.equal((await h.repository.getAnalysisState(h.guideId))?.draft?.revision, 1);
});

test("an already claimed deletion rejects a later save rather than resurrecting the guide", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW - 8 * DAY });
  const h = await createAnalysisHarness(t, 1);
  t.mock.timers.setTime(NOW);
  assert.ok(await h.repository.updateStatus(h.guideId, "failed", {
    expectedStatuses: ["ready"], expectedUpdatedAt: h.guide.updatedAt, errorCode: DELETION_PENDING,
  }));
  const pending = await h.repository.getGuideById(h.guideId);
  assert.equal(await h.repository.executeAnalysisCommand(h.guideId, saveCommand(h)), null);
  assert.deepEqual(await h.repository.getGuideById(h.guideId), pending);
  await cleanupPrivateAssetLifecycle(h.repository, new LocalStorage(join(h.root, "objects")), { ...expiryOptions, now: NOW });
  assert.equal(await h.repository.getGuideById(h.guideId), null);
});

test("recent legacy drafts are excluded before the batch limit without renewing them on read", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW - 10 * DAY });
  const h = await createAnalysisHarness(t, 1);
  t.mock.timers.setTime(NOW - 60_000);
  await h.repository.executeAnalysisCommand(h.guideId, saveCommand(h));
  // Reproduce the on-disk shape from the previous release, not live/user data.
  const state = JSON.parse(await readFile(h.repository.filePath, "utf8"));
  state.guides[0].updatedAt = h.guide.updatedAt;
  await writeFile(h.repository.filePath, JSON.stringify(state));
  for (const [id, status, errorCode] of [
    ["expired-ready", "ready", null], ["expired-failed", "failed", "PROCESSING_FAILED"],
    ["pending", "failed", DELETION_PENDING_ACTIVE], ["queued", "queued", null],
  ] as const) {
    await h.repository.createGuide({ id, slug: id, title: id, editToken: "synthetic-key", status, errorCode,
      originalObjectKey: `guides/${id}/source.mp4`, sourceFilename: "synthetic.mp4",
      sourceMimeType: "video/mp4", sourceSizeBytes: 1, createdAt: new Date(NOW - 8 * DAY).toISOString() });
  }
  t.mock.timers.setTime(NOW);
  const cutoff = new Date(NOW - 7 * DAY).toISOString();
  const before = await readFile(h.repository.filePath, "utf8");
  assert.deepEqual((await h.repository.listExpiredDrafts(cutoff, lifecycleCodes, 1)).map(g => g.id), ["expired-ready"]);
  assert.deepEqual((await h.repository.listExpiredDrafts(cutoff, lifecycleCodes, 20)).map(g => g.id), ["expired-ready", "expired-failed"]);
  assert.equal(await readFile(h.repository.filePath, "utf8"), before);
  const later = new Date(NOW + 7 * DAY).toISOString();
  assert.ok((await h.repository.listExpiredDrafts(later, lifecycleCodes, 20)).some(g => g.id === h.guideId));
});

test("Postgres expiry query filters both timestamps and lifecycle rows before LIMIT (SQL shape)", async () => {
  let condition: SQL | undefined;
  let limit: number | undefined;
  const database = { select: () => ({ from: () => ({ where: (value: SQL) => {
    condition = value;
    return { orderBy: () => ({ limit: async (value: number) => { limit = value; return []; } }) };
  } }) }) };
  const repository = new PostgresGuideRepository(database as unknown as ProcessorDatabase);
  const cutoff = new Date(NOW - 7 * DAY).toISOString();
  assert.deepEqual(await repository.listExpiredDrafts(cutoff, lifecycleCodes, 2), []);
  assert.equal(limit, 2);
  assert.ok(condition);
  const query = new PgDialect().sqlToQuery(condition);
  assert.match(query.sql, /"guides"\."updated_at" <=/);
  assert.match(query.sql, /not exists \(select 1 from "guide_drafts"/);
  assert.match(query.sql, /"guide_drafts"\."guide_id" = "guides"\."id"/);
  assert.match(query.sql, /"guide_drafts"\."updated_at" >/);
  assert.match(query.sql, /"guides"\."error_code" not in/);
  for (const value of ["ready", "failed", cutoff, ...lifecycleCodes]) assert.ok(query.params.includes(value));
});
