import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";

import { JsonGuideRepository } from "../src/processor/repository.js";
import { LocalStorage, type Storage } from "../src/processor/storage.js";
import { DELETION_PENDING_ACTIVE, UPLOAD_CANCELLATION_TOMBSTONE } from "../src/processor/asset-lifecycle.js";

process.env.NODE_ENV = "test";
const { cleanupLocalProcessingResidue, cleanupPrivateAssetLifecycle, verifyStorage, withStartupTimeout } = await import("../src/processor/index.js");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryDataDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "showme-startup-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function probeStorage(options: {
  payload?: string;
  deleteError?: Error;
  onDelete?: () => void;
} = {}): Storage {
  return {
    async putFile() {},
    async materialize() {
      throw new Error("not used");
    },
    async openRead() {
      return Readable.from([Buffer.from(options.payload ?? "showme-storage-ready", "utf8")]);
    },
    async delete() {
      options.onDelete?.();
      if (options.deleteError) throw options.deleteError;
    },
  };
}

test("storage startup probe verifies the complete payload and deletes the probe object", async () => {
  let deleted = false;
  await verifyStorage(
    { dataDir: await temporaryDataDirectory() },
    probeStorage({ onDelete: () => { deleted = true; } }),
  );
  assert.equal(deleted, true);
});

test("storage startup probe rejects a corrupted payload after deleting the probe object", async () => {
  let deleted = false;
  await assert.rejects(
    verifyStorage(
      { dataDir: await temporaryDataDirectory() },
      probeStorage({ payload: "showme-storage-readx", onDelete: () => { deleted = true; } }),
    ),
    /unexpected data/,
  );
  assert.equal(deleted, true);
});

test("storage startup probe fails readiness when object deletion fails", async () => {
  const deleteError = new Error("delete failed");
  await assert.rejects(
    verifyStorage(
      { dataDir: await temporaryDataDirectory() },
      probeStorage({ deleteError }),
    ),
    (error: unknown) => error === deleteError,
  );
});

test("startup checks have a bounded wait", async () => {
  await assert.rejects(
    withStartupTimeout("database", 10, () => new Promise(() => undefined)),
    /database startup check timed out after 10ms/,
  );
});

