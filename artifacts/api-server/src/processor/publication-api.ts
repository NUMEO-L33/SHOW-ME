import express, { type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { GuideRepository, GuideWithSteps } from "./domain.js";
import { isDeletionPending } from "./asset-lifecycle.js";
import { PublicationJobError, publicationRequestSchema, type PublicationJob, type PublicationRequest } from "./publication-jobs.js";
import type { PublicationOwnerStatus } from "./publication-lifecycle.js";
import { publicationHeaders, publicationJson, publicationError, publicationRequestPool, PublicationHttpError } from "./publication-http.js";

/** Trusted running-executor composition, never a browser or environment enable flag. */
export interface PublicationAdmission {
  isAccepting(): boolean;
  request(guideId: string, command: PublicationRequest, signal: AbortSignal): Promise<PublicationJob | null>;
}
const uuid = publicationRequestSchema.shape.id;
const publishSchema = z.object({ publicationId: uuid, baseDraftRevision: publicationRequestSchema.shape.expectedDraftRevision,
  inputFingerprint: publicationRequestSchema.shape.expectedInputFingerprint, reviewFingerprint: publicationRequestSchema.shape.expectedReviewFingerprint,
  originalSharingEnabled: z.boolean(), publicSharing: z.literal(true) }).strict();
const stopSchema = z.object({ expectedHeadVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), expectedJobId: uuid.nullable() }).strict();
function serialize(status: PublicationOwnerStatus, accepting: boolean) {
  const { head, job } = status;
  return {
    state: status.expired ? "expired" : status.pendingJobId ? "publishing" : status.active ? "published" : head ? "revoked" : "unpublished",
    headVersion: head?.version ?? 0, pendingJobId: status.pendingJobId,
    activePublicationId: status.active ? head!.activePublicationId : null, publicPath: status.active ? `/g/${head!.publicSlug}` : null,
    firstPublishedAt: head?.firstPublishedAt ?? null, expiresAt: head?.expiresAt ?? null,
    canRequest: accepting && status.editable && !status.expired && !status.pendingJobId,
    canWithdraw: status.active || status.pendingJobId !== null,
    job: job ? { publicationId: job.id, status: job.status, baseDraftRevision: job.revision,
      errorCode: job.errorCode, createdAt: job.createdAt, updatedAt: job.updatedAt } : null,
  };
}

export function createPublicationRouter({ repository, authenticate, admission, timeoutMs = 5_000 }: {
  repository: GuideRepository; authenticate: (req: Request) => Promise<GuideWithSteps>;
  admission?: PublicationAdmission; timeoutMs?: number;
}) {
  const router = express.Router({ mergeParams: true }), json = express.json({ limit: 4096, strict: true, inflate: false });
  const pooled = publicationRequestPool(16, timeoutMs);
  const limited = (limit: number) => rateLimit({ windowMs: 60_000, limit, standardHeaders: "draft-8", legacyHeaders: false,
    message: { code: "PUBLICATION_RATE_LIMIT", error: "요청이 많아요. 잠시 뒤 다시 확인해 주세요." } });
  const authenticated = new WeakMap<Request, GuideWithSteps>();
  const accepting = () => admission?.isAccepting() === true;
  const authenticateCurrent = async (req: Request, signal: AbortSignal) => {
    const guide = await authenticate(req); signal.throwIfAborted();
    if (isDeletionPending(guide)) throw new PublicationHttpError("PUBLICATION_NOT_FOUND");
    return guide;
  };
  const read = async (req: Request, signal: AbortSignal, jobId?: string) => {
    const guide = authenticated.get(req) ?? await authenticateCurrent(req, signal);
    const status = await repository.getPublicationOwnerStatus(guide.id, jobId); signal.throwIfAborted();
    if (!status) throw new PublicationHttpError("PUBLICATION_NOT_FOUND");
    await authenticateCurrent(req, signal); return status;
  };
  router.use(publicationHeaders);
  const noQuery = (req: Request) => { if (Object.keys(req.query).length) throw new PublicationHttpError("PUBLICATION_INVALID_REQUEST"); };
  router.get(["/publications", "/publications/:publicationId"], limited(60), pooled(async (req, res, signal) => {
    await authenticateCurrent(req, signal); noQuery(req);
    const id = req.params.publicationId;
    if (id !== undefined && !uuid.safeParse(id).success) throw new PublicationHttpError("PUBLICATION_INVALID_REQUEST");
    publicationJson(res, { publication: serialize(await read(req, signal, id as string | undefined), accepting()) });
  }));
  // Authentication precedes JSON parsing; this router does not intercept other guide routes.
  router.post(["/publish", "/unpublish"], limited(20), pooled(async (req, _res, signal) => {
    authenticated.set(req, await authenticateCurrent(req, signal)); noQuery(req);
  }, true), (req, _res, next) => {
    next(req.is("application/json") ? undefined : new PublicationHttpError("PUBLICATION_JSON_REQUIRED"));
  }, json, pooled(async (req, res, signal) => {
    const guide = await authenticateCurrent(req, signal);
    try {
      if (req.path === "/unpublish") {
        const parsed = stopSchema.safeParse(req.body);
        if (!parsed.success) throw new PublicationHttpError("PUBLICATION_INVALID_REQUEST");
        const stopped = await repository.stopPublication(guide.id, { type: "withdraw", ...parsed.data }); signal.throwIfAborted();
        if (!stopped) throw new PublicationHttpError("PUBLICATION_CONFLICT");
        publicationJson(res, { publication: serialize(await read(req, signal), accepting()) }); return;
      }
      const parsed = publishSchema.safeParse(req.body);
      if (!parsed.success) throw new PublicationHttpError("PUBLICATION_INVALID_REQUEST");
      if (parsed.data.originalSharingEnabled) throw new PublicationHttpError("PUBLICATION_ORIGINAL_UNAVAILABLE");
      const command: PublicationRequest = { type: "request", id: parsed.data.publicationId,
        expectedDraftRevision: parsed.data.baseDraftRevision, expectedInputFingerprint: parsed.data.inputFingerprint,
        expectedReviewFingerprint: parsed.data.reviewFingerprint, originalSharingEnabled: false };
      const previous = await repository.getPublicationJob(guide.id, command.id); signal.throwIfAborted();
      // Recover a durable request even when the executor is now stopped. Repository
      // fingerprint comparison never restarts a cancelled/completed request.
      if (!previous && !accepting()) throw new PublicationHttpError("PUBLICATION_UNAVAILABLE");
      const job = previous ? await repository.executePublicationCommand(guide.id, command)
        : await admission!.request(guide.id, command, signal);
      signal.throwIfAborted();
      if (!job) throw new PublicationHttpError("PUBLICATION_CONFLICT");
      const current = await read(req, signal, command.id);
      publicationJson(res, { publication: serialize(current, accepting()) }, current.job?.status === "queued" || current.job?.status === "running" ? 202 : 200);
    } catch (error) {
      if (error instanceof PublicationJobError) throw new PublicationHttpError(error.code);
      throw error;
    }
  }));
  router.use(publicationError);
  return router;
}
