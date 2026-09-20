// Opt-in Replit development acceptance check. Never imported by app startup.
import { randomBytes, randomUUID } from "node:crypto";
import { open, mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fork } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "../../..");
const journalPath = join(root, ".local/showme/live-synthetic-run.json");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = () => { throw new Error("LIVE_SYNTHETIC_CHECK_FAILED"); };
const check = value => { if (!value) fail(); };
const report = (stage, extra = {}) => console.log(JSON.stringify({ check: "LIVE_SYNTHETIC_CHECK", stage, ...extra }));

export function checkArguments(args, env) {
  check(args.length === 2 && args[0] === "--run-synthetic" && (args[1] === "--evidence-stdin" || args[1].startsWith("--evidence=")));
  check(env.REPL_ID && uuid.test(env.REPL_ID) && !["1", "true"].includes(env.REPLIT_DEPLOYMENT));
  check(!env.NODE_ENV || env.NODE_ENV === "development");
  check(!env.SHOWME_ANALYSIS_MODE || env.SHOWME_ANALYSIS_MODE === "off");
  check(/^[\x21-\x7e]{10,4096}$/.test(env.GEMINI_API_KEY ?? ""));
  return args[1] === "--evidence-stdin" ? null : resolve(args[1].slice(11));
}

export function singleSendTransport(transport, model, onResponse = () => {}) {
  const sent = new Set();
  return { sent, fetch: async (url, options) => {
    const endpoint = String(url);
    const operation = endpoint === `https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens` ? "count"
      : endpoint === `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` ? "generate" : null;
    check(operation && !sent.has(operation) && options?.method === "POST");
    check(operation !== "generate" || sent.has("count"));
    // Mark BEFORE sending. An ambiguous failure cannot silently send again.
    sent.add(operation);
    const response = await transport(url, { ...options, redirect: "error" });
    onResponse(operation, response.status);
    return response;
  } };
}

export function assertRecoveryGuide(journal, guide) {
  check(uuid.test(journal.guideId) && guide.id === journal.guideId &&
    guide.sourceFilename === "showme-fixed-synthetic-acceptance.mp4" && guide.sourceSizeBytes === 1 &&
    guide.originalObjectKey === `guides/${journal.guideId}/source/${"0".repeat(64)}.mp4` &&
    guide.processingAttemptCount <= 1 && guide.steps.length <= 2);
  for (const step of guide.steps) {
    check([0, 1].includes(step.position));
    const prefix = `guides/${guide.id}/attempts/1/frames/frame-${String(step.position + 1).padStart(3, "0")}`;
    check(step.representativeFrameKey === `${prefix}.jpg` && step.thumbnailFrameKey === `${prefix}-thumb.jpg`);
  }
}

