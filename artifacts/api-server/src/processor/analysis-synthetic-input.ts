import { createHash } from "node:crypto";
import { z } from "zod";
import { analysisManifest } from "./analysis-contract.js";
import { analysisAdmissionInputSchema, type AnalysisAdmissionInput } from "./analysis-admission.js";
import { createPrivateAnalysisImageLoader } from "./analysis-images.js";
import { LocalAnalysisEvidence, evidenceUnavailable } from "./analysis-local-evidence.js";
import type { AnalysisApprovedInputEvidence, AnalysisEvidenceSource } from "./analysis-readiness.js";
import type { GuideRepository } from "./domain.js";
import type { Storage } from "./storage.js";
import { boundedCountPolicySchema } from "./gemini/count-policy.js";
import { syntheticAnalysisInput } from "./gemini/synthetic.js";

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const syntheticInputGrantSchema = z.object({
  kind: z.literal("fixed-synthetic-screens-v1"), approvalId: id, deploymentRef: id,
  input: analysisAdmissionInputSchema, createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  inputTokenLimit: z.number().int().positive().safe(), countPolicy: boundedCountPolicySchema,
}).strict();
export type SyntheticInputGrant = z.infer<typeof syntheticInputGrantSchema>;
type CountableEvidence = Extract<AnalysisApprovedInputEvidence, { kind: "approved-countable-input" }>;

/**
 * Explicit server-owned grant for the TWO frozen bundled screens only. No user-
 * supplied pixels, hashes, URLs or file names can expand that allowlist. A grant
 * is not inferred from a hash; the private loader enforces its exact bytes before
 * every send. No HTTP/env registration and no external request here.
 */
export class FixedSyntheticInputSource implements AnalysisEvidenceSource<CountableEvidence> {
  readonly #source: LocalAnalysisEvidence<CountableEvidence>;
  readonly #guard: () => void;
  #revoked = false;
  #loader?: ReturnType<typeof createPrivateAnalysisImageLoader>;
  constructor(options: { grant: SyntheticInputGrant; repository: Pick<GuideRepository, "getGuideById">;
    storage: Pick<Storage, "openRead">; ffmpegPath: string; clock?: () => Date }) {
    const parsed = syntheticInputGrantSchema.safeParse(options.grant); if (!parsed.success) evidenceUnavailable();
    const grant = parsed.data; const clock = options.clock ?? (() => new Date());
    const created = Date.parse(grant.createdAt); const expires = Date.parse(grant.expiresAt);
    if (expires <= created || expires - created > 86_400_000 || grant.input.frameCount !== 2) evidenceUnavailable();
    const repository = options.repository, storage = options.storage, ffmpegPath = options.ffmpegPath;
    let lastTime = -Infinity;
    this.#guard = () => { const at = clock().valueOf();
      if (this.#revoked || !Number.isFinite(at) || at < lastTime || at < created || at >= expires) evidenceUnavailable();
      lastTime = at; };
    this.#source = new LocalAnalysisEvidence({ clock, current: this.#guard, read: async (input, _signal, guard) => {
      if (Object.entries(grant.input).some(([key, value]) => input[key as keyof AnalysisAdmissionInput] !== value)) evidenceUnavailable();
      const guide = await repository.getGuideById(input.guideId); guard();
      if (!guide || guide.id !== input.guideId) evidenceUnavailable();
      const manifest = analysisManifest(guide); const fixture = await syntheticAnalysisInput(); guard();
      if (manifest.fingerprint !== input.inputFingerprint || manifest.frames.length !== fixture.targets.length ||
          manifest.frames.some((frame, i) => ["position", "width", "height", "timestampMs"].some((key) =>
            frame[key as keyof typeof frame] !== fixture.targets[i][key as keyof typeof frame]))) evidenceUnavailable();
      const approval = { id: grant.approvalId, scope: "approved_synthetic" as const, guideId: input.guideId,
        inputFingerprint: manifest.fingerprint, createdAt: grant.createdAt, expiresAt: grant.expiresAt,
        images: manifest.frames.map((frame, i) => ({ stepId: frame.stepId,
          sha256: createHash("sha256").update(fixture.images[i].bytes).digest("hex") })) };
      guard();
      this.#loader = createPrivateAnalysisImageLoader({ repository, storage, approval, ffmpegPath, clock,
        isApprovalCurrent: (approvalId) => { try { this.#guard(); return approvalId === grant.approvalId; } catch { return false; } } });
      return { kind: "approved-countable-input", deploymentRef: grant.deploymentRef, input: grant.input,
        scope: "approved_synthetic", inputApprovalId: grant.approvalId, inputTokenLimit: grant.inputTokenLimit,
        countPolicy: grant.countPolicy, expiresAt: grant.expiresAt };
    } });
  }
  inspect(input: AnalysisAdmissionInput, signal: AbortSignal) { return this.#source.inspect(input, signal); }
  isCurrent(evidence: CountableEvidence) { return this.#source.isCurrent(evidence); }
  readonly loadImage = async (guideId: string, stepId: string, signal: AbortSignal, fingerprint: string) => {
    this.#guard(); if (!this.#loader) evidenceUnavailable();
    return this.#loader(guideId, stepId, signal, fingerprint);
  };
  /** Permanent for this process-local grant. A restart never restores it from user recovery data. */
  revoke() { this.#revoked = true; this.#loader = undefined; this.#source.clear(); }
}
