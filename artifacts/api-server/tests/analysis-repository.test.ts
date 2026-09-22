import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";

import { ANALYSIS_CONSENT_VERSION } from "../src/processor/analysis-contract.js";
import { emptyAnalysisState, transitionAnalysis } from "../src/processor/analysis-state.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { createAnalysisHarness, fakeOutput } from "./helpers/analysis-fixtures.js";

test("analysis state initializes lazily and survives reopening a legacy JSON repository", async (context) => {
  const { repository, guideId, initialize } = await createAnalysisHarness(context);
  const legacy = JSON.parse(await readFile(repository.filePath, "utf8"));
  legacy.version = 1;
  delete legacy.privacyAssets;
  delete legacy.publicationJobs; delete legacy.publications; delete legacy.publicationHeads; delete legacy.privateCleanup;
  delete legacy.funding;
  delete legacy.analysis;
  await writeFile(repository.filePath, JSON.stringify(legacy));
  const draft = (await initialize())?.draft;
  assert.equal(draft?.revision, 0);
  const reopened = new JsonGuideRepository(repository.filePath);
  assert.deepEqual((await reopened.getAnalysisState(guideId))?.draft, draft);
  assert.deepEqual(await initialize(), await repository.getAnalysisState(guideId));
  const corrupted = JSON.parse(await readFile(repository.filePath, "utf8"));
  corrupted.analysis = null;
  await writeFile(repository.filePath, JSON.stringify(corrupted));
  await assert.rejects(() => reopened.getAnalysisState(guideId));
});

test("analysis requires current consent, deduplicates a run and admits only one active run", async (context) => {
  const { repository, guideId, initialize, start } = await createAnalysisHarness(context);
  await initialize();
  await assert.rejects(() => repository.executeAnalysisCommand(guideId, {
    type: "start", runId: "run-a", baseDraftRevision: 0, consentVersion: "old-consent",
    provider: "fixture", model: "fixture-v1", promptVersion: "prompt-v1",
  }));
  const [first, second] = await Promise.all([start(), start("run-b")]);
  assert.ok(first);
  assert.equal(second, null);
  assert.deepEqual(await start(), first);
  assert.equal((await repository.getGuideById(guideId))?.processingAttemptId, "media-a");
});

test("first valid analysis atomically creates a private draft without changing media steps", async (context) => {
  const { repository, guideId, guide, initialize, start } = await createAnalysisHarness(context);
  await initialize();
  await start();
  const [a, b] = await Promise.all([
    repository.executeAnalysisCommand(guideId, { type: "claim", runId: "run-a", attemptId: "a", expectedAttemptCount: 0, leaseMs: 10000 }),
    repository.executeAnalysisCommand(guideId, { type: "claim", runId: "run-a", attemptId: "b", expectedAttemptCount: 0, leaseMs: 10000 }),
  ]);
  assert.ok(a);
  assert.equal(b, null);
  const completed = await repository.executeAnalysisCommand(guideId, {
    type: "finish", runId: "run-a", attemptId: "a", attemptCount: 1,
    output: fakeOutput(guide.steps.map((step) => step.id)), inputTokens: 100, outputTokens: 20,
  });
  assert.equal(completed?.draft?.revision, 1);
  assert.equal(completed?.runs[0].appliedDraftRevision, 1);
  assert.equal(completed?.draft?.document.steps[0].privacyReview, "pending");
  assert.equal(completed?.draft?.document.steps[0].elements.length, 2);
  assert.deepEqual(await repository.getGuideById(guideId), guide);
});

test("a human revision wins over late analysis and stale saves are rejected", async (context) => {
  const { repository, guideId, guide, initialize, start } = await createAnalysisHarness(context);
  const initialized = await initialize();
  assert.ok(initialized?.draft);
  await start();
  await repository.executeAnalysisCommand(guideId, { type: "claim", runId: "run-a", attemptId: "a", expectedAttemptCount: 0, leaseMs: 10000 });
  const document = { ...initialized.draft.document, title: "사람이 수정한 제목" };
  assert.ok(await repository.executeAnalysisCommand(guideId, { type: "save-draft", expectedRevision: 0, document }));
  assert.equal(await repository.executeAnalysisCommand(guideId, { type: "save-draft", expectedRevision: 0, document }), null);
  const completed = await repository.executeAnalysisCommand(guideId, {
    type: "finish", runId: "run-a", attemptId: "a", attemptCount: 1,
    output: fakeOutput(guide.steps.map((step) => step.id)), inputTokens: 100, outputTokens: 20,
  });
  assert.equal(completed?.runs[0].status, "succeeded");
  assert.equal(completed?.runs[0].appliedDraftRevision, null);
  assert.deepEqual(completed?.draft?.document, document);
});

