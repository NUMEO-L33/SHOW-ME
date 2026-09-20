import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { createAnalysisHarness, fakeOutput } from "./helpers/analysis-fixtures.js";
import { analysisManifest, initialDraft, parseDraftDocument, type DraftDocument } from "../src/processor/analysis-contract.js";
import { transitionAnalysis, type AnalysisState } from "../src/processor/analysis-state.js";
import { privacyAfterEdit, privacyReviewState } from "../src/processor/privacy-review.js";
import type { PrivacyCommand } from "../src/processor/privacy-review-schema.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { postgresAccountingFixture } from "./helpers/accounting-postgres-fixture.js";
import { emptyFundingLedger } from "../src/processor/analysis-funding.js";
import { guideDrafts, guides } from "../src/processor/db/schema.js";

async function harness(t: TestContext, ai = false) {
  const h = await createAnalysisHarness(t), manifest = analysisManifest(h.guide);
  let state: AnalysisState;
  if (ai) {
    await h.initialize(); await h.start();
    await h.repository.executeAnalysisCommand(h.guideId, { type: "claim", runId: "run-a", attemptId: "try-a", expectedAttemptCount: 0, leaseMs: 180_000 });
    state = (await h.repository.executeAnalysisCommand(h.guideId, { type: "finish", runId: "run-a", attemptId: "try-a", attemptCount: 1,
      output: fakeOutput(manifest.frames.map(f => f.stepId)), inputTokens: 1, outputTokens: 1 }))!;
  } else state = (await h.repository.executeAnalysisCommand(h.guideId, { type: "save-editor-draft", expectedRevision: 0,
    expectedInputFingerprint: manifest.fingerprint, document: initialDraft(manifest) }))!;
  const command = (action: PrivacyCommand["action"], input = state): PrivacyCommand => ({ type: "review-privacy", action,
    expectedRevision: input.draft!.revision, expectedInputFingerprint: manifest.fingerprint,
    expectedReviewFingerprint: privacyReviewState(h.guide, input)!.fingerprint, mutationId: randomUUID() });
  const apply = async (action: PrivacyCommand["action"]) => { state = (await h.repository.executeAnalysisCommand(h.guideId, command(action)))!; assert.ok(state); return state; };
  const confirm = async () => {
    for (const s of state.draft!.document.steps) {
      const view = privacyReviewState(h.guide, state)!;
      for (const c of view.steps.find(v => v.stepId === s.id)!.candidates)
        await apply({ type: "candidate", stepId: s.id, candidateId: c.id, status: "masked", maskId: c.coveringMaskIds[0] });
      await apply({ type: "image", stepId: s.id, confirmed: true });
      await apply({ type: "text", stepId: s.id, confirmed: true });
    }
    await apply({ type: "title", confirmed: true }); return state;
  };
  return { ...h, manifest, command, apply, confirm, state: () => state };
}

test("v1 stays unconfirmed on read; explicit review upgrades to v2, persists and never publishes", async t => {
  const h = await harness(t), before = structuredClone(h.state());
  const view = privacyReviewState(h.guide, before)!;
  assert.equal(view.complete, false); assert.equal(view.steps[0].candidates.length, 0);
  assert.equal(h.state().draft!.document.schemaVersion, 1);
  assert.deepEqual(h.state(), before);
  const reviewed = await h.confirm();
  assert.equal(reviewed.draft!.document.schemaVersion, 2);
  assert.equal(privacyReviewState(h.guide, reviewed)!.complete, true);
  assert.equal(privacyReviewState(h.guide, reviewed)!.publicationEnabled, false);
  const reopened = new JsonGuideRepository(h.repository.filePath);
  assert.deepEqual(await reopened.getAnalysisState(h.guideId), reviewed);
  assert.equal((await reopened.getGuideById(h.guideId))!.status, "ready");
});

