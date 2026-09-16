import { z } from "zod";
import { GeminiError } from "./provider.js";
import { buildGeminiRequest, GEMINI_TEST_MODEL, type AnalysisInput } from "./request.js";

export const TOKEN_PROBE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEST_MODEL}:countTokens`;
export function buildTokenCountRequest(input: AnalysisInput) {
  return { generateContentRequest: { model: `models/${GEMINI_TEST_MODEL}`, ...buildGeminiRequest(input) } };
}
/** Shared bounded parser; no credentials, network, disk or implicit retry. */
export async function readTokenCountResponse(response: Response, signal: AbortSignal): Promise<number> {
  const maximum = 64 * 1024; const length = response.headers.get("content-length");
  if (!response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum))) {
    void response.body?.cancel().catch(() => {}); throw new GeminiError("GEMINI_RESPONSE_INVALID");
  }
  const reader = response.body.getReader(); const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = []; let size = 0; let reads = 0;
  try {
    while (true) {
      signal.throwIfAborted(); const chunk = await reader.read(); signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum || ++reads > 4096) throw new GeminiError("GEMINI_RESPONSE_INVALID");
      chunks.push(chunk.value);
    }
    const parsed = z.object({ totalTokens: z.number().int().positive().safe() }).safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
    if (!parsed.success) throw new GeminiError("GEMINI_RESPONSE_INVALID");
    return parsed.data.totalTokens;
  } finally { signal.removeEventListener("abort", cancel); cancel(); }
}
