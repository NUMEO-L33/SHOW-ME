import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { syntheticVideo, SYNTHETIC_SHA256 } from "./private-access-fixture.mjs";

export class CheckFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new CheckFailure(code); };
export const safeCode = error => error instanceof CheckFailure ? error.code : "CHECK_FAILED";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function checkedOrigin(value) {
  if (typeof value !== "string" || /[\s\\%]/.test(value)) fail("INVALID_ORIGIN");
  let url;
  try { url = new URL(value); } catch { fail("INVALID_ORIGIN"); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail("INVALID_ORIGIN");
  if (value !== url.origin && value !== `${url.origin}/`) fail("INVALID_ORIGIN");
  // Only the exact loopback spellings, or explicit HTTPS Replit app hosts.
  const local = /^(?:http|https):\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?\/?$/.test(value);
  const replit = url.protocol === "https:" && !url.port &&
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:replit\.dev|replit\.app)$/.test(url.hostname);
  if (!local && !replit) fail("INVALID_ORIGIN");
  return url.origin;
}

export function createRun(origin) {
  return { kind: "showme-synthetic-access-v1", origin: checkedOrigin(origin), guideId: randomUUID(),
    editToken: randomBytes(32).toString("base64url"), fixtureHash: SYNTHETIC_SHA256, pid: process.pid };
}
export function validateRun(run) {
  if (!run || run.kind !== "showme-synthetic-access-v1" || run.fixtureHash !== SYNTHETIC_SHA256 ||
      !uuid.test(run.guideId) || !tokenPattern.test(run.editToken) || !Number.isSafeInteger(run.pid) || run.pid < 1 ||
      checkedOrigin(run.origin) !== run.origin) fail("INVALID_RECOVERY_RECORD");
  return run;
}

