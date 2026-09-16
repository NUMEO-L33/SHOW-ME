import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import request from "supertest";

import { DurableAnalysisAdmission, AnalysisAdmissionError, type AnalysisAdmissionInput, type AnalysisAdmissionSnapshot, type AnalysisSpendingPolicy } from "../src/processor/analysis-admission.js";
import type { AnalysisAdmission, AnalysisRequestCommand } from "../src/processor/analysis-api.js";
import { ANALYSIS_CONSENT_VERSION, analysisManifest } from "../src/processor/analysis-contract.js";
import { loadConfig } from "../src/processor/config.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "../src/processor/gemini/request.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { createProcessorApp } from "../src/processor/server.js";
import { LocalStorage } from "../src/processor/storage.js";
import { analysisAccountingControls, analysisBudgetWindows, analysisRuns, guides } from "../src/processor/db/schema.js";
import { emptyFundingLedger } from "../src/processor/analysis-funding.js";
import { createAnalysisHarness } from "./helpers/analysis-fixtures.js";
import { postgresAccountingFixture } from "./helpers/accounting-postgres-fixture.js";

const now = new Date("2026-09-14T12:00:00.000Z");
const limits = { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicrousd: 1_000_000 };

async function harness(context: TestContext) {
  const token = randomBytes(32).toString("base64url");
  const h = await createAnalysisHarness(context, 2, { guideId: randomUUID(), editToken: token });
  const command: AnalysisRequestCommand = { type: "request", runId: randomUUID(), baseDraftRevision: 0,
    consentVersion: ANALYSIS_CONSENT_VERSION, provider: "gemini", model: GEMINI_TEST_MODEL,
    promptVersion: GEMINI_PROMPT_VERSION, expectedInputFingerprint: analysisManifest(h.guide).fingerprint };
  // Deliberately simulated claims. JSON fixtures do NOT verify a live DB, worker, quota or billing.
  const snapshot: AnalysisAdmissionSnapshot = {
    id: "fixture-readiness-v1", checkedAt: now.toISOString(), validUntil: new Date(now.valueOf() + 20_000).toISOString(),
    guideId: h.guideId, inputFingerprint: command.expectedInputFingerprint, frameCount: 2,
    model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION, scope: "approved_synthetic", inputApprovalId: "fixture-input-approval",
    runtime: { repository: "postgres-0008", dispatcher: "durable-accounted-v1", inputTokenBound: 1000, boundIncludes: "prompt-schema-targets-context" },
    policy: { version: "fixture-policy", accountingOnly: true, price: { model: GEMINI_TEST_MODEL, version: "fixture-price",
      inputMicrousdPerMillionTokens: 100000, outputMicrousdPerMillionTokens: 200000 },
      maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 1, globalLimit: { ...limits }, guideLimit: { ...limits } },
    entitlement: { mode: "free_only", projectRef: "private-project", evidenceId: "private-quota-evidence", paidFallback: false,
      providerLimits: { requestsPerMinute: 15, inputTokensPerMinute: 250_000, requestsPerDay: 100, resetTimeZone: "America/Los_Angeles" } },
  };
  let timestamp = now.valueOf(); let current = true;
  const inspections: AnalysisAdmissionInput[] = [];
  const readiness = {
    async inspect(input: AnalysisAdmissionInput, _signal: AbortSignal): Promise<unknown> { void _signal; inspections.push(input); return structuredClone(snapshot); },
    isCurrent(id: string) { return current && id === snapshot.id; },
  };
  const makeAdmission = (spending?: AnalysisSpendingPolicy) => new DurableAnalysisAdmission({ repository: h.repository, readiness, spending, clock: () => new Date(timestamp) });
  const admission = makeAdmission();
  const submit = (selected = command, signal = new AbortController().signal) => admission.request(h.guideId, selected, signal);
  const config = loadConfig({ NODE_ENV: "test", DATA_DIR: h.root, SHOWME_STORAGE: "local", CORS_ORIGINS: "http://localhost:3000" });
  const appWith = (analysisAdmission?: AnalysisAdmission) => createProcessorApp({ config, repository: h.repository,
    storage: new LocalStorage(join(h.root, "objects")), analysisAdmission,
    pipeline: { async process() { assert.fail("analysis must not call the media pipeline"); }, async processClaimed() { assert.fail("no dispatch"); } } });
  const body = (runId = command.runId) => ({ runId, baseDraftRevision: 0, consentVersion: ANALYSIS_CONSENT_VERSION, externalProcessing: true });
  const state = async () => JSON.parse(await readFile(h.repository.filePath, "utf8"));
  return { ...h, token, command, snapshot, readiness, inspections, makeAdmission, admission, submit, appWith, body, state,
    app: appWith(admission), url: `/api/guides/${h.guideId}/analysis`, authorization: `Bearer ${token}`,
    setTime: (date: Date) => { timestamp = date.valueOf(); }, setCurrent: (value: boolean) => { current = value; } };
}

