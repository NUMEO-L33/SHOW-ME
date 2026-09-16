import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { JsonGuideRepository } from "../src/processor/repository.js";

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "showme-repository-test-"));
  const repository = new JsonGuideRepository(join(root, "guides.json"));
  await repository.createGuide({
    id: "attempt-guide",
    ownerId: null,
    slug: "attempt-guide",
    editToken: "test-edit-token",
    title: "Attempt test",
    status: "queued",
    originalObjectKey: "guides/attempt-guide/source.mp4",
    sourceFilename: "source.mp4",
    sourceMimeType: "video/mp4",
    sourceSizeBytes: 128,
  });
  return { root, repository };
}

test("processing attempt CAS prevents stale status and step publication", async (context) => {
  const { root, repository } = await createRepository();
  context.after(() => rm(root, { recursive: true, force: true }));

  const first = await repository.claimProcessingAttempt("attempt-guide", "attempt-a", {
    expectedStatuses: ["queued"],
    expectedProcessingAttemptId: null,
    expectedProcessingAttemptCount: 0,
    maxAttempts: 3,
  });
  assert.ok(first);
  assert.equal(first.status, "probing");
  assert.equal(first.processingAttemptId, "attempt-a");
  assert.equal(first.processingAttemptCount, 1);

  assert.equal(
    await repository.claimProcessingAttempt("attempt-guide", "attempt-b", {
      expectedStatuses: ["queued"],
      expectedProcessingAttemptId: null,
      expectedProcessingAttemptCount: 0,
      maxAttempts: 3,
    }),
    null,
  );
  assert.equal(
    await repository.updateStatus("attempt-guide", "extracting", {
      expectedStatuses: ["probing"],
      expectedProcessingAttemptId: "attempt-b",
      expectedProcessingAttemptCount: 1,
    }),
    null,
  );

  const extracting = await repository.updateStatus("attempt-guide", "extracting", {
    expectedStatuses: ["probing"],
    expectedProcessingAttemptId: "attempt-a",
    expectedProcessingAttemptCount: 1,
  });
  assert.equal(extracting?.status, "extracting");

  assert.equal(
    await repository.completeProcessingAttempt("attempt-guide", {
      attemptId: "attempt-b",
      attemptCount: 1,
      steps: [{
        shortLabel: "stale",
        instruction: "must not publish",
        startMs: 0,
        endMs: 1_000,
      }],
    }),
    null,
  );
  assert.equal((await repository.getGuideById("attempt-guide"))?.steps.length, 0);

  const completed = await repository.completeProcessingAttempt("attempt-guide", {
    attemptId: "attempt-a",
    attemptCount: 1,
    steps: [{
      shortLabel: "current",
      instruction: "publish this step",
      startMs: 0,
      endMs: 1_000,
    }],
  });
  assert.ok(completed);
  assert.equal(completed.status, "ready");
  assert.equal(completed.progress, 100);
  assert.equal(completed.steps.length, 1);
  assert.equal(completed.steps[0].shortLabel, "current");
});

test("attempt count survives retries and atomically poisons an exhausted job", async (context) => {
  const { root, repository } = await createRepository();
  context.after(() => rm(root, { recursive: true, force: true }));

  const first = await repository.claimProcessingAttempt("attempt-guide", "attempt-a", {
    maxAttempts: 2,
  });
  assert.equal(first?.processingAttemptCount, 1);
  await repository.updateStatus("attempt-guide", "failed", {
    expectedStatuses: ["probing"],
    expectedProcessingAttemptId: "attempt-a",
    expectedProcessingAttemptCount: 1,
    errorCode: "TEST_FAILURE",
    errorMessage: "retryable",
  });
  const requeuedFirst = await repository.updateStatus("attempt-guide", "queued", {
    expectedStatuses: ["failed"],
  });
  assert.equal(requeuedFirst?.processingAttemptId, null);
  assert.equal(requeuedFirst?.processingAttemptCount, 1);

  const second = await repository.claimProcessingAttempt("attempt-guide", "attempt-b", {
    expectedStatuses: ["queued"],
    expectedProcessingAttemptId: null,
    expectedProcessingAttemptCount: 1,
    maxAttempts: 2,
  });
  assert.equal(second?.processingAttemptCount, 2);
  assert.equal(
    await repository.updateStatus("attempt-guide", "failed", {
      expectedStatuses: ["probing"],
      expectedProcessingAttemptId: "attempt-a",
      expectedProcessingAttemptCount: 1,
      errorCode: "STALE_FAILURE",
    }),
    null,
  );
  await repository.updateStatus("attempt-guide", "failed", {
    expectedStatuses: ["probing"],
    expectedProcessingAttemptId: "attempt-b",
    expectedProcessingAttemptCount: 2,
    errorCode: "TEST_FAILURE",
    errorMessage: "retryable",
  });
  await repository.updateStatus("attempt-guide", "queued", {
    expectedStatuses: ["failed"],
  });

  const exhausted = await repository.claimProcessingAttempt("attempt-guide", "attempt-c", {
    expectedStatuses: ["queued"],
    expectedProcessingAttemptId: null,
    expectedProcessingAttemptCount: 2,
    maxAttempts: 2,
  });
  assert.ok(exhausted);
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.processingAttemptId, null);
  assert.equal(exhausted.processingAttemptCount, 2);
  assert.equal(exhausted.errorCode, "PROCESSING_ATTEMPTS_EXHAUSTED");
});

