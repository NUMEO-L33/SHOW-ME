import express, { type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { AnalysisContractError, analysisManifest, initialDraft, parseDraftDocument } from "./analysis-contract.js";
import type { AnalysisState } from "./analysis-state.js";
import type { GuideRepository, GuideWithSteps } from "./domain.js";
import { privacyCommandSchema } from "./privacy-review-schema.js";
import { privacyReviewState } from "./privacy-review.js";

const errors = {
  DRAFT_INVALID_REQUEST: [400, "저장할 제목·설명·목적·단계 형식을 확인해 주세요."],
  DRAFT_JSON_REQUIRED: [415, "저장 요청은 JSON 형식이어야 합니다."],
  DRAFT_BODY_TOO_LARGE: [413, "저장할 내용이 너무 커요."],
  DRAFT_MEDIA_CHANGED: [409, "영상 상태가 바뀌었어요. 최신 작업을 다시 열어 주세요."],
  DRAFT_CONFLICT: [409, "다른 창에서 편집이 저장됐어요. 현재 입력은 유지했습니다. 최신 저장본을 확인해 주세요."],
  DRAFT_UNAVAILABLE: [503, "서버 저장을 확인하지 못했어요. 입력을 유지하고 다시 시도해 주세요."],
} as const;
class DraftError extends Error {
  constructor(readonly code: keyof typeof errors) { super(code); }
}
const saveSchema = z.object({
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  document: z.unknown(),
}).strict();
function manifestFor(guide: GuideWithSteps) {
  try { return analysisManifest(guide); } catch { throw new DraftError("DRAFT_MEDIA_CHANGED"); }
}
function serialize(guide: GuideWithSteps, state: AnalysisState | null) {
  const manifest = manifestFor(guide);
  if (!state || (state.draft && state.draft.inputFingerprint !== manifest.fingerprint)) throw new DraftError("DRAFT_MEDIA_CHANGED");
  const draft = state.draft;
  const title = guide.title.replace(/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, 120) || "새 화면 안내서";
  const document = parseDraftDocument(draft?.document ?? { ...initialDraft(manifest), title }, manifest.frames);
  return { guideId: guide.id, revision: draft?.revision ?? 0, inputFingerprint: manifest.fingerprint,
    document, persisted: Boolean(draft), updatedAt: draft?.updatedAt ?? null };
}

/** Owner-only human editing. No storage reads, provider calls or analysis admission. */
export function createDraftRouter({ repository, authenticate }: {
  repository: GuideRepository; authenticate: (request: Request) => Promise<GuideWithSteps>;
}) {
  const router = express.Router({ mergeParams: true });
  const snapshots = new WeakMap<Request, GuideWithSteps>();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false,
    message: { code: "DRAFT_RATE_LIMIT", error: "저장 요청이 많아요. 잠시 뒤 다시 시도해 주세요." } }));
  router.use(async (req, _res, next) => {
    try { snapshots.set(req, await authenticate(req)); next(); } catch (error) { next(error); }
  });
  router.get("/privacy", async (req, res, next) => {
    try {
      if (Object.keys(req.query).length) throw new DraftError("DRAFT_INVALID_REQUEST");
      const before = snapshots.get(req)!;
      const state = await repository.getAnalysisState(before.id);
      const current = await authenticate(req);
      if (manifestFor(before).fingerprint !== manifestFor(current).fingerprint) throw new DraftError("DRAFT_MEDIA_CHANGED");
      const review = state && privacyReviewState(current, state);
      if (!review) throw new DraftError("DRAFT_CONFLICT");
      res.json({ draft: serialize(current, state), review });
    } catch (error) { next(error); }
  });
  router.post("/privacy", (req, _res, next) => {
    next(req.is("application/json") ? undefined : new DraftError("DRAFT_JSON_REQUIRED"));
  }, express.json({ limit: 8 * 1024, strict: true, inflate: false }), async (req, res, next) => {
    try {
      if (Object.keys(req.query).length) throw new DraftError("DRAFT_INVALID_REQUEST");
      const command = privacyCommandSchema.safeParse(req.body);
      if (!command.success) throw new DraftError("DRAFT_INVALID_REQUEST");
      const before = snapshots.get(req)!;
      const state = await repository.executeAnalysisCommand(before.id, command.data);
      if (!state) throw new DraftError("DRAFT_CONFLICT");
      const current = await authenticate(req);
      if (manifestFor(before).fingerprint !== manifestFor(current).fingerprint) throw new DraftError("DRAFT_MEDIA_CHANGED");
      const review = privacyReviewState(current, state);
      if (!review) throw new DraftError("DRAFT_CONFLICT");
      res.json({ draft: serialize(current, state), review });
    } catch (error) { next(error); }
  });
  router.get("/", async (req, res, next) => {
    try {
      const before = snapshots.get(req)!;
      const fingerprint = manifestFor(before).fingerprint;
      const state = await repository.getAnalysisState(before.id);
      const current = await authenticate(req);
      if (manifestFor(current).fingerprint !== fingerprint) throw new DraftError("DRAFT_MEDIA_CHANGED");
      res.json({ draft: serialize(current, state) });
    } catch (error) { next(error); }
  });
  router.put("/", (req, _res, next) => {
    next(req.is("application/json") ? undefined : new DraftError("DRAFT_JSON_REQUIRED"));
  }, express.json({ limit: 1024 * 1024, strict: true, inflate: false }), async (req, res, next) => {
    try {
      const parsed = saveSchema.safeParse(req.body);
      if (!parsed.success || parsed.data.document === undefined) throw new DraftError("DRAFT_INVALID_REQUEST");
      const before = snapshots.get(req)!;
      const manifest = manifestFor(before);
      if (manifest.fingerprint !== parsed.data.inputFingerprint) throw new DraftError("DRAFT_MEDIA_CHANGED");
      const document = parseDraftDocument(parsed.data.document, manifest.frames);
      const state = await repository.executeAnalysisCommand(before.id, {
        type: "save-editor-draft", expectedRevision: parsed.data.expectedRevision,
        expectedInputFingerprint: manifest.fingerprint, document,
      });
      if (!state) throw new DraftError("DRAFT_CONFLICT");
      const current = await authenticate(req);
      if (manifestFor(current).fingerprint !== manifest.fingerprint) throw new DraftError("DRAFT_MEDIA_CHANGED");
      res.json({ draft: serialize(current, state) });
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    // Preserve the application's authenticated 404 without exposing inner errors.
    if (error && typeof error === "object" && "code" in error && error.code === "GUIDE_NOT_FOUND") return next(error);
    const type = error && typeof error === "object" && "type" in error ? error.type : undefined;
    const code = error instanceof DraftError ? error.code : error instanceof AnalysisContractError ? "DRAFT_INVALID_REQUEST"
      : type === "entity.too.large" ? "DRAFT_BODY_TOO_LARGE" : type === "encoding.unsupported" ? "DRAFT_JSON_REQUIRED"
      : type === "entity.parse.failed" ? "DRAFT_INVALID_REQUEST" : "DRAFT_UNAVAILABLE";
    const [status, message] = errors[code];
    res.status(status).json({ error: message, code });
  });
  return router;
}