test("default server admission remains closed and saves no draft, run, window or reservation", async (context) => {
  const h = await harness(context); const before = await h.state();
  const response = await request(h.appWith()).post(h.url).set("Authorization", h.authorization).send(h.body()).expect(503);
  assert.equal(response.body.code, "ANALYSIS_UNAVAILABLE");
  assert.deepEqual(await h.state(), before); assert.equal(h.inspections.length, 0);
});

test("durable HTTP admission saves the run, batches and reservation with a private safe response", async (context) => {
  const h = await harness(context);
  const responses = await Promise.all([0, 1].map(() => request(h.app).post(h.url).set("Authorization", h.authorization).send(h.body()).expect(202)));
  const state = await h.state();
  assert.equal(state.funding.reservations.length, 1); assert.equal(state.funding.batches.length, 1);
  assert.equal(state.funding.windows.length, 2); assert.equal(state.funding.attempts.length, 0);
  assert.equal(state.analysis[0].state.runs.length, 1);
  for (const response of responses) {
    assert.equal(response.body.run.status, "queued"); assert.equal(response.headers["cache-control"], "no-store");
    for (const value of [h.token, "private-project", "private-quota-evidence", "fixture-price", "policy", "maximum", "fingerprint", "ObjectKey"]) assert.ok(!response.text.includes(value));
  }
  const saved = JSON.stringify(state);
  assert.ok(!saved.includes("private-project")); assert.ok(!saved.includes("private-quota-evidence"));
  assert.deepEqual(await h.repository.getGuideById(h.guideId), h.guide);
  assert.deepEqual(Object.keys(h.inspections[0]).sort(), ["guideId", "inputFingerprint", "frameCount", "model", "promptVersion"].sort());
});

test("twenty concurrent durable admissions reserve once and reopen without new readiness", async (context) => {
  const h = await harness(context);
  const results = await Promise.all(Array.from({ length: 20 }, () => h.submit()));
  assert.ok(results.every((r) => r?.runs.length === 1));
  const saved = await h.state(); assert.equal(saved.funding.reservations.length, 1);
  const reopened = new DurableAnalysisAdmission({ repository: new JsonGuideRepository(h.repository.filePath) });
  assert.ok(await reopened.request(h.guideId, h.command, new AbortController().signal));
  assert.deepEqual(await h.state(), saved);
});

test("different run IDs race to one active reservation", async (context) => {
  const h = await harness(context);
  const results = await Promise.all([h.submit(), h.submit({ ...h.command, runId: randomUUID() })]);
  assert.equal(results.filter(Boolean).length, 1); assert.equal((await h.state()).funding.reservations.length, 1);
});

