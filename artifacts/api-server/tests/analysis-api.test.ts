import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import request from "supertest";

import { ANALYSIS_API_MODEL, AnalysisApiError, type AnalysisAdmission, type AnalysisRequestCommand } from "../src/processor/analysis-api.js";
import { ANALYSIS_CONSENT_VERSION, analysisManifest } from "../src/processor/analysis-contract.js";
import { executeAnalysisAttempt } from "../src/processor/analysis-runner.js";
import type { AnalysisState } from "../src/processor/analysis-state.js";
import { loadConfig } from "../src/processor/config.js";
import { GEMINI_PROMPT_VERSION } from "../src/processor/gemini/request.js";
import { JsonGuideRepository } from "../src/processor/repository.js";
import { createProcessorApp } from "../src/processor/server.js";
import { LocalStorage } from "../src/processor/storage.js";
import { fakeOutput } from "./helpers/analysis-fixtures.js";

function body(runId = randomUUID(), baseDraftRevision = 0) {
  return { runId, baseDraftRevision, consentVersion: ANALYSIS_CONSENT_VERSION, externalProcessing: true };
}

async function harness(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "showme-analysis-api-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = new JsonGuideRepository(join(root, "guides.json"));
  const storage = new LocalStorage(join(root, "objects"));
  const guideId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await repository.createGuide({ id: guideId, slug: guideId, editToken: token,
    title: "private filename", status: "queued", originalObjectKey: `guides/${guideId}/private-source.mp4`,
    sourceFilename: "private-recording.mp4", sourceMimeType: "video/mp4", sourceSizeBytes: 12 });
  await repository.claimProcessingAttempt(guideId, "private-media-attempt");
  await repository.updateStatus(guideId, "extracting");
  const guide = await repository.completeProcessingAttempt(guideId, { attemptId: "private-media-attempt", attemptCount: 1,
    steps: [0, 1].map((position) => ({ id: `step-${position}`, position, shortLabel: "placeholder", instruction: "placeholder",
      startMs: position * 1000, endMs: (position + 1) * 1000, representativeTimestampMs: position * 1000 + 500,
      representativeFrameKey: `guides/${guideId}/private-frame-${position}.jpg`,
      thumbnailFrameKey: `guides/${guideId}/private-thumb-${position}.jpg`, frameWidth: 640, frameHeight: 360 })),
  });
  assert.ok(guide);
  const config = loadConfig({ NODE_ENV: "test", DATA_DIR: root, SHOWME_STORAGE: "local", CORS_ORIGINS: "http://localhost:3000" });
  const submissions: AnalysisRequestCommand[] = [];
  // Deliberately test-only: no worker, image loader, Google call or operating budget.
  const admission: AnalysisAdmission = { async request(id, command, signal) {
    signal.throwIfAborted(); submissions.push(command);
    return repository.executeAnalysisCommand(id, command);
  } };
  const appWith = (analysisAdmission?: AnalysisAdmission, ready = true) => createProcessorApp({
    config, repository, storage, readiness: { ready }, analysisAdmission,
    pipeline: { async process() {}, async processClaimed() {} },
  });
  const app = appWith(admission);
  const url = `/api/guides/${guideId}/analysis`;
  const authorization = `Bearer ${token}`;
  return { root, repository, guide, guideId, token, admission, submissions, appWith, app, url, authorization };
}

test("analysis startup is disabled without durable admission and creates no draft or queued run", async (context) => {
  const h = await harness(context);
  const before = await h.repository.getAnalysisState(h.guideId);
  const result = await request(h.appWith()).post(h.url).set("Authorization", h.authorization).send(body()).expect(503);
  assert.equal(result.body.code, "ANALYSIS_UNAVAILABLE");
  assert.equal(result.headers["cache-control"], "no-store");
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), before);
  assert.equal(h.submissions.length, 0);
  const starting = await request(h.appWith(h.admission, false)).post(h.url).set("Authorization", h.authorization).send(body()).expect(503);
  assert.equal(starting.body.code, "SERVICE_STARTING");
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), before);
});

test("latest analysis lookup is owner-only, draft-bound and has no initialization or admission side effects", async context => {
  const h = await harness(context);
  const query = { inputFingerprint: analysisManifest(h.guide).fingerprint };
  const before = await h.repository.getAnalysisState(h.guideId);
  for (const authorization of [undefined, "Bearer wrong-key"]) {
    const lookup = request(h.appWith()).get(h.url).set("X-ShowMe-Input-Fingerprint", query.inputFingerprint);
    if (authorization) lookup.set("Authorization", authorization);
    await lookup.expect(404);
  }
  const response = await request(h.appWith()).get(h.url).set("X-ShowMe-Input-Fingerprint", query.inputFingerprint).set("Authorization", h.authorization).expect(200);
  assert.deepEqual(response.body, { ...query, frameIds: ["step-0", "step-1"], run: null });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), before);
  assert.equal(h.submissions.length, 0);
});