test("attempt count prevents ABA when an attempt id is reused", async (context) => {
  const { root, repository } = await createRepository();
  context.after(() => rm(root, { recursive: true, force: true }));

  await repository.claimProcessingAttempt("attempt-guide", "reused-id", {
    maxAttempts: 3,
  });
  await repository.updateStatus("attempt-guide", "failed", {
    expectedStatuses: ["probing"],
    expectedProcessingAttemptId: "reused-id",
    expectedProcessingAttemptCount: 1,
    errorCode: "TEST_FAILURE",
  });
  await repository.updateStatus("attempt-guide", "queued", {
    expectedStatuses: ["failed"],
  });
  const second = await repository.claimProcessingAttempt("attempt-guide", "reused-id", {
    expectedProcessingAttemptId: null,
    expectedProcessingAttemptCount: 1,
    maxAttempts: 3,
  });
  assert.equal(second?.processingAttemptCount, 2);

  assert.equal(
    await repository.updateStatus("attempt-guide", "failed", {
      expectedStatuses: ["probing"],
      expectedProcessingAttemptId: "reused-id",
      expectedProcessingAttemptCount: 1,
      errorCode: "STALE_FAILURE",
    }),
    null,
  );
  assert.equal((await repository.getGuideById("attempt-guide"))?.status, "probing");
});

test("legacy JSON guides are normalized with initial attempt metadata", async (context) => {
  const { root, repository } = await createRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const raw = JSON.parse(await readFile(repository.filePath, "utf8")) as {
    guides: Array<Record<string, unknown>>;
  };
  delete raw.guides[0].processingAttemptId;
  delete raw.guides[0].processingAttemptCount;
  await writeFile(repository.filePath, `${JSON.stringify(raw)}\n`, "utf8");

  const reopened = new JsonGuideRepository(repository.filePath);
  const guide = await reopened.getGuideById("attempt-guide");
  assert.equal(guide?.processingAttemptId, null);
  assert.equal(guide?.processingAttemptCount, 0);
});

test("deletion and retry CAS guards cannot overwrite each other", async (context) => {
  const { root, repository } = await createRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  await repository.updateStatus("attempt-guide", "failed", {
    expectedStatuses: ["queued"],
    expectedErrorCode: null,
    errorCode: "PROCESSING_FAILED",
    errorMessage: "retryable",
  });

  const deletionClaim = await repository.updateStatus("attempt-guide", "failed", {
    expectedStatuses: ["failed"],
    expectedProcessingAttemptId: null,
    expectedProcessingAttemptCount: 0,
    expectedErrorCode: "PROCESSING_FAILED",
    errorCode: "DELETION_PENDING",
    errorMessage: "deleting",
  });
  assert.equal(deletionClaim?.errorCode, "DELETION_PENDING");
  assert.equal(
    await repository.updateStatus("attempt-guide", "queued", {
      expectedStatuses: ["failed"],
      expectedProcessingAttemptId: null,
      expectedProcessingAttemptCount: 0,
      expectedErrorCode: "PROCESSING_FAILED",
    }),
    null,
  );

  assert.equal(await repository.deleteGuide("attempt-guide", {
    expectedStatuses: ["failed"],
    expectedProcessingAttemptId: null,
    expectedProcessingAttemptCount: 0,
    expectedErrorCode: "PROCESSING_FAILED",
  }), false);
  assert.equal(await repository.deleteGuide("attempt-guide", {
    expectedStatuses: ["failed"],
    expectedProcessingAttemptId: null,
    expectedProcessingAttemptCount: 0,
    expectedErrorCode: "DELETION_PENDING",
  }), true);
  assert.equal(await repository.getGuideById("attempt-guide"), null);
});

test("only one uploader can claim an exact durable upload snapshot", async (context) => {
  const { root, repository } = await createRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploading = await repository.updateStatus("attempt-guide", "uploading", {
    expectedStatuses: ["queued"],
  });
  assert.ok(uploading);

  const [first, second] = await Promise.all([
    repository.claimUploadLease("attempt-guide", "upload-lease-a", {
      expectedProcessingAttemptId: uploading.processingAttemptId,
      expectedUpdatedAt: uploading.updatedAt,
    }),
    repository.claimUploadLease("attempt-guide", "upload-lease-b", {
      expectedProcessingAttemptId: uploading.processingAttemptId,
      expectedUpdatedAt: uploading.updatedAt,
    }),
  ]);
  const winner = first ?? second;
  assert.ok(winner);
  assert.equal(Number(Boolean(first)) + Number(Boolean(second)), 1);
  assert.equal(winner.processingAttemptCount, 0);
  assert.equal(await repository.renewUploadLease("attempt-guide", "not-the-owner"), null);
  assert.ok(await repository.renewUploadLease("attempt-guide", winner.processingAttemptId ?? ""));
});

test("failed error-code filtering happens before the result limit", async (context) => {
  const { root, repository } = await createRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  await repository.updateStatus("attempt-guide", "failed", {
    expectedStatuses: ["queued"],
    errorCode: "ORDINARY_FAILURE",
  });
  await repository.createGuide({
    id: "pending-cleanup-guide",
    slug: "pending-cleanup-guide",
    editToken: "pending-token",
    title: "Pending cleanup",
    status: "failed",
    errorCode: "DELETION_PENDING",
    originalObjectKey: "guides/pending-cleanup-guide/source.mp4",
    sourceFilename: "source.mp4",
    sourceMimeType: "video/mp4",
    sourceSizeBytes: 128,
  });

  const pending = await repository.listFailedByErrorCodes(["DELETION_PENDING"], 1);
  assert.deepEqual(pending.map((guide) => guide.id), ["pending-cleanup-guide"]);
  const ordinary = await repository.listFailedExcludingErrorCodes(["DELETION_PENDING"], 1);
  assert.deepEqual(ordinary.map((guide) => guide.id), ["attempt-guide"]);
});