async function privateJson(path) {
  const { constants } = await import("node:fs");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    check(st.isFile() && st.size > 0 && st.size <= 32768 && st.nlink === 1 && !(st.mode & 0o077) && st.uid === process.getuid());
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

async function parent(args) {
  const evidencePath = checkArguments(args, process.env);
  const { runAnalysisOperationsAdmin, readOperationsCommand } = await import("../src/processor/analysis-operations-admin.ts");
  const evidence = evidencePath ? await privateJson(evidencePath) : await readOperationsCommand(process.stdin, AbortSignal.timeout(5000));
  check(evidence.replId === process.env.REPL_ID && evidence.keyBinding === "user-confirmed-rotation" && evidence.projectRef && evidence.credentialRef);
  const { readRuntimeBinding, runtimeEnvironment } = await import("./start.mjs");
  const runtime = await readRuntimeBinding();
  const operator = await privateJson(join(root, ".local/showme/operator-db.json"));
  check(operator.kind === "showme-development-operator-v1" && operator.replId === process.env.REPL_ID);
  const runtimeUrl = new URL(runtime.connectionString), operatorUrl = new URL(operator.connectionString);
  check(["protocol", "hostname", "port", "pathname"].every(name => runtimeUrl[name] === operatorUrl[name]));
  const env = { REPL_ID: process.env.REPL_ID, REPLIT_DEPLOYMENT: "0", SHOWME_OPERATOR_DATABASE_URL: operator.connectionString };
  const deployment = evidence.deploymentRef;
  const admin = async (action, command) => {
    const result = await runAnalysisOperationsAdmin({ args: [`--action=${action}`, `--deployment=${deployment}`,
      `--database=${decodeURIComponent(runtimeUrl.pathname.slice(1))}`, `--replit-development=${process.env.REPL_ID}`,
      ...(action === "status" ? [] : [action === "activate" ? "--confirm-synthetic-activation" : "--confirm-stop"])],
      env, signal: AbortSignal.timeout(15000), readCommand: async () => command });
    check(result.exitCode === 0); return JSON.parse(result.output);
  };
  const before = await admin("status");
  check(before.version === 0 && before.lastActivationVersion === 0);
  const journal = { kind: "showme-live-synthetic-v1", replId: process.env.REPL_ID, guideId: randomUUID(),
    deploymentRef: deployment, reviewId: randomUUID(), activationId: randomUUID(), startedAt: new Date().toISOString() };
  // Never overwrite a previous incomplete check. This contains no credential.
  const jf = await open(journalPath, "wx", 0o600);
  await jf.writeFile(JSON.stringify(journal)); await jf.sync(); await jf.close();
  let child, reviewWritten = false, childDone = false, success = false, interrupt;
  try {
    const childEnv = runtimeEnvironment({ ...process.env, SHOWME_ANALYSIS_MODE: "fixed-synthetic" }, runtime);
    child = fork(script, ["--child"], { cwd: resolve(dirname(script), ".."), env: childEnv,
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    const messages = [], waiters = [];
    const deliver = message => { if (waiters.length) waiters.shift()(message); else messages.push(message); };
    interrupt = () => deliver({ type: "interrupted" });
    process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
    child.on("message", deliver);
    child.on("error", () => deliver({ type: "failed" }));
    child.on("exit", () => { childDone = true; deliver({ type: "exited" }); });
    const rawNext = async () => {
      let timer; const deadline = new Promise(resolve => { timer = setTimeout(() => resolve({ type: "timeout" }), 240000); });
      try { return await Promise.race([messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve)), deadline]); }
      finally { clearTimeout(timer); }
    };
    const next = async () => { let message;
      do { message = await rawNext(); if (message.type === "progress") report(message.stage, message.details); } while (message.type === "progress");
      return message;
    };
    child.send({ type: "seed", journal, evidence });
    const seeded = await next(); check(seeded.type === "seeded");
    report("FROZEN_SCREENS_STORED", { frames: 2 });
    const { checkAnalysisOperationsReview } = await import("../src/processor/analysis-operations-review.ts");
    const { operationsActorRef } = await import("../src/processor/analysis-operations-store.ts");
    const now = new Date(), expiresAt = new Date(now.valueOf() + 10 * 60000).toISOString();
    const review = { ...evidence.review, kind: "operator-analysis-review-v1", id: journal.reviewId, revision: 1, state: "approved",
      recordedAt: now.toISOString(), expiresAt, deploymentRef: deployment, projectRef: evidence.projectRef,
      credentialRef: evidence.credentialRef, storageRef: seeded.storageRef, scope: "approved_synthetic", mode: "free_only",
      paidFallback: false, changeDetection: "operator-recheck-required" };
    checkAnalysisOperationsReview({ ...review, reviewerRef: operationsActorRef(decodeURIComponent(operatorUrl.username)) }, now);
    // Set before write so an uncertain reply still triggers a read/stop attempt.
    reviewWritten = true;
    await admin("put", { type: "put", commandId: randomUUID(), expectedVersion: 0, review });
    await admin("activate", { type: "activate", commandId: journal.activationId, expectedVersion: 0,
      deploymentRef: deployment, reviewId: journal.reviewId, expectedReviewVersion: 1,
      grant: { ...seeded.grant, createdAt: now.toISOString(), expiresAt } });
    child.send({ type: "activate", activationId: journal.activationId });
    const result = await next();
    check(result.type === "completed");
    report("RESULT_PERSISTED", result.details);
    await admin("revoke", { type: "revoke", commandId: randomUUID(), expectedVersion: 1,
      deploymentRef: deployment, reviewId: journal.reviewId });
    child.send({ type: "verify-stop" });
    const stopped = await next(); check(stopped.type === "stopped");
    report("REVOCATION_BLOCKS_NEW_RUN");
    child.send({ type: "cleanup" });
    const cleaned = await next(); check(cleaned.type === "cleaned");
    const status = await admin("status"); check(status.halted && status.state === "revoked");
    if (!childDone) await once(child, "exit");
    check(child.exitCode === 0); childDone = true;
    await unlink(journalPath);
    success = true; report("PASS", { aiHalted: true, testGuideDeleted: true, credentialsPrinted: false });
  } finally {
    if (interrupt) { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
    if (!success) {
      if (reviewWritten) {
        try { const status = await admin("status");
          if (status.state === "approved" && status.reviewId === journal.reviewId) await admin("revoke", {
            type: "revoke", commandId: randomUUID(), expectedVersion: status.version, deploymentRef: deployment, reviewId: journal.reviewId });
          report("STOP_CONFIRMED", { halted: (await admin("status")).halted });
        } catch { report("STOP_REQUIRES_OPERATOR_CHECK"); }
      }
      if (child && !childDone) {
        child.send({ type: "cleanup" });
        await Promise.race([once(child, "exit"), delay(30000)]);
        if (!childDone) child.kill("SIGTERM");
      }
      report("RECOVERY_JOURNAL_RETAINED");
    }
  }
}

async function childMain() {
  check(process.send && process.env.SHOWME_ANALYSIS_MODE === "fixed-synthetic" && !process.env.SHOWME_OPERATOR_DATABASE_URL);
  // A hard parent death cannot leave an orphan dispatcher able to send later.
  process.once("disconnect", () => process.exit(process.exitCode ?? 1));
  const messages = [], waiters = [];
  process.on("message", m => { if (waiters.length) waiters.shift()(m); else messages.push(m); });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve));
  const send = message => process.send?.(message);
  const { Pool } = await import("pg");
  const { loadConfig } = await import("../src/processor/config.ts");
  const { PostgresGuideRepository } = await import("../src/processor/repository.ts");
  const { ReplitObjectStorage } = await import("../src/processor/storage.ts");
  const { analysisManifest, ANALYSIS_CONSENT_VERSION } = await import("../src/processor/analysis-contract.ts");
  const { configuredAnalysisFactory, verifyAnalysisRuntimeRole } = await import("../src/processor/analysis-bootstrap.ts");
  const { verifyDatabaseMigrations } = await import("../src/processor/database-migrations.ts");
  const { createAnalysisLifecycle } = await import("../src/processor/analysis-lifecycle.ts");
  const { syntheticAnalysisInput } = await import("../src/processor/gemini/synthetic.ts");
  const { GEMINI_TEST_MODEL, GEMINI_PROMPT_VERSION } = await import("../src/processor/gemini/request.ts");
  const { SYNTHETIC_COUNT_LIMITS } = await import("../src/processor/gemini/count-policy.ts");
  const { attemptFrameObjectKey, finalizeGuideDeletion, sourceObjectKey, DELETION_PENDING } = await import("../src/processor/asset-lifecycle.ts");
  const { syntheticStorageRef } = await import("../src/processor/analysis-synthetic-runtime.ts");
  const { createProcessorApp } = await import("../src/processor/server.ts");
  const first = await next(); check(first.type === "seed" && uuid.test(first.journal.guideId));
  const { journal, evidence } = first, id = journal.guideId;
  const config = loadConfig(process.env);
  check(config.storageDriver === "replit" && config.replitBucketId === evidence.bucketId && config.replitObjectPrefix === evidence.prefix);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  pool.on("error", () => send({ type: "failed" }));
  const repository = PostgresGuideRepository.fromPool(pool), storage = new ReplitObjectStorage({ bucketId: evidence.bucketId, prefix: evidence.prefix });
  let lifecycle, server, temp, created = false, grant, api, runId, stage = "preflight";
  const transport = singleSendTransport(fetch, GEMINI_TEST_MODEL,
    (operation, status) => send({ type: "progress", stage: "PROVIDER_RESPONSE", details: { operation, status } }));
  try {
    await verifyAnalysisRuntimeRole(pool, AbortSignal.timeout(10000));
    await verifyDatabaseMigrations(repository.database);
    check(!(await repository.getGuideById(id)));
    stage = "seed";
    const fixture = await syntheticAnalysisInput();
    const token = randomBytes(32).toString("base64url");
    const sourceKey = sourceObjectKey(id, ".mp4", "0".repeat(64));
    await repository.createGuide({ id, slug: id, editToken: token, title: "ShowMe fixed synthetic AI acceptance", status: "uploading",
      originalObjectKey: sourceKey, sourceFilename: "showme-fixed-synthetic-acceptance.mp4", sourceMimeType: "video/mp4", sourceSizeBytes: 1 });
    created = true;
    await repository.updateStatus(id, "queued");
    const attemptId = randomUUID(); check(await repository.claimProcessingAttempt(id, attemptId));
    await repository.updateStatus(id, "extracting");
    temp = await mkdtemp(join(tmpdir(), "showme-live-synthetic-"));
    const steps = [];
    for (const [i, image] of fixture.images.entries()) {
      const file = join(temp, `${i}.jpg`); await writeFile(file, image.bytes, { flag: "wx", mode: 0o600 });
      const frame = attemptFrameObjectKey(id, 1, i + 1, "frame"), thumbnail = attemptFrameObjectKey(id, 1, i + 1, "thumbnail");
      await storage.putFile(frame, file); await storage.putFile(thumbnail, file);
      steps.push({ id: `${id}-step-${i}`, position: i, shortLabel: "합성 화면", instruction: "시험 설명",
        startMs: i * 1000, endMs: (i + 1) * 1000, representativeTimestampMs: fixture.targets[i].timestampMs,
        representativeFrameKey: frame, thumbnailFrameKey: thumbnail, frameWidth: 640, frameHeight: 360 });
    }
    const guide = await repository.completeProcessingAttempt(id, { attemptId, attemptCount: 1, steps }); check(guide);
    const manifest = analysisManifest(guide);
    grant = { kind: "fixed-synthetic-screens-v1", approvalId: journal.reviewId, deploymentRef: evidence.deploymentRef,
      input: { guideId: id, inputFingerprint: manifest.fingerprint, frameCount: 2, model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION },
      inputTokenLimit: evidence.review.policy.maxInputTokensPerRequest, countPolicy: { ...SYNTHETIC_COUNT_LIMITS, maxImages: 2 } };
    send({ type: "seeded", grant, storageRef: syntheticStorageRef(evidence.bucketId, evidence.prefix) });
    const activation = await next(); check(activation.type === "activate");
    const settings = { mode: "fixed-synthetic", activationId: activation.activationId, deploymentRef: evidence.deploymentRef,
      projectRef: evidence.projectRef, credentialRef: evidence.credentialRef, apiKey: process.env.GEMINI_API_KEY };
    stage = "bootstrap";
    lifecycle = await createAnalysisLifecycle({ repository, storage }, configuredAnalysisFactory(settings, config, { fetch: transport.fetch }));
    check(lifecycle);
    const app = createProcessorApp({ config, repository, storage,
      pipeline: { process: async () => fail() }, analysisAdmission: lifecycle.admission });
    server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/api/guides/${id}`;
    api = async (path, method = "GET", body, auth = true) => {
      const response = await fetch(base + path, { method, headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}),
        "X-ShowMe-Input-Fingerprint": manifest.fingerprint, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(method === "DELETE" ? 60000 : 10000), redirect: "error" });
      const result = response.status === 204 ? null : await response.json(); return { status: response.status, data: result };
    };
    stage = "consent-and-readiness";
    lifecycle.start();
    check((await api("/analysis/capabilities", "GET", undefined, false)).status === 404);
    check((await api("/analysis/capabilities")).data.startAvailable === true);
    runId = randomUUID();
    check((await api("/analysis", "POST", { runId, baseDraftRevision: 0, consentVersion: ANALYSIS_CONSENT_VERSION, externalProcessing: false })).status === 400);
    check(transport.sent.size === 0);
    stage = "request-and-result";
    const accepted = await api("/analysis", "POST", { runId, baseDraftRevision: 0, consentVersion: ANALYSIS_CONSENT_VERSION, externalProcessing: true });
    check([200, 202].includes(accepted.status));
    let result;
    for (let i = 0; i < 210; i++) {
      result = await api(`/analysis/${runId}`); check(result.status === 200);
      if (["succeeded", "failed", "cancelled"].includes(result.data.run.status)) break;
      await delay(1000);
    }
    if (result.data.run.status !== "succeeded") send({ type: "progress", stage: "RUN_NOT_SUCCEEDED", details: {
      status: result.data.run.status, errorCode: result.data.run.errorCode } });
    check(result.data.run.status === "succeeded" && result.data.run.result.steps.length === 2);
    const draft = await api("/draft"); check(draft.status === 200 && draft.data.draft.persisted && draft.data.draft.revision === 1);
    const state = await repository.getAnalysisState(id); check(state.runs[0].status === "succeeded" && state.draft.revision === 1);
    check(transport.sent.size === 2);
    send({ type: "completed", details: { inputTokens: result.data.run.inputTokens, outputTokens: result.data.run.outputTokens,
      frames: 2, draftRevision: draft.data.draft.revision, countRequests: 1, generationRequests: 1 } });
    stage = "revocation";
    check((await next()).type === "verify-stop");
    check((await api("/analysis/capabilities")).data.startAvailable === false);
    const denied = await api("/analysis", "POST", { runId: randomUUID(), baseDraftRevision: 1,
      consentVersion: ANALYSIS_CONSENT_VERSION, externalProcessing: true });
    check(denied.status === 503 && transport.sent.size === 2);
    send({ type: "stopped" });
    check((await next()).type === "cleanup");
  } catch { send({ type: "progress", stage: "CHILD_FAILED", details: { phase: stage } }); send({ type: "failed" }); process.exitCode = 1; }
  finally {
    try {
      await lifecycle?.stop();
      if (created) {
        if (runId) { const state = await repository.getAnalysisState(id); const run = state?.runs.find(r => r.id === runId);
          if (run && ["running", "queued"].includes(run.status)) await repository.executeAnalysisCommand(id, { type: "cancel", runId }); }
        if (api) check((await api("", "DELETE")).status === 204);
        else {
          check(await repository.updateStatus(id, "failed", { errorCode: DELETION_PENDING }));
          check(await finalizeGuideDeletion(repository, storage, id, 2));
        }
        check(!(await repository.getGuideById(id)));
      }
      send({ type: "cleaned" });
    } catch (error) {
      send({ type: "progress", stage: "CLEANUP_FAILED", details: {
        reason: ["TimeoutError", "AbortError"].includes(error?.name) ? error.name : "cleanup-not-confirmed" } });
      send({ type: "cleanup-failed" }); process.exitCode = 1;
    }
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    if (temp) await rm(temp, { recursive: true, force: true });
    await pool.end(); if (process.exitCode === undefined) process.exitCode = 0; process.disconnect?.();
  }
}

async function cleanupOnly() {
  check(process.env.REPL_ID && !["1", "true"].includes(process.env.REPLIT_DEPLOYMENT));
  check(!process.env.SHOWME_ANALYSIS_MODE || process.env.SHOWME_ANALYSIS_MODE === "off");
  const journal = await privateJson(journalPath);
  check(journal.kind === "showme-live-synthetic-v1" && journal.replId === process.env.REPL_ID && uuid.test(journal.guideId));
  const { readRuntimeBinding, runtimeEnvironment } = await import("./start.mjs");
  const { Pool } = await import("pg");
  const { loadConfig } = await import("../src/processor/config.ts");
  const { PostgresGuideRepository } = await import("../src/processor/repository.ts");
  const { ReplitObjectStorage } = await import("../src/processor/storage.ts");
  const { verifyAnalysisRuntimeRole } = await import("../src/processor/analysis-bootstrap.ts");
  const { finalizeGuideDeletion, DELETION_PENDING } = await import("../src/processor/asset-lifecycle.ts");
  const { PostgresAnalysisOperationsStore } = await import("../src/processor/analysis-operations-store.ts");
  const { syntheticStorageRef } = await import("../src/processor/analysis-synthetic-runtime.ts");
  const env = runtimeEnvironment(process.env, await readRuntimeBinding());
  check(!env.GEMINI_API_KEY && !env.SHOWME_OPERATOR_DATABASE_URL);
  const config = loadConfig(env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  pool.on("error", () => {});
  try {
    await verifyAnalysisRuntimeRole(pool, AbortSignal.timeout(10000));
    const repository = PostgresGuideRepository.fromPool(pool);
    const observation = await new PostgresAnalysisOperationsStore({ pool }).observe(journal.deploymentRef, AbortSignal.timeout(10000));
    check(config.storageDriver === "replit" && config.replitBucketId && observation.halted &&
      observation.entry?.review.id === journal.reviewId && observation.entry.review.state === "revoked" &&
      observation.entry.review.storageRef === syntheticStorageRef(config.replitBucketId, config.replitObjectPrefix));
    const guide = await repository.getGuideById(journal.guideId);
    if (guide) {
      // Recovery can act only on this journal's exact, unchanged generated fixture.
      assertRecoveryGuide(journal, guide);
      const state = await repository.getAnalysisState(guide.id);
      check(!state?.runs.some(run => ["queued", "running"].includes(run.status)));
      check(await repository.updateStatus(guide.id, "failed", { expectedUpdatedAt: guide.updatedAt, errorCode: DELETION_PENDING }));
      const storage = new ReplitObjectStorage({ bucketId: config.replitBucketId, prefix: config.replitObjectPrefix });
      check(await finalizeGuideDeletion(repository, storage, guide.id, 2, { timeoutMs: 60000 }));
      check(!(await repository.getGuideById(guide.id)));
    }
    await unlink(journalPath);
    report("CLEANUP_ONLY_DONE", { testGuideDeleted: true, aiHalted: true, aiCalls: 0 });
  } finally { await pool.end(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--help") console.log("Opt-in Replit fixed-synthetic acceptance: --run-synthetic --evidence-stdin (reviewed JSON, no credentials), or --evidence=<private JSON>. One count, one generation; journal blocks reruns. --cleanup-only removes only the retained journal's fixture while halted; never sends AI calls. No .env loading or key output.");
    else if (process.argv.length === 3 && process.argv[2] === "--cleanup-only") await cleanupOnly();
    else if (process.argv.length === 3 && process.argv[2] === "--child" && process.send) await childMain();
    else await parent(process.argv.slice(2));
  } catch { report("FAILED_NO_SECRET_DETAILS"); process.exitCode = 1; }
}
