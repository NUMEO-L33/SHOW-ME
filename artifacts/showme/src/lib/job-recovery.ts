import { readGuideIntent, validateGuideIntent, type GuideIntent } from "./guide-intent.js";
import { UPLOAD_RECOVERY_GRACE_MS } from "./job-feedback.js";
import { persistRecoverableCredentials, recoverableCredentialKey } from "./processor-client.js";

export type ActiveJob = {
  guideId: string;
  editToken: string;
  baseUrl: string;
  phase: "uploading" | "processing" | "failed" | "deleting";
  startedAt: number;
  deletionMissingGraceUntil?: number;
  intent: GuideIntent;
};
export type PersistedActiveJob = ActiveJob & { fileName: string };

export function parsePersistedActiveJob(value: string | null): PersistedActiveJob | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PersistedActiveJob>;
    if (!parsed || typeof parsed !== "object" ||
      typeof parsed.guideId !== "string" || typeof parsed.editToken !== "string" || typeof parsed.baseUrl !== "string") return null;
    return {
      guideId: parsed.guideId,
      editToken: parsed.editToken,
      baseUrl: parsed.baseUrl,
      phase: parsed.phase === "deleting" ? "deleting" : parsed.phase === "uploading" ? "uploading" : parsed.phase === "failed" ? "failed" : "processing",
      startedAt: typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt) ? parsed.startedAt : Date.now() - UPLOAD_RECOVERY_GRACE_MS,
      deletionMissingGraceUntil: typeof parsed.deletionMissingGraceUntil === "number" ? parsed.deletionMissingGraceUntil : undefined,
      fileName: typeof parsed.fileName === "string" ? parsed.fileName : "화면 녹화 영상",
      intent: readGuideIntent(parsed.intent),
    };
  } catch { return null; }
}

export function saveJobIntent(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  job: ActiveJob,
  fileName: string,
  intent: GuideIntent,
): ActiveJob {
  const error = validateGuideIntent(intent);
  if (error) throw new Error(error);
  const next = { ...job, intent: readGuideIntent(intent) };
  // One atomic record keeps intent attached to the correct guide. A failed
  // read-back rolls back without replacing that guide's recovery credential.
  persistRecoverableCredentials(storage, recoverableCredentialKey(job.guideId), JSON.stringify({ ...next, fileName }));
  return next;
}
