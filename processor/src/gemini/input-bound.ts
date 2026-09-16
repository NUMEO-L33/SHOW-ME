import { createHash } from "node:crypto";
import { z } from "zod";

import { AnalysisAdmissionError } from "../analysis-admission.js";
import { fundingDay } from "../analysis-funding.js";
import { providerQuotaDay } from "../analysis-provider-quota.js";
import { buildGeminiRequest, GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL, type AnalysisInput } from "./request.js";

/** Offline inventory, not a token counter. Bytes/approximate image tokens are NOT a proved total bound. */
export function auditGeminiInput(input: AnalysisInput, inputApprovalId: string, inputFingerprint: string) {
  const request = buildGeminiRequest(input);
  const serialized = JSON.stringify(request);
  const bytes = (value: string) => Buffer.byteLength(value, "utf8");
  return {
    model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION, inputApprovalId, inputFingerprint,
    requestFingerprint: createHash("sha256").update(JSON.stringify([GEMINI_TEST_MODEL, serialized])).digest("hex"),
    targetCount: input.targets.length, contextCount: input.context.length,
    systemInstructionBytes: bytes(JSON.stringify(request.systemInstruction)),
    metadataBytes: request.contents[0].parts.reduce((total, part) => total + ("text" in part ? bytes(part.text) : 0), 0),
    responseSchemaBytes: bytes(JSON.stringify(request.generationConfig.responseJsonSchema)),
    imageBytes: input.images.reduce((total, image) => total + image.bytes.byteLength, 0),
    requestBytes: bytes(serialized),
    // Google media-resolution documentation: approximate family-level default, NOT a total cap.
    approximateImageTokens: input.images.length * 1120,
    verifiedInputTokenUpperBound: null,
  };
}
export type GeminiInputAudit = ReturnType<typeof auditGeminiInput>;
export interface AnalysisInputBoundVerifier {
  /** Trusted offline/local evidence resolver. Must NOT upload images or call countTokens implicitly. */
  inspect(audit: GeminiInputAudit, signal: AbortSignal): Promise<unknown>;
  isCurrent(evidenceId: string): boolean;
}
const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceSchema = z.object({
  id, sourceId: id, kind: z.literal("reviewed-exact-request"),
  model: z.literal(GEMINI_TEST_MODEL), promptVersion: z.literal(GEMINI_PROMPT_VERSION),
  inputApprovalId: id, inputFingerprint: hash, requestFingerprint: hash,
  checkedAt: z.string().datetime(), validUntil: z.string().datetime(),
  totalInputTokenUpperBound: z.number().int().positive().safe(),
  includes: z.literal("system-schema-metadata-targets-context-envelope"),
}).strict();

/** Validates trusted evidence for the entire exact request; this shape alone is not provider proof. */
export function verifyGeminiInputBound(options: {
  audit: GeminiInputAudit; raw: unknown; verifier: AnalysisInputBoundVerifier; maxInputTokens: number;
  clock: () => Date; signal: AbortSignal;
}) {
  const unavailable = (): never => { throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE"); };
  const parsed = evidenceSchema.safeParse(options.raw);
  if (!parsed.success) throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE");
  const evidence = parsed.data;
  if (!["model", "promptVersion", "inputApprovalId", "inputFingerprint", "requestFingerprint"].every(
    (key) => evidence[key as keyof typeof evidence] === options.audit[key as keyof GeminiInputAudit]) ||
    !Number.isSafeInteger(options.maxInputTokens) || options.maxInputTokens < evidence.totalInputTokenUpperBound) unavailable();
  const initial = options.clock().valueOf();
  const assertCurrent = (at = options.clock()) => {
    const time = at.valueOf(); const checked = Date.parse(evidence.checkedAt); const expiry = Date.parse(evidence.validUntil);
    if (options.signal.aborted || !Number.isFinite(time) || !Number.isFinite(initial) || time < initial ||
        checked > time || expiry <= time || expiry <= checked || expiry - checked > 30_000 ||
        fundingDay(at) !== fundingDay(new Date(checked)) || providerQuotaDay(at) !== providerQuotaDay(new Date(checked))) unavailable();
    const current: unknown = options.verifier.isCurrent(evidence.id);
    if (current !== true) { void Promise.resolve(current).catch(() => undefined); unavailable(); }
  };
  assertCurrent();
  return { evidence, assertCurrent };
}
