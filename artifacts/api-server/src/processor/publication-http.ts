import type { Request, Response, NextFunction } from "express";

const errors = {
  PUBLICATION_NOT_FOUND: [404, "게시 안내서를 찾을 수 없어요."],
  PUBLICATION_INVALID_REQUEST: [400, "게시 요청 형식을 확인해 주세요."],
  PUBLICATION_JSON_REQUIRED: [415, "요청을 JSON 형식으로 보내 주세요."],
  PUBLICATION_BODY_TOO_LARGE: [413, "게시 요청이 너무 커요."],
  PUBLICATION_CONFLICT: [409, "게시 또는 편집 상태가 바뀌었어요. 최신 상태를 확인해 주세요."],
  PUBLICATION_NOT_READY: [409, "저장된 최신 내용과 모든 개인정보 확인을 마친 뒤 게시해 주세요."],
  PUBLICATION_ORIGINAL_UNAVAILABLE: [409, "원본 영상 공유는 아직 사용할 수 없어요."],
  PUBLICATION_CAPACITY: [429, "게시 작업 정리가 끝난 뒤 다시 시도해 주세요."],
  PUBLICATION_UNAVAILABLE: [503, "게시 기능이 아직 준비되지 않았어요. 잠시 뒤 상태를 확인해 주세요."],
  PUBLICATION_TIMEOUT: [503, "게시 처리 확인이 지연됐어요. 같은 요청 ID로 상태를 확인해 주세요."],
} as const;
export class PublicationHttpError extends Error {
  constructor(readonly code: keyof typeof errors) { super(code); }
}
export function publicationHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive"); next();
}
export function publicationJson(res: Response, value: unknown, status = 200) {
  // Do not let Express conditional freshness turn a revoked request into 304.
  res.status(status).type("json").end(JSON.stringify(value));
}
export function publicationError(error: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.destroyed || res.writableEnded) return;
  if (error && typeof error === "object" && "code" in error && error.code === "GUIDE_NOT_FOUND") return next(error);
  const bodyType = error && typeof error === "object" && "type" in error ? error.type : undefined;
  const code = error instanceof PublicationHttpError ? error.code : bodyType === "entity.too.large" ? "PUBLICATION_BODY_TOO_LARGE"
    : bodyType === "entity.parse.failed" ? "PUBLICATION_INVALID_REQUEST" : bodyType === "encoding.unsupported" ? "PUBLICATION_JSON_REQUIRED"
      : "PUBLICATION_UNAVAILABLE";
  const [status, message] = errors[code];
  publicationJson(res, { code, error: message }, status);
}

/** Timed-out/aborted non-cooperative I/O keeps its slot until it actually ends. */
export function publicationRequestPool(limit: number, timeoutMs: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 32 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 25_000)
    throw new RangeError("Invalid publication HTTP limits");
  let active = 0;
  return (work: (req: Request, res: Response, signal: AbortSignal) => Promise<void>, advance = false) =>
    async (req: Request, res: Response, next: NextFunction) => {
      if (active >= limit) { next(new PublicationHttpError("PUBLICATION_UNAVAILABLE")); return; }
      active++;
      const abort = new AbortController(), error = () => new PublicationHttpError("PUBLICATION_TIMEOUT");
      const stopped = new Promise<never>((_resolve, reject) => abort.signal.addEventListener("abort", () => reject(error()), { once: true }));
      void stopped.catch(() => undefined);
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      const closed = () => { if (!res.writableEnded) abort.abort(); }; res.once("close", closed);
      const operation = Promise.resolve().then(() => work(req, res, abort.signal)).finally(() => { active--; });
      try { await Promise.race([operation, stopped]); if (advance) next(); } catch (err) { next(err); }
      finally { clearTimeout(timer); res.removeListener("close", closed); abort.abort(); }
    };
}
