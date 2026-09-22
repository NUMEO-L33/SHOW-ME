import { z } from "zod";
import { boundedRequest, ProcessorClientError } from "./processor-client.js";
import type { DraftIdentity } from "./draft-client.js";

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const jobSchema = z.object({ publicationId: uuid, status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  baseDraftRevision: version.refine(v => v > 0), errorCode: z.enum(["INPUT_CHANGED", "CANCELLED", "LEASE_EXPIRED", "ASSET_FAILED"]).nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
export const publicationStatusSchema = z.object({
  state: z.enum(["unpublished", "publishing", "published", "revoked", "expired"]), headVersion: version,
  pendingJobId: uuid.nullable(), activePublicationId: uuid.nullable(), publicPath: z.string().regex(/^\/g\/[A-Za-z0-9_-]{32}$/).nullable(),
  firstPublishedAt: z.string().datetime().nullable(), expiresAt: z.string().datetime().nullable(),
  canRequest: z.boolean(), canWithdraw: z.boolean(), job: jobSchema.nullable(),
}).strict().refine(s => (s.activePublicationId === null) === (s.publicPath === null) &&
  (s.headVersion === 0 ? s.firstPublishedAt === null && s.expiresAt === null && s.activePublicationId === null
    : s.firstPublishedAt !== null && s.expiresAt !== null && Date.parse(s.expiresAt) - Date.parse(s.firstPublishedAt) === 15 * 86400_000) &&
  (s.state !== "published" || s.activePublicationId !== null) && (s.state !== "publishing" || s.pendingJobId !== null) &&
  (s.state !== "expired" || s.publicPath === null && !s.canRequest) &&
  (!s.canRequest || s.pendingJobId === null) && s.canWithdraw === (s.activePublicationId !== null || s.pendingJobId !== null));
export type PublicationStatus = z.infer<typeof publicationStatusSchema>;
const publishSchema = z.object({ publicationId: uuid, baseDraftRevision: version.refine(v => v > 0), inputFingerprint: hash,
  reviewFingerprint: hash, originalSharingEnabled: z.literal(false), publicSharing: z.literal(true) }).strict();
export type PublishRequest = z.infer<typeof publishSchema>;
const stopSchema = z.object({ expectedHeadVersion: version, expectedJobId: uuid.nullable() }).strict();
export type UnpublishRequest = z.infer<typeof stopSchema>;

async function publicationRequest(identity: DraftIdentity, route: string, body?: PublishRequest | UnpublishRequest, signal?: AbortSignal, jobId?: string) {
  uuid.parse(identity.guideId); z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(identity.editToken);
  return boundedRequest(`${identity.baseUrl.replace(/\/+$/, "")}/api/guides/${identity.guideId}/${route}`, {
    method: body ? "POST" : "GET", signal,
    headers: { Authorization: `Bearer ${identity.editToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, async response => {
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ProcessorClientError("게시 상태를 확인하지 못했어요.", response.status, typeof payload?.code === "string" ? payload.code : undefined);
    const parsed = publicationStatusSchema.safeParse(payload?.publication);
    if (!parsed.success || jobId !== undefined && parsed.data.job?.publicationId !== jobId)
      throw new ProcessorClientError("게시 응답을 확인할 수 없어요.", undefined, "INVALID_RESPONSE");
    return parsed.data;
  });
}
export function getPublicationStatus(identity: DraftIdentity, publicationId?: string, signal?: AbortSignal): Promise<PublicationStatus> {
  if (publicationId !== undefined) uuid.parse(publicationId);
  return publicationRequest(identity, publicationId ? `publications/${publicationId}` : "publications", undefined, signal, publicationId);
}
/** One explicit request only. Keep its ID on uncertainty; never retry with a fresh ID automatically. */
export function publishGuide(identity: DraftIdentity, body: PublishRequest, signal?: AbortSignal): Promise<PublicationStatus> {
  const parsed = publishSchema.parse(body);
  return publicationRequest(identity, "publish", parsed, signal, parsed.publicationId);
}
export function unpublishGuide(identity: DraftIdentity, observed: UnpublishRequest, signal?: AbortSignal): Promise<PublicationStatus> {
  return publicationRequest(identity, "unpublish", stopSchema.parse(observed), signal);
}
export function publicationFailure(error: unknown): string {
  if (error instanceof ProcessorClientError) {
    if (error.status === 409) return "저장 또는 게시 상태가 바뀌었어요. 최신 상태와 개인정보 확인을 다시 확인해 주세요.";
    if (error.status === 404 || error.status === 401 || error.status === 403) return "이 작업의 접근 권한을 확인할 수 없어요.";
    if (error.status === 429) return "요청이 많거나 정리 중인 게시 작업이 있어요. 잠시 뒤 다시 확인해 주세요.";
  }
  return "게시 완료 여부를 확인하지 못했어요. 새 요청을 만들지 말고 같은 요청의 상태를 확인해 주세요.";
}