test("latest lookup rejects unknown queries and a stale media fingerprint", async context => {
  const h = await harness(context);
  const query = { inputFingerprint: analysisManifest(h.guide).fingerprint };
  for (const invalid of ["", "invalid"]) {
    await request(h.app).get(h.url).set("X-ShowMe-Input-Fingerprint", invalid).set("Authorization", h.authorization).expect(400);
  }
  await request(h.app).get(h.url).query({ image: "private" }).set("X-ShowMe-Input-Fingerprint", query.inputFingerprint).set("Authorization", h.authorization).expect(400);
  await request(h.app).get(h.url).set("X-ShowMe-Input-Fingerprint", "0".repeat(64)).set("Authorization", h.authorization).expect(409);
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), { draft: null, runs: [] });
});

test("latest lookup returns the newest current-media run without reviving cancelled work", async context => {
  const h = await harness(context);
  const query = { inputFingerprint: analysisManifest(h.guide).fingerprint };
  const first = body();
  await request(h.app).post(h.url).set("Authorization", h.authorization).send(first).expect(202);
  await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: first.runId });
  const second = body();
  await request(h.app).post(h.url).set("Authorization", h.authorization).send(second).expect(202);
  await h.repository.executeAnalysisCommand(h.guideId, { type: "cancel", runId: second.runId });
  const before = await h.repository.getAnalysisState(h.guideId);
  const response = await request(h.appWith()).get(h.url).set("X-ShowMe-Input-Fingerprint", query.inputFingerprint).set("Authorization", h.authorization).expect(200);
  assert.equal(response.body.run.runId, second.runId);
  assert.equal(response.body.run.status, "cancelled");
  for (const forbidden of [h.token, h.guide.editTokenHash, "private-frame", "private-source", "attemptId", "manifest"]) assert.ok(!response.text.includes(forbidden));
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), before);
  assert.equal(h.submissions.length, 2);
});

test("late deletion or media replacement prevents even an empty latest result from reaching the editor", async context => {
  for (const deleted of [false, true]) {
    const h = await harness(context);
    const query = { inputFingerprint: analysisManifest(h.guide).fingerprint };
    const read = h.repository.getAnalysisState.bind(h.repository);
    context.mock.method(h.repository, "getAnalysisState", async (id: string) => {
      const state = await read(id);
      if (deleted) await h.repository.deleteGuide(id);
      else await h.repository.replaceSteps(id, h.guide.steps.map(step => ({ ...step, representativeFrameKey: "replacement.jpg" })));
      return state;
    });
    await request(h.app).get(h.url).set("X-ShowMe-Input-Fingerprint", query.inputFingerprint).set("Authorization", h.authorization).expect(deleted ? 404 : 409);
  }
});

test("analysis routes require the owning guide bearer key; query tokens and another key cannot substitute", async (context) => {
  const h = await harness(context);
  const sent = body();
  await request(h.app).post(h.url).set("Authorization", h.authorization).send(sent).expect(202);
  const before = await h.repository.getAnalysisState(h.guideId);
  for (const authorization of ["", `Bearer ${randomBytes(32).toString("base64url")}`, "Bearer invalid"]) {
    for (const [method, path] of [["post", h.url], ["get", `${h.url}/${sent.runId}`], ["post", `${h.url}/${sent.runId}/cancel`]] as const) {
      const response = await request(h.app)[method](`${path}?editToken=${h.token}&asset_token=not-a-bearer-key`)
        .set("Authorization", authorization).send(method === "post" ? sent : undefined).expect(404);
      assert.equal(response.body.code, "GUIDE_NOT_FOUND");
      assert.equal(response.headers["cache-control"], "no-store");
      assert.ok(!response.text.includes(h.token));
    }
  }
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), before);
  assert.equal(h.submissions.length, 1);
});

