import { createHash } from "node:crypto";
import { analysisManifest, parseDraftDocument, type DraftDocument } from "./analysis-contract.js";
import type { AnalysisState } from "./analysis-state.js";
import type { GuideWithSteps } from "./domain.js";
import { type PrivacyLedger, type PrivacyCommand } from "./privacy-review-schema.js";
import { PRIVACY_RENDER_VERSION } from "./privacy-render.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const masks = (s: DraftDocument["steps"][number]) => s.elements.filter(e => e.type === "privacy-mask");
const maskIdentity = (s: DraftDocument["steps"][number]) => masks(s).map(m =>
  [m.id, m.bounds.x, m.bounds.y, m.bounds.width, m.bounds.height, m.enabled, m.visible, m.zIndex]);
const source = (s: DraftDocument["steps"][number]) => [s.id, s.activeFrameStepId, s.sourceStepIds];

/** Ordinary editing can only preserve or invalidate server-owned acknowledgements. */
export function privacyAfterEdit(previous: DraftDocument, next: DraftDocument): PrivacyLedger | undefined {
  if (!previous.privacy) return undefined;
  const privacy = structuredClone(previous.privacy);
  if (previous.title !== next.title) privacy.titleFingerprint = null;
  privacy.steps = privacy.steps.filter(record => {
    const before = previous.steps.find(s => s.id === record.stepId), after = next.steps.find(s => s.id === record.stepId);
    if (!before || !after || !equal(source(before), source(after))) return false;
    if (!equal(maskIdentity(before), maskIdentity(after))) {
      record.imageFingerprint = null;
      record.candidates = record.candidates.map(c => c.status === "masked" ? { ...c, status: "pending", maskId: null } : c);
    }
    if (before.shortLabel !== after.shortLabel || before.instruction !== after.instruction) record.textFingerprint = null;
    return true;
  });
  return privacy;
}

export function validatePrivacyEdit(previous: DraftDocument | undefined, next: DraftDocument): boolean {
  if (!previous?.privacy) return next.schemaVersion === 1 && next.privacy === undefined;
  return next.schemaVersion === 2 && equal(next.privacy, privacyAfterEdit(previous, next));
}

export function privacyReviewState(guide: GuideWithSteps, state: AnalysisState) {
  const manifest = analysisManifest(guide), draft = state.draft;
  if (!draft || draft.revision < 1 || draft.inputFingerprint !== manifest.fingerprint) return null;
  const document = parseDraftDocument(draft.document, manifest.frames);
  // Last appended successful run for this media version. A newer run, even with
  // identical regions, requires a new review. Never copy decisions across runs.
  const run = [...state.runs].reverse().find(r => r.status === "succeeded" && r.result && r.manifest.fingerprint === manifest.fingerprint);
  const titleFingerprint = hash(["title-v1", guide.id, document.title]);
  const titleConfirmed = document.privacy?.titleFingerprint === titleFingerprint;
  const steps = document.steps.map(step => {
    const proposed = run?.result?.steps.find(s => s.stepId === step.activeFrameStepId)?.privacy ?? [];
    const candidates = proposed.map((c, i) => ({ ...c, id: hash([run!.id, step.activeFrameStepId, i, c]) }));
    const sourceFingerprint = hash(["source-v1", guide.id, manifest.fingerprint, source(step), run?.id ?? null, candidates]);
    const stored = document.privacy?.steps.find(s => s.stepId === step.id && s.sourceFingerprint === sourceFingerprint);
    const decisions = candidates.map(c => {
      const decision = stored?.candidates.find(d => d.id === c.id);
      const coveringMaskIds = masks(step).filter(m => m.enabled && m.bounds.x <= c.bounds.x && m.bounds.y <= c.bounds.y &&
        m.bounds.x + m.bounds.width >= c.bounds.x + c.bounds.width && m.bounds.y + m.bounds.height >= c.bounds.y + c.bounds.height).map(m => m.id);
      const status = decision?.status === "dismissed" ? "dismissed" as const
        : decision?.status === "masked" && coveringMaskIds.includes(decision.maskId!) ? "masked" as const : "pending" as const;
      return { ...c, status, maskId: status === "masked" ? decision!.maskId : null, coveringMaskIds };
    });
    const imageFingerprint = hash(["image-v1", PRIVACY_RENDER_VERSION, sourceFingerprint, masks(step), decisions.map(c => [c.id, c.status, c.maskId])]);
    const textFingerprint = hash(["text-v1", guide.id, manifest.fingerprint, source(step), step.shortLabel, step.instruction]);
    return { stepId: step.id, frameStepId: step.activeFrameStepId, sourceFingerprint, imageFingerprint, textFingerprint,
      imageConfirmed: stored?.imageFingerprint === imageFingerprint && decisions.every(c => c.status !== "pending"),
      textConfirmed: stored?.textFingerprint === textFingerprint, candidates: decisions };
  });
  const result = { guideId: guide.id, revision: draft.revision, inputFingerprint: manifest.fingerprint,
    titleFingerprint, titleConfirmed, steps,
    complete: titleConfirmed && steps.every(s => s.imageConfirmed && s.textConfirmed), publicationEnabled: false as const };
  return { ...result, fingerprint: hash(result) };
}

