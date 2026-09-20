import { z } from "zod";
import { boundedRequest, ProcessorClientError } from "./processor-client.js";
import { snapshotSchema, type DraftIdentity, type DraftSnapshot } from "./draft-client.js";
import { editableContent } from "./privacy-ledger.js";

const id = z.string().min(1).max(128), hash = z.string().regex(/^[a-f0-9]{64}$/);
const percent = z.number().finite().min(0).max(100);
const bounds = z.object({ x: percent, y: percent, width: percent.positive(), height: percent.positive() }).strict()
  .refine(v => v.x + v.width <= 100 && v.y + v.height <= 100);
const reviewSchema = z.object({
  guideId: id, revision: z.number().int().positive(), inputFingerprint: hash, fingerprint: hash,
  titleFingerprint: hash, titleConfirmed: z.boolean(), complete: z.boolean(), publicationEnabled: z.literal(false),
  steps: z.array(z.object({ stepId: id, frameStepId: id, sourceFingerprint: hash, imageFingerprint: hash, textFingerprint: hash,
    imageConfirmed: z.boolean(), textConfirmed: z.boolean(), candidates: z.array(z.object({ id: hash,
      kind: z.enum(["phone", "account", "identity", "address", "email", "balance", "password", "other"]), bounds,
      status: z.enum(["pending", "masked", "dismissed"]), maskId: id.nullable(), coveringMaskIds: z.array(id).max(20),
    }).strict()).max(20),
  }).strict()).min(1).max(24),
}).strict();
const envelope = z.object({ draft: snapshotSchema, review: reviewSchema }).strict();
export type PrivacyReview = z.infer<typeof reviewSchema>;
export type PrivacyReviewAction = { type: "title"; confirmed: boolean }
  | { type: "image" | "text"; stepId: string; confirmed: boolean }
  | { type: "candidate"; stepId: string; candidateId: string; status: "pending" | "masked" | "dismissed"; maskId: string | null };
export type PrivacyWrite = { type: "review-privacy"; expectedRevision: number; expectedInputFingerprint: string;
  expectedReviewFingerprint: string; mutationId: string; action: PrivacyReviewAction };
export function privacyWrite(base: DraftSnapshot, review: PrivacyReview, action: PrivacyReviewAction): PrivacyWrite {
  if (!base.persisted || base.revision !== review.revision || base.guideId !== review.guideId || base.inputFingerprint !== review.inputFingerprint)
    throw new ProcessorClientError("최신 저장본을 다시 확인해 주세요.", 409);
  return { type: "review-privacy", expectedRevision: base.revision, expectedInputFingerprint: base.inputFingerprint,
    expectedReviewFingerprint: review.fingerprint, mutationId: crypto.randomUUID(), action };
}
export async function requestPrivacyReview(identity: DraftIdentity, base: DraftSnapshot, write?: PrivacyWrite, signal?: AbortSignal) {
  return boundedRequest(`${identity.baseUrl.replace(/\/+$/, "")}/api/guides/${encodeURIComponent(identity.guideId)}/draft/privacy`, {
    method: write ? "POST" : "GET", signal, cache: "no-store",
    headers: { Authorization: `Bearer ${identity.editToken}`, ...(write ? { "Content-Type": "application/json" } : {}) },
    ...(write ? { body: JSON.stringify(write) } : {}),
  }, async response => {
    if (!response.ok) throw new ProcessorClientError("개인정보 확인을 저장하지 못했어요.", response.status);
    const parsed = envelope.safeParse(await response.json());
    if (!parsed.success) throw new ProcessorClientError("확인 응답 형식이 올바르지 않아요.", undefined, "INVALID_RESPONSE");
    const { draft, review } = parsed.data;
    if (draft.guideId !== identity.guideId || draft.guideId !== base.guideId || !draft.persisted ||
        draft.inputFingerprint !== base.inputFingerprint || draft.revision !== base.revision + (write ? 1 : 0) ||
        editableContent(draft.document) !== editableContent(base.document) || review.guideId !== draft.guideId ||
        review.revision !== draft.revision || review.inputFingerprint !== draft.inputFingerprint ||
        review.steps.length !== draft.document.steps.length || new Set(review.steps.map(s => s.stepId)).size !== review.steps.length ||
        review.steps.some(s => !draft.document.steps.some(d => d.id === s.stepId && d.activeFrameStepId === s.frameStepId) ||
          new Set(s.candidates.map(c => c.id)).size !== s.candidates.length ||
          s.imageConfirmed && s.candidates.some(c => c.status === "pending")) ||
        review.complete !== (review.titleConfirmed && review.steps.every(s => s.imageConfirmed && s.textConfirmed)) ||
        write && (draft.document.schemaVersion !== 2 || draft.document.privacy?.lastMutation?.id !== write.mutationId))
      throw new ProcessorClientError("저장된 내용이 바뀌었어요. 최신 저장본을 불러와 주세요.", 409);
    return parsed.data;
  });
}
