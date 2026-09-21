import { createHash } from "node:crypto";
import { z } from "zod";
import { analysisManifest, parseDraftDocument } from "./analysis-contract.js";
import type { AnalysisState } from "./analysis-state.js";
import type { GuideWithSteps } from "./domain.js";
import { attemptFrameObjectKey } from "./asset-lifecycle.js";
import { privacyReviewState } from "./privacy-review.js";
import { PRIVACY_RENDER_VERSION } from "./privacy-render-version.js";

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bounds = z.object({ x: z.number().finite().min(0), y: z.number().finite().min(0),
  width: z.number().finite().positive(), height: z.number().finite().positive() }).strict()
  .refine(b => b.x + b.width <= 100 && b.y + b.height <= 100);
const frame = z.object({ stepId: id, frameStepId: id, sourceKey: z.string().max(512),
  width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096),
  masks: z.array(bounds).max(20) }).strict().refine(f => f.width * f.height <= 4_194_304);
export const privacyAssetReceiptSchema = z.object({ key: z.string().max(512), sha256: hash,
  size: z.number().int().positive().max(13 * 1024 * 1024) }).strict();
export const privacyAssetBatchSchema = z.object({
  guideId: id, id: z.string().uuid(), version: z.number().int().positive(),
  revision: z.number().int().positive(), inputFingerprint: hash, reviewFingerprint: hash,
  renderVersion: z.literal(PRIVACY_RENDER_VERSION), createdAt: z.string().datetime(),
  status: z.enum(["reserved", "writing", "ready", "cleanup"]), writerId: z.string().uuid().nullable(),
  writerSettled: z.boolean(), frames: z.array(frame).min(1).max(24),
  receipts: z.array(privacyAssetReceiptSchema).max(48),
}).strict().superRefine((b, ctx) => {
  const keys = privacyAssetKeys(b);
  if (new Set(b.frames.map(f => f.stepId)).size !== b.frames.length ||
      b.frames.some(f => !new RegExp(`^guides/${b.guideId}/attempts/[1-9][0-9]*/frames/frame-[0-9]{3}\\.jpg$`).test(f.sourceKey)) ||
      b.receipts.some(r => !keys.includes(r.key)) || new Set(b.receipts.map(r => r.key)).size !== b.receipts.length ||
      (!b.writerSettled && b.writerId === null) ||
      (b.status === "reserved" && (b.writerId !== null || !b.writerSettled || b.receipts.length !== 0)) ||
      (b.status === "writing" && (b.writerId === null || b.writerSettled)) ||
      (b.status === "ready" && (!b.writerSettled || !b.writerId || b.receipts.length !== keys.length))) {
    ctx.addIssue({ code: "custom", message: "Invalid private asset ledger" });
  }
});
export type PrivacyAssetBatch = z.infer<typeof privacyAssetBatchSchema>;
export type PrivacyAssetReceipt = z.infer<typeof privacyAssetReceiptSchema>;
export type PrivacyAssetCommand =
  | { type: "reserve"; id: string; revision: number; inputFingerprint: string; reviewFingerprint: string }
  | { type: "claim"; id: string; version: number; writerId: string }
  | { type: "settle"; id: string; writerId: string; receipts: PrivacyAssetReceipt[] | null }
  | { type: "cancel"; id: string }
  | { type: "cleaned"; id: string; version: number };
