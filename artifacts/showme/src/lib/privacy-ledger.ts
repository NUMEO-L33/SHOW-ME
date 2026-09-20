import { z } from "zod";
import type { EditorDocument } from "./draft-client.js";

const id = z.string().min(1).max(128), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const privacyLedgerSchema = z.object({
  policyVersion: z.literal("privacy-review-v1"), titleFingerprint: hash.nullable(),
  steps: z.array(z.object({ stepId: id, sourceFingerprint: hash, imageFingerprint: hash.nullable(), textFingerprint: hash.nullable(),
    candidates: z.array(z.object({ id: hash, status: z.enum(["pending", "masked", "dismissed"]), maskId: id.nullable() })
      .strict().refine(v => (v.status === "masked") === (v.maskId !== null))).max(20),
  }).strict()).max(24),
  lastMutation: z.object({ id: z.string().uuid(), fingerprint: hash, baseRevision: z.number().int().nonnegative() }).strict().nullable(),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.steps.map(s => s.stepId)).size !== v.steps.length || v.steps.some(s => new Set(s.candidates.map(c => c.id)).size !== s.candidates.length))
    ctx.addIssue({ code: "custom", message: "Duplicate privacy review identity." });
});

/** Mirrors the server's invalidation, never creates an acknowledgement. */
export function privacyAfterEdit(previous: EditorDocument, next: EditorDocument) {
  if (!previous.privacy) return undefined;
  const privacy = structuredClone(previous.privacy), same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const masks = (s: EditorDocument["steps"][number]) => s.elements.filter(e => e.type === "privacy-mask").map(m =>
    [m.id, m.bounds.x, m.bounds.y, m.bounds.width, m.bounds.height, m.enabled, m.visible, m.zIndex]);
  if (previous.title !== next.title) privacy.titleFingerprint = null;
  privacy.steps = privacy.steps.filter(record => {
    const before = previous.steps.find(s => s.id === record.stepId), after = next.steps.find(s => s.id === record.stepId);
    if (!before || !after || !same([before.id, before.activeFrameStepId, before.sourceStepIds], [after.id, after.activeFrameStepId, after.sourceStepIds])) return false;
    if (!same(masks(before), masks(after))) {
      record.imageFingerprint = null;
      record.candidates = record.candidates.map(c => c.status === "masked" ? { ...c, status: "pending", maskId: null } : c);
    }
    if (before.shortLabel !== after.shortLabel || before.instruction !== after.instruction) record.textFingerprint = null;
    return true;
  });
  return privacy;
}

export function editableContent(document: EditorDocument) {
  const { schemaVersion: _version, privacy: _privacy, ...content } = document;
  return JSON.stringify(content);
}
