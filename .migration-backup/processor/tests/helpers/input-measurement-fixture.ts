import type { AnalysisInputMeasurementVerifier, MeasurementLookup } from "../../src/gemini/input-measurement.js";

/** Fictional local test response ONLY. No real countTokens, consent or billing proof. */
export function inputMeasurementFixture(clock: () => Date): AnalysisInputMeasurementVerifier {
  return {
    async inspect(input: MeasurementLookup) {
      const { projectRef, model, promptVersion, inputApprovalId, inputFingerprint, requestFingerprint } = input;
      return { id: "fictional-count", kind: "countTokens-exact-request", projectRef, model, promptVersion,
        inputApprovalId, inputFingerprint, requestFingerprint, measuredInputTokens: 100,
        checkedAt: clock().toISOString(), validUntil: new Date(clock().valueOf() + 20_000).toISOString() };
    },
    isCurrent: () => true,
  };
}