export interface PrivacyAssetRepository {
  /** Internal only. Reserve cleanup ownership BEFORE any storage write. Never publishes. */
  executePrivacyAssetCommand(guideId: string, command: PrivacyAssetCommand): Promise<PrivacyAssetBatch | null>;
  listPrivacyAssetBatches(guideId: string): Promise<PrivacyAssetBatch[]>;
}
export function privacyAssetKeys(batch: Pick<PrivacyAssetBatch, "guideId" | "id" | "frames">): string[] {
  return batch.frames.flatMap((_f, i) => ["frame", "thumbnail"].map(v =>
    `guides/${batch.guideId}/private-redactions/${batch.id}/${i}-${v}.png`));
}
export const privacyAssetDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function matches(guide: GuideWithSteps, state: AnalysisState, batch: Pick<PrivacyAssetBatch,
  "revision" | "inputFingerprint" | "reviewFingerprint"> & Partial<Pick<PrivacyAssetBatch, "frames">>) {
  if (guide.status !== "ready") return false;
  try {
    const view = privacyReviewState(guide, state);
    if (!view?.complete || view.revision !== batch.revision || view.inputFingerprint !== batch.inputFingerprint ||
        view.fingerprint !== batch.reviewFingerprint) return false;
    if (batch.frames) {
      const document = parseDraftDocument(state.draft!.document, analysisManifest(guide).frames);
      const expected = document.steps.map(step => {
        const source = guide.steps.find(f => f.id === step.activeFrameStepId)!;
        return { stepId: step.id, frameStepId: source.id, sourceKey: source.representativeFrameKey,
          width: source.frameWidth, height: source.frameHeight,
          masks: step.elements.flatMap(e => e.type === "privacy-mask" && e.enabled ? [e.bounds] : []) };
      });
      if (JSON.stringify(batch.frames) !== JSON.stringify(expected)) return false;
    }
    return true;
  } catch { return false; }
}

/** Parent-guide lock is held by both implementations, including against edit/delete. */
export function transitionPrivacyAsset(guide: GuideWithSteps, state: AnalysisState, previous: PrivacyAssetBatch | undefined,
  command: PrivacyAssetCommand, now: Date): { batch: PrivacyAssetBatch; remove?: boolean } | null {
  id.parse(guide.id); z.string().uuid().parse(command.id);
  if (command.type === "reserve") {
    if (previous || !matches(guide, state, command)) return null;
    const document = parseDraftDocument(state.draft!.document, analysisManifest(guide).frames);
    const frames = document.steps.map(step => {
      const source = guide.steps.find(f => f.id === step.activeFrameStepId)!;
      const key = attemptFrameObjectKey(guide.id, guide.processingAttemptCount, source.position + 1, "frame");
      if (source.representativeFrameKey !== key) throw new Error("PRIVACY_ASSET_SOURCE_INVALID");
      return { stepId: step.id, frameStepId: source.id, sourceKey: key, width: source.frameWidth!, height: source.frameHeight!,
        masks: step.elements.flatMap(e => e.type === "privacy-mask" && e.enabled ? [e.bounds] : []) };
    });
    return { batch: privacyAssetBatchSchema.parse({ guideId: guide.id, id: command.id, version: 1,
      revision: command.revision, inputFingerprint: command.inputFingerprint, reviewFingerprint: command.reviewFingerprint,
      renderVersion: PRIVACY_RENDER_VERSION, createdAt: now.toISOString(), status: "reserved", writerId: null,
      writerSettled: true, frames, receipts: [] }) };
  }
  if (!previous) return null;
  const batch = privacyAssetBatchSchema.parse(previous);
  if (batch.guideId !== guide.id || batch.id !== command.id) return null;
  switch (command.type) {
    case "claim":
      z.string().uuid().parse(command.writerId);
      if (batch.version !== command.version || batch.status !== "reserved" || !matches(guide, state, batch)) return null;
      batch.status = "writing"; batch.writerId = command.writerId; batch.writerSettled = false; break;
    case "settle":
      if (batch.writerId !== command.writerId || batch.writerSettled) return null;
      batch.writerSettled = true;
      batch.receipts = z.array(privacyAssetReceiptSchema).max(48).parse(command.receipts ?? []);
      batch.status = batch.status === "writing" && command.receipts && matches(guide, state, batch) ? "ready" : "cleanup";
      break;
    case "cancel": batch.status = "cleanup"; break;
    case "cleaned":
      if (batch.version !== command.version || batch.status !== "cleanup" || !batch.writerSettled) return null;
      return { batch, remove: true };
  }
  batch.version++;
  return { batch: privacyAssetBatchSchema.parse(batch) };
}