test("HTTP authentication, consent and client policy overrides fail before readiness", async (context) => {
  const h = await harness(context);
  await request(h.app).post(h.url).send(h.body()).expect(404);
  await request(h.app).post(h.url).set("Authorization", h.authorization).send({ ...h.body(), externalProcessing: false }).expect(400);
  for (const extra of [{ mode: "paid_capped" }, { policy: h.snapshot.policy }, { readiness: h.snapshot }]) {
    await request(h.app).post(h.url).set("Authorization", h.authorization).send({ ...h.body(), ...extra }).expect(400);
  }
  assert.equal(h.inspections.length, 0); assert.equal((await h.state()).funding.reservations.length, 0);
});

test("missing, malformed, unready, stale or mismatched verifier evidence leaves no partial state", async (context) => {
  const h = await harness(context); const before = await h.state();
  const cases: unknown[] = [null, {}, { ...h.snapshot, unexpected: "private" },
    { ...h.snapshot, guideId: randomUUID() }, { ...h.snapshot, inputFingerprint: "0".repeat(64) },
    { ...h.snapshot, frameCount: 3 }, { ...h.snapshot, scope: "arbitrary_user_video" },
    { ...h.snapshot, model: "other-model" }, { ...h.snapshot, promptVersion: "old-prompt" },
    { ...h.snapshot, runtime: { ...h.snapshot.runtime, dispatcher: "not-ready" } },
    { ...h.snapshot, runtime: { ...h.snapshot.runtime, repository: "local-json" } },
    { ...h.snapshot, runtime: { ...h.snapshot.runtime, repository: "postgres-0004" } },
    { ...h.snapshot, runtime: { ...h.snapshot.runtime, repository: "postgres-0005" } },
    { ...h.snapshot, runtime: { ...h.snapshot.runtime, repository: "postgres-0007" } },
    { ...h.snapshot, runtime: { ...h.snapshot.runtime, inputTokenBound: 1001 } },
    { ...h.snapshot, runtime: { ...h.snapshot.runtime, boundIncludes: "images-only" } },
    { ...h.snapshot, policy: { ...h.snapshot.policy, globalLimit: { ...limits, requests: 0 } } },
    { ...h.snapshot, validUntil: now.toISOString() },
    { ...h.snapshot, checkedAt: new Date(now.valueOf() + 1000).toISOString() },
    { ...h.snapshot, validUntil: new Date(now.valueOf() + 31_000).toISOString() },
  ];
  for (const snapshot of cases) {
    context.mock.method(h.readiness, "inspect", async () => snapshot, { times: 1 });
    await assert.rejects(h.submit(), /ANALYSIS_UNAVAILABLE/);
    assert.deepEqual(await h.state(), before);
  }
  h.setCurrent(false); await assert.rejects(h.submit(), /ANALYSIS_UNAVAILABLE/);
  assert.deepEqual(await h.state(), before);
});

test("free-only policy rejects paid fallback, excessive free quotas and paid evidence", async (context) => {
  const h = await harness(context); const before = await h.state();
  const entitlement = h.snapshot.entitlement;
  assert.equal(entitlement.mode, "free_only");
  if (entitlement.mode !== "free_only") assert.fail();
  for (const e of [
    { ...entitlement, paidFallback: true },
    { ...entitlement, providerLimits: { ...entitlement.providerLimits, requestsPerDay: 99 } },
    { ...entitlement, providerLimits: { ...entitlement.providerLimits, inputTokensPerMinute: 999 } },
    { ...entitlement, providerLimits: { ...entitlement.providerLimits, requestsPerMinute: 0 } },
    { ...entitlement, providerLimits: { ...entitlement.providerLimits, resetTimeZone: "UTC" } },
    { mode: "free_only", projectRef: "project", evidenceId: "evidence", paidFallback: false,
      dailyQuota: { requests: 100, inputTokens: 1_000_000, outputTokens: 1_000_000 } },
    { mode: "paid_capped", projectRef: "project", evidenceId: "evidence", approvalId: "approval" },
  ]) {
    context.mock.method(h.readiness, "inspect", async () => ({ ...h.snapshot, entitlement: e }), { times: 1 });
    await assert.rejects(h.submit(), /ANALYSIS_UNAVAILABLE/);
  }
  assert.deepEqual(await h.state(), before);
});

