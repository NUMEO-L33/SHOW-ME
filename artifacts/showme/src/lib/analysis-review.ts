import { z } from "zod";
import { boundedRequest, ProcessorClientError } from "./processor-client.js";
import { editorDocumentSchema, type DraftIdentity, type DraftSnapshot, type EditorDocument } from "./draft-client.js";

const id = z.string().min(1).max(128);
const text = (max: number) => z.string().trim().min(1).max(max).refine(v => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v));
const percent = z.number().finite().min(0).max(100);
const point = z.object({ x: percent, y: percent }).strict();
const rect = z.object({ x: percent, y: percent, width: percent.positive(), height: percent.positive() }).strict()
  .refine(v => v.x + v.width <= 100 && v.y + v.height <= 100);
const suggestion = z.object({
  stepId: id, shortLabel: text(60), instruction: text(500),
  action: z.enum(["tap", "wait", "observe", "unknown"]), target: point.nullable(),
  privacy: z.array(z.object({ kind: z.enum(["phone", "account", "identity", "address", "email", "balance", "password", "other"]), bounds: rect }).strict()).max(20),
  reviewReasons: z.array(z.enum(["unclear_action", "small_text", "missing_context", "privacy_uncertain"])).max(4),
  mergeWithNext: z.boolean(),
}).strict().refine(v => (v.action === "tap" || v.target === null) &&
  (!(v.action === "unknown" || v.action === "tap" && v.target === null) || v.reviewReasons.length > 0));
const revision = z.number().int().min(0).max(2_147_483_647);
const runSchema = z.object({
  runId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]), model: id,
  baseDraftRevision: revision, appliedDraftRevision: revision.nullable(), cancellable: z.boolean(), reviewRequired: z.boolean(),
  result: z.object({ schemaVersion: z.literal(1), steps: z.array(suggestion).min(1).max(24) }).strict().nullable(),
  errorCode: z.enum(["AI_REFUSED", "AI_INCOMPLETE", "AI_INVALID_OUTPUT", "AI_TIMEOUT", "AI_PROVIDER_FAILED"]).nullable(),
  inputTokens: z.number().int().nonnegative().safe(), outputTokens: z.number().int().nonnegative().safe(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict().refine(v => v.cancellable === (v.status === "queued" || v.status === "running") &&
  v.reviewRequired === (v.status === "succeeded") && (v.result !== null) === (v.status === "succeeded") &&
  (v.errorCode !== null) === (v.status === "failed") && (v.appliedDraftRevision === null || v.status === "succeeded"));
const envelopeSchema = z.object({
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/), frameIds: z.array(id).min(1).max(24), run: runSchema.nullable(),
}).strict();
export type StoredAnalysis = z.infer<typeof envelopeSchema>;
export type AnalysisRunView = NonNullable<StoredAnalysis["run"]>;
export type AnalysisPreview = { base: DraftSnapshot; analysis: StoredAnalysis };

function invalid(): never { throw new ProcessorClientError("AI 결과와 현재 작업의 연결을 확인하지 못했어요.", undefined, "INVALID_RESPONSE"); }
function conflict(): never { throw new ProcessorClientError("편집 내용이 바뀌었어요. 결과를 다시 열어 주세요.", 409, "ANALYSIS_STATE_CHANGED"); }

export function parseStoredAnalysis(raw: unknown, base: DraftSnapshot): StoredAnalysis {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) invalid();
  const value = parsed.data;
  const frames = new Set(value.frameIds);
  if (value.inputFingerprint !== base.inputFingerprint || frames.size !== value.frameIds.length ||
      base.document.steps.some(step => !step.sourceStepIds.includes(step.activeFrameStepId) || step.sourceStepIds.some(source => !frames.has(source)))) invalid();
  if (value.run?.result) {
    const steps = value.run.result.steps;
    const ids = new Set(steps.map(step => step.stepId));
    if (ids.size !== frames.size || steps.length !== frames.size || value.frameIds.some(frame => !ids.has(frame)) ||
        steps.find(step => step.stepId === value.frameIds.at(-1))?.mergeWithNext) invalid();
  }
  return value;
}

