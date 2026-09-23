import { z } from "zod";
import type { GuideWithSteps } from "./domain.js";
import { emptyAnalysisState } from "./analysis-state.js";
import { isDeletionPending } from "./asset-lifecycle.js";
import { publicationHeadSchema, type GuidePublication, type PublicationHead, type PublicationState } from "./publication-commit.js";
import { publicationTime, transitionPublicationJob, type PublicationCommand, type PublicationJob } from "./publication-jobs.js";
import { transitionPrivacyAsset, type PrivacyAssetBatch } from "./privacy-assets.js";

const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const slug = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
export const publicationStopSchema = z.discriminatedUnion("type", [
  // Compare the observed head AND pending job. An old retry must not cancel a
  // newer, explicit publish request, including before the first publication.
  z.object({ type: z.literal("withdraw"), expectedHeadVersion: version, expectedJobId: uuid.nullable() }).strict(),
  z.object({ type: z.literal("expire"), expectedHeadVersion: version.refine(v => v > 0) }).strict(),
]);
export type PublicationStop = z.infer<typeof publicationStopSchema>;
export type PublicationStopResult = { head: PublicationHead | null; cancelledJobIds: string[]; changed: boolean };
export const publicationAccessSchema = z.object({ slug, publicationId: uuid.optional() }).strict();
export type PublicationAccess = z.infer<typeof publicationAccessSchema>;
export type AccessiblePublication = { head: PublicationHead; publication: GuidePublication };
/** Internal snapshot for the authenticated owner API; never serialize raw jobs. */
export type PublicationOwnerStatus = { head: PublicationHead | null; job: PublicationJob | null;
  pendingJobId: string | null; active: boolean; expired: boolean; editable: boolean };
export const publicationExpiryQuerySchema = z.object({ limit: z.number().int().min(1).max(20).default(20),
  after: z.object({ expiresAt: z.string().datetime(), publicSlug: slug }).strict().optional(),
  guideId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional() }).strict();
export type PublicationExpiryQuery = z.input<typeof publicationExpiryQuerySchema>;
export type PublicationExpiryCandidate = Pick<PublicationHead, "guideId" | "version" | "expiresAt" | "publicSlug">;
export interface PublicationLifecycleRepository {
  getPublicationOwnerStatus(guideId: string, jobId?: string, now?: Date): Promise<PublicationOwnerStatus | null>;
  /** Internal: caller must authenticate mutations. No public DTO or HTTP route. */
  stopPublication(guideId: string, command: PublicationStop, now?: Date): Promise<PublicationStopResult | null>;
  /** Rechecks current authority; raw internal records must not be sent as a public DTO. */
  getAccessiblePublication(query: PublicationAccess, now?: Date): Promise<AccessiblePublication | null>;
  listExpiredPublications(query: PublicationExpiryQuery, now?: Date): Promise<PublicationExpiryCandidate[]>;
}
const pending = (job: PublicationJob) => job.status === "queued" || job.status === "running";

export function selectPublicationOwnerStatus(guide: GuideWithSteps, state: PublicationState, jobs: PublicationJob[],
  assets: PrivacyAssetBatch[], jobId: string | undefined, now: Date): PublicationOwnerStatus | null {
  if (isDeletionPending(guide)) return null;
  const pendingJob = jobs.find(pending);
  const job = jobId ? jobs.find(j => j.id === jobId) : pendingJob ?? [...jobs].sort((a, b) =>
    Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1))[0];
  if (jobId && !job) return null;
  const { head } = state;
  return { head, job: job ?? null, pendingJobId: pendingJob?.id ?? null,
    active: !!(head && selectAccessiblePublication(guide, state, assets, { slug: head.publicSlug }, now)),
    expired: !!head && Date.parse(head.expiresAt) <= now.getTime(), editable: guide.status === "ready" && guide.errorCode === null };
}

/** An expired link cannot admit more image work while the sweeper is delayed.
 * Historical request lookup and owner cleanup remain possible. */
