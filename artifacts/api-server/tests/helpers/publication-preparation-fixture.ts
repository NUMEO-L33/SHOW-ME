import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GuideRepository, GuideWithSteps } from "../../src/processor/domain.js";
import type { PublicationJobRepository } from "../../src/processor/publication-jobs.js";
import { LocalStorage } from "../../src/processor/storage.js";
import { syntheticAnalysisInput } from "../../src/processor/gemini/synthetic.js";
import { encodePrivacyPng, type renderPrivateRedaction } from "../../src/processor/privacy-render.js";
import { reviewedAssetFixture } from "./privacy-assets-fixture.js";
import { testMediaPaths } from "./media-binaries.js";

export async function publicationPreparationFixture(repository: GuideRepository & PublicationJobRepository, guide: GuideWithSteps, root: string) {
  const reviewed = await reviewedAssetFixture(repository, guide), storage = new LocalStorage(join(root, "objects"));
  const source = Buffer.from((await syntheticAnalysisInput()).images[0].bytes), file = join(root, "synthetic.jpg");
  await writeFile(file, source);
  for (const step of guide.steps) await storage.putFile(step.representativeFrameKey!, file);
  const request = { type: "request" as const, id: randomUUID(), expectedDraftRevision: reviewed.request.revision,
    expectedInputFingerprint: reviewed.request.inputFingerprint, expectedReviewFingerprint: reviewed.request.reviewFingerprint,
    originalSharingEnabled: false };
  const job = await repository.executePublicationCommand(guide.id, request); assert.ok(job);
  const options = { repository, storage, guideId: guide.id, jobId: job.id, expectedVersion: job.version,
    workDir: join(root, "work"), ffmpegPath: testMediaPaths().ffmpegPath, signal: new AbortController().signal };
  const fastRender: typeof renderPrivateRedaction = async () => encodePrivacyPng(Buffer.alloc(3), 1, 1);
  return { ...reviewed, source, storage, job, options, fastRender };
}
