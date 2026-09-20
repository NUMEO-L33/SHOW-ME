import express, { type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { Readable } from "node:stream";
import { analysisManifest, parseDraftDocument } from "./analysis-contract.js";
import { attemptFrameObjectKey } from "./asset-lifecycle.js";
import type { GuideRepository, GuideWithSteps } from "./domain.js";
import type { Storage } from "./storage.js";
import { renderPrivateRedaction, PRIVACY_RENDER_VERSION } from "./privacy-render.js";

const querySchema = z.object({ revision: z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).refine(n => n <= 2_147_483_647),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), variant: z.enum(["frame", "thumbnail"]) }).strict();
class PreviewError extends Error { constructor(readonly status: number) { super("PRIVACY_PREVIEW_UNAVAILABLE"); } }

/** Owner-only, saved-revision preview. No public link, storage writes, draft approval or AI calls. */
export function createPrivacyPreviewRouter({ repository, storage, authenticate, ffmpegPath, render = renderPrivateRedaction }: {
  repository: GuideRepository; storage: Pick<Storage, "openRead">; ffmpegPath: string;
  authenticate: (request: Request) => Promise<GuideWithSteps>; render?: typeof renderPrivateRedaction;
}) {
  const router = express.Router({ mergeParams: true });
  let active = false;
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); next(); });
  router.use(rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false,
    message: { code: "PRIVACY_PREVIEW_RATE_LIMIT", error: "잠시 뒤 가림 미리보기를 다시 열어 주세요." } }));
  router.get("/:stepId/:variant", async (req, res, next) => {
    let ownsSlot = false;
    const abort = new AbortController();
    let stream: Readable | undefined;
    const stop = () => { abort.abort(); stream?.destroy(); };
    const timer = setTimeout(stop, 25_000);
    const closed = () => { if (!res.writableEnded) stop(); };
    res.once("close", closed);
    const stopped = new Promise<never>((_resolve, reject) => abort.signal.addEventListener("abort", () => reject(new PreviewError(503)), { once: true }));
    // Consume a possible early timeout while authentication is still pending.
    void stopped.catch(() => undefined);
    const guard = () => { if (abort.signal.aborted) throw new PreviewError(503); };
    const snapshot = async () => {
      const guide = await authenticate(req); guard();
      if (guide.status !== "ready" || guide.errorCode !== null) throw new PreviewError(409);
      const manifest = analysisManifest(guide);
      if (Object.keys(req.query).length) throw new PreviewError(400);
      const parsed = querySchema.safeParse({ revision: req.header("X-ShowMe-Draft-Revision"),
        fingerprint: req.header("X-ShowMe-Input-Fingerprint"), variant: req.params.variant });
      if (!parsed.success) throw new PreviewError(400);
      const state = await repository.getAnalysisState(guide.id); guard();
      if (!state?.draft || state.draft.revision !== parsed.data.revision || manifest.fingerprint !== parsed.data.fingerprint ||
          state.draft.inputFingerprint !== manifest.fingerprint) throw new PreviewError(409);
      const document = parseDraftDocument(state.draft.document, manifest.frames);
      const step = document.steps.find(step => step.id === req.params.stepId);
      const frame = guide.steps.find(frame => frame.id === step?.activeFrameStepId);
      if (!step || !frame) throw new PreviewError(404);
      const key = attemptFrameObjectKey(guide.id, guide.processingAttemptCount, frame.position + 1, "frame");
      if (key !== frame.representativeFrameKey) throw new PreviewError(409);
      return { guide, step, frame, key, query: parsed.data };
    };
    const work = async () => {
      const before = await snapshot(); guard();
      if (active) throw new PreviewError(503);
      active = true; ownsSlot = true;
      const openedStream = await storage.openRead(before.key).then(opened => {
        opened.on("error", () => undefined); if (abort.signal.aborted) opened.destroy(); return opened;
      }); stream = openedStream; guard();
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of openedStream) {
        guard(); if (!(chunk instanceof Uint8Array) || chunks.length >= 4096 || size + chunk.byteLength > 2 * 1024 * 1024) throw new PreviewError(503);
        size += chunk.byteLength; chunks.push(Buffer.from(chunk));
      }
      const masks = before.step.elements.filter(e => e.type === "privacy-mask" && e.enabled);
      // enabled controls privacy, not stacking/visibility; a hidden enabled mask still redacts.
      const png = await render({ bytes: Buffer.concat(chunks, size), width: before.frame.frameWidth!, height: before.frame.frameHeight!,
        masks: masks.map(e => { if (e.type !== "privacy-mask") throw new PreviewError(503); return e.bounds; }),
        variant: before.query.variant, ffmpegPath, signal: abort.signal });
      guard(); const current = await snapshot(); guard();
      if (current.key !== before.key || JSON.stringify(current.step) !== JSON.stringify(before.step)) throw new PreviewError(409);
      res.setHeader("X-ShowMe-Draft-Revision", String(before.query.revision));
      res.setHeader("X-ShowMe-Privacy-Render", PRIVACY_RENDER_VERSION);
      res.type("png").send(png);
    };
    const operation = work().finally(() => { if (ownsSlot) active = false; });
    try { await Promise.race([operation, stopped]); } catch (error) { next(error); }
    finally { clearTimeout(timer); stop(); res.removeListener("close", closed); }
  });
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error && typeof error === "object" && "code" in error && error.code === "GUIDE_NOT_FOUND") return next(error);
    res.status(error instanceof PreviewError ? error.status : 503).json({ code: "PRIVACY_PREVIEW_UNAVAILABLE",
      error: "가림 미리보기를 만들지 못했어요. 저장 상태와 최신 작업을 확인해 주세요. 원본으로 대신 표시하지 않습니다." });
  });
  return router;
}