test("analysis creates an atomic initial draft and run with server-owned model metadata and safe DTO", async (context) => {
  const h = await harness(context);
  const sent = body();
  const response = await request(h.app).post(h.url).set("Authorization", h.authorization).send(sent).expect(202);
  assert.equal(response.headers.location, `${h.url}/${sent.runId}`);
  assert.equal(response.body.run.runId, sent.runId);
  assert.equal(response.body.run.status, "queued");
  assert.equal(response.body.run.model, ANALYSIS_API_MODEL);
  assert.equal(response.body.run.result, null);
  assert.equal(response.body.run.cancellable, true);
  assert.deepEqual(Object.keys(response.body.run).sort(), ["runId", "status", "model", "baseDraftRevision", "appliedDraftRevision",
    "cancellable", "reviewRequired", "result", "errorCode", "inputTokens", "outputTokens", "createdAt", "updatedAt"].sort());
  assert.equal(h.submissions[0].expectedInputFingerprint, analysisManifest(h.guide).fingerprint);
  assert.equal(h.submissions[0].provider, "gemini");
  assert.equal(h.submissions[0].promptVersion, GEMINI_PROMPT_VERSION);
  const state = await h.repository.getAnalysisState(h.guideId);
  assert.equal(state?.draft?.revision, 0);
  assert.equal(state?.runs.length, 1);
  assert.deepEqual(await h.repository.getGuideById(h.guideId), h.guide);
  const lookup = await request(h.app).get(`${h.url}/${sent.runId}`).set("Authorization", h.authorization).expect(200);
  for (const forbidden of [h.token, h.guide.editTokenHash, "private", "manifest", "attemptId", "fingerprint", "ObjectKey"]) {
    assert.ok(!lookup.text.includes(forbidden)); assert.ok(!response.text.includes(forbidden));
  }
});

test("analysis validates consent, identifiers, revisions and unknown fields before admission or initialization", async (context) => {
  const h = await harness(context);
  const malformed = [
    { ...body(), externalProcessing: false }, { ...body(), consentVersion: "old-consent" },
    { ...body(), model: "foreign-model" }, { ...body(), image: "private-base64" },
    { ...body(), baseDraftRevision: -1 }, { ...body(), baseDraftRevision: 0.5 },
    { ...body(), runId: "../foreign" }, { runId: randomUUID() },
  ];
  for (const sent of malformed) {
    const response = await request(h.appWith(h.admission)).post(h.url).set("Authorization", h.authorization).send(sent).expect(400);
    assert.ok(["ANALYSIS_INVALID_REQUEST", "ANALYSIS_CONSENT_REQUIRED"].includes(response.body.code));
  }
  await request(h.app).post(h.url).set("Authorization", h.authorization).send(body(undefined, 1)).expect(409);
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), { draft: null, runs: [] });
  assert.equal(h.submissions.length, 0);
});

test("analysis JSON parsing is bounded, rejects non-JSON/compression and never echoes bad bodies", async (context) => {
  const h = await harness(context);
  const malformed = await request(h.app).post(h.url).set("Authorization", h.authorization)
    .set("Content-Type", "application/json").send('{"private-api-key":').expect(400);
  assert.equal(malformed.body.code, "ANALYSIS_INVALID_REQUEST");
  assert.ok(!malformed.text.includes("private-api-key"));
  const large = await request(h.app).post(h.url).set("Authorization", h.authorization).send({ private: "x".repeat(5000) }).expect(413);
  assert.equal(large.body.code, "ANALYSIS_BODY_TOO_LARGE");
  await request(h.app).post(h.url).set("Authorization", h.authorization).set("Content-Type", "text/plain").send("private").expect(415);
  await request(h.app).post(h.url).set("Authorization", h.authorization).set("Content-Encoding", "gzip").send(body()).expect(415);
  assert.equal(h.submissions.length, 0);
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), { draft: null, runs: [] });
});

test("concurrent duplicate requests persist one run, while a different active run or changed payload conflicts", async (context) => {
  const h = await harness(context);
  const sent = body();
  const responses = await Promise.all([0, 1].map(() => request(h.app).post(h.url).set("Authorization", h.authorization).send(sent).expect(202)));
  assert.equal(responses[0].body.run.runId, responses[1].body.run.runId);
  assert.equal((await h.repository.getAnalysisState(h.guideId))?.runs.length, 1);
  const submissions = h.submissions.length;
  await request(h.app).post(h.url).set("Authorization", h.authorization).send(sent).expect(202);
  assert.equal(h.submissions.length, submissions);
  await request(h.app).post(h.url).set("Authorization", h.authorization).send(body()).expect(409);
  await request(h.app).post(h.url).set("Authorization", h.authorization).send({ ...sent, baseDraftRevision: 1 }).expect(409);
  assert.equal((await h.repository.getAnalysisState(h.guideId))?.runs.length, 1);
});

test("concurrent different requests cannot both become active", async (context) => {
  const h = await harness(context);
  const responses = await Promise.all([body(), body()].map((sent) => request(h.app).post(h.url).set("Authorization", h.authorization).send(sent)));
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
  assert.equal((await h.repository.getAnalysisState(h.guideId))?.runs.length, 1);
});

