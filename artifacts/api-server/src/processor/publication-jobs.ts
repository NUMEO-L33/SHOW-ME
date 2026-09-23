import { createHash } from "node:crypto";
import { z } from "zod";
import { analysisManifest, parseDraftDocument, pointSchema } from "./analysis-contract.js";
import type { AnalysisState } from "./analysis-state.js";
import type { GuideWithSteps } from "./domain.js";
import { matchesPrivacyAssetInput, privacyAssetBatchSchema, privacyAssetReceiptSchema, transitionPrivacyAsset, type PrivacyAssetBatch } from "./privacy-assets.js";

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = (max: number) => z.string().trim().min(1).max(max)
  .refine(s => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s));
export const PUBLICATION_LEASE_MS = 120_000;
export const PUBLICATION_JOB_LIMIT = 32;
export const publicationRequestSchema = z.object({
  type: z.literal("request"), id: uuid, expectedDraftRevision: version,
  expectedInputFingerprint: hash, expectedReviewFingerprint: hash, originalSharingEnabled: z.boolean(),
}).strict();
const owner = { id: uuid, leaseId: uuid, expectedVersion: version };
export const publicationCommandSchema = z.discriminatedUnion("type", [
  publicationRequestSchema,
  z.object({ type: z.literal("claim"), ...owner }).strict(),
  z.object({ type: z.literal("assets-ready"), ...owner }).strict(),
  z.object({ type: z.literal("check-writer"), ...owner }).strict(),
  z.object({ type: z.literal("complete-assets"), ...owner, receipts: z.array(privacyAssetReceiptSchema).min(2).max(48) }).strict(),
  z.object({ type: z.literal("abandon"), id: uuid, leaseId: uuid }).strict(),
  z.object({ type: z.literal("fail"), ...owner }).strict(),
  z.object({ type: z.literal("recover"), id: uuid, expectedVersion: version }).strict(),
  z.object({ type: z.literal("cancel"), id: uuid }).strict(),
]);
export type PublicationCommand = z.infer<typeof publicationCommandSchema>;
export type PublicationRequest = z.infer<typeof publicationRequestSchema>;

// Explicit allowlist: no intent, original filename, source key, AI candidate,
// review ledger or editing credential is copied into the future viewer content.
export const publicationContentSchema = z.object({ title: text(120), steps: z.array(z.object({
  id, shortLabel: text(60), instruction: text(500),
  taps: z.array(z.object({ center: pointSchema, radius: z.number().finite().min(0).max(100),
    zIndex: z.number().int().min(0).max(100) }).strict()).max(21),
}).strict()).min(1).max(24) }).strict().refine(content => new Set(content.steps.map(s => s.id)).size === content.steps.length);
const failure = z.enum(["INPUT_CHANGED", "CANCELLED", "LEASE_EXPIRED", "ASSET_FAILED"]);
const baseJobSchema = z.object({
  guideId: id, id: uuid, version, requestFingerprint: hash,
  revision: version, inputFingerprint: hash, reviewFingerprint: hash, originalSharingEnabled: z.literal(false),
  batchId: uuid, content: publicationContentSchema, contentFingerprint: hash,
  status: z.enum(["queued", "running", "failed", "cancelled", "succeeded"]),
  phase: z.enum(["queued", "rendering", "assets-ready", "stopped", "committed"]),
  leaseId: uuid.nullable(), leaseExpiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), errorCode: failure.nullable(),
}).strict();
export type PublicationJob = z.infer<typeof baseJobSchema>;
export const publicationDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = publicationDigest;
function requestFingerprint(request: PublicationRequest) {
  return digest([request.expectedDraftRevision, request.expectedInputFingerprint,
    request.expectedReviewFingerprint, request.originalSharingEnabled]);
}
export const publicationJobSchema = baseJobSchema.superRefine((job, ctx) => {
  if (job.requestFingerprint !== requestFingerprint({ type: "request", id: job.id,
    expectedDraftRevision: job.revision, expectedInputFingerprint: job.inputFingerprint,
    expectedReviewFingerprint: job.reviewFingerprint, originalSharingEnabled: job.originalSharingEnabled }) ||
    job.contentFingerprint !== digest(job.content) || Date.parse(job.updatedAt) < Date.parse(job.createdAt) ||
    (job.status === "queued" && (job.phase !== "queued" || job.leaseId !== null || job.leaseExpiresAt !== null || job.errorCode !== null)) ||
    (job.status === "running" && (!["rendering", "assets-ready"].includes(job.phase) || !job.leaseId || !job.leaseExpiresAt || job.errorCode !== null ||
      Date.parse(job.leaseExpiresAt) <= Date.parse(job.updatedAt))) ||
    (["failed", "cancelled"].includes(job.status) && (job.phase !== "stopped" || job.leaseExpiresAt !== null || !job.errorCode))) {
    ctx.addIssue({ code: "custom", message: "Invalid publication job" });
  }
  if (job.status === "succeeded" && (job.phase !== "committed" || !job.leaseId || job.leaseExpiresAt !== null || job.errorCode !== null))
    ctx.addIssue({ code: "custom", message: "Invalid committed publication job" });
});
export class PublicationJobError extends Error {
  constructor(readonly code: "PUBLICATION_CONFLICT" | "PUBLICATION_NOT_READY" | "PUBLICATION_CAPACITY" | "PUBLICATION_ORIGINAL_UNAVAILABLE") {
    super(code);
  }
}
export interface PublicationJobRepository {
  /** Internal persistence; authenticated admission/execution uses this without exposing lease commands. */
  executePublicationCommand(guideId: string, command: PublicationCommand, now?: Date): Promise<PublicationJob | null>;
  getPublicationJob(guideId: string, jobId: string): Promise<PublicationJob | null>;
  listPublicationWork(limit?: number, now?: Date): Promise<Array<{ guideId: string; id: string; version: number }>>;
  /** Internal keyset scan. Queued discovery does not claim permission to render. */
  listPublicationRecovery(query: PublicationRecoveryQuery, now?: Date): Promise<PublicationRecoveryCandidate[]>;
}
export const publicationRecoveryQuerySchema = z.object({ kind: z.enum(["expired", "cleanup", "queued"]),
  limit: z.number().int().min(1).max(20).default(20), after: uuid.optional(), guideId: id.optional() }).strict();
