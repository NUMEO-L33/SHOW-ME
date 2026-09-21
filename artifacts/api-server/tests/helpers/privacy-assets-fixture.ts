import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { GuideRepository, GuideWithSteps } from "../../src/processor/domain.js";
import { analysisManifest, initialDraft } from "../../src/processor/analysis-contract.js";
import { privacyReviewState } from "../../src/processor/privacy-review.js";
import type { PrivacyCommand } from "../../src/processor/privacy-review-schema.js";

export async function reviewedAssetFixture(repository: GuideRepository, guide: GuideWithSteps) {
  const manifest = analysisManifest(guide), document = initialDraft(manifest);
  for (const step of document.steps) step.elements = [{ id: "cover", type: "privacy-mask", enabled: true, visible: false,
    zIndex: 0, bounds: { x: 0, y: 0, width: 100, height: 100 } }];
  let state = (await repository.executeAnalysisCommand(guide.id, { type: "save-editor-draft", expectedRevision: 0,
    expectedInputFingerprint: manifest.fingerprint, document }))!;
  const actions: PrivacyCommand["action"][] = [{ type: "title", confirmed: true }, ...document.steps.flatMap(step => [
    { type: "text" as const, stepId: step.id, confirmed: true }, { type: "image" as const, stepId: step.id, confirmed: true }])];
  for (const action of actions) state = (await repository.executeAnalysisCommand(guide.id, { type: "review-privacy",
    expectedRevision: state.draft!.revision, expectedInputFingerprint: manifest.fingerprint,
    expectedReviewFingerprint: privacyReviewState(guide, state)!.fingerprint, mutationId: randomUUID(), action }))!;
  assert.ok(privacyReviewState(guide, state)!.complete);
  const request = { revision: state.draft!.revision, inputFingerprint: manifest.fingerprint,
    reviewFingerprint: privacyReviewState(guide, state)!.fingerprint };
  return { state, request, manifest };
}