test("completed analysis is readable and replayable without readmission or overwriting the draft", async (context) => {
  const h = await harness(context);
  const sent = body();
  await request(h.app).post(h.url).set("Authorization", h.authorization).send(sent).expect(202);
  await executeAnalysisAttempt({ repository: h.repository, guideId: h.guideId, runId: sent.runId, expectedAttemptCount: 0,
    provider: { name: "gemini", model: ANALYSIS_API_MODEL, async analyzeFrames(input) {
      return { status: "completed", output: fakeOutput(input.targets.map((frame) => frame.stepId)), inputTokens: 10, outputTokens: 20 };
    } }, loadImage: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  });
  const state = await h.repository.getAnalysisState(h.guideId);
  const lookup = await request(h.app).get(`${h.url}/${sent.runId}`).set("Authorization", h.authorization).expect(200);
  assert.equal(lookup.body.run.status, "succeeded");
  assert.equal(lookup.body.run.appliedDraftRevision, 1);
  assert.equal(lookup.body.run.reviewRequired, true);
  assert.equal(lookup.body.run.result.steps[0].instruction, "설정 버튼을 누르세요.");
  assert.equal(lookup.body.run.cancellable, false);
  const replay = await request(h.appWith()).post(h.url).set("Authorization", h.authorization).send(sent).expect(200);
  assert.deepEqual(replay.body, lookup.body);
  await request(h.app).post(`${h.url}/${sent.runId}/cancel`).set("Authorization", h.authorization).expect(409);
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), state);
  assert.equal(h.submissions.length, 1);
});

test("cancel is idempotent and fences a running worker without deleting source frames or the draft", async (context) => {
  const h = await harness(context);
  const sent = body();
  await request(h.app).post(h.url).set("Authorization", h.authorization).send(sent).expect(202);
  await h.repository.executeAnalysisCommand(h.guideId, { type: "claim", runId: sent.runId, attemptId: "worker", expectedAttemptCount: 0, leaseMs: 10000 });
  const draft = (await h.repository.getAnalysisState(h.guideId))?.draft;
  for (let index = 0; index < 2; index += 1) {
    const cancelled = await request(h.appWith()).post(`${h.url}/${sent.runId}/cancel`).set("Authorization", h.authorization).expect(200);
    assert.equal(cancelled.body.run.status, "cancelled");
    assert.equal(cancelled.body.run.cancellable, false);
  }
  assert.equal(await h.repository.executeAnalysisCommand(h.guideId, { type: "finish", runId: sent.runId, attemptId: "worker", attemptCount: 1,
    output: fakeOutput(["step-0", "step-1"]), inputTokens: 0, outputTokens: 0 }), null);
  assert.deepEqual((await h.repository.getAnalysisState(h.guideId))?.draft, draft);
  assert.deepEqual(await h.repository.getGuideById(h.guideId), h.guide);
});

test("cancel rejects unexpected input and unknown run lookups never initialize analysis", async (context) => {
  const h = await harness(context);
  await request(h.app).get(`${h.url}/${randomUUID()}`).set("Authorization", h.authorization).expect(404);
  await request(h.app).get(`${h.url}/bad-id`).set("Authorization", h.authorization).expect(404);
  await request(h.app).post(`${h.url}/${randomUUID()}/cancel`).set("Authorization", h.authorization).expect(404);
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), { draft: null, runs: [] });
  const sent = body();
  await request(h.app).post(h.url).set("Authorization", h.authorization).send(sent).expect(202);
  await request(h.app).post(`${h.url}/${sent.runId}/cancel`).set("Authorization", h.authorization).send({ provider: "private" }).expect(400);
  assert.equal((await h.repository.getAnalysisState(h.guideId))?.runs[0].status, "queued");
});

test("non-ready and deleting media cannot start or expose an analysis result", async (context) => {
  const h = await harness(context);
  const sent = body();
  await request(h.app).post(h.url).set("Authorization", h.authorization).send(sent).expect(202);
  await h.repository.updateStatus(h.guideId, "failed", { errorCode: "DELETION_PENDING" });
  for (const operation of [request(h.app).post(h.url).send(body()), request(h.app).get(`${h.url}/${sent.runId}`),
    request(h.app).post(`${h.url}/${sent.runId}/cancel`)]) {
    const response = await operation.set("Authorization", h.authorization).expect(409);
    assert.equal(response.body.code, "ANALYSIS_MEDIA_NOT_READY");
  }
  assert.equal(h.submissions.length, 1);
});

