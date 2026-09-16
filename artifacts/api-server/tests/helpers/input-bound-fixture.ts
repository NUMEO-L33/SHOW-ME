import { type AnalysisInputBoundVerifier, type GeminiInputAudit } from "../../src/processor/gemini/input-bound.js";

/** Deliberately fictional evidence for orchestration tests, not a real tokenizer/countTokens result. */
export function inputBoundFixture(clock: () => Date): AnalysisInputBoundVerifier {
  return {
    async inspect(audit: GeminiInputAudit) {
      const { model, promptVersion, inputApprovalId, inputFingerprint, requestFingerprint } = audit;
      return { id: "fictional-token-evidence", sourceId: "fictional-token-source", kind: "reviewed-exact-request",
        model, promptVersion, inputApprovalId, inputFingerprint, requestFingerprint,
        checkedAt: clock().toISOString(), validUntil: new Date(clock().valueOf() + 20_000).toISOString(),
        totalInputTokenUpperBound: 1000, includes: "system-schema-metadata-targets-context-envelope" };
    },
    isCurrent: () => true,
  };
}
