import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { publicationCheckScope, verifyPublicationCheckRemoved, verifyPublicationCheckPrivileges } from "../scripts/publication-check-scope.js";
import { runPublicationStorageCheck } from "../scripts/check-publication-storage.js";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { reviewedAssetFixture } from "./helpers/privacy-assets-fixture.js";
import { attemptFrameObjectKey } from "../src/processor/asset-lifecycle.js";
import type { GuideRepository } from "../src/processor/domain.js";
import type { Pool } from "pg";

test("diagnostic facade refuses foreign identities and unknown methods before invoking persistence", async () => {
  const id = randomUUID(), calls: unknown[][] = [];
  const raw = new Proxy({}, { get: (_target, key) => (...args: unknown[]) => { calls.push([key, ...args]); return Promise.resolve(null); } }) as GuideRepository;
  const scoped = publicationCheckScope(raw, id);
  assert.throws(() => publicationCheckScope(raw, "../other"));
  for (const run of [() => scoped.getGuideById(randomUUID()), () => scoped.deleteGuide(randomUUID()),
    () => scoped.listByStatuses(["ready"]), () => scoped.listPublicationWork(),
    () => scoped.executeAnalysisCommand(randomUUID(), { type: "initialize" }),
    () => scoped.listPublicationRecovery({ kind: "queued", guideId: "other" }),
    () => scoped.listExpiredPublications({ guideId: "other" }),
    () => scoped.createGuide({ id, slug: "other" } as never)]) assert.throws(run, /REFUSED/);
  assert.deepEqual(calls, []);
  await scoped.listPublicationRecovery({ kind: "queued", limit: 1 });
  await scoped.listExpiredPublications({ limit: 1 });
  assert.deepEqual(calls, [["listPublicationRecovery", { kind: "queued", limit: 1, guideId: id }, undefined],
    ["listExpiredPublications", { limit: 1, guideId: id }, undefined]]);
  calls.length = 0;
  assert.equal(await scoped.getAccessiblePublication({ slug: "x".repeat(32) }), null);
  assert.deepEqual(calls, [["getPublicationState", id]]);
});

test("fixture removal check uses one bounded identity and refuses surviving rows", async () => {
  const id = randomUUID(); let remaining = false, calls = 0;
  const pool = { query: async (sql: string, parameters: unknown[]) => {
    calls++; assert.deepEqual(parameters, [id]); assert.ok(sql.includes("WHERE id=$1"));
    assert.equal((sql.match(/WHERE guide_id=\$1/g) ?? []).length, 8);
    return { rows: [{ remaining }] };
  } } as unknown as Pool;
  await verifyPublicationCheckRemoved(pool, id);
  remaining = true; await assert.rejects(verifyPublicationCheckRemoved(pool, id), /REFUSED/);
  await assert.rejects(verifyPublicationCheckRemoved(pool, "invalid"), /REFUSED/);
  assert.equal(calls, 2);
});

test("integration preflight needs cleanup grants but refuses immutable publication UPDATE", async () => {
  let change: (rows: Record<string, unknown>[]) => Record<string, unknown>[] = rows => rows;
  const pool = { query: async (sql: string, [tables]: [string[]]) => {
    assert.ok(sql.startsWith("SELECT "));
    return { rows: change(tables.map(name => ({ name, readable: true, insertable: true, deletable: true,
      updatable: name !== "guide_publications" }))) };
  } } as unknown as Pool;
  await verifyPublicationCheckPrivileges(pool);
  for (const mode of ["missing", "duplicate", "delete", "snapshot-update"]) {
    change = rows => {
      if (mode === "missing") return rows.slice(1);
      if (mode === "duplicate") return rows.map(() => rows[0]);
      if (mode === "delete") rows[0].deletable = false;
      if (mode === "snapshot-update") rows.find(row => row.name === "guide_publications")!.updatable = true;
      return rows;
    };
    await assert.rejects(verifyPublicationCheckPrivileges(pool), /REFUSED/);
  }
});

test("database operations remain tracked until late completion; foreign calls never enter persistence", async () => {
  const id = randomUUID(), inFlight = new Set<Promise<unknown>>(); let finish!: () => void, calls = 0;
  const delayed = new Promise<void>(resolve => { finish = resolve; });
  const raw = { getGuideById: async () => { calls++; await delayed; return null; } } as unknown as GuideRepository;
  const scoped = publicationCheckScope(raw, id, work => {
    inFlight.add(work); void work.finally(() => inFlight.delete(work)).catch(() => undefined); return work;
  });
  const work = scoped.getGuideById(id);
  assert.equal(inFlight.size, 1); await Promise.resolve(); assert.equal(calls, 1);
  await assert.rejects(scoped.getGuideById(randomUUID()), /REFUSED/);
  assert.equal(calls, 1); assert.equal(inFlight.size, 1);
  finish(); await work; assert.equal(inFlight.size, 0);
});

for (const failRender of [false, true]) test(`diagnostic DB composition preserves unrelated queued work and cleans its own fixture (render failure=${failRender})`,
  { timeout: 210_000 }, async t => {
    // JSON double tests the scope/cleanup orchestration, NOT PostgreSQL behavior.
    const foreign = randomUUID(), h = await createAnalysisHarness(t, 1, { guideId: foreign, editToken: "foreign-token" });
    await h.repository.replaceSteps(foreign, h.guide.steps.map(s => ({ ...s,
      representativeFrameKey: attemptFrameObjectKey(foreign, 1, 1, "frame") })));
    const guide = (await h.repository.getGuideById(foreign))!, review = await reviewedAssetFixture(h.repository, guide);
    const job = (await h.repository.executePublicationCommand(foreign, { type: "request", id: randomUUID(),
      expectedDraftRevision: review.request.revision, expectedInputFingerprint: review.request.inputFingerprint,
      expectedReviewFingerprint: review.request.reviewFingerprint, originalSharingEnabled: false }))!;
    const before = await h.repository.getGuideById(foreign);
    const logs: string[] = [], verified: string[] = [];
    const execute = () => runPublicationStorageCheck(["--local-synthetic"], { NODE_ENV: "test",
      SHOWME_TEST_FFMPEG_PATH: process.env.SHOWME_TEST_FFMPEG_PATH, SHOWME_TEST_FFPROBE_PATH: process.env.SHOWME_TEST_FFPROBE_PATH,
      ...(failRender ? { FFMPEG_PATH: "showme-nonexistent-decoder" } : {}) }, line => logs.push(line), {
      repository: h.repository, verifyRemoved: async id => {
        assert.notEqual(id, foreign); assert.equal(await h.repository.getGuideById(id), null);
        assert.equal(await h.repository.getPublicationState(id), null); assert.deepEqual(await h.repository.listPrivacyAssetBatches(id), []);
        verified.push(id);
      },
    });
    if (failRender) await assert.rejects(execute());
    else { const result = await execute(); assert.equal(result.passed, true); assert.equal(result.databaseFixtureRemoved, true); }
    assert.equal(verified.length, 1);
    assert.equal(logs.some(line => line.includes("CLEANUP_PENDING")), false, logs.join("\n"));
    assert.deepEqual(await h.repository.getGuideById(foreign), before);
    assert.deepEqual(await h.repository.getPublicationJob(foreign, job.id), job);
    assert.equal((await h.repository.listPublicationRecovery({ kind: "queued", guideId: foreign, limit: 1 })).length, 1);
    assert.deepEqual(await h.repository.listPublicationRecovery({ kind: "queued", guideId: verified[0], limit: 1 }), []);
  });