test("cancel and whole-guide deletion prevent late completions and remove all analysis records", async (context) => {
  const { repository, guideId, guide, initialize, start } = await createAnalysisHarness(context);
  await initialize();
  await start();
  await repository.executeAnalysisCommand(guideId, { type: "claim", runId: "run-a", attemptId: "a", expectedAttemptCount: 0, leaseMs: 10000 });
  await repository.executeAnalysisCommand(guideId, { type: "cancel", runId: "run-a" });
  const finish = { type: "finish" as const, runId: "run-a", attemptId: "a", attemptCount: 1, output: fakeOutput(guide.steps.map((step) => step.id)), inputTokens: 0, outputTokens: 0 };
  assert.equal(await repository.executeAnalysisCommand(guideId, finish), null);
  await start("run-b");
  await repository.updateStatus(guideId, "failed", { errorCode: "DELETION_PENDING" });
  assert.equal(await repository.executeAnalysisCommand(guideId, { type: "claim", runId: "run-b", attemptId: "b", expectedAttemptCount: 0, leaseMs: 10000 }), null);
  assert.equal(await repository.executeAnalysisCommand(guideId, { type: "initialize" }), null);
  assert.ok(await repository.deleteGuide(guideId));
  assert.equal(await repository.getAnalysisState(guideId), null);
  assert.equal(await repository.executeAnalysisCommand(guideId, finish), null);
  assert.deepEqual(JSON.parse(await readFile(repository.filePath, "utf8")).analysis, []);
});

test("a replaced media input cannot accept an older analysis result", async (context) => {
  const { repository, guideId, guide, initialize, start } = await createAnalysisHarness(context);
  await initialize();
  await start();
  await repository.executeAnalysisCommand(guideId, { type: "claim", runId: "run-a", attemptId: "a", expectedAttemptCount: 0, leaseMs: 10000 });
  await repository.replaceSteps(guideId, guide.steps.map((step) => ({ ...step, representativeFrameKey: `${step.id}-new.jpg` })));
  assert.equal(await repository.executeAnalysisCommand(guideId, {
    type: "finish", runId: "run-a", attemptId: "a", attemptCount: 1,
    output: fakeOutput(guide.steps.map((step) => step.id)), inputTokens: 1, outputTokens: 1,
  }), null);
});

test("shared transaction reducer fences expired/ABA attempts and enforces a retry cap", async (context) => {
  const { guide } = await createAnalysisHarness(context);
  const date = new Date("2026-09-12T00:00:00.000Z");
  let state = transitionAnalysis(guide, emptyAnalysisState(), { type: "initialize" }, date)!;
  state = transitionAnalysis(guide, state, {
    type: "start", runId: "r", baseDraftRevision: 0, consentVersion: ANALYSIS_CONSENT_VERSION,
    provider: "fixture", model: "fixture-v1", promptVersion: "v1",
  }, date)!;
  for (let count = 0; count < 3; count++) {
    state = transitionAnalysis(guide, state, { type: "claim", runId: "r", attemptId: "reused", expectedAttemptCount: count, leaseMs: 10 }, new Date(date.getTime() + count * 20))!;
    assert.ok(state);
    assert.equal(transitionAnalysis(guide, state, { type: "finish", runId: "r", attemptId: "reused", attemptCount: count, output: {}, inputTokens: 0, outputTokens: 0 }, date), null);
  }
  assert.equal(transitionAnalysis(guide, state, { type: "claim", runId: "r", attemptId: "fourth", expectedAttemptCount: 3, leaseMs: 10 }, new Date(date.getTime() + 100)), null);
  assert.equal(transitionAnalysis(guide, state, { type: "finish", runId: "r", attemptId: "reused", attemptCount: 3, output: fakeOutput(guide.steps.map((step) => step.id)), inputTokens: 0, outputTokens: 0 }, new Date(date.getTime() + 100)), null);
});