export type PublicationRecoveryQuery = z.input<typeof publicationRecoveryQuerySchema>;
export type PublicationRecoveryCandidate = Pick<PublicationJob, "guideId" | "id" | "version" | "batchId">;
export function publicationTime(now = new Date()): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("Invalid publication clock");
  return new Date(now);
}
export function publicationWorkLimit(limit = 20): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid publication work limit");
  return limit;
}
export function publicationAvailableAt(job: PublicationJob): string | null {
  return job.status === "queued" ? job.createdAt : job.status === "running" ? job.leaseExpiresAt : null;
}
function contentFor(guide: GuideWithSteps, state: AnalysisState) {
  const document = parseDraftDocument(state.draft!.document, analysisManifest(guide).frames);
  return publicationContentSchema.parse({ title: document.title, steps: document.steps.map(step => ({
    id: step.id, shortLabel: step.shortLabel, instruction: step.instruction,
    taps: step.elements.flatMap(e => e.type === "tap" && e.visible ? [{ center: e.center, radius: e.radius, zIndex: e.zIndex }] : []),
  })) });
}
export function publicationInputCurrent(guide: GuideWithSteps, state: AnalysisState, job: PublicationJob, batch?: PrivacyAssetBatch) {
  return !!batch && batch.id === job.batchId && batch.guideId === job.guideId && batch.revision === job.revision &&
    batch.inputFingerprint === job.inputFingerprint && batch.reviewFingerprint === job.reviewFingerprint &&
    matchesPrivacyAssetInput(guide, state, batch) && digest(contentFor(guide, state)) === job.contentFingerprint;
}
const current = publicationInputCurrent;
type Transition = { job: PublicationJob; asset?: PrivacyAssetBatch; changed: boolean };
/** Must run under the parent guide lock, with asset and job writes in ONE commit.
 * Preparation commands never publish; only the separate atomic commit may succeed. */
