import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { AnalysisContractError, AnalysisProviderFailure, parseAnalysisOutput, type AnalysisProvider } from "../analysis-contract.js";
import { buildGeminiRequest, geminiEndpoint, GEMINI_MAX_OUTPUT_TOKENS, GEMINI_MODEL, isGeminiModel, type AnalysisInput, type GeminiModel } from "./request.js";

export class GeminiError extends AnalysisProviderFailure {
  override name = "GeminiError";
  readonly httpStatus?: number;
  constructor(readonly code: "GEMINI_DISABLED" | "GEMINI_KEY_MISSING" | "GEMINI_AUTH_FAILED" |
    "GEMINI_QUOTA_LIMIT" | "GEMINI_HTTP_FAILED" | "GEMINI_TIMEOUT" | "GEMINI_CANCELLED" |
    "GEMINI_RESPONSE_INVALID" | "GEMINI_LOCAL_LIMIT", httpStatus?: number) {
    super(code === "GEMINI_TIMEOUT" ? "AI_TIMEOUT" : code === "GEMINI_RESPONSE_INVALID" ? "AI_INVALID_OUTPUT" : "AI_PROVIDER_FAILED", code);
    // A bounded numeric status is safe to report; never attach provider bodies or credentials.
    this.httpStatus = Number.isInteger(httpStatus) && httpStatus! >= 400 && httpStatus! <= 599 ? httpStatus : undefined;
  }
}

export type RequestPermit = (signal: AbortSignal) => Promise<void>;
/** Recheck durable ownership/permission after asynchronous adapter work, then immediately before fetch. */
export type DispatchSendPermit = (signal: AbortSignal) => Promise<() => void>;
const counter = z.number().int().nonnegative().safe();
const envelopeSchema = z.object({
  modelVersion: z.string().optional(),
  candidates: z.array(z.object({ finishReason: z.string(), content: z.unknown().optional() })).max(1).optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z.unknown().optional(),
});
const usageSchema = z.object({
  promptTokenCount: counter, candidatesTokenCount: counter, thoughtsTokenCount: counter.optional(),
  toolUsePromptTokenCount: counter.optional(), totalTokenCount: counter,
});
const MAX_RESPONSE_BYTES = 512 * 1024;

/** Read a bounded body. Raw provider bodies/errors are never included in errors or logs. */
async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => {});
    throw new GeminiError("GEMINI_RESPONSE_INVALID");
  }
  if (!response.body) throw new GeminiError("GEMINI_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new GeminiError("GEMINI_RESPONSE_INVALID");
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new GeminiError("GEMINI_RESPONSE_INVALID"); }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export function parseGeminiResponse(raw: unknown, input: AnalysisInput, model: GeminiModel = GEMINI_MODEL): Awaited<ReturnType<AnalysisProvider["analyzeFrames"]>> {
  if (!isGeminiModel(model)) throw new GeminiError("GEMINI_DISABLED");
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success || (parsed.data.modelVersion !== undefined && parsed.data.modelVersion !== model)) {
    throw new GeminiError("GEMINI_RESPONSE_INVALID");
  }
  const response = parsed.data;
  const block = response.promptFeedback?.blockReason;
  if (block && block !== "BLOCK_REASON_UNSPECIFIED") {
    if (!["SAFETY", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY"].includes(block) || response.candidates?.length) {
      throw new GeminiError("GEMINI_RESPONSE_INVALID");
    }
    return { status: "refused" };
  }
  const candidate = response.candidates?.[0];
  if (!candidate) throw new GeminiError("GEMINI_RESPONSE_INVALID");
  if (candidate.finishReason === "MAX_TOKENS") return { status: "incomplete" };
  if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY",
    "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "ESCALATION"].includes(candidate.finishReason)) return { status: "refused" };
  if (candidate.finishReason !== "STOP" || response.modelVersion !== model) throw new GeminiError("GEMINI_RESPONSE_INVALID");
  const content = z.object({
    role: z.literal("model").optional(),
    parts: z.array(z.object({ text: z.string(), thought: z.boolean().optional(), thoughtSignature: z.string().optional() }).strict()).min(1).max(8),
  }).safeParse(candidate.content);
  const parsedUsage = usageSchema.safeParse(response.usageMetadata);
  if (!content.success || !parsedUsage.success) throw new GeminiError("GEMINI_RESPONSE_INVALID");
  // Never extract or persist reasoning/signatures; tool and other non-text parts fail closed.
  const text = content.data.parts.filter((part) => !part.thought).map((part) => part.text);
  if (!text.length) throw new GeminiError("GEMINI_RESPONSE_INVALID");
  let output: unknown;
  try { output = JSON.parse(text.join("")) as unknown; } catch { throw new AnalysisContractError(); }
  const validated = parseAnalysisOutput(output, input.targets.map((frame) => frame.stepId));
  if (validated.steps.some((step) => step.mergeWithNext)) throw new AnalysisContractError();
  const usage = parsedUsage.data;
  const outputTokens = usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0);
  if (!Number.isSafeInteger(outputTokens) || !Number.isSafeInteger(outputTokens + usage.promptTokenCount) ||
      usage.totalTokenCount < outputTokens + usage.promptTokenCount || (usage.toolUsePromptTokenCount ?? 0) !== 0) {
    throw new GeminiError("GEMINI_RESPONSE_INVALID");
  }
  return { status: "completed", output: validated, inputTokens: usage.promptTokenCount, outputTokens };
}

