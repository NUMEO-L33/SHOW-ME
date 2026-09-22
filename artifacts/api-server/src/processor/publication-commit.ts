import { z } from "zod";
import type { GuideWithSteps } from "./domain.js";
import type { AnalysisState } from "./analysis-state.js";
import { publicationContentSchema, publicationDigest, publicationInputCurrent, publicationJobSchema,
  publicationTime, type PublicationJob } from "./publication-jobs.js";
import { privacyAssetKeys, privacyAssetReceiptSchema, transitionPrivacyAsset, type PrivacyAssetBatch } from "./privacy-assets.js";
import { isDeletionPending } from "./asset-lifecycle.js";

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const guideId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const PUBLICATION_LIFETIME_MS = 15 * 24 * 60 * 60 * 1000;
export const publicationCommitSchema = z.object({ id: uuid, leaseId: uuid, expectedVersion: version }).strict();
export type PublicationCommit = z.infer<typeof publicationCommitSchema>;
export const guidePublicationSchema = z.object({
  guideId, id: uuid, batchId: uuid, revision: version, content: publicationContentSchema,
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().datetime(), originalSharingEnabled: z.literal(false),
  images: z.array(z.object({ stepId: guideId, width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096), frame: privacyAssetReceiptSchema, thumbnail: privacyAssetReceiptSchema }).strict()).min(1).max(24),
}).strict().superRefine((p, ctx) => {
  const keys = privacyAssetKeys({ guideId: p.guideId, id: p.batchId, frames: p.images });
  if (p.contentFingerprint !== publicationDigest(p.content) || p.images.length !== p.content.steps.length ||
    p.images.some((image, i) => image.stepId !== p.content.steps[i].id || image.width * image.height > 4_194_304 ||
      image.frame.key !== keys[i * 2] || image.thumbnail.key !== keys[i * 2 + 1]))
    ctx.addIssue({ code: "custom", message: "Invalid publication snapshot" });
});
export type GuidePublication = z.infer<typeof guidePublicationSchema>;
export const publicationHeadSchema = z.object({ guideId, version, publicSlug: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  activePublicationId: uuid.nullable(), firstPublishedAt: z.string().datetime(), expiresAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict().refine(h => Date.parse(h.expiresAt) - Date.parse(h.firstPublishedAt) === PUBLICATION_LIFETIME_MS &&
  Date.parse(h.updatedAt) >= Date.parse(h.firstPublishedAt));
export type PublicationHead = z.infer<typeof publicationHeadSchema>;
export type PublicationState = { head: PublicationHead | null; publications: GuidePublication[] };
export type PublicationCommitResult = { publication: GuidePublication; head: PublicationHead; replayed: boolean; active: boolean };
export interface PublicationRepository {
  /** Internal persistence only. Neither method authenticates users or exposes public DTOs. */
  getPublicationState(guideId: string): Promise<PublicationState | null>;
  commitPublication(guideId: string, command: PublicationCommit, now?: Date): Promise<PublicationCommitResult | null>;
}
export function validatePublicationState(state: PublicationState, jobs: PublicationJob[]): PublicationState {
  const publications = state.publications.map(p => guidePublicationSchema.parse(p));
  const head = state.head ? publicationHeadSchema.parse(state.head) : null;
  if (new Set(publications.map(p => p.id)).size !== publications.length ||
    publications.some(p => !jobs.some(j => j.guideId === p.guideId && j.id === p.id && j.batchId === p.batchId &&
      j.status === "succeeded" && j.contentFingerprint === p.contentFingerprint && j.revision === p.revision)) ||
    jobs.some(j => j.status === "succeeded" && !publications.some(p => p.guideId === j.guideId && p.id === j.id)) ||
    (head?.activePublicationId && !publications.some(p => p.guideId === head.guideId && p.id === head.activePublicationId)) ||
    (publications.length > 0 && !head)) throw new Error("INVALID_PUBLICATION_STATE");
  return { head, publications };
}
/** Cleanup may never take the currently referenced pixels while a guide is live.
 * Whole-guide deletion wins first through the existing durable deletion marker. */
export function publicationProtectsAsset(guide: GuideWithSteps, state: PublicationState, batchId: string): boolean {
  return !isDeletionPending(guide) && !!state.head?.activePublicationId &&
    state.publications.some(p => p.id === state.head!.activePublicationId && p.batchId === batchId);
}

/** Must run under the parent guide lock. Snapshot, head, job success and old
 * asset cleanup ownership are committed together. No storage/network I/O here. */
export function preparePublicationCommit(guide: GuideWithSteps, analysis: AnalysisState, jobs: PublicationJob[], assets: PrivacyAssetBatch[],
  state: PublicationState, raw: PublicationCommit, now: Date, newSlug: string):
  { result: PublicationCommitResult; job: PublicationJob; oldAsset?: PrivacyAssetBatch; changed: boolean } | null {
  const command = publicationCommitSchema.parse(raw), job = jobs.find(j => j.id === command.id);
  now = publicationTime(now);
  if (!job || isDeletionPending(guide)) return null;
  if (job.status === "succeeded") {
    const publication = state.publications.find(p => p.id === job.id), head = state.head;
    if (!publication || !head || job.leaseId !== command.leaseId || job.version !== command.expectedVersion + 1) return null;
    return { changed: false, job, result: { publication, head, replayed: true,
      active: head.activePublicationId === publication.id && now.getTime() < Date.parse(head.expiresAt) } };
  }
  if (job.status !== "running" || job.phase !== "assets-ready" || job.version !== command.expectedVersion || job.leaseId !== command.leaseId) return null;
  now = new Date(Math.max(now.getTime(), Date.parse(job.updatedAt), state.head ? Date.parse(state.head.updatedAt) : 0));
  if (Date.parse(job.leaseExpiresAt!) <= now.getTime() || (state.head && Date.parse(state.head.expiresAt) <= now.getTime())) return null;
  const batch = assets.find(b => b.id === job.batchId);
  if (!batch || batch.status !== "ready" || !batch.writerSettled || batch.writerId !== job.leaseId ||
    !publicationInputCurrent(guide, analysis, job, batch)) return null;
  const keys = privacyAssetKeys(batch);
  const publication = guidePublicationSchema.parse({ guideId: guide.id, id: job.id, batchId: job.batchId, revision: job.revision,
    content: job.content, contentFingerprint: job.contentFingerprint, createdAt: now.toISOString(), originalSharingEnabled: false,
    images: batch.frames.map((frame, i) => ({ stepId: frame.stepId, width: frame.width, height: frame.height,
      frame: batch.receipts.find(r => r.key === keys[i * 2]), thumbnail: batch.receipts.find(r => r.key === keys[i * 2 + 1]) })) });
  const head = publicationHeadSchema.parse(state.head ? { ...state.head, activePublicationId: publication.id,
    version: state.head.version + 1, updatedAt: now.toISOString() } : { guideId: guide.id, publicSlug: newSlug,
    activePublicationId: publication.id, version: 1, firstPublishedAt: now.toISOString(), updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PUBLICATION_LIFETIME_MS).toISOString() });
  let oldAsset: PrivacyAssetBatch | undefined;
  if (state.head?.activePublicationId) {
    const old = state.publications.find(p => p.id === state.head!.activePublicationId);
    const asset = old && assets.find(a => a.id === old.batchId);
    if (!old || !asset || asset.status !== "ready" || !asset.writerSettled) return null;
    oldAsset = transitionPrivacyAsset(guide, analysis, asset, { type: "cancel", id: asset.id }, now)!.batch;
  }
  const succeeded = publicationJobSchema.parse({ ...job, version: job.version + 1, status: "succeeded", phase: "committed",
    leaseExpiresAt: null, updatedAt: now.toISOString() });
  return { changed: true, job: succeeded, oldAsset, result: { publication, head, replayed: false, active: true } };
}
