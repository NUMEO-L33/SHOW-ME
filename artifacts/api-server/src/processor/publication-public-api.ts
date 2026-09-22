import express from "express";
import { rateLimit } from "express-rate-limit";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { z } from "zod";
import type { GuideRepository } from "./domain.js";
import type { Storage } from "./storage.js";
import { publicationAccessSchema, type AccessiblePublication } from "./publication-lifecycle.js";
import { privacyAssetReceiptSchema } from "./privacy-assets.js";
import { publicationHeaders, publicationJson, publicationError, publicationRequestPool, PublicationHttpError } from "./publication-http.js";

const imageParams = publicationAccessSchema.extend({ stepId: z.string().regex(/^step-[1-9][0-9]{0,2}$/),
  publicationId: publicationAccessSchema.shape.publicationId.unwrap(), variant: z.enum(["frame", "thumbnail"]) }).strict();
const imagePath = (slug: string, publicationId: string, stepId: string, variant: "frame" | "thumbnail") =>
  `/api/public/guides/${slug}/assets/${publicationId}/${stepId}/${variant}`;
function serialize({ head, publication }: AccessiblePublication) {
  return { publicationId: publication.id, title: publication.content.title, publishedAt: publication.createdAt,
    expiresAt: head.expiresAt, originalSharingEnabled: false,
    // Public identifiers are snapshot-local ordinals, never private draft IDs.
    steps: publication.content.steps.map((step, index) => ({ id: `step-${index + 1}`, shortLabel: step.shortLabel, instruction: step.instruction,
      taps: step.taps.map(tap => ({ center: { x: tap.center.x, y: tap.center.y }, radius: tap.radius, zIndex: tap.zIndex })),
      width: publication.images[index].width, height: publication.images[index].height,
      frameUrl: imagePath(head.publicSlug, publication.id, `step-${index + 1}`, "frame"),
      thumbnailUrl: imagePath(head.publicSlug, publication.id, `step-${index + 1}`, "thumbnail") })) };
}

/** Only immutable, currently active processed PNGs. No original or draft fallback. */
export function createPublicPublicationRouter({ repository, storage, timeoutMs = 25_000 }: {
  repository: GuideRepository; storage: Pick<Storage, "openRead">; timeoutMs?: number;
}) {
  const router = express.Router({ mergeParams: true }), metadata = publicationRequestPool(16, timeoutMs), images = publicationRequestPool(4, timeoutMs);
  const limited = (limit: number) => rateLimit({ windowMs: 60_000, limit, standardHeaders: "draft-8", legacyHeaders: false,
    message: { code: "PUBLICATION_RATE_LIMIT", error: "요청이 많아요. 잠시 뒤 다시 열어 주세요." } });
  router.use(publicationHeaders);
  router.get("/:slug", limited(120), metadata(async (req, res, signal) => {
    const parsed = publicationAccessSchema.safeParse({ slug: req.params.slug });
    if (!parsed.success || Object.keys(req.query).length) throw new PublicationHttpError("PUBLICATION_NOT_FOUND");
    const current = await repository.getAccessiblePublication(parsed.data); signal.throwIfAborted();
    if (!current) throw new PublicationHttpError("PUBLICATION_NOT_FOUND");
    publicationJson(res, { guide: serialize(current) });
  }));
  router.get("/:slug/assets/:publicationId/:stepId/:variant", limited(240), images(async (req, res, signal) => {
    const parsed = imageParams.safeParse(req.params);
    if (!parsed.success || Object.keys(req.query).length || req.header("Range")) throw new PublicationHttpError("PUBLICATION_NOT_FOUND");
    const { slug, publicationId, stepId, variant } = parsed.data, query = { slug, publicationId };
    const before = await repository.getAccessiblePublication(query); signal.throwIfAborted();
    const index = Number(stepId.slice(5)) - 1, image = before?.publication.images[index];
    if (!image) throw new PublicationHttpError("PUBLICATION_NOT_FOUND");
    const receipt = privacyAssetReceiptSchema.parse(image[variant]);
    let stream: Readable | undefined;
    const stop = () => stream?.destroy(); signal.addEventListener("abort", stop, { once: true });
    try {
      const openedStream = await storage.openRead(receipt.key).then(opened => {
        opened.on("error", () => undefined);
        if (signal.aborted) opened.destroy(); return opened;
      });
      stream = openedStream;
      signal.throwIfAborted();
      const chunks: Buffer[] = []; let size = 0;
      // Verify the entire bounded receipt before sending ANY bytes. This catches
      // accidental storage replacement/corruption instead of serving raw pixels.
      const hash = createHash("sha256");
      for await (const chunk of openedStream) {
        signal.throwIfAborted();
        if (!(chunk instanceof Uint8Array) || chunks.length >= 4096 || size + chunk.byteLength > receipt.size)
          throw new PublicationHttpError("PUBLICATION_UNAVAILABLE");
        size += chunk.byteLength; const copy = Buffer.from(chunk); hash.update(copy); chunks.push(copy);
      }
      signal.throwIfAborted();
      const bytes = Buffer.concat(chunks, size);
      if (size !== receipt.size || hash.digest("hex") !== receipt.sha256 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
        throw new PublicationHttpError("PUBLICATION_UNAVAILABLE");
      const current = await repository.getAccessiblePublication(query); signal.throwIfAborted();
      const currentReceipt = current?.publication.images[index]?.[variant];
      if (!currentReceipt || currentReceipt.key !== receipt.key || currentReceipt.sha256 !== receipt.sha256 || currentReceipt.size !== receipt.size)
        throw new PublicationHttpError("PUBLICATION_NOT_FOUND");
      res.status(200).type("png").setHeader("Content-Length", size);
      res.end(bytes);
    } finally { signal.removeEventListener("abort", stop); stream?.destroy(); }
  }));
  router.use(publicationError);
  return router;
}