/** Called only while the repository holds its normal parent-guide write lock. */
export function applyPrivacyCommand(guide: GuideWithSteps, state: AnalysisState, command: PrivacyCommand, now: Date): AnalysisState | null {
  const view = privacyReviewState(guide, state), draft = state.draft;
  if (!view || !draft || view.inputFingerprint !== command.expectedInputFingerprint) return null;
  const requestFingerprint = hash(command);
  if (draft.revision === command.expectedRevision + 1 && draft.document.privacy?.lastMutation?.id === command.mutationId &&
      draft.document.privacy.lastMutation.fingerprint === requestFingerprint) return state;
  if (draft.revision !== command.expectedRevision || view.fingerprint !== command.expectedReviewFingerprint) return null;
  const ledger: PrivacyLedger = {
    policyVersion: "privacy-review-v1", titleFingerprint: view.titleConfirmed ? view.titleFingerprint : null,
    steps: view.steps.map(s => ({ stepId: s.stepId, sourceFingerprint: s.sourceFingerprint,
      imageFingerprint: s.imageConfirmed ? s.imageFingerprint : null, textFingerprint: s.textConfirmed ? s.textFingerprint : null,
      candidates: s.candidates.map(c => ({ id: c.id, status: c.status, maskId: c.maskId })) })),
    lastMutation: { id: command.mutationId, fingerprint: requestFingerprint, baseRevision: command.expectedRevision },
  };
  const action = command.action;
  if (action.type === "title") ledger.titleFingerprint = action.confirmed ? view.titleFingerprint : null;
  else {
    const step = view.steps.find(s => s.stepId === action.stepId), record = ledger.steps.find(s => s.stepId === action.stepId);
    if (!step || !record) return null;
    if (action.type === "text") record.textFingerprint = action.confirmed ? step.textFingerprint : null;
    else if (action.type === "image") {
      if (action.confirmed && step.candidates.some(c => c.status === "pending")) return null;
      record.imageFingerprint = action.confirmed ? step.imageFingerprint : null;
    } else {
      const candidate = step.candidates.find(c => c.id === action.candidateId), decision = record.candidates.find(c => c.id === action.candidateId);
      if (!candidate || !decision || (action.status === "masked" ? !action.maskId || !candidate.coveringMaskIds.includes(action.maskId) : action.maskId !== null)) return null;
      decision.status = action.status; decision.maskId = action.maskId; record.imageFingerprint = null;
    }
  }
  draft.document = { ...draft.document, schemaVersion: 2, privacy: ledger };
  draft.revision++; draft.updatedAt = now.toISOString();
  return state;
}
