import type { EditorStep, DraftIdentity, DraftSnapshot } from "./draft-client.js";
import { boundedRequest, ProcessorClientError } from "./processor-client.js";

export type EditorMask = Extract<EditorStep["elements"][number], { type: "privacy-mask" }>;
export const masksFor = (step: EditorStep) => step.elements.filter((e): e is EditorMask => e.type === "privacy-mask");
export function editMask(step: EditorStep, id: string, change: Partial<EditorMask["bounds"]> | "remove" | "toggle"): EditorStep {
  const mask = masksFor(step).find(mask => mask.id === id);
  if (!mask) return step;
  if (change === "remove") return { ...step, privacyReview: "pending", elements: step.elements.filter(e => e.id !== id) };
  const updated = change === "toggle" ? { ...mask, enabled: !mask.enabled, visible: !mask.enabled } : (() => {
    if (!Object.values(change).every(value => Number.isFinite(value))) return mask;
    const bounds = { ...mask.bounds, ...change };
    bounds.width = Math.max(1, Math.min(100, bounds.width)); bounds.height = Math.max(1, Math.min(100, bounds.height));
    bounds.x = Math.max(0, Math.min(100 - bounds.width, bounds.x)); bounds.y = Math.max(0, Math.min(100 - bounds.height, bounds.y));
    return { ...mask, bounds };
  })();
  return { ...step, privacyReview: "pending", elements: step.elements.map(e => e.id === id ? updated : e) };
}
export function addMask(step: EditorStep, id: string): EditorStep {
  if (!id || id.length > 128 || step.elements.some(e => e.id === id) || masksFor(step).length >= 20 || step.elements.length >= 21) return step;
  return { ...step, privacyReview: "pending", elements: [...step.elements, { id, type: "privacy-mask", enabled: true, visible: true,
    zIndex: 20, bounds: { x: 35, y: 40, width: 30, height: 15 } }] };
}

export async function getPrivacyPreview(identity: DraftIdentity, base: DraftSnapshot, stepId: string,
  variant: "frame" | "thumbnail", signal?: AbortSignal): Promise<Blob> {
  if (!base.persisted || base.guideId !== identity.guideId || !base.document.steps.some(s => s.id === stepId)) throw new Error("SAVED_DRAFT_REQUIRED");
  return boundedRequest(`${identity.baseUrl.replace(/\/+$/, "")}/api/guides/${encodeURIComponent(identity.guideId)}/privacy-preview/${encodeURIComponent(stepId)}/${variant}`, {
    method: "GET", signal, headers: { Authorization: `Bearer ${identity.editToken}`,
      "X-ShowMe-Draft-Revision": String(base.revision), "X-ShowMe-Input-Fingerprint": base.inputFingerprint },
  }, async response => {
    if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "image/png" ||
        response.headers.get("x-showme-draft-revision") !== String(base.revision) ||
        response.headers.get("x-showme-privacy-render") !== "opaque-tiles-v1") throw new ProcessorClientError("가림 미리보기를 확인하지 못했어요.", response.status);
    const blob = await response.blob();
    if (blob.size < 8 || blob.size > 16 * 1024 * 1024 ||
        new Uint8Array(await blob.slice(0, 8).arrayBuffer()).some((byte, i) => byte !== [137, 80, 78, 71, 13, 10, 26, 10][i]))
      throw new ProcessorClientError("가림 이미지 형식이 올바르지 않아요.");
    return blob;
  }, 30_000);
}