test("paid contract needs explicit matching project, approval and spending cap (fictional fixtures only)", async (context) => {
  const h = await harness(context);
  h.snapshot.entitlement = { mode: "paid_capped", projectRef: "fixture-project", approvalId: "fixture-approval", evidenceId: "fixture-evidence" };
  for (const config of [
    { mode: "paid_capped", projectRef: "other", approvalId: "fixture-approval", dailyCostMicrousd: 1_000_000 },
    { mode: "paid_capped", projectRef: "fixture-project", approvalId: "other", dailyCostMicrousd: 1_000_000 },
    { mode: "paid_capped", projectRef: "fixture-project", approvalId: "fixture-approval", dailyCostMicrousd: 999999 },
  ] as AnalysisSpendingPolicy[]) await assert.rejects(h.makeAdmission(config).request(h.guideId, h.command, new AbortController().signal), /ANALYSIS_UNAVAILABLE/);
  assert.throws(() => h.makeAdmission({ mode: "paid_capped", projectRef: "fixture-project", approvalId: "fixture-approval", dailyCostMicrousd: 0 }));
  const permitted = h.makeAdmission({ mode: "paid_capped", projectRef: "fixture-project", approvalId: "fixture-approval", dailyCostMicrousd: 1_000_000 });
  assert.ok(await permitted.request(h.guideId, h.command, new AbortController().signal));
  assert.equal((await h.state()).funding.attempts.length, 0);
});

test("revocation, expiry, midnight or abort while awaiting the writer rejects before commit", async (context) => {
  for (const reason of ["revoked", "expired", "midnight", "pacific-midnight", "aborted"] as const) {
    const h = await harness(context); const before = await h.state();
    const controller = new AbortController();
    if (reason === "midnight") {
      const at = new Date("2026-09-14T23:59:59.000Z"); h.setTime(at);
      h.snapshot.checkedAt = at.toISOString(); h.snapshot.validUntil = new Date(at.valueOf() + 20_000).toISOString();
    }
    if (reason === "pacific-midnight") {
      const at = new Date("2026-09-14T06:59:59.000Z"); h.setTime(at);
      h.snapshot.checkedAt = at.toISOString(); h.snapshot.validUntil = new Date(at.valueOf() + 20_000).toISOString();
    }
    const reserve = h.repository.reserveAnalysisRequest.bind(h.repository);
    context.mock.method(h.repository, "reserveAnalysisRequest", async (...args: Parameters<typeof reserve>) => {
      if (reason === "revoked") h.setCurrent(false);
      if (reason === "expired") h.setTime(new Date(now.valueOf() + 20_000));
      if (reason === "midnight") h.setTime(new Date("2026-09-15T00:00:00.000Z"));
      if (reason === "pacific-midnight") h.setTime(new Date("2026-09-14T07:00:00.000Z"));
      if (reason === "aborted") controller.abort(new Error("private abort reason"));
      return reserve(...args);
    });
    await assert.rejects(h.submit(h.command, controller.signal), (error: unknown) => error instanceof AnalysisAdmissionError);
    assert.deepEqual(await h.state(), before);
  }
});

test("a recent snapshot from before UTC or Pacific reset cannot admit work after the reset", async (context) => {
  for (const midnight of ["2026-09-14T00:00:00.000Z", "2026-09-14T07:00:00.000Z"]) {
    const h = await harness(context); const before = await h.state(); const at = Date.parse(midnight);
    h.snapshot.checkedAt = new Date(at - 1000).toISOString(); h.snapshot.validUntil = new Date(at + 10_000).toISOString();
    h.setTime(new Date(at)); await assert.rejects(h.submit(), /ANALYSIS_UNAVAILABLE/);
    assert.deepEqual(await h.state(), before);
  }
});