/** Internal adapter only. Startup and public upload endpoints never register this automatically. */
export class GeminiAnalysisProvider implements AnalysisProvider {
  readonly name = "gemini";
  readonly model: GeminiModel;
  readonly maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS;
  readonly dispatchContract = "single-send-v1" as const;
  /** A durable dispatcher must require zero; smoke tests retain their existing default. */
  get transientRetries(): 0 | 1 { return this.#options.transientRetries ?? 1; }
  readonly #options: {
    apiKey: string; allowExternalProcessing: boolean; reserveRequest: RequestPermit;
    fetch?: typeof fetch; timeoutMs?: number; transientRetries?: 0 | 1;
  };

  constructor(options: {
    apiKey: string; allowExternalProcessing: boolean; reserveRequest: RequestPermit;
    fetch?: typeof fetch; timeoutMs?: number; transientRetries?: 0 | 1; model?: GeminiModel;
  }) {
    const timeout = options.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000 ||
        ![0, 1].includes(options.transientRetries ?? 1)) throw new GeminiError("GEMINI_DISABLED");
    const model = options.model ?? GEMINI_MODEL;
    if (!isGeminiModel(model)) throw new GeminiError("GEMINI_DISABLED");
    this.model = model;
    this.#options = { ...options };
  }

  async analyzeFrames(input: AnalysisInput, parentSignal: AbortSignal, authorizeSend?: DispatchSendPermit) {
    if (!this.#options.allowExternalProcessing) throw new GeminiError("GEMINI_DISABLED");
    // Treat keys as opaque header values; current auth keys may contain periods.
    if (!/^[\x21-\x7e]{10,4096}$/.test(this.#options.apiKey)) throw new GeminiError("GEMINI_KEY_MISSING");
    if (parentSignal.aborted) throw new GeminiError("GEMINI_CANCELLED");
    const body = JSON.stringify(buildGeminiRequest(input));
    const controller = new AbortController();
    let timedOut = false;
    const onParentAbort = () => controller.abort();
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#options.timeoutMs ?? 60_000);
    let onAbort!: () => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new GeminiError(timedOut ? "GEMINI_TIMEOUT" : "GEMINI_CANCELLED"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const operation = async () => {
      const send = this.#options.fetch ?? globalThis.fetch;
      for (let attempt = 0; attempt <= (this.#options.transientRetries ?? 1); attempt += 1) {
        controller.signal.throwIfAborted();
        await this.#options.reserveRequest(controller.signal);
        controller.signal.throwIfAborted();
        const finalCheck = await authorizeSend?.(controller.signal);
        controller.signal.throwIfAborted();
        // No await between this synchronous guard and fetch. A Promise is not a valid guard.
        if (authorizeSend) {
          if (typeof finalCheck !== "function") throw new GeminiError("GEMINI_DISABLED");
          const returned: unknown = finalCheck();
          if (returned !== undefined) {
            void Promise.resolve(returned).catch(() => undefined);
            throw new GeminiError("GEMINI_DISABLED");
          }
        }
        const response = await send(geminiEndpoint(this.model), {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { "content-type": "application/json", "x-goog-api-key": this.#options.apiKey }, body,
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          controller.signal.throwIfAborted();
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          if (response.status === 401 || response.status === 403) throw new GeminiError("GEMINI_AUTH_FAILED", response.status);
          // Free daily quota failures must not trigger an automatic retry loop.
          if (response.status === 429) throw new GeminiError("GEMINI_QUOTA_LIMIT", response.status);
          if ([500, 502, 503, 504].includes(response.status) && attempt < (this.#options.transientRetries ?? 1)) {
            await delay(500, undefined, { signal: controller.signal });
            continue;
          }
          throw new GeminiError("GEMINI_HTTP_FAILED", response.status);
        }
        return parseGeminiResponse(await readResponse(response, controller.signal), input, this.model);
      }
      throw new GeminiError("GEMINI_HTTP_FAILED");
    };
    try { return await Promise.race([operation(), deadline]); }
    catch (error) {
      if (error instanceof GeminiError || error instanceof AnalysisContractError) throw error;
      if (controller.signal.aborted) throw new GeminiError(timedOut ? "GEMINI_TIMEOUT" : "GEMINI_CANCELLED");
      throw new GeminiError("GEMINI_HTTP_FAILED");
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", onParentAbort);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }
}