test("new review requires saved content; malformed v2, duplicate ledgers and forged ordinary writes are refused", async t => {
  const h = await harness(t);
  assert.equal(privacyReviewState(h.guide, { draft: null, runs: [] }), null);
  assert.throws(() => parseDraftDocument({ ...h.state().draft!.document, schemaVersion: 2 }, h.manifest.frames));
  const reviewed = await h.confirm(), document = structuredClone(reviewed.draft!.document);
  document.privacy!.steps.push(document.privacy!.steps[0]);
  assert.throws(() => parseDraftDocument(document, h.manifest.frames));
  for (const type of ["save-editor-draft", "save-draft"] as const) {
    const forged = structuredClone(reviewed.draft!.document); forged.privacy!.titleFingerprint = "0".repeat(64);
    const command = type === "save-editor-draft" ? { type, expectedRevision: reviewed.draft!.revision,
      expectedInputFingerprint: h.manifest.fingerprint, document: forged } : { type, expectedRevision: reviewed.draft!.revision, document: forged };
    assert.throws(() => transitionAnalysis(h.guide, reviewed, command));
  }
  const downgrade = { ...reviewed.draft!.document, schemaVersion: 1 as const }; delete downgrade.privacy;
  assert.throws(() => transitionAnalysis(h.guide, reviewed, { type: "save-editor-draft", expectedRevision: reviewed.draft!.revision,
    expectedInputFingerprint: h.manifest.fingerprint, document: downgrade }));
});

test("candidate decisions require canonical identities and a fully covering enabled mask", async t => {
  const h = await harness(t, true), step = privacyReviewState(h.guide, h.state())!.steps[0], c = step.candidates[0];
  assert.equal(c.status, "pending"); assert.equal(c.coveringMaskIds.length, 1);
  assert.equal(transitionAnalysis(h.guide, h.state(), h.command({ type: "image", stepId: step.stepId, confirmed: true })), null);
  for (const action of [
    { type: "candidate", stepId: step.stepId, candidateId: "f".repeat(64), status: "dismissed", maskId: null },
    { type: "candidate", stepId: step.stepId, candidateId: c.id, status: "masked", maskId: "foreign" },
    { type: "candidate", stepId: step.stepId, candidateId: c.id, status: "dismissed", maskId: c.coveringMaskIds[0] },
  ] as PrivacyCommand["action"][]) assert.equal(transitionAnalysis(h.guide, h.state(), h.command(action)), null);
  for (const change of ["disabled", "undersized"] as const) {
    const next = structuredClone(h.state()), mask = next.draft!.document.steps[0].elements.find(e => e.type === "privacy-mask")!;
    if (change === "disabled") mask.enabled = false; else mask.bounds.width -= 1;
    assert.equal(privacyReviewState(h.guide, next)!.steps[0].candidates[0].coveringMaskIds.length, 0);
  }
  const reviewed = await h.confirm(); assert.equal(privacyReviewState(h.guide, reviewed)!.complete, true);
  await h.apply({ type: "candidate", stepId: step.stepId, candidateId: c.id, status: "dismissed", maskId: null });
  const changed = privacyReviewState(h.guide, h.state())!.steps[0];
  assert.equal(changed.candidates[0].status, "dismissed"); assert.equal(changed.imageConfirmed, false);
  assert.equal(changed.textConfirmed, true);
});

const mutations: Array<[string, (d: DraftDocument) => void, [boolean, boolean, boolean]]> = [
  ["title", d => { d.title = "변경 제목"; }, [false, true, true]],
  ["instruction", d => { d.steps[0].instruction = "변경 설명"; }, [true, true, false]],
  ["label", d => { d.steps[0].shortLabel = "변경 이름"; }, [true, true, false]],
  ["mask", d => { d.steps[0].elements.push({ id: "manual", type: "privacy-mask", bounds: { x: 0, y: 0, width: 5, height: 5 }, enabled: true, visible: true, zIndex: 20 }); }, [true, false, true]],
  ["tap", d => { d.steps[0].elements.push({ id: "pointer", type: "tap", center: { x: 10, y: 20 }, radius: 5, visible: true, zIndex: 10 }); }, [true, true, true]],
];
for (const [name, mutate, expected] of mutations) test(`ordinary ${name} edit invalidates only affected checks, and undo cannot resurrect them`, async t => {
  const h = await harness(t), reviewed = await h.confirm(), next = structuredClone(reviewed.draft!.document);
  mutate(next); next.privacy = privacyAfterEdit(reviewed.draft!.document, next);
  const saved = transitionAnalysis(h.guide, reviewed, { type: "save-editor-draft", expectedRevision: reviewed.draft!.revision,
    expectedInputFingerprint: h.manifest.fingerprint, document: next })!;
  const view = privacyReviewState(h.guide, saved)!;
  assert.deepEqual([view.titleConfirmed, view.steps[0].imageConfirmed, view.steps[0].textConfirmed], expected);
  assert.equal(view.steps[1].imageConfirmed, true); assert.equal(view.steps[1].textConfirmed, true);
  const undo = structuredClone(reviewed.draft!.document); undo.privacy = privacyAfterEdit(saved.draft!.document, undo);
  const undone = transitionAnalysis(h.guide, saved, { type: "save-editor-draft", expectedRevision: saved.draft!.revision,
    expectedInputFingerprint: h.manifest.fingerprint, document: undo })!;
  const again = privacyReviewState(h.guide, undone)!;
  assert.deepEqual([again.titleConfirmed, again.steps[0].imageConfirmed, again.steps[0].textConfirmed], expected);
});

