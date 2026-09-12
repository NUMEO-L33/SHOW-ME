import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  DELETION_PENDING,
  finalizeGuideDeletion,
  guideAssetKeys,
  materializePrivateAsset,
  PrivateAssetReadInterruptedError,
  PrivateAssetWriteInterruptedError,
  putPrivateAsset,
} from "../src/asset-lifecycle.js";
import type { GuideWithSteps } from "../src/domain.js";
import { JsonGuideRepository } from "../src/repository.js";
import type { Storage } from "../src/storage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "showme-assets-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("an interrupted private write is deleted if the storage SDK commits late", { timeout: 5_000 }, async () => {
  let releaseWrite!: () => void;
  let confirmStarted!: () => void;
  let confirmDelete!: () => void;
  const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>((resolve) => { confirmStarted = resolve; });
  const deleted = new Promise<void>((resolve) => { confirmDelete = resolve; });
  let objectExists = false;
  const storage: Storage = {
    async putFile() {
      confirmStarted();
      await writeReleased;
      objectExists = true;
    },
    async materialize() { throw new Error("not used"); },
    async openRead() { throw new Error("not used"); },
    async delete() {
      objectExists = false;
      confirmDelete();
    },
  };
  const abort = new AbortController();
  const writing = putPrivateAsset(storage, "guides/test/source/private.webm", "unused", {
    signal: abort.signal,
  });

  await writeStarted;
  abort.abort();
  await assert.rejects(writing, PrivateAssetWriteInterruptedError);
  releaseWrite();
  await deleted;
  assert.equal(objectExists, false);
});

test("durable guide cleanup covers the invariant 100-step key range", () => {
  const guide = {
    id: "old-deployment-guide",
    originalObjectKey: "guides/old-deployment-guide/source/private.mp4",
    processingAttemptCount: 1,
    steps: [],
  } as unknown as GuideWithSteps;
  const keys = guideAssetKeys(guide, 6);

  assert.ok(keys.includes("guides/old-deployment-guide/attempts/1/frames/frame-100.jpg"));
  assert.ok(keys.includes("guides/old-deployment-guide/attempts/1/frames/frame-100-thumb.jpg"));
});

test("pre-aborted private operations never start a storage SDK request", async () => {
  let writes = 0;
  let reads = 0;
  const storage: Storage = {
    async putFile() { writes += 1; },
    async materialize(_key, destinationPath) {
      reads += 1;
      return destinationPath;
    },
    async openRead() { throw new Error("not used"); },
    async delete() {},
  };
  const abort = new AbortController();
  abort.abort();

  await assert.rejects(
    putPrivateAsset(storage, "guides/test/source.webm", "unused", { signal: abort.signal }),
    PrivateAssetWriteInterruptedError,
  );
  await assert.rejects(
    materializePrivateAsset(storage, "guides/test/source.webm", "unused", { signal: abort.signal }),
    PrivateAssetReadInterruptedError,
  );
  assert.equal(writes, 0);
  assert.equal(reads, 0);
});

test("a materialization deadline releases the caller and removes a late local copy", async () => {
  const root = await temporaryDirectory();
  const destination = join(root, "source.webm");
  let releaseRead!: () => void;
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
  const storage: Storage = {
    async putFile() { throw new Error("not used"); },
    async materialize(_key, destinationPath) {
      await readReleased;
      await writeFile(destinationPath, "late private copy");
      return destinationPath;
    },
    async openRead() { throw new Error("not used"); },
    async delete() {},
  };
  let interruption: PrivateAssetReadInterruptedError | undefined;
  try {
    await materializePrivateAsset(storage, "guides/test/source.webm", destination, { timeoutMs: 20 });
    assert.fail("materialization should have timed out");
  } catch (error) {
    assert.ok(error instanceof PrivateAssetReadInterruptedError);
    interruption = error;
  }

  releaseRead();
  await interruption?.lateCleanup;
  await assert.rejects(access(destination));
});

test("timed-out deletes coalesce, preserve the durable row, and retry after settlement", async () => {
  const root = await temporaryDirectory();
  const repository = new JsonGuideRepository(join(root, "guides.json"));
  const guideId = "stalled-private-delete";
  await repository.createGuide({
    id: guideId,
    slug: guideId,
    editToken: "delete-token",
    title: "delete",
    status: "failed",
    errorCode: DELETION_PENDING,
    errorMessage: "deleting",
    originalObjectKey: `guides/${guideId}/source/private.webm`,
    sourceFilename: "private.webm",
    sourceMimeType: "video/webm",
    sourceSizeBytes: 10,
  });
  let releaseDelete!: () => void;
  const firstDelete = new Promise<void>((resolve) => { releaseDelete = resolve; });
  let deleteCalls = 0;
  const storage: Storage = {
    async putFile() { throw new Error("not used"); },
    async materialize() { throw new Error("not used"); },
    async openRead() { throw new Error("not used"); },
    async delete() {
      deleteCalls += 1;
      if (deleteCalls === 1) await firstDelete;
    },
  };
  const finalize = () => finalizeGuideDeletion(repository, storage, guideId, 8, { timeoutMs: 20 });

  const attempts = await Promise.allSettled([finalize(), finalize()]);
  assert.ok(attempts.every((result) => result.status === "rejected"));
  assert.equal(deleteCalls, 1);
  assert.equal((await repository.getGuideById(guideId))?.errorCode, DELETION_PENDING);

  releaseDelete();
  await firstDelete;
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(await finalize(), true);
  assert.equal(deleteCalls, 2);
  assert.equal(await repository.getGuideById(guideId), null);
});
