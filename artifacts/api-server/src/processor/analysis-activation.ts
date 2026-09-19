import { createHash } from "node:crypto";
import { z } from "zod";

const ref = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
/** Scoped DB switch, not consent, runtime readiness or proof of image contents. */
export const analysisActivationSchema = z.object({
  id: z.string().uuid(), deploymentRef: ref, projectRef: ref, credentialRef: ref, storageRef: ref,
  guideId: z.string().min(1).max(128), grantHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime(),
}).strict();
export type AnalysisActivation = z.infer<typeof analysisActivationSchema>;

export function activationForGrant(id: string, grant: { input: { guideId: string }; expiresAt: string },
  binding: Pick<AnalysisActivation, "deploymentRef" | "projectRef" | "credentialRef" | "storageRef">): AnalysisActivation {
  return analysisActivationSchema.parse({ id, ...binding, guideId: grant.input.guideId, expiresAt: grant.expiresAt,
    grantHash: createHash("sha256").update(JSON.stringify(grant)).digest("hex") });
}

/** Called again under the shared accounting lock, not just against a cached readiness receipt. */
export function matchesAnalysisActivation(actual: AnalysisActivation | undefined, expected: AnalysisActivation | undefined,
  guideId: string, at: Date): boolean {
  if (!actual || !expected) return !actual && !expected; // Legacy unconfigured accounting remains testable.
  return Number.isFinite(at.valueOf()) && at.valueOf() < Date.parse(actual.expiresAt) && guideId === actual.guideId &&
    Object.keys(expected).every((key) => expected[key as keyof AnalysisActivation] === actual[key as keyof AnalysisActivation]);
}