function client(run, { fetchImpl = fetch, requestMs = 15_000 } = {}) {
  validateRun(run);
  const base = `/api/guides/${run.guideId}`;
  return async function call(path, { method = "GET", token, body, signal, statuses = [200], image = false, headers = {} } = {}) {
    if (path !== "/api/healthz" && path !== "/api/guides" && path !== base && path !== `${base}/draft` &&
        !new RegExp(`^${base}/assets/[0-9a-f-]{36}/(?:frame|thumbnail)(?:\\?asset_token=[A-Za-z0-9_.%-]+)?$`).test(path)) {
      fail("DESTINATION_BLOCKED");
    }
    const abort = AbortSignal.any([AbortSignal.timeout(requestMs), ...(signal ? [signal] : [])]);
    let response;
    try {
      response = await fetchImpl(`${run.origin}${path}`, { method, body,
        headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: abort, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
      if (response.redirected || (response.url && response.url !== `${run.origin}${path}`)) fail("REDIRECT_BLOCKED");
      if (!statuses.includes(response.status)) fail("UNEXPECTED_HTTP_STATUS");
      if (response.status === 204) return { status: 204 };
      const contentType = response.headers.get("content-type") ?? "";
      if (image ? !/^image\/jpeg(?:;|$)/i.test(contentType) : !/^application\/json(?:;|$)/i.test(contentType)) fail("INVALID_RESPONSE");
      const limit = image ? 1024 * 1024 : 128 * 1024;
      const reader = response.body?.getReader();
      if (!reader) fail("INVALID_RESPONSE");
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          abort.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) fail("RESPONSE_TOO_LARGE");
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks, size);
      if (image && (size < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)) fail("INVALID_IMAGE_RESPONSE");
      return { status: response.status, body: image ? undefined : JSON.parse(bytes.toString("utf8")),
        noStore: /(?:^|,)\s*no-store\b/i.test(response.headers.get("cache-control") ?? "") };
    } catch (error) {
      if (error instanceof CheckFailure) throw error;
      fail(signal?.aborted ? "CHECK_CANCELLED" : abort.aborted ? "REQUEST_TIMEOUT" : "REQUEST_FAILED");
    } finally {
      // Never print response bodies, SDK exceptions, URLs or tokens.
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  };
}

function assertHidden(result) {
  if (result.status !== 404 || !["GUIDE_NOT_FOUND", "ASSET_NOT_FOUND"].includes(result.body?.code) ||
      Object.keys(result.body).some(key => !["code", "error"].includes(key))) fail("PRIVATE_ACCESS_NOT_DENIED");
}
function ownedGuide(result, run) {
  const guide = result.body?.guide;
  if (!guide || guide.id !== run.guideId || !Array.isArray(guide.steps) || !result.noStore) fail("INVALID_OWNED_GUIDE");
  return guide;
}
function ownedDraft(result, run) {
  const draft = result.body?.draft;
  if (!result.noStore || draft?.guideId !== run.guideId || !Array.isArray(draft.document?.steps) ||
      draft.document.steps.length !== 1) fail("INVALID_OWNED_DRAFT");
  return draft;
}
function assetsFor(guide, run) {
  if (guide.steps.length !== 1 || !uuid.test(guide.steps[0].id)) fail("INVALID_SYNTHETIC_STEPS");
  const step = guide.steps[0];
  return ["frame", "thumbnail"].map(variant => {
    const path = `/api/guides/${run.guideId}/assets/${step.id}/${variant}`;
    const signed = step[`${variant}Url`];
    if (typeof signed !== "string" || !signed.startsWith(`${path}?asset_token=`)) fail("INVALID_ASSET_DESTINATION");
    const parsed = new URL(signed, run.origin);
    if (parsed.origin !== run.origin || parsed.pathname !== path || parsed.hash ||
        parsed.searchParams.size !== 1 || !/^[A-Za-z0-9_.-]{1,2048}$/.test(parsed.searchParams.get("asset_token") ?? "")) {
      fail("INVALID_ASSET_DESTINATION");
    }
    return { path, signed };
  });
}

// Cleanup uses only the fresh identity allocated by this tool (or its private
// recovery record), never an ID supplied by a server response or command line.
export async function cleanupRun(run, options = {}) {
  const { cleanupMs = 60_000, cleanupAttempts = 8, cleanupDelayMs = 3_000, signedAssets = [] } = options;
  const call = client(run, options);
  const signal = AbortSignal.timeout(cleanupMs);
  const base = `/api/guides/${run.guideId}`;
  for (let attempt = 0; attempt < cleanupAttempts && !signal.aborted; attempt++) {
    try {
      const deleted = await call(base, { method: "DELETE", token: run.editToken, signal, statuses: [204, 202, 409, 503] });
      if (deleted.status === 204) {
        // A 404 alone is not proof of deletion. Require the DELETE acknowledgement
        // AND loss of previously valid owner access and signed image access.
        assertHidden(await call(base, { token: run.editToken, signal, statuses: [404] }));
        assertHidden(await call(`${base}/draft`, { token: run.editToken, signal, statuses: [404] }));
        for (const path of signedAssets) assertHidden(await call(path, { signal, statuses: [404] }));
        return;
      }
    } catch (error) {
      // Unknown credentials/redirects/unexpected 404 cannot be called successful
      // deletion. Leave the recovery record rather than hiding the failure.
      if (!["REQUEST_FAILED", "REQUEST_TIMEOUT"].includes(safeCode(error))) fail("CLEANUP_UNCONFIRMED");
    }
    try { await delay(cleanupDelayMs, undefined, { signal }); } catch { break; }
  }
  fail("CLEANUP_UNCONFIRMED");
}

export async function checkPrivateAccess(run, options = {}) {
  const { saveRecovery = async () => {}, clearRecovery = async () => {}, report = () => {},
    signal, flowMs = 120_000, pollMs = 1_000 } = options;
  const flowSignal = AbortSignal.any([AbortSignal.timeout(flowMs), ...(signal ? [signal] : [])]);
  const call = client(run, options);
  const base = `/api/guides/${run.guideId}`;
  let attemptedUpload = false;
  let recoverySaved = false;
  let signedAssets = [];
  let failure;
  try {
    const health = await call("/api/healthz", { signal: flowSignal });
    if (health.body?.status !== "ok") fail("SERVER_NOT_READY");
    report("SERVER_READY");
    const form = new FormData();
    form.append("video", new Blob([syntheticVideo()], { type: "video/mp4" }), `showme-synthetic-access-${run.guideId}.mp4`);
    // Persist before sending, so a lost upload response / interruption cannot
    // lose the only credential needed to delete this synthetic test job.
    await saveRecovery(run);
    recoverySaved = true;
    flowSignal.throwIfAborted();
    attemptedUpload = true;
    const upload = await call("/api/guides", { method: "POST", token: run.editToken, body: form,
      headers: { "X-ShowMe-Guide-Id": run.guideId }, signal: flowSignal, statuses: [202] });
    if (upload.body?.guideId !== run.guideId) fail("UPLOAD_IDENTITY_MISMATCH");
    report("SYNTHETIC_UPLOAD_ACCEPTED");
    let guide;
    while (true) {
      guide = ownedGuide(await call(base, { token: run.editToken, signal: flowSignal }), run);
      if (guide.status === "ready") break;
      if (!["uploading", "queued", "probing", "extracting"].includes(guide.status)) fail("PROCESSING_FAILED");
      await delay(pollMs, undefined, { signal: flowSignal });
    }
    const draft = ownedDraft(await call(`${base}/draft`, { token: run.editToken, signal: flowSignal }), run);
    report("OWNER_GUIDE_AND_DRAFT_OK");
    const assets = assetsFor(guide, run);
    signedAssets = assets.map(asset => asset.signed);
    for (const asset of assets) {
      const result = await call(asset.signed, { image: true, signal: flowSignal });
      if (!result.noStore) fail("PRIVATE_CACHE_POLICY_MISSING");
    }
    report("SIGNED_IMAGES_OK");
    const wrongToken = randomBytes(32).toString("base64url");
    for (const token of [undefined, wrongToken]) {
      for (const path of [base, `${base}/draft`, ...assets.map(asset => asset.path)]) {
        assertHidden(await call(path, { token, signal: flowSignal, statuses: [404] }));
      }
    }
    // Bracket denials with live owner success. A deleted/nonexistent guide is
    // not a positive access-control result.
    const after = ownedGuide(await call(base, { token: run.editToken, signal: flowSignal }), run);
    const afterDraft = ownedDraft(await call(`${base}/draft`, { token: run.editToken, signal: flowSignal }), run);
    if (after.status !== "ready" || JSON.stringify(afterDraft) !== JSON.stringify(draft)) fail("POSITIVE_CONTROL_CHANGED");
    for (const asset of assets) await call(asset.signed, { image: true, signal: flowSignal });
    report("NO_KEY_AND_WRONG_KEY_DENIED");
  } catch (error) { failure = signal?.aborted ? "CHECK_CANCELLED" : safeCode(error); }
  finally {
    if (attemptedUpload) {
      try {
        // Cleanup deliberately has its own budget and is not aborted by Ctrl-C.
        await cleanupRun(run, { ...options, signedAssets });
        await clearRecovery(run);
        report("TEST_GUIDE_DELETED");
      } catch {
        report("CLEANUP_UNCONFIRMED");
        failure = "CLEANUP_UNCONFIRMED";
      }
    } else if (recoverySaved) {
      try { await clearRecovery(run); } catch { failure = "RECOVERY_FILE_UNSAFE"; }
    }
  }
  if (failure) fail(failure);
  report("PASS");
}
