import { z } from "zod";
import type { Guide, GuideRepository, GuideWithSteps } from "./domain.js";
import type { Storage } from "./storage.js";
import type { AnalysisState } from "./analysis-state.js";
import type { PublicationHead } from "./publication-commit.js";
import { cleanupStorageKeys, guideAssetKeys, isDeletionPending, DELETION_PENDING, privateStorageDeletesPending } from "./asset-lifecycle.js";
import { publicationDigest, transitionPublicationJob, type PublicationJob } from "./publication-jobs.js";
import { transitionPrivacyAsset, type PrivacyAssetBatch } from "./privacy-assets.js";
import { cleanupPrivateRedactions } from "./privacy-asset-cleanup.js";

export const PRIVATE_MEDIA_EXPIRED = "PRIVATE_MEDIA_EXPIRED";
export const PRIVATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const uuid = z.string().uuid();
export const privateCleanupSchema = z.object({ guideId: id, id: uuid, expiredAt: z.string().datetime(),
  keys: z.array(z.string().min(1).max(1024)).min(1).max(4096) }).strict().superRefine((row, ctx) => {
  // This ledger owns only raw objects, never publication/private-redaction PNGs.
  if (new Set(row.keys).size !== row.keys.length || row.keys.some(key => !rawPrivateKey(row.guideId, key)))
    ctx.addIssue({ code: "custom", message: "Invalid private cleanup keys" });
});
export type PrivateCleanup = z.infer<typeof privateCleanupSchema>;
export const privateExpirySchema = z.object({ expectedUpdatedAt: z.string().datetime(), updatedBefore: z.string().datetime() }).strict();
export type PrivateExpiry = z.infer<typeof privateExpirySchema>;
export const privateCleanupQuerySchema = z.object({ after: uuid.optional(), limit: z.number().int().min(1).max(20).default(20) }).strict();
export type PrivateCleanupQuery = z.input<typeof privateCleanupQuerySchema>;
export interface PrivateRetentionRepository {
  expirePrivateDraft(guideId: string, command: PrivateExpiry, now?: Date): Promise<Guide | null>;
  getPrivateCleanup(guideId: string): Promise<PrivateCleanup | null>;
  listPrivateCleanup(query: PrivateCleanupQuery): Promise<PrivateCleanup[]>;
  completePrivateCleanup(guideId: string, cleanupId: string): Promise<boolean>;
  listExpiredRetainedGuides(limit?: number, now?: Date): Promise<Guide[]>;
}
function rawPrivateKey(guideId: string, key: string): boolean {
  if (!key.startsWith(`guides/${guideId}/`) || /[\\\u0000-\u001f]/.test(key) || key.split("/").some(s => s === "." || s === "..")) return false;
  const tail = key.slice(`guides/${guideId}/`.length);
  return /^(source(?:\/|\.)|frames\/|attempts\/[1-9][0-9]*\/frames\/)/.test(tail) && !tail.includes("private-redactions");
}
export const privateMediaExpired = (guide: Pick<Guide, "status" | "errorCode">): boolean => guide.status === "failed" && guide.errorCode === PRIVATE_MEDIA_EXPIRED;
export const retainedPublicationLive = (head: PublicationHead | null, now: Date): boolean => !!head?.activePublicationId && Date.parse(head.expiresAt) > now.getTime();

/** Parent lock required. Preserve the established last-successful-save 7-day
 * rule; publication/read/retry cleanup never renews that private timestamp. */