test("direct admission abort does not wait for an uncooperative verifier or save its late result", async (context) => {
  const h = await harness(context); const before = await h.state(); const controller = new AbortController();
  let release!: (value: unknown) => void; let entered!: () => void;
  const inspected = new Promise<void>((resolve) => { entered = resolve; });
  context.mock.method(h.readiness, "inspect", () => { entered(); return new Promise((resolve) => { release = resolve; }); });
  const pending = h.submit(h.command, controller.signal);
  await inspected; controller.abort(); await assert.rejects(pending, /ANALYSIS_ADMISSION_TIMEOUT/);
  release(h.snapshot); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await h.state(), before);
});

test("an already aborted request never inspects or reserves and hides its abort reason", async (context) => {
  const h = await harness(context); const before = await h.state(); const controller = new AbortController();
  controller.abort(new Error("private reason"));
  await assert.rejects(h.submit(h.command, controller.signal), (error: unknown) => error instanceof AnalysisAdmissionError && error.message === "ANALYSIS_ADMISSION_TIMEOUT");
  assert.equal(h.inspections.length, 0); assert.deepEqual(await h.state(), before);
});

test("media replacement and deletion during readiness cannot initialize stale work", async (context) => {
  for (const remove of [false, true]) {
    const h = await harness(context);
    context.mock.method(h.readiness, "inspect", async () => {
      if (remove) await h.repository.deleteGuide(h.guideId);
      else await h.repository.replaceSteps(h.guideId, h.guide.steps.map((s) => ({ ...s, representativeFrameKey: `new/${s.id}.jpg` })));
      return h.snapshot;
    });
    assert.equal(await h.submit(), null);
    const saved = await h.state(); assert.equal(saved.funding.reservations.length, 0); assert.equal(saved.analysis.length, 0);
  }
});

test("HTTP budget rejection is 429 without reservation details and keeps lookup and cancellation available", async (context) => {
  const h = await harness(context); h.snapshot.policy.guideLimit.requests = 2;
  await request(h.app).post(h.url).set("Authorization", h.authorization).send(h.body()).expect(202);
  await request(h.app).post(`${h.url}/${h.command.runId}/cancel`).set("Authorization", h.authorization).expect(200);
  const before = await h.state();
  const rejected = await request(h.app).post(h.url).set("Authorization", h.authorization).send(h.body(randomUUID())).expect(429);
  assert.equal(rejected.body.code, "ANALYSIS_BUDGET_LIMIT"); assert.equal(rejected.headers["cache-control"], "no-store");
  assert.ok(!rejected.text.includes("costMicrousd")); assert.deepEqual(await h.state(), before);
  await request(h.app).get(`${h.url}/${h.command.runId}`).set("Authorization", h.authorization).expect(200);
  await request(h.app).post(`${h.url}/${h.command.runId}/cancel`).set("Authorization", h.authorization).expect(200);
});

test("durable lost commit acknowledgement replays through HTTP without rechecking permission", async (context) => {
  const h = await harness(context);
  const hook = h.repository as unknown as { writeState(state: unknown): Promise<void> };
  const write = hook.writeState.bind(h.repository);
  context.mock.method(hook, "writeState", async (state: unknown) => { await write(state); throw new Error("private lost acknowledgement"); }, { times: 1 });
  await request(h.app).post(h.url).set("Authorization", h.authorization).send(h.body()).expect(503);
  const saved = await h.state(); const calls = h.inspections.length; h.setCurrent(false);
  await request(h.app).post(h.url).set("Authorization", h.authorization).send(h.body()).expect(202);
  assert.equal(h.inspections.length, calls); assert.deepEqual(await h.state(), saved);
});

test("HTTP readiness timeout stays bounded and a late snapshot cannot initialize work", async (context) => {
  const h = await harness(context); const before = await h.state(); let release!: (value: unknown) => void;
  context.mock.method(h.readiness, "inspect", async () => new Promise((resolve) => { release = resolve; }));
  const response = await request(h.app).post(h.url).set("Authorization", h.authorization).send(h.body()).expect(503);
  assert.equal(response.body.code, "ANALYSIS_ADMISSION_TIMEOUT");
  release(h.snapshot); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await h.state(), before);
});

