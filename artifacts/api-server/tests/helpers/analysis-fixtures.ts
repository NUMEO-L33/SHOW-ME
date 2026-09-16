import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { ANALYSIS_CONSENT_VERSION, type AnalysisProvider } from "../../src/processor/analysis-contract.js";
import { JsonGuideRepository } from "../../src/processor/repository.js";

export function fakeOutput(stepIds: readonly string[]) {
  return {
    schemaVersion: 1 as const,
    steps: stepIds.map((stepId) => ({
      stepId, shortLabel: "설정 열기", instruction: "설정 버튼을 누르세요.", action: "tap" as const,
      target: { x: 30, y: 40 }, privacy: [{ kind: "phone" as const, bounds: { x: 10, y: 20, width: 25, height: 10 } }],
      reviewReasons: [], mergeWithNext: false,
    })),
  };
}

export function fakeProvider(): AnalysisProvider {
  return {
    name: "fixture", model: "fixture-v1",
    async analyzeFrames(input, signal) {
      signal.throwIfAborted();
      return { status: "completed", output: fakeOutput(input.targets.map((frame) => frame.stepId)), inputTokens: 100, outputTokens: 20 };
    },
  };
}

export async function createAnalysisHarness(context: TestContext, stepCount = 2,
  identity = { guideId: "analysis-guide", editToken: "fixture-token" }) {
  const root = await mkdtemp(join(tmpdir(), "showme-analysis-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = new JsonGuideRepository(join(root, "guides.json"));
  const guideId = identity.guideId;
  await repository.createGuide({
    id: guideId, slug: guideId, editToken: identity.editToken, title: "private filename is not an AI title",
    status: "queued", originalObjectKey: `guides/${guideId}/source.mp4`,
    sourceFilename: "private-fixture.mp4", sourceMimeType: "video/mp4", sourceSizeBytes: 128,
  });
  await repository.claimProcessingAttempt(guideId, "media-a");
  await repository.updateStatus(guideId, "extracting");
  const guide = await repository.completeProcessingAttempt(guideId, {
    attemptId: "media-a", attemptCount: 1,
    steps: Array.from({ length: stepCount }, (_, index) => ({
      id: `step-${index}`, shortLabel: "placeholder", instruction: "placeholder", position: index,
      startMs: index * 1000, endMs: (index + 1) * 1000, representativeTimestampMs: index * 1000 + 500,
      representativeFrameKey: `guides/${guideId}/frames/${index}.jpg`,
      thumbnailFrameKey: `guides/${guideId}/frames/${index}-thumb.jpg`,
      frameWidth: 640, frameHeight: 360,
    })),
  });
  assert.ok(guide);
  const initialize = () => repository.executeAnalysisCommand(guideId, { type: "initialize" });
  const start = (runId = "run-a", baseDraftRevision = 0) => repository.executeAnalysisCommand(guideId, {
    type: "start", runId, baseDraftRevision, consentVersion: ANALYSIS_CONSENT_VERSION,
    provider: "fixture", model: "fixture-v1", promptVersion: "prompt-v1",
  });
  return { root, guideId, guide, repository, initialize, start };
}