export function preparePrivateExpiry(guide: GuideWithSteps, analysis: AnalysisState, head: PublicationHead | null,
  jobs: PublicationJob[], assets: PrivacyAssetBatch[], command: PrivateExpiry, now: Date, cleanupId: string) {
  if (guide.updatedAt !== command.expectedUpdatedAt || isDeletionPending(guide)) return null;
  if (privateMediaExpired(guide)) {
    if (retainedPublicationLive(head, now)) return null;
    return { guide: { ...guide, status: "failed" as const, errorCode: DELETION_PENDING,
      statusMessage: "보관 기간이 끝난 자료를 정리하고 있어요.", errorMessage: "새 영상으로 시작해 주세요." }, cleanup: null, jobs: [], assets: [] };
  }
  if (!["ready", "failed"].includes(guide.status) || Date.parse(guide.updatedAt) > Date.parse(command.updatedBefore) ||
    (analysis.draft && Date.parse(analysis.draft.updatedAt) > Date.parse(command.updatedBefore))) return null;
  if (!head) return { guide: { ...guide, status: "failed" as const, errorCode: DELETION_PENDING, progress: 100,
    statusMessage: "보관 기간이 지난 미공개 초안을 삭제하고 있어요.", errorMessage: "미공개 초안의 보관 기간이 끝났어요." }, cleanup: null, jobs: [], assets: [] };
  // Only a completed media pipeline proves that original/frame writes settled.
  // Unknown/failed media work must not be declared physically cleaned here.
  if (guide.status !== "ready" || guide.errorCode !== null) return null;
  if (guide.processingAttemptCount > 20) throw new Error("PRIVATE_CLEANUP_CAPACITY");
  const cleanup = privateCleanupSchema.parse({ guideId: guide.id, id: cleanupId, expiredAt: now.toISOString(), keys: guideAssetKeys(guide, 100) });
  const changedJobs: PublicationJob[] = [], changedAssets = new Map<string, PrivacyAssetBatch>();
  for (const job of jobs.filter(j => j.status !== "succeeded")) {
    const next = transitionPublicationJob(guide, analysis, jobs, assets, { type: "cancel", id: job.id }, now, job.batchId)!;
    // Keep ownership/late-writer evidence, not unpublished editing text.
    const content = { title: "보관 기간이 지난 작업", steps: [{ id: "expired", shortLabel: "만료됨", instruction: "편집 자료가 만료됐어요.", taps: [] }] };
    changedJobs.push({ ...next.job, content, contentFingerprint: publicationDigest(content) });
    if (next.asset) changedAssets.set(next.asset.id, next.asset);
  }
  const active = jobs.find(j => j.id === head.activePublicationId)?.batchId;
  for (const asset of assets) if (asset.id !== active && !changedAssets.has(asset.id))
    changedAssets.set(asset.id, transitionPrivacyAsset(guide, analysis, asset, { type: "cancel", id: asset.id }, now)!.batch);
  return { guide: { ...guide, title: "보관 기간이 지난 안내서", sourceFilename: "expired-video", originalObjectKey: `guides/${guide.id}/source/expired`,
    sourceMimeType: "application/octet-stream", sourceSizeBytes: 0, durationMs: null, sourceWidth: null, sourceHeight: null,
    displayWidth: null, displayHeight: null, rotationDegrees: null, status: "failed" as const, errorCode: PRIVATE_MEDIA_EXPIRED, progress: 100,
    statusMessage: "원본과 편집 자료의 보관 기간이 끝났어요. 유효한 공유 안내서는 계속 볼 수 있어요.",
    errorMessage: "다시 분석하거나 편집하려면 새 영상을 올려 주세요." }, cleanup, jobs: changedJobs, assets: [...changedAssets.values()] };
}

/** Delete raw objects and non-active processed copies, never the active
 * publication. Retain the ledger until deletions and writers are acknowledged;
 * whole-guide deletion must also pass through this ledger. */
export async function cleanupExpiredPrivateMedia(repository: GuideRepository, storage: Storage, guideId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<boolean> {
  options.signal?.throwIfAborted(); const row = await repository.getPrivateCleanup(guideId); options.signal?.throwIfAborted();
  if (!row) return true;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  await cleanupStorageKeys(storage, row.keys, options); options.signal?.throwIfAborted();
  // Unpublished/replaced processed copies expire with the draft, too. The
  // active publication is ready (not cleanup) and additionally fenced by repo.
  let complete = true;
  for (const batch of await repository.listPrivacyAssetBatches(guideId)) {
    if (batch.status !== "cleanup") continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (!await cleanupPrivateRedactions(repository, storage, guideId, { ...options, batchId: batch.id, timeoutMs: remaining })) complete = false;
  }
  if (!complete) return false;
  return repository.completePrivateCleanup(guideId, row.id);
}
const cursors = new WeakMap<PrivateRetentionRepository, string>();
export async function sweepExpiredPrivateMedia(repository: GuideRepository, storage: Storage, options: { deadline: number; timeoutMs: number }) {
  if (privateStorageDeletesPending(storage)) return;
  const rows = await repository.listPrivateCleanup({ after: cursors.get(repository), limit: 20 });
  if (!rows.length) cursors.delete(repository);
  const errors: unknown[] = [];
  for (const row of rows) {
    const remaining = options.deadline - Date.now();
    if (remaining <= 0 || privateStorageDeletesPending(storage)) break;
    cursors.set(repository, row.id);
    try { await cleanupExpiredPrivateMedia(repository, storage, row.guideId, { timeoutMs: Math.min(options.timeoutMs, remaining) }); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Private media cleanup pending");
}