test("readiness and storage exceptions are redacted from HTTP and logs", async (context) => {
  const h = await harness(context); const logs = context.mock.method(console, "error", () => {});
  context.mock.method(h.readiness, "inspect", async () => { throw new Error(`private-verifier:${h.token}`); }, { times: 1 });
  const response = await request(h.app).post(h.url).set("Authorization", h.authorization).send(h.body()).expect(503);
  assert.equal(response.body.code, "ANALYSIS_UNAVAILABLE");
  assert.ok(!JSON.stringify(logs.mock.calls).includes(h.token)); assert.ok(!response.text.includes("private-verifier"));
  assert.equal((await h.state()).funding.reservations.length, 0);
  context.mock.method(h.repository, "reserveAnalysisRequest", async () => { throw new Error(`private-database:${h.token}`); }, { times: 1 });
  const failure = await request(h.app).post(h.url).set("Authorization", h.authorization).send(h.body()).expect(503);
  assert.equal(failure.body.code, "ANALYSIS_UNAVAILABLE");
  assert.ok(!JSON.stringify(logs.mock.calls).includes(h.token)); assert.ok(!failure.text.includes("private-database"));
});

test("the global budget rejects a different guide through durable admission without partial state", async (context) => {
  const h = await harness(context); h.snapshot.policy.globalLimit.requests = 2;
  const secondId = randomUUID();
  await h.repository.createGuide({ id: secondId, slug: secondId, editToken: randomBytes(32).toString("base64url"), title: "fixture",
    status: "queued", originalObjectKey: `second/source.mp4`, sourceFilename: "synthetic.mp4", sourceMimeType: "video/mp4", sourceSizeBytes: 128 });
  await h.repository.claimProcessingAttempt(secondId, "media-second"); await h.repository.updateStatus(secondId, "extracting");
  const second = await h.repository.completeProcessingAttempt(secondId, { attemptId: "media-second", attemptCount: 1,
    steps: h.guide.steps.map((s) => ({ ...s, id: `second-${s.id}`, representativeFrameKey: `second/${s.id}.jpg` })) });
  assert.ok(second);
  const readiness = { ...h.readiness, async inspect(input: AnalysisAdmissionInput) { return { ...h.snapshot, ...input }; } };
  const admission = new DurableAnalysisAdmission({ repository: h.repository, readiness, clock: () => new Date(now) });
  const outcomes = await Promise.allSettled([
    admission.request(h.guideId, h.command, new AbortController().signal),
    admission.request(secondId, { ...h.command, runId: randomUUID(), expectedInputFingerprint: analysisManifest(second).fingerprint }, new AbortController().signal),
  ]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled" && o.value).length, 1);
  const failure = outcomes.find((o) => o.status === "rejected");
  assert.ok(failure?.status === "rejected" && failure.reason instanceof AnalysisAdmissionError);
  assert.equal(failure.reason.code, "ANALYSIS_BUDGET_LIMIT");
  const saved = await h.state(); assert.equal(saved.analysis.length, 1);
  assert.equal(saved.funding.reservations.length, 1); assert.equal(saved.funding.windows.length, 2);
});

test("an accounting halt blocks new HTTP admission while saved status and cancellation remain accessible", async (context) => {
  const h = await harness(context); await h.submit();
  const identity = { runId: h.command.runId, batchIndex: 0, ordinal: 0 as const, dispatchId: "fixture-dispatch" };
  await h.repository.executeAnalysisAccounting(h.guideId, { type: "allocate", ...identity }, now);
  await h.repository.executeAnalysisAccounting(h.guideId, { type: "sending", ...identity }, now);
  await h.repository.executeAnalysisAccounting(h.guideId, { type: "settle", ...identity, usage: { status: "known", inputTokens: 1001, outputTokens: 20 } }, now);
  await request(h.app).get(`${h.url}/${h.command.runId}`).set("Authorization", h.authorization).expect(200);
  await request(h.app).post(`${h.url}/${h.command.runId}/cancel`).set("Authorization", h.authorization).expect(200);
  const before = await h.state();
  const response = await request(h.app).post(h.url).set("Authorization", h.authorization).send(h.body(randomUUID())).expect(503);
  assert.equal(response.body.code, "ANALYSIS_UNAVAILABLE"); assert.deepEqual(await h.state(), before);
  await request(h.app).post(h.url).set("Authorization", h.authorization).send(h.body()).expect(200);
});

test("a policy version change cannot reset an active day's counters through admission", async (context) => {
  const h = await harness(context); await h.submit();
  await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: h.command.runId });
  const before = await h.state(); h.snapshot.policy.version = "changed";
  await assert.rejects(h.submit({ ...h.command, runId: randomUUID() }), /ANALYSIS_UNAVAILABLE/);
  assert.deepEqual(await h.state(), before);
});