test("startup removes only disposable incoming and work residue", async () => {
  const root = await temporaryDataDirectory();
  const incomingFile = join(root, "incoming", "partial.webm");
  const workFile = join(root, "work", "guide", "attempt", "frame.jpg");
  const objectFile = join(root, "objects", "guides", "preserved.mp4");
  const repositoryFile = join(root, "guides.json");
  await Promise.all([
    mkdir(join(root, "incoming"), { recursive: true }),
    mkdir(join(root, "work", "guide", "attempt"), { recursive: true }),
    mkdir(join(root, "objects", "guides"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(incomingFile, "partial"),
    writeFile(workFile, "temporary"),
    writeFile(objectFile, "private object"),
    writeFile(repositoryFile, "durable repository"),
  ]);

  await cleanupLocalProcessingResidue(root);

  await assert.rejects(access(join(root, "incoming")));
  await assert.rejects(access(join(root, "work")));
  await access(objectFile);
  await access(repositoryFile);
});

test("startup cleanup removes a crash-window upload so the same identity can be uploaded again", async () => {
  const root = await temporaryDataDirectory();
  const repository = new JsonGuideRepository(join(root, "guides.json"));
  const storage = new LocalStorage(join(root, "objects"));
  const source = join(root, "source.mp4");
  const guideId = "crashed-upload";
  const editToken = "retained-edit-token";
  const key = `guides/${guideId}/source/source.mp4`;
  await writeFile(source, Buffer.from("private source"));
  await repository.createGuide({
    id: guideId,
    slug: guideId,
    editToken,
    title: "crashed",
    status: "uploading",
    originalObjectKey: key,
    sourceFilename: "source.mp4",
    sourceMimeType: "video/mp4",
    sourceSizeBytes: 14,
  });
  await storage.putFile(key, source);

  await cleanupPrivateAssetLifecycle(repository, storage, {
    maxSteps: 8,
    activeGraceMs: 60_000,
    now: Date.now() + 60_001,
  });
  assert.equal(await repository.getGuideById(guideId), null);
  await assert.rejects(access(join(storage.root, key)));

  const recreated = await repository.createGuide({
    id: guideId,
    slug: `${guideId}-again`,
    editToken,
    title: "resumed",
    status: "uploading",
    originalObjectKey: key,
    sourceFilename: "source.mp4",
    sourceMimeType: "video/mp4",
    sourceSizeBytes: 14,
  });
  assert.equal(recreated.id, guideId);
});

test("an expired pre-upload cancellation tombstone is removed after its safety window", async () => {
  const root = await temporaryDataDirectory();
  const repository = new JsonGuideRepository(join(root, "tombstones.json"));
  const storage = new LocalStorage(join(root, "tombstone-objects"));
  const guideId = "expired-upload-cancellation";
  const createdAt = new Date(Date.now() - 120_000).toISOString();
  await repository.createGuide({
    id: guideId,
    slug: guideId,
    editToken: "expired-cancellation-token",
    title: "cancelled",
    status: "failed",
    statusMessage: "cancelled",
    progress: 100,
    errorCode: UPLOAD_CANCELLATION_TOMBSTONE,
    errorMessage: "cancelled",
    originalObjectKey: `guides/${guideId}/cancelled/no-source`,
    sourceFilename: "cancelled-upload.webm",
    sourceMimeType: "video/webm",
    sourceSizeBytes: 0,
    createdAt,
  });

  await cleanupPrivateAssetLifecycle(repository, storage, {
    maxSteps: 8,
    activeGraceMs: 60_000,
    now: Date.now(),
  });
  assert.equal(await repository.getGuideById(guideId), null);
});

test("fresh tombstones cannot starve immediate source-bearing deletion", async () => {
  const root = await temporaryDataDirectory();
  const repository = new JsonGuideRepository(join(root, "priority-guides.json"));
  const storage = new LocalStorage(join(root, "priority-objects"));
  const guideId = "immediate-private-cleanup";
  const sourcePath = join(root, "priority-source.mp4");
  const sourceKey = `guides/${guideId}/source.mp4`;
  await writeFile(sourcePath, "private source");
  await repository.createGuide({
    id: guideId,
    slug: guideId,
    editToken: "priority-token",
    title: "priority cleanup",
    status: "failed",
    errorCode: "DELETION_PENDING",
    originalObjectKey: sourceKey,
    sourceFilename: "source.mp4",
    sourceMimeType: "video/mp4",
    sourceSizeBytes: 14,
  });
  await storage.putFile(sourceKey, sourcePath);
  const isolatedBatches = new Proxy(repository, {
    get(target, property) {
      if (property === "listFailedByErrorCodes") {
        return (errorCodes: readonly string[], limit?: number) => (
          errorCodes.length === 1
            ? target.listFailedByErrorCodes(errorCodes, limit)
            : Promise.resolve([])
        );
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  await cleanupPrivateAssetLifecycle(isolatedBatches, storage, {
    maxSteps: 8,
    activeGraceMs: 60_000,
    cancellationGraceMs: 24 * 60 * 60_000,
  });
  assert.equal(await repository.getGuideById(guideId), null);
  await assert.rejects(access(join(storage.root, sourceKey)));
});

test("expired ready and failed drafts are deleted when browser credentials are gone", async () => {
  const root = await temporaryDataDirectory();
  const repository = new JsonGuideRepository(join(root, "retention-guides.json"));
  const storage = new LocalStorage(join(root, "retention-objects"));
  const createdAt = new Date(Date.now() - 120_000).toISOString();
  const fixture = join(root, "retention-private.bin");
  await writeFile(fixture, "private draft data");

  for (const status of ["ready", "failed"] as const) {
    const guideId = `expired-${status}-draft`;
    const sourceKey = `guides/${guideId}/source.mp4`;
    await repository.createGuide({
      id: guideId,
      slug: guideId,
      editToken: `${guideId}-token`,
      title: guideId,
      status,
      errorCode: status === "failed" ? "PROCESSING_FAILED" : null,
      originalObjectKey: sourceKey,
      sourceFilename: "source.mp4",
      sourceMimeType: "video/mp4",
      sourceSizeBytes: 18,
      createdAt,
    });
    await storage.putFile(sourceKey, fixture);
  }

  await cleanupPrivateAssetLifecycle(repository, storage, {
    maxSteps: 8,
    activeGraceMs: 60_000,
    cancellationGraceMs: 24 * 60 * 60_000,
    abandonedDraftGraceMs: 60_000,
    now: Date.now(),
  });

  for (const status of ["ready", "failed"] as const) {
    const guideId = `expired-${status}-draft`;
    assert.equal(await repository.getGuideById(guideId), null);
    await assert.rejects(access(join(storage.root, `guides/${guideId}/source.mp4`)));
  }
});

test("durable pending cleanup remains claimable after deletion failure and succeeds on the next sweep", async () => {
  const root = await temporaryDataDirectory();
  const repository = new JsonGuideRepository(join(root, "retry-guides.json"));
  const local = new LocalStorage(join(root, "retry-objects"));
  const source = join(root, "retry-source.mp4");
  const guideId = "cleanup-retry";
  const key = `guides/${guideId}/source/source.mp4`;
  await writeFile(source, Buffer.from("private source"));
  await repository.createGuide({
    id: guideId,
    slug: guideId,
    editToken: "cleanup-token",
    title: "cleanup",
    status: "failed",
    originalObjectKey: key,
    sourceFilename: "source.mp4",
    sourceMimeType: "video/mp4",
    sourceSizeBytes: 14,
  });
  await repository.updateStatus(guideId, "failed", {
    expectedStatuses: ["failed"],
    errorCode: "DELETION_PENDING",
    errorMessage: "deleting",
  });
  await local.putFile(key, source);
  let failDelete = true;
  const flaky = new Proxy(local, {
    get(target, property) {
      if (property === "delete") {
        return async (objectKey: string) => {
          if (failDelete) throw new Error("temporary storage outage");
          return target.delete(objectKey);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const sweep = () => cleanupPrivateAssetLifecycle(repository, flaky, {
    maxSteps: 8,
    activeGraceMs: 60_000,
  });

  await assert.rejects(sweep(), /Pending private guide cleanup failed/);
  assert.equal((await repository.getGuideById(guideId))?.errorCode, "DELETION_PENDING");
  failDelete = false;
  await sweep();
  assert.equal(await repository.getGuideById(guideId), null);
  await assert.rejects(access(join(local.root, key)));
});

test("a lifecycle snapshot cannot delete an active marker renewed after selection", async () => {
  const root = await temporaryDataDirectory();
  const repository = new JsonGuideRepository(join(root, "renewed-marker.json"));
  const guideId = "renewed-active-marker";
  await repository.createGuide({
    id: guideId,
    slug: guideId,
    editToken: "renewed-token",
    title: "active write",
    status: "failed",
    errorCode: DELETION_PENDING_ACTIVE,
    originalObjectKey: `guides/${guideId}/source.mp4`,
    sourceFilename: "source.mp4",
    sourceMimeType: "video/mp4",
    sourceSizeBytes: 10,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
  });
  const racingRepository = new Proxy(repository, {
    get(target, property) {
      if (property === "listFailedByErrorCodes") {
        return async (codes: readonly string[], limit?: number) => {
          const selected = await target.listFailedByErrorCodes(codes, limit);
          if (codes.includes(DELETION_PENDING_ACTIVE)) {
            await target.updateStatus(guideId, "failed", { errorCode: DELETION_PENDING_ACTIVE });
          }
          return selected;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let deletes = 0;
  await cleanupPrivateAssetLifecycle(racingRepository, probeStorage({ onDelete: () => { deletes += 1; } }), {
    maxSteps: 8,
    activeGraceMs: 60_000,
  });

  assert.equal(deletes, 0);
  assert.equal((await repository.getGuideById(guideId))?.errorCode, DELETION_PENDING_ACTIVE);
});

test("bounded sweeps rotate stuck deletion rows so later drafts can be deleted", { timeout: 5_000 }, async () => {
  const root = await temporaryDataDirectory();
  const repository = new JsonGuideRepository(join(root, "rotating-cleanup.json"));
  for (let index = 0; index < 3; index += 1) {
    const id = `rotation-${index}`;
    await repository.createGuide({
      id,
      slug: id,
      editToken: `${id}-token`,
      title: id,
      status: "failed",
      errorCode: "DELETION_PENDING",
      originalObjectKey: `guides/${id}/source.mp4`,
      sourceFilename: "source.mp4",
      sourceMimeType: "video/mp4",
      sourceSizeBytes: 10,
      createdAt: new Date(Date.now() - 120_000 + index).toISOString(),
    });
  }
  let releaseDelete!: () => void;
  const stuckDelete = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const storage: Storage = {
    ...probeStorage(),
    async delete(key) {
      if (key.includes("rotation-0")) await stuckDelete;
    },
  };
  const sweep = () => cleanupPrivateAssetLifecycle(repository, storage, {
    maxSteps: 8,
    activeGraceMs: 60_000,
    batchLimit: 1,
    sweepBudgetMs: 500,
    storageOperationTimeoutMs: 20,
  });
  await assert.rejects(sweep(), /Pending private guide cleanup failed/);
  await sweep();
  await sweep();
  assert.equal(await repository.getGuideById("rotation-1"), null);
  assert.equal(await repository.getGuideById("rotation-2"), null);
  assert.equal((await repository.getGuideById("rotation-0"))?.errorCode, "DELETION_PENDING");
  releaseDelete();
  await stuckDelete;
});

test("an upload heartbeat between selection and cleanup preserves the source lease", async () => {
  const root = await temporaryDataDirectory();
  const repository = new JsonGuideRepository(join(root, "upload-renewal.json"));
  const id = "renewed-upload";
  const original = await repository.createGuide({
    id, slug: id, title: id, editToken: "lease-token", status: "uploading",
    originalObjectKey: `guides/${id}/source.mp4`,
    sourceFilename: "source.mp4", sourceMimeType: "video/mp4", sourceSizeBytes: 10,
  });
  await repository.claimUploadLease(id, "live-lease", {
    expectedProcessingAttemptId: null, expectedUpdatedAt: original.updatedAt,
  });
  const racingRepository = new Proxy(repository, {
    get(target, property) {
      if (property === "listByStatuses") {
        return async (statuses: Parameters<typeof target.listByStatuses>[0], limit?: number) => {
          const selected = await target.listByStatuses(statuses, limit);
          if (statuses.includes("uploading")) {
            // Feed the sweeper a previously stale snapshot, then renew the
            // real lease before its compare-and-set mutation can run.
            for (const guide of selected) guide.updatedAt = new Date(Date.now() - 120_000).toISOString();
            await target.renewUploadLease(id, "live-lease");
          }
          return selected;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let deletes = 0;
  await cleanupPrivateAssetLifecycle(racingRepository, probeStorage({ onDelete: () => { deletes += 1; } }), {
    maxSteps: 8, activeGraceMs: 60_000,
  });
  assert.equal(deletes, 0);
  assert.equal((await repository.getGuideById(id))?.processingAttemptId, "live-lease");
  assert.equal((await repository.getGuideById(id))?.status, "uploading");
});
