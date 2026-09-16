import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { providerQuotaDay } from "../analysis-provider-quota.js";
import { auditGeminiInput } from "./input-bound.js";
import { GeminiError } from "./provider.js";
import { GEMINI_TEST_MODEL, type AnalysisInput } from "./request.js";
import { TOKEN_PROBE_ENDPOINT, buildTokenCountRequest, readTokenCountResponse } from "./count-request.js";
export { TOKEN_PROBE_ENDPOINT, buildTokenCountRequest } from "./count-request.js";
import { syntheticAnalysisInput } from "./synthetic.js";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../../.data/gemini-token-probe");

/** Explicit, invocation-local confirmations. Old .env smoke flags grant no authority here. */
export function tokenProbeMode(args: string[], env: NodeJS.ProcessEnv): "dry-run" | "live" {
  if (args.length === 0) return "dry-run";
  const flags = new Set(args);
  if (args.length !== 3 || flags.size !== 3 ||
      !["--live", "--confirm-free-project", "--approve-synthetic-images"].every((flag) => flags.has(flag))) {
    throw new GeminiError("GEMINI_DISABLED");
  }
  if (!/^[\x21-\x7e]{10,4096}$/.test(env.GEMINI_API_KEY ?? "")) throw new GeminiError("GEMINI_KEY_MISSING");
  return "live";
}

/** Two code-generated patterns repeated in six frame positions, not arbitrary/user images. */
export async function prepareSyntheticTokenProbe() {
  const source = await syntheticAnalysisInput();
  const frames = Array.from({ length: 6 }, (_, position) => ({
    stepId: `token-probe-${position}`, position, timestampMs: position * 1000 + 500, width: 640, height: 360,
  }));
  const input: AnalysisInput = {
    targets: frames.slice(1, 5), context: [frames[0], frames[5]],
    images: frames.map((frame) => ({ stepId: frame.stepId, mimeType: "image/jpeg", bytes: source.images[frame.position % 2].bytes })),
  };
  const body = JSON.stringify(buildTokenCountRequest(input));
  const fingerprint = createHash("sha256").update(body).digest("hex");
  return { input, body, report: {
    ...auditGeminiInput(input, "synthetic-token-probe-v1", fingerprint),
    api: "countTokens", syntheticOnly: true, distinctPatterns: 2,
    countRequestFingerprint: fingerprint,
    freeProjectEvidence: "operator-confirmation-only", projectVerifiedAutomatically: false,
    measuredInputTokens: null as number | null, enablesAnalysis: false,
  } };
}

/** One attempt per Pacific day in this checkout; not an account-wide quota or billing proof. */
export async function reserveTokenProbeAttempt(root: string, fingerprint: string, signal: AbortSignal, at = new Date()) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new GeminiError("GEMINI_DISABLED");
  if (signal.aborted) throw new GeminiError("GEMINI_CANCELLED");
  try {
    const target = join(root, providerQuotaDay(at));
    await mkdir(target, { recursive: true });
    const file = await open(join(target, "attempt.reserved"), "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ model: GEMINI_TEST_MODEL, fingerprint, reservedAt: at.toISOString() }));
      await file.sync();
    } finally { await file.close(); }
  } catch { throw new GeminiError("GEMINI_LOCAL_LIMIT"); }
  if (signal.aborted) throw new GeminiError("GEMINI_CANCELLED");
}

/** Developer diagnostic only. Never registered in the server or input-bound verifier. */
export async function runTokenProbe(args: string[], env: NodeJS.ProcessEnv, dependencies: {
  fetch?: typeof fetch; reserve?: typeof reserveTokenProbeAttempt; signal?: AbortSignal; timeoutMs?: number;
} = {}) {
  const mode = tokenProbeMode(args, env);
  const timeout = dependencies.timeoutMs ?? 20_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 20_000) throw new GeminiError("GEMINI_DISABLED");
  if (dependencies.signal?.aborted) throw new GeminiError("GEMINI_CANCELLED");
  const { body, report } = await prepareSyntheticTokenProbe();
  if (mode === "dry-run") return { ...report, freeProjectEvidence: "not-checked", status: "prepared-not-sent", networkCalls: 0 };

  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort();
  dependencies.signal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  let onAbort!: () => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new GeminiError(timedOut ? "GEMINI_TIMEOUT" : "GEMINI_CANCELLED"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const operation = async () => {
    if (dependencies.signal?.aborted) controller.abort();
    controller.signal.throwIfAborted();
    await (dependencies.reserve ?? reserveTokenProbeAttempt)(directory, report.countRequestFingerprint, controller.signal);
    controller.signal.throwIfAborted();
    const response = await (dependencies.fetch ?? globalThis.fetch)(TOKEN_PROBE_ENDPOINT, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY! }, body,
    });
    if (controller.signal.aborted || !response.ok) {
      void response.body?.cancel().catch(() => {});
      controller.signal.throwIfAborted();
      throw new GeminiError(response.status === 429 ? "GEMINI_QUOTA_LIMIT" :
        [401, 403].includes(response.status) ? "GEMINI_AUTH_FAILED" : "GEMINI_HTTP_FAILED", response.status);
    }
    const totalTokens = await readTokenCountResponse(response, controller.signal);
    controller.signal.throwIfAborted();
    return { ...report, status: "counted-synthetic-only", networkCalls: 1, measuredInputTokens: totalTokens };
  };
  try { return await Promise.race([operation(), deadline]); }
  catch (error) {
    if (controller.signal.aborted) throw new GeminiError(timedOut ? "GEMINI_TIMEOUT" : "GEMINI_CANCELLED");
    if (error instanceof GeminiError) throw error;
    throw new GeminiError("GEMINI_RESPONSE_INVALID");
  } finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener("abort", onParentAbort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runTokenProbe(process.argv.slice(2), process.env).then((report) => {
    console.log(JSON.stringify(report, null, 2));
  }).catch((error: unknown) => {
    console.error(JSON.stringify({ status: "failed-no-automatic-retry", code: error instanceof GeminiError ? error.code : "GEMINI_PROBE_FAILED",
      httpStatus: error instanceof GeminiError ? error.httpStatus : undefined }));
    process.exitCode = 1;
  });
}
