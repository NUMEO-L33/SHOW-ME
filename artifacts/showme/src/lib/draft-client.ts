import { z } from "zod";
import { boundedRequest, ProcessorClientError, type ProcessorGuide } from "./processor-client.js";
import type { GuideIntent } from "./guide-intent.js";
import type { GuideStep } from "./showme-data.js";

const text = (max: number) => z.string().trim().min(1).max(max).refine(v => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v));
const id = z.string().min(1).max(128);
const percent = z.number().finite().min(0).max(100);
const point = z.object({ x: percent, y: percent }).strict();
const rect = z.object({ x: percent, y: percent, width: percent.positive(), height: percent.positive() }).strict()
  .refine(v => v.x + v.width <= 100 && v.y + v.height <= 100);
const element = { id, zIndex: z.number().int().min(0).max(100), visible: z.boolean() };
const stepSchema = z.object({
  id, activeFrameStepId: id, sourceStepIds: z.array(id).min(1).max(24), shortLabel: text(60), instruction: text(500),
  elements: z.array(z.discriminatedUnion("type", [
    z.object({ ...element, type: z.literal("tap"), center: point, radius: percent }).strict(),
    z.object({ ...element, type: z.literal("privacy-mask"), bounds: rect, enabled: z.boolean() }).strict(),
  ])).max(21), privacyReview: z.literal("pending"),
}).strict();
export const editorDocumentSchema = z.object({
  schemaVersion: z.literal(1), title: text(120),
  intent: z.object({ goal: text(120), audience: z.string().trim().max(120), notes: z.string().trim().max(1000) }).strict().optional(),
  steps: z.array(stepSchema).min(1).max(24),
}).strict();
export type EditorDocument = z.infer<typeof editorDocumentSchema>;
export type EditorStep = z.infer<typeof stepSchema>;
const snapshotSchema = z.object({
  guideId: id, revision: z.number().int().min(0).max(2_147_483_647), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  document: editorDocumentSchema, persisted: z.boolean(), updatedAt: z.string().datetime().nullable(),
}).strict();
export type DraftSnapshot = z.infer<typeof snapshotSchema>;
export type DraftIdentity = { baseUrl: string; guideId: string; editToken: string };

export function draftFailure(error: unknown): string {
  if (error instanceof ProcessorClientError) {
    if (error.status === 409) return "다른 창의 저장 또는 영상 상태 변경과 충돌했어요. 입력은 유지했습니다. 최신 저장본을 확인해 주세요.";
    if (error.status === 404 || error.status === 401 || error.status === 403) return "작업 접근 권한을 확인할 수 없어요. 입력을 유지했습니다. 로그인과 연결을 확인해 주세요.";
    if (error.status === 400 || error.status === 413) return "제목 120자·설명 500자 이내인지, 빈 내용이나 < > 같은 문자가 없는지 확인해 주세요.";
  }
  return "서버 저장을 확인하지 못했어요. 입력은 유지했습니다. 연결을 확인하고 저장을 다시 눌러 주세요.";
}

async function draftRequest(identity: DraftIdentity, body?: { expectedRevision: number; inputFingerprint: string; document: EditorDocument }, signal?: AbortSignal): Promise<DraftSnapshot> {
  return boundedRequest(`${identity.baseUrl.replace(/\/+$/, "")}/api/guides/${encodeURIComponent(identity.guideId)}/draft`, {
    method: body ? "PUT" : "GET", signal, cache: "no-store",
    headers: { Authorization: `Bearer ${identity.editToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, async response => {
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ProcessorClientError("편집 서버 요청 실패", response.status, payload?.code);
    const parsed = snapshotSchema.safeParse(payload?.draft);
    if (!parsed.success || parsed.data.guideId !== identity.guideId ||
        (body && (!parsed.data.persisted || parsed.data.inputFingerprint !== body.inputFingerprint ||
          parsed.data.revision !== body.expectedRevision + 1 || JSON.stringify(parsed.data.document) !== JSON.stringify(editorDocumentSchema.parse(body.document)))))
      throw new ProcessorClientError("저장 응답을 확인할 수 없어요.", undefined, "INVALID_RESPONSE");
    return parsed.data;
  });
}
export const getDraft = (identity: DraftIdentity, signal?: AbortSignal) => draftRequest(identity, undefined, signal);
export const putDraft = (identity: DraftIdentity, base: DraftSnapshot, document: EditorDocument, signal?: AbortSignal) =>
  draftRequest(identity, { expectedRevision: base.revision, inputFingerprint: base.inputFingerprint, document: editorDocumentSchema.parse(document) }, signal);

export function draftSteps(document: EditorDocument, media: ProcessorGuide): GuideStep[] {
  const frames = new Map(media.steps.map(step => [String(step.id), step]));
  const used = new Set<string>();
  const ids = new Set<string>();
  return document.steps.map(step => {
    const frame = frames.get(step.activeFrameStepId);
    if (!frame || ids.has(step.id) || !step.sourceStepIds.includes(step.activeFrameStepId) ||
        new Set(step.elements.map(e => e.id)).size !== step.elements.length) throw new ProcessorClientError("단계 연결을 확인할 수 없어요.", undefined, "INVALID_RESPONSE");
    ids.add(step.id);
    for (const source of step.sourceStepIds) {
      if (!frames.has(source) || used.has(source)) throw new ProcessorClientError("단계 연결을 확인할 수 없어요.", undefined, "INVALID_RESPONSE");
      used.add(source);
    }
    const tap = step.elements.find(e => e.type === "tap");
    return { ...frame, id: step.id, shortLabel: step.shortLabel, instruction: step.instruction,
      target: tap?.center ?? { x: 50, y: 50 }, targetVisible: tap?.visible ?? false, draft: structuredClone(step),
      privacyCount: 0, privacyEnabled: false };
  });
}

export function draftDocument(title: string, steps: GuideStep[], intent: GuideIntent): EditorDocument {
  return editorDocumentSchema.parse({ schemaVersion: 1, title,
    ...(intent.goal.trim() ? { intent } : {}),
    steps: steps.map(step => {
      if (!step.draft) throw new Error("SERVER_DRAFT_REQUIRED");
      const previousTap = step.draft.elements.find(e => e.type === "tap");
      const elements = step.draft.elements.map(element => element === previousTap
        ? { ...element, center: step.target, visible: Boolean(step.targetVisible) } : element);
      if (!previousTap && step.targetVisible) {
        const prefix = `${step.draft.id.slice(0, 100)}:tap`;
        let tapId = prefix;
        for (let suffix = 1; elements.some(element => element.id === tapId); suffix++) tapId = `${prefix}-${suffix}`;
        elements.push({ id: tapId, type: "tap", center: step.target, radius: 5, zIndex: 10, visible: true });
      }
      return { ...step.draft, shortLabel: step.shortLabel, instruction: step.instruction,
        elements,
      };
    }),
  });
}