test("mask movement resets masked decisions; frame merge removes both old acknowledgements", async t => {
  const h = await harness(t, true), reviewed = await h.confirm(), changed = structuredClone(reviewed.draft!.document);
  const mask = changed.steps[0].elements.find(e => e.type === "privacy-mask")!; mask.bounds.x++;
  changed.privacy = privacyAfterEdit(reviewed.draft!.document, changed);
  assert.equal(changed.privacy!.steps[0].candidates[0].status, "pending");
  const merged = structuredClone(reviewed.draft!.document);
  merged.steps = [{ ...merged.steps[1], id: merged.steps[0].id, sourceStepIds: merged.steps.flatMap(s => s.sourceStepIds) }];
  merged.privacy = privacyAfterEdit(reviewed.draft!.document, merged);
  assert.deepEqual(merged.privacy!.steps, []);
});

test("new AI candidates invalidate old decisions even without a draft revision change", async t => {
  const h = await harness(t, true), reviewed = await h.confirm(), replacement = structuredClone(reviewed);
  replacement.runs.push({ ...structuredClone(replacement.runs[0]), id: "run-new" });
  const view = privacyReviewState(h.guide, replacement)!;
  assert.equal(view.complete, false); assert.equal(view.steps[0].candidates[0].status, "pending");
  assert.equal(transitionAnalysis(h.guide, replacement, h.command({ type: "image", stepId: "step-0", confirmed: true }, reviewed)), null);
});

test("exact retry is idempotent; changed mutation, concurrent edits, media replacement and deletion fail closed", async t => {
  const h = await harness(t), command = h.command({ type: "title", confirmed: true });
  const saved = (await h.repository.executeAnalysisCommand(h.guideId, command))!;
  assert.deepEqual(await h.repository.executeAnalysisCommand(h.guideId, command), saved);
  assert.equal(await h.repository.executeAnalysisCommand(h.guideId, { ...command, action: { type: "title", confirmed: false } }), null);
  assert.equal(transitionAnalysis({ ...h.guide, processingAttemptCount: 2 }, saved, command), null);
  assert.equal(transitionAnalysis({ ...h.guide, status: "failed", errorCode: "DELETION_PENDING" }, saved, command), null);
  await h.repository.deleteGuide(h.guideId);
  assert.equal(await h.repository.executeAnalysisCommand(h.guideId, command), null);
});

test("Postgres review takes the parent lock, rolls back failed writes, and replay does not extend retention", async t => {
  const h = await harness(t), fixture = postgresAccountingFixture(h.guide, h.state(), emptyFundingLedger());
  const command = h.command({ type: "title", confirmed: true });
  fixture.failWrite(guides);
  await assert.rejects(fixture.repository.executeAnalysisCommand(h.guideId, command));
  assert.deepEqual((await fixture.repository.getAnalysisState(h.guideId))?.draft, h.state().draft);
  // A new fixture separates the one injected transactional failure from success.
  const ok = postgresAccountingFixture(h.guide, h.state(), emptyFundingLedger());
  const result = await ok.repository.executeAnalysisCommand(h.guideId, command);
  assert.equal(result?.draft?.document.schemaVersion, 2);
  assert.ok(ok.locks.some(l => l.table === guides && l.mode === "update"));
  assert.deepEqual(ok.writes, [guideDrafts, guides]);
  const writes = ok.writes.length; await ok.repository.executeAnalysisCommand(h.guideId, command);
  assert.equal(ok.writes.length, writes);
});