export function parseAnalysisRun(raw: unknown, base: DraftSnapshot, frameIds: string[], runId: string): AnalysisRunView {
  const envelope = z.object({ run: runSchema }).strict().safeParse(raw);
  if (!envelope.success || envelope.data.run.runId !== runId) invalid();
  return parseStoredAnalysis({ inputFingerprint: base.inputFingerprint, frameIds, run: envelope.data.run }, base).run!;
}

/** Explicit read only: no start, retry, polling, image upload or provider call. */
export async function getStoredAnalysis(identity: DraftIdentity, base: DraftSnapshot, signal?: AbortSignal): Promise<AnalysisPreview> {
  if (base.guideId !== identity.guideId) invalid();
  const frozen = structuredClone(base);
  const analysis = await boundedRequest(`${identity.baseUrl.replace(/\/+$/, "")}/api/guides/${encodeURIComponent(identity.guideId)}/analysis`, {
    method: "GET", signal, headers: { Authorization: `Bearer ${identity.editToken}`, "X-ShowMe-Input-Fingerprint": base.inputFingerprint },
  }, async response => {
    if (!response.ok) throw new ProcessorClientError("AI 결과 조회 실패", response.status);
    const raw: unknown = await response.json().catch(() => null);
    return parseStoredAnalysis(raw, frozen);
  });
  return { base: frozen, analysis };
}

/** Explicit selection only; autosave's existing revision CAS protects other tabs. */
export function applyAnalysisPreview(preview: AnalysisPreview, current: DraftSnapshot, document: EditorDocument, selectedIds: readonly string[]): EditorDocument {
  if (current.guideId !== preview.base.guideId || current.revision !== preview.base.revision ||
      current.inputFingerprint !== preview.base.inputFingerprint || !current.persisted ||
      JSON.stringify(document) !== JSON.stringify(preview.base.document) ||
      JSON.stringify(current.document) !== JSON.stringify(preview.base.document)) conflict();
  const analysis = parseStoredAnalysis(preview.analysis, current);
  if (analysis.run?.status !== "succeeded" || !analysis.run.result) invalid();
  const selected = new Set(selectedIds);
  if (!selected.size || selected.size !== selectedIds.length ||
      selectedIds.some(id => !document.steps.some(step => step.id === id && step.sourceStepIds.length === 1))) invalid();
  const result = analysis.run.result;
  return editorDocumentSchema.parse({ ...document, steps: document.steps.map(step => {
    if (!selected.has(step.id)) return structuredClone(step);
    const value = result.steps.find(candidate => candidate.stepId === step.activeFrameStepId);
    if (!value) return invalid();
    // Keep existing privacy elements. Candidates are NOT permanent redactions,
    // and neither approval nor merging/deletion can be inferred from AI output.
    const elements: EditorDocument["steps"][number]["elements"] = step.elements.filter(element => element.type !== "tap");
    if (value.target) {
      const prefix = `${step.id.slice(0, 100)}:ai-tap`;
      let tapId = prefix;
      for (let suffix = 1; elements.some(element => element.id === tapId); suffix++) tapId = `${prefix}-${suffix}`;
      elements.push({ id: tapId, type: "tap", center: { ...value.target }, radius: 5, zIndex: 10, visible: true });
    }
    return { ...step, shortLabel: value.shortLabel, instruction: value.instruction,
      elements, privacyReview: "pending" as const };
  }) });
}

export function analysisReviewFailure(error: unknown): string {
  if (error instanceof ProcessorClientError) {
    if (error.status === 409) return "편집 또는 영상 상태가 바뀌었어요. 현재 입력은 유지했어요. 자동 저장을 확인하고 결과를 다시 열어 주세요.";
    if ([401, 403, 404].includes(error.status ?? 0)) return "저장된 AI 결과에 접근할 수 없어요. 현재 편집 내용은 유지했어요.";
  }
  return "AI 결과를 확인하지 못했어요. 현재 편집은 유지했으며 새 AI 분석을 실행하지 않았어요.";
}
