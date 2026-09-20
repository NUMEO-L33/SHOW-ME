import { z } from "zod";

const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const privacyLedgerSchema = z.object({
  policyVersion: z.literal("privacy-review-v1"),
  titleFingerprint: hash.nullable(),
  steps: z.array(z.object({
    stepId: id, sourceFingerprint: hash,
    imageFingerprint: hash.nullable(), textFingerprint: hash.nullable(),
    candidates: z.array(z.object({
      id: hash, status: z.enum(["pending", "masked", "dismissed"]), maskId: id.nullable(),
    }).strict().refine(v => (v.status === "masked") === (v.maskId !== null))).max(20),
  }).strict()).max(24),
  lastMutation: z.object({ id: z.string().uuid(), fingerprint: hash, baseRevision: z.number().int().nonnegative() }).strict().nullable(),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.steps.map(s => s.stepId)).size !== v.steps.length ||
      v.steps.some(s => new Set(s.candidates.map(c => c.id)).size !== s.candidates.length))
    ctx.addIssue({ code: "custom", message: "Duplicate privacy review identity." });
});
export type PrivacyLedger = z.infer<typeof privacyLedgerSchema>;
export const privacyActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("title"), confirmed: z.boolean() }).strict(),
  z.object({ type: z.literal("text"), stepId: id, confirmed: z.boolean() }).strict(),
  z.object({ type: z.literal("image"), stepId: id, confirmed: z.boolean() }).strict(),
  z.object({ type: z.literal("candidate"), stepId: id, candidateId: hash,
    status: z.enum(["pending", "masked", "dismissed"]), maskId: id.nullable(),
  }).strict(),
]);
export const privacyCommandSchema = z.object({
  type: z.literal("review-privacy"), expectedRevision: z.number().int().min(1).max(2_147_483_646),
  expectedInputFingerprint: hash, expectedReviewFingerprint: hash,
  mutationId: z.string().uuid(), action: privacyActionSchema,
}).strict();
export type PrivacyCommand = z.infer<typeof privacyCommandSchema>;