export function publicationPreparationAllowed(head: PublicationHead | null, jobs: PublicationJob[], command: PublicationCommand, now: Date): boolean {
  if (!head || Date.parse(head.expiresAt) > publicationTime(now).getTime()) return true;
  return ["cancel", "abandon", "fail", "recover"].includes(command.type) ||
    (command.type === "request" && jobs.some(j => j.id === command.id));
}

export function selectAccessiblePublication(guide: GuideWithSteps, state: PublicationState, assets: PrivacyAssetBatch[],
  query: PublicationAccess, now: Date): AccessiblePublication | null {
  const head = state.head;
  if (isDeletionPending(guide) || !head?.activePublicationId || head.publicSlug !== query.slug ||
    Date.parse(head.expiresAt) <= publicationTime(now).getTime() ||
    (query.publicationId && query.publicationId !== head.activePublicationId)) return null;
  const publication = state.publications.find(p => p.id === head.activePublicationId);
  const batch = publication && assets.find(b => b.id === publication.batchId && b.guideId === guide.id);
  if (!publication || !batch || batch.status !== "ready" || !batch.writerSettled ||
    publication.images.flatMap(i => [i.frame, i.thumbnail]).some(receipt =>
      !batch.receipts.some(r => r.key === receipt.key && r.sha256 === receipt.sha256 && r.size === receipt.size))) return null;
  return { head, publication };
}

/** Parent guide lock required. First revoke the reference AND fence every
 * observed pending writer in one transaction; storage deletion happens later. */
export function preparePublicationStop(guide: GuideWithSteps, state: PublicationState, jobs: PublicationJob[], assets: PrivacyAssetBatch[],
  raw: PublicationStop, now: Date): { result: PublicationStopResult; jobs: PublicationJob[]; assets: PrivacyAssetBatch[] } | null {
  const command = publicationStopSchema.parse(raw), head = state.head;
  now = publicationTime(now);
  if (isDeletionPending(guide) || (head?.version ?? 0) !== command.expectedHeadVersion) return null;
  const running = jobs.filter(pending);
  if (command.type === "withdraw") {
    if (running.some(j => j.id !== command.expectedJobId) ||
      (command.expectedJobId && !jobs.some(j => j.id === command.expectedJobId))) return null;
  } else if (!head || Date.parse(head.expiresAt) > now.getTime()) return null;
  now = new Date(Math.max(now.getTime(), head ? Date.parse(head.updatedAt) : 0, ...running.map(j => Date.parse(j.updatedAt))));
  const changedJobs: PublicationJob[] = [], changedAssets = new Map<string, PrivacyAssetBatch>();
  for (const job of running) {
    const stopped = transitionPublicationJob(guide, emptyAnalysisState(), jobs, assets, { type: "cancel", id: job.id }, now, job.batchId)!;
    changedJobs.push(stopped.job); if (stopped.asset) changedAssets.set(stopped.asset.id, stopped.asset);
  }
  if (head?.activePublicationId) {
    const publication = state.publications.find(p => p.id === head.activePublicationId)!;
    const asset = assets.find(b => b.id === publication.batchId);
    if (asset) changedAssets.set(asset.id, transitionPrivacyAsset(guide, emptyAnalysisState(), asset, { type: "cancel", id: asset.id }, now)!.batch);
  }
  const changed = !!head?.activePublicationId || changedJobs.length > 0;
  const nextHead = head && changed ? publicationHeadSchema.parse({ ...head, activePublicationId: null,
    version: head.version + 1, updatedAt: now.toISOString() }) : head;
  return { result: { head: nextHead, cancelledJobIds: changedJobs.map(j => j.id), changed }, jobs: changedJobs, assets: [...changedAssets.values()] };
}

export function publicationExpiryCandidate(head: PublicationHead, jobs: PublicationJob[], now: Date): boolean {
  return Date.parse(head.expiresAt) <= now.getTime() &&
    (!!head.activePublicationId || jobs.some(j => j.guideId === head.guideId && pending(j)));
}
export function comparePublicationExpiry(a: { expiresAt: string; publicSlug: string }, b: { expiresAt: string; publicSlug: string }): number {
  return Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || (a.publicSlug < b.publicSlug ? -1 : a.publicSlug > b.publicSlug ? 1 : 0);
}