test("readiness snapshots are copied before awaiting storage, not mutated by the verifier", async (context) => {
  const h = await harness(context);
  context.mock.method(h.readiness, "inspect", async () => h.snapshot);
  const reserve = h.repository.reserveAnalysisRequest.bind(h.repository);
  context.mock.method(h.repository, "reserveAnalysisRequest", async (...args: Parameters<typeof reserve>) => {
    h.snapshot.policy.globalLimit.requests = 1;
    return reserve(...args);
  });
  assert.ok(await h.submit());
  assert.equal((await h.state()).funding.reservations[0].details.policy.globalLimit.requests, 100);
});

test("storage precommit rejection changes nothing and durable replay skips that guard", async (context) => {
  const h = await harness(context); const before = await h.state();
  await assert.rejects(h.repository.reserveAnalysisRequest(h.guideId, h.command, h.snapshot.policy, now, () => { throw new Error("revoked"); }));
  assert.deepEqual(await h.state(), before);
  await h.submit();
  const saved = await h.state();
  const replay = await h.repository.reserveAnalysisRequest(h.guideId, h.command, h.snapshot.policy, now, () => { assert.fail("replay must not re-admit"); });
  assert.equal(replay?.replayed, true); assert.deepEqual(await h.state(), saved);
});

test("Postgres precommit guard runs under locks and rolls back provisional windows (transaction double)", async (context) => {
  const h = await harness(context);
  const pg = postgresAccountingFixture(h.guide, { draft: null, runs: [] }, emptyFundingLedger());
  let checks = 0;
  await assert.rejects(pg.repository.reserveAnalysisRequest(h.guideId, h.command, h.snapshot.policy, now, () => {
    checks += 1; throw new Error("readiness revoked");
  }), /readiness revoked/);
  assert.equal(checks, 1);
  assert.deepEqual(pg.locks, [analysisAccountingControls, analysisBudgetWindows, analysisBudgetWindows, guides].map((table) => ({ table, mode: "update" })));
  assert.deepEqual(pg.rows(analysisBudgetWindows), []); assert.deepEqual(pg.rows(analysisRuns), []);
});

test("accidentally asynchronous precommit guards cannot bypass validation or partially save", async (context) => {
  const h = await harness(context); const before = await h.state();
  for (const guard of [async () => {}, async () => { throw new Error("private async rejection"); }]) {
    await assert.rejects(h.repository.reserveAnalysisRequest(h.guideId, h.command, h.snapshot.policy, now, guard), /must be synchronous/);
    assert.deepEqual(await h.state(), before);
  }
});

test("truthy or asynchronous readiness checks cannot bypass the synchronous commit guard", async (context) => {
  const h = await harness(context); const before = await h.state();
  for (const check of [() => "true", async () => true, async () => { throw new Error("private async readiness error"); }]) {
    context.mock.method(h.readiness, "isCurrent", check as unknown as (id: string) => boolean, { times: 1 });
    await assert.rejects(h.submit(), /ANALYSIS_UNAVAILABLE/);
    assert.deepEqual(await h.state(), before);
  }
});
