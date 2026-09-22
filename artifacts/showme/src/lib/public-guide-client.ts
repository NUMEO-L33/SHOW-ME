import { z } from "zod";
import { boundedPublicRequest, ProcessorClientError } from "./processor-client.js";

const slugSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const percent = z.number().finite().min(0).max(100);
const text = (max: number) => z.string().min(1).max(max);
const publicGuideSchema = z.object({
  publicationId: z.string().uuid().regex(/^[a-f0-9-]+$/), title: text(120), publishedAt: z.string().datetime(),
  expiresAt: z.string().datetime(), originalSharingEnabled: z.literal(false),
  steps: z.array(z.object({ id: z.string(), shortLabel: text(60), instruction: text(500),
    taps: z.array(z.object({ center: z.object({ x: percent, y: percent }).strict(), radius: percent,
      zIndex: z.number().int().min(0).max(100) }).strict()).max(21),
    width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096),
    frameUrl: z.string(), thumbnailUrl: z.string(),
  }).strict()).min(1).max(24),
}).strict().refine(g => Date.parse(g.expiresAt) > Date.parse(g.publishedAt) &&
  Date.parse(g.expiresAt) - Date.parse(g.publishedAt) <= 15 * 86400_000);
export type PublicGuideSnapshot = z.infer<typeof publicGuideSchema>;

export function parsePublicGuide(payload: unknown, slug: string): PublicGuideSnapshot {
  slugSchema.parse(slug);
  const guide = z.object({ guide: publicGuideSchema }).strict().parse(payload).guide;
  for (const [index, step] of guide.steps.entries()) {
    const id = `step-${index + 1}`, prefix = `/api/public/guides/${slug}/assets/${guide.publicationId}/${id}`;
    if (step.id !== id || step.frameUrl !== `${prefix}/frame` || step.thumbnailUrl !== `${prefix}/thumbnail`)
      throw new ProcessorClientError("공개 이미지 주소를 확인할 수 없어요.", undefined, "INVALID_RESPONSE");
  }
  return guide;
}
async function readBounded(response: Response, max: number, signal?: AbortSignal) {
  if (!response.ok) throw new ProcessorClientError("공유 내용을 불러오지 못했어요.", response.status);
  if (!response.body || Number(response.headers.get("Content-Length")) > max) throw new Error("INVALID_RESPONSE");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
      if ((size += value.length) > max || chunks.length >= 8192) throw new Error("INVALID_RESPONSE"); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export function getPublicGuide(baseUrl: string, slug: string, signal?: AbortSignal) {
  slugSchema.parse(slug);
  return boundedPublicRequest(`${baseUrl.replace(/\/+$/, "")}/api/public/guides/${slug}`, signal, async response =>
    parsePublicGuide(JSON.parse(new TextDecoder().decode(await readBounded(response, 128 * 1024, signal))), slug));
}
/** One active frame, no private credential, redirect or original fallback. */
export function getPublicFrame(baseUrl: string, slug: string, guide: PublicGuideSnapshot, index: number, signal?: AbortSignal) {
  const safe = parsePublicGuide({ guide }, slug), step = safe.steps[index];
  if (!step || !Number.isInteger(index)) throw new Error("INVALID_STEP");
  return boundedPublicRequest(`${baseUrl.replace(/\/+$/, "")}${step.frameUrl}`, signal, async response => {
    const bytes = await readBounded(response, 13 * 1024 * 1024, signal);
    if (response.headers.get("Content-Type")?.split(";")[0] !== "image/png" ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) throw new Error("INVALID_IMAGE");
    return new Blob([bytes], { type: "image/png" });
  }, 30_000);
}
export function publicGuideFailure(error: unknown) {
  return error instanceof ProcessorClientError && error.status === 404
    ? "이 링크는 볼 수 없어요. 공유가 중지되었거나 기간이 끝났을 수 있어요."
    : "공유 내용을 확인하지 못했어요. 잠시 뒤 다시 불러와 주세요.";
}