test("media replaced between authentication and admission cannot partially initialize or accept a stale request", async (context) => {
  const h = await harness(context);
  const app = h.appWith({ async request(id, command) {
    await h.repository.replaceSteps(id, h.guide.steps.map((step) => ({ ...step, representativeFrameKey: "new-private-frame.jpg" })));
    return h.repository.executeAnalysisCommand(id, command);
  } });
  await request(app).post(h.url).set("Authorization", h.authorization).send(body()).expect(409);
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), { draft: null, runs: [] });
});

test("deletion after admission prevents a stale success response and removes all analysis state", async (context) => {
  const h = await harness(context);
  const app = h.appWith({ async request(id, command) {
    const state = await h.repository.executeAnalysisCommand(id, command);
    await h.repository.deleteGuide(id);
    return state;
  } });
  await request(app).post(h.url).set("Authorization", h.authorization).send(body()).expect(404);
  assert.equal(await h.repository.getAnalysisState(h.guideId), null);
});

test("admission errors redact private details from both HTTP responses and logs", async (context) => {
  const h = await harness(context);
  const logs = context.mock.method(console, "error", () => {});
  const app = h.appWith({ async request() { throw new Error(`private-provider-response:${h.token}`); } });
  const response = await request(app).post(h.url).set("Authorization", h.authorization).send(body()).expect(500);
  assert.equal(response.body.code, "ANALYSIS_INTERNAL_ERROR");
  const output = JSON.stringify(logs.mock.calls.map((call) => call.arguments)) + response.text;
  assert.ok(!output.includes("private-provider-response") && !output.includes(h.token));
  const unavailable = h.appWith({ async request() { throw new AnalysisApiError("ANALYSIS_UNAVAILABLE"); } });
  await request(unavailable).post(h.url).set("Authorization", h.authorization).send(body()).expect(503);
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), { draft: null, runs: [] });
});

test("a lost admission acknowledgement has a deadline and can be recovered by the same run ID", async (context) => {
  const h = await harness(context);
  let release!: (state: AnalysisState | null) => void;
  let capturedSignal: AbortSignal | undefined;
  let calls = 0;
  const app = h.appWith({ async request(id, command, signal) {
    calls += 1; capturedSignal = signal;
    await h.repository.executeAnalysisCommand(id, command);
    return new Promise<AnalysisState | null>((resolve) => { release = resolve; });
  } });
  const sent = body();
  const response = await request(app).post(h.url).set("Authorization", h.authorization).send(sent).expect(503);
  assert.equal(response.body.code, "ANALYSIS_ADMISSION_TIMEOUT");
  assert.equal(capturedSignal?.aborted, true);
  release(null);
  await request(app).get(`${h.url}/${sent.runId}`).set("Authorization", h.authorization).expect(200);
  await request(app).post(h.url).set("Authorization", h.authorization).send(sent).expect(202);
  assert.equal(calls, 1);
  assert.equal((await h.repository.getAnalysisState(h.guideId))?.runs.length, 1);
});

test("analysis request throttling leaves lookup and cancellation available and makes no extra admission", async (context) => {
  const h = await harness(context);
  const sent = body();
  for (let index = 0; index < 10; index += 1) {
    await request(h.app).post(h.url).set("Authorization", h.authorization).send(sent).expect(202);
  }
  const limited = await request(h.app).post(h.url).set("Authorization", h.authorization).send(sent).expect(429);
  assert.equal(limited.body.code, "ANALYSIS_RATE_LIMIT");
  assert.equal(limited.headers["cache-control"], "no-store");
  assert.ok(limited.headers["retry-after"]);
  assert.equal(h.submissions.length, 1);
  await request(h.app).get(`${h.url}/${sent.runId}`).set("Authorization", h.authorization).expect(200);
  await request(h.app).post(`${h.url}/${sent.runId}/cancel`).set("Authorization", h.authorization).expect(200);
  const persisted = await readFile(h.repository.filePath, "utf8");
  assert.ok(!persisted.includes(h.token));
});

test("an abort-aware admission still reports the safe deadline error", async (context) => {
  const h = await harness(context);
  const app = h.appWith({ async request(_id, _command, signal) {
    return new Promise<AnalysisState | null>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private-aborted-operation")), { once: true });
    });
  } });
  const response = await request(app).post(h.url).set("Authorization", h.authorization).send(body()).expect(503);
  assert.equal(response.body.code, "ANALYSIS_ADMISSION_TIMEOUT");
  assert.ok(!response.text.includes("private-aborted-operation"));
  assert.deepEqual(await h.repository.getAnalysisState(h.guideId), { draft: null, runs: [] });
});