export function transitionPublicationJob(guide: GuideWithSteps, state: AnalysisState, jobs: readonly PublicationJob[],
  assets: readonly PrivacyAssetBatch[], raw: PublicationCommand, now: Date, newBatchId: string): Transition | null {
  id.parse(guide.id); now = publicationTime(now);
  const command = publicationCommandSchema.parse(raw);
  const previous = jobs.find(j => j.id === command.id);
  if (command.type === "request") {
    if (previous) {
      if (previous.requestFingerprint !== requestFingerprint(command)) throw new PublicationJobError("PUBLICATION_CONFLICT");
      return { job: previous, changed: false }; // Never resurrect cancelled/failed work.
    }
    if (command.originalSharingEnabled) throw new PublicationJobError("PUBLICATION_ORIGINAL_UNAVAILABLE");
    if (jobs.length >= PUBLICATION_JOB_LIMIT || jobs.some(j => j.status === "queued" || j.status === "running") || assets.length >= 4)
      throw new PublicationJobError("PUBLICATION_CAPACITY");
    const reserved = transitionPrivacyAsset(guide, state, undefined, { type: "reserve", id: newBatchId,
      revision: command.expectedDraftRevision, inputFingerprint: command.expectedInputFingerprint,
      reviewFingerprint: command.expectedReviewFingerprint }, now);
    if (!reserved) throw new PublicationJobError("PUBLICATION_NOT_READY");
    const content = contentFor(guide, state);
    return { changed: true, asset: reserved.batch, job: publicationJobSchema.parse({ guideId: guide.id, id: command.id, version: 1,
      requestFingerprint: requestFingerprint(command), revision: command.expectedDraftRevision,
      inputFingerprint: command.expectedInputFingerprint, reviewFingerprint: command.expectedReviewFingerprint,
      originalSharingEnabled: false, batchId: reserved.batch.id, content, contentFingerprint: digest(content),
      status: "queued", phase: "queued", leaseId: null, leaseExpiresAt: null,
      createdAt: now.toISOString(), updatedAt: now.toISOString(), errorCode: null }) };
  }
  if (!previous) return null;
  const job = publicationJobSchema.parse(previous);
  const rawBatch = assets.find(b => b.id === job.batchId);
  const batch = rawBatch ? privacyAssetBatchSchema.parse(rawBatch) : undefined;
  const terminal = job.status === "failed" || job.status === "cancelled" || job.status === "succeeded";
  if (command.type === "cancel" && terminal) return { job, changed: false };
  if (command.type === "abandon" && job.leaseId !== command.leaseId) return null;
  if (command.type === "abandon" && terminal) return { job, changed: false };
  if (terminal || ("expectedVersion" in command && command.expectedVersion !== job.version)) return null;
  // Clamp a backwards host clock; PostgreSQL uses a fresh post-lock DB clock.
  now = new Date(Math.max(now.getTime(), Date.parse(job.updatedAt)));
  const stop = (status: "failed" | "cancelled", errorCode: z.infer<typeof failure>): Transition => {
    job.status = status; job.phase = "stopped"; job.errorCode = errorCode; job.leaseExpiresAt = null;
    job.version++; job.updatedAt = now.toISOString();
    const cancelled = batch ? transitionPrivacyAsset(guide, state, batch, { type: "cancel", id: batch.id }, now) : null;
    return { job: publicationJobSchema.parse(job), asset: cancelled?.batch, changed: true };
  };
  if (command.type === "cancel") return stop("cancelled", "CANCELLED");
  // Owning invocation only, including an expired lease or lost finish ack.
  // Does not claim that storage writes settled; the asset ledger retains that fact.
  if (command.type === "abandon") return stop("failed", "ASSET_FAILED");
  if (command.type === "recover") {
    if (job.status !== "running" || Date.parse(job.leaseExpiresAt!) > now.getTime()) return null;
    // Expired ownership is NOT evidence that a remote write stopped. Cancel and
    // retain the asset ledger, never reset writerSettled or reuse its object keys.
    return stop("failed", "LEASE_EXPIRED");
  }
  if (command.type === "claim") {
    if (job.status !== "queued") return null;
    if (!current(guide, state, job, batch) || batch?.status !== "reserved") return stop("failed", "INPUT_CHANGED");
    const claimed = transitionPrivacyAsset(guide, state, batch, { type: "claim", id: batch.id,
      version: batch.version, writerId: command.leaseId }, now);
    if (!claimed) return stop("failed", "ASSET_FAILED");
    job.status = "running"; job.phase = "rendering"; job.leaseId = command.leaseId;
    job.leaseExpiresAt = new Date(now.getTime() + PUBLICATION_LEASE_MS).toISOString();
    job.updatedAt = now.toISOString(); job.version++;
    return { job: publicationJobSchema.parse(job), asset: claimed.batch, changed: true };
  }
  if (job.status !== "running" || job.leaseId !== command.leaseId || Date.parse(job.leaseExpiresAt!) <= now.getTime()) return null;
  if (command.type === "fail") return stop("failed", "ASSET_FAILED");
  if (!current(guide, state, job, batch)) return stop("failed", "INPUT_CHANGED");
  if (command.type === "check-writer" || command.type === "complete-assets") {
    if (job.phase !== "rendering" || batch?.status !== "writing" || batch.writerId !== job.leaseId || batch.writerSettled) return null;
    if (command.type === "check-writer") return { job, changed: false };
    const settled = transitionPrivacyAsset(guide, state, batch, { type: "settle", id: batch.id,
      writerId: command.leaseId, receipts: command.receipts }, now);
    if (settled?.batch.status !== "ready") return null;
    job.phase = "assets-ready"; job.updatedAt = now.toISOString(); job.version++;
    return { job: publicationJobSchema.parse(job), asset: settled.batch, changed: true };
  }
  if (batch?.status !== "ready" || batch.writerId !== job.leaseId || !batch.writerSettled) return null;
  if (job.phase === "assets-ready") return { job, changed: false };
  job.phase = "assets-ready"; job.updatedAt = now.toISOString(); job.version++;
  return { job: publicationJobSchema.parse(job), changed: true };
}
