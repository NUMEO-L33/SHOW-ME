import express from "express";
import { rateLimit } from "express-rate-limit";
import type { GuideRepository } from "./domain.js";
import { publicationAccessSchema, type AccessiblePublication } from "./publication-lifecycle.js";
import { publicationHeaders, publicationRequestPool, PublicationHttpError } from "./publication-http.js";

const START = "<!-- showme:metadata:start -->", END = "<!-- showme:metadata:end -->";
const escape = (value: string) => value.replace(/[&<>"']/g, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const text = (value: string, limit: number) => Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ").trim()).slice(0, limit).join("");

export function renderPublicationPage(shell: string, current: AccessiblePublication, origin: string): string {
  if (Buffer.byteLength(shell) > 64 * 1024 || shell.split(START).length !== 2 || shell.split(END).length !== 2 ||
      shell.indexOf(START) > shell.indexOf(END)) throw new PublicationHttpError("PUBLICATION_UNAVAILABLE");
  const { head, publication } = current;
  const title = text(publication.content.title, 120), first = publication.content.steps[0];
  const description = text(first.instruction, 200) || `${publication.content.steps.length}단계 화면 안내서`;
  const url = `${origin}/g/${head.publicSlug}`;
  // This is the existing authority-checked processed PNG endpoint, not a bucket URL or signed private asset.
  const image = `${origin}/api/public/guides/${head.publicSlug}/assets/${publication.id}/step-1/thumbnail`;
  const meta = (name: string, value: string, property = true) => `<meta ${property ? "property" : "name"}="${name}" content="${escape(value)}" />`;
  const tags = [
    `<title>${escape(title)} · ShowMe</title>`, meta("description", description, false),
    meta("robots", "noindex, nofollow, noarchive", false), `<link rel="canonical" href="${escape(url)}" />`,
    meta("og:title", title), meta("og:description", description), meta("og:type", "website"),
    meta("og:site_name", "ShowMe"), meta("og:locale", "ko_KR"), meta("og:url", url),
    meta("og:image", image), meta("og:image:type", "image/png"), meta("og:image:alt", text(first.shortLabel, 120)),
    meta("twitter:card", "summary_large_image", false), meta("twitter:title", title, false),
    meta("twitter:description", description, false), meta("twitter:image", image, false),
  ].join("\n    ");
  return shell.slice(0, shell.indexOf(START)) + tags + shell.slice(shell.indexOf(END) + END.length);
}

function pageError(res: express.Response, status: number) {
  const message = status === 404 ? "게시 안내서를 찾을 수 없어요. 링크가 만료되거나 공유가 중지되었을 수 있어요."
    : "안내서를 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.";
  res.status(status).type("html").end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow, noarchive"><title>ShowMe · 안내서를 열 수 없어요</title></head><body><main><h1>안내서를 열 수 없어요</h1><p>${message}</p></main></body></html>`);
}

export function createPublicationPageRouter({ repository, origin, loadShell, timeoutMs = 5_000 }: {
  repository: Pick<GuideRepository, "getAccessiblePublication">; origin?: string;
  loadShell: (signal: AbortSignal) => Promise<string>; timeoutMs?: number;
}) {
  const router = express.Router(), work = publicationRequestPool(8, timeoutMs);
  router.use(publicationHeaders);
  router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false,
    handler: (_req, res) => pageError(res, 429) }));
  router.get("/:slug", work(async (req, res, signal) => {
    const parsed = publicationAccessSchema.safeParse({ slug: req.params.slug });
    if (!parsed.success || req.originalUrl.includes("?")) throw new PublicationHttpError("PUBLICATION_NOT_FOUND");
    const before = await repository.getAccessiblePublication(parsed.data); signal.throwIfAborted();
    if (!before) throw new PublicationHttpError("PUBLICATION_NOT_FOUND");
    if (!origin) throw new PublicationHttpError("PUBLICATION_UNAVAILABLE");
    const shell = await loadShell(signal); signal.throwIfAborted();
    // Template I/O can overlap withdrawal, expiry or a republish. Never send the previous snapshot then.
    const current = await repository.getAccessiblePublication({ ...parsed.data, publicationId: before.publication.id });
    signal.throwIfAborted();
    if (!current) throw new PublicationHttpError("PUBLICATION_NOT_FOUND");
    const html = renderPublicationPage(shell, current, origin);
    res.status(200).type("html").end(html); // no automatic ETag/304 freshness
  }));
  router.use((_req, res) => pageError(res, 404));
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (!res.destroyed && !res.writableEnded) pageError(res,
      error instanceof PublicationHttpError && error.code === "PUBLICATION_NOT_FOUND" ? 404 : 503);
  });
  return router;
}
