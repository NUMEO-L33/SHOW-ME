import { z } from "zod";

import type { GuideWithSteps } from "./domain.js";
import {
  ANALYSIS_CONSENT_VERSION, ANALYSIS_LIMITS, AnalysisContractError,
  analysisManifest, analysisOutputSchema, draftDocumentSchema, draftFromAnalysis, initialDraft, parseAnalysisOutput, parseDraftDocument,
  type AnalysisManifest, type AnalysisOutput, type DraftDocument,
} from "./analysis-contract.js";

export type AnalysisDraft = {
  revision: number;
  inputFingerprint: string;
  document: DraftDocument;
  createdAt: string;
  updatedAt: string;
};
export type AnalysisRun = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  manifest: AnalysisManifest;
  baseDraftRevision: number;
  consentVersion: string;
  provider: string;
  model: string;
  promptVersion: string;
  attemptId: string | null;
  attemptCount: number;
  leaseExpiresAt: string | null;
  result: AnalysisOutput | null;
  errorCode: AnalysisErrorCode | null;
  inputTokens: number;
  outputTokens: number;
  appliedDraftRevision: number | null;
  createdAt: string;
  updatedAt: string;
};
export type AnalysisState = { draft: AnalysisDraft | null; runs: AnalysisRun[] };
export type AnalysisErrorCode = "AI_REFUSED" | "AI_INCOMPLETE" | "AI_INVALID_OUTPUT" | "AI_TIMEOUT" | "AI_PROVIDER_FAILED";

type AttemptIdentity = { runId: string; attemptId: string; attemptCount: number };
export type AnalysisCommand =
  | { type: "initialize" }
  | { type: "start"; runId: string; baseDraftRevision: number; consentVersion: string; provider: string; model: string; promptVersion: string }
  | { type: "claim"; runId: string; attemptId: string; expectedAttemptCount: number; leaseMs: number }
  | ({ type: "finish"; output: unknown; inputTokens: number; outputTokens: number } & AttemptIdentity)
  | ({ type: "fail"; errorCode: AnalysisErrorCode } & AttemptIdentity)
  | { type: "cancel"; runId: string }
  | { type: "save-draft"; expectedRevision: number; document: unknown };

const opaque = z.string().min(1).max(128);
const revision = z.number().int().min(0).max(2_147_483_646);
const counter = z.number().int().nonnegative().safe();
const errorCode = z.enum(["AI_REFUSED", "AI_INCOMPLETE", "AI_INVALID_OUTPUT", "AI_TIMEOUT", "AI_PROVIDER_FAILED"]);
const attemptFields = { runId: opaque, attemptId: opaque, attemptCount: counter };
const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("initialize") }).strict(),
  z.object({
    type: z.literal("start"), runId: opaque, baseDraftRevision: revision,
    consentVersion: z.literal(ANALYSIS_CONSENT_VERSION), provider: opaque, model: opaque, promptVersion: opaque,
  }).strict(),
  z.object({
    type: z.literal("claim"), runId: opaque, attemptId: opaque, expectedAttemptCount: counter,
    leaseMs: z.number().int().min(1).max(ANALYSIS_LIMITS.timeoutMs),
  }).strict(),
  z.object({ type: z.literal("finish"), ...attemptFields, output: z.unknown(), inputTokens: counter, outputTokens: counter }).strict(),
  z.object({ type: z.literal("fail"), ...attemptFields, errorCode }).strict(),
  z.object({ type: z.literal("cancel"), runId: opaque }).strict(),
  z.object({ type: z.literal("save-draft"), expectedRevision: revision, document: z.unknown() }).strict(),
]);

export function parseAnalysisCommand(raw: unknown): AnalysisCommand {
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success || (parsed.data.type === "finish" && parsed.data.output === undefined) ||
      (parsed.data.type === "save-draft" && parsed.data.document === undefined)) throw new AnalysisContractError();
  return parsed.data as AnalysisCommand;
}

export function emptyAnalysisState(): AnalysisState { return { draft: null, runs: [] }; }

const isoDate = z.string().datetime();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.object({
  fingerprint, mediaAttemptId: opaque, mediaAttemptCount: counter.min(1),
  frames: z.array(z.object({
    stepId: opaque, position: counter, timestampMs: counter, width: counter.min(1), height: counter.min(1),
  }).strict()).min(1).max(ANALYSIS_LIMITS.maxFrames),
}).strict();
const persistedStateSchema = z.object({
  draft: z.object({
    revision: counter.max(2_147_483_647), inputFingerprint: fingerprint, document: draftDocumentSchema,
    createdAt: isoDate, updatedAt: isoDate,
  }).strict().nullable(),
  runs: z.array(z.object({
    id: opaque, status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
    manifest: manifestSchema, baseDraftRevision: revision, consentVersion: z.literal(ANALYSIS_CONSENT_VERSION),
    provider: opaque, model: opaque, promptVersion: opaque, attemptId: opaque.nullable(),
    attemptCount: counter.max(ANALYSIS_LIMITS.maxAttempts), leaseExpiresAt: isoDate.nullable(),
    result: analysisOutputSchema.nullable(), errorCode: errorCode.nullable(), inputTokens: counter,
    outputTokens: counter, appliedDraftRevision: counter.nullable(), createdAt: isoDate, updatedAt: isoDate,
  }).strict()).max(ANALYSIS_LIMITS.maxRuns),
}).strict();

export function parseAnalysisState(raw: unknown): AnalysisState {
  const parsed = persistedStateSchema.safeParse(raw);
  if (!parsed.success) throw new AnalysisContractError();
  const state = parsed.data;
  if (new Set(state.runs.map((run) => run.id)).size !== state.runs.length ||
      state.runs.filter((run) => run.status === "queued" || run.status === "running").length > 1) throw new AnalysisContractError();
  for (const run of state.runs) {
    if (run.status === "running" && (!run.attemptId || !run.leaseExpiresAt || run.attemptCount < 1)) throw new AnalysisContractError();
    if ((run.status === "succeeded") !== (run.result !== null)) throw new AnalysisContractError();
    if (run.result) parseAnalysisOutput(run.result, run.manifest.frames.map((frame) => frame.stepId), run.manifest.frames.at(-1)?.stepId);
  }
  return state;
}

/** Pure transition shared by JSON and PostgreSQL. Caller must hold the guide lock. */
export function transitionAnalysis(
  guide: GuideWithSteps,
  previous: AnalysisState,
  command: AnalysisCommand,
  now: Date = new Date(),
): AnalysisState | null {
  command = parseAnalysisCommand(command);
  // Deletion/failed/reprocessing media is never eligible for an analysis write.
  if (guide.status !== "ready" || guide.errorCode !== null) return null;
  const manifest = analysisManifest(guide);
  const state = structuredClone(previous);
  const timestamp = now.toISOString();
  if (command.type === "initialize") {
    if (state.draft) return state.draft.inputFingerprint === manifest.fingerprint ? state : null;
    state.draft = {
      revision: 0, inputFingerprint: manifest.fingerprint, document: initialDraft(manifest),
      createdAt: timestamp, updatedAt: timestamp,
    };
    return state;
  }
  const draft = state.draft;
  if (!draft || draft.inputFingerprint !== manifest.fingerprint) return null;
  if (command.type === "save-draft") {
    revision.parse(command.expectedRevision);
    if (draft.revision !== command.expectedRevision) return null;
    draft.document = parseDraftDocument(command.document, manifest.frames);
    draft.revision = revision.parse(draft.revision) + 1;
    draft.updatedAt = timestamp;
    return state;
  }
  opaque.parse(command.runId);
  const existing = state.runs.find((run) => run.id === command.runId);
  if (command.type === "start") {
    revision.parse(command.baseDraftRevision);
    if (command.consentVersion !== ANALYSIS_CONSENT_VERSION) throw new AnalysisContractError();
    for (const value of [command.provider, command.model, command.promptVersion]) opaque.parse(value);
    if (existing) {
      return existing.baseDraftRevision === command.baseDraftRevision &&
        existing.manifest.fingerprint === manifest.fingerprint && existing.provider === command.provider &&
        existing.model === command.model && existing.promptVersion === command.promptVersion &&
        existing.consentVersion === command.consentVersion ? state : null;
    }
    if (draft.revision !== command.baseDraftRevision || state.runs.length >= ANALYSIS_LIMITS.maxRuns ||
        state.runs.some((run) => run.status === "queued" || run.status === "running")) return null;
    state.runs.push({
      id: command.runId, status: "queued", manifest, baseDraftRevision: command.baseDraftRevision,
      consentVersion: command.consentVersion, provider: command.provider, model: command.model,
      promptVersion: command.promptVersion, attemptId: null, attemptCount: 0, leaseExpiresAt: null,
      result: null, errorCode: null, inputTokens: 0, outputTokens: 0, appliedDraftRevision: null,
      createdAt: timestamp, updatedAt: timestamp,
    });
    return state;
  }
  if (!existing || existing.manifest.fingerprint !== manifest.fingerprint) return null;
  if (command.type === "cancel") {
    if (existing.status === "cancelled") return state;
    if (existing.status !== "queued" && existing.status !== "running") return null;
    existing.status = "cancelled";
    existing.leaseExpiresAt = null;
    existing.updatedAt = timestamp;
    return state;
  }
  opaque.parse(command.attemptId);
  if (command.type === "claim") {
    counter.parse(command.expectedAttemptCount);
    z.number().int().min(1).max(ANALYSIS_LIMITS.timeoutMs).parse(command.leaseMs);
    if (existing.attemptCount !== command.expectedAttemptCount || existing.attemptCount >= ANALYSIS_LIMITS.maxAttempts ||
        (existing.status !== "queued" && !(existing.status === "running" && existing.leaseExpiresAt &&
          Date.parse(existing.leaseExpiresAt) <= now.getTime()))) return null;
    existing.status = "running";
    existing.attemptId = command.attemptId;
    existing.attemptCount += 1;
    existing.leaseExpiresAt = new Date(now.getTime() + command.leaseMs).toISOString();
    existing.updatedAt = timestamp;
    return state;
  }
  counter.parse(command.attemptCount);
  if (existing.status !== "running" || existing.attemptId !== command.attemptId ||
      existing.attemptCount !== command.attemptCount) return null;
  if (command.type === "fail") {
    existing.errorCode = errorCode.parse(command.errorCode);
    existing.status = "failed";
  } else {
    // Even an otherwise valid completion cannot revive an expired worker.
    if (!existing.leaseExpiresAt || Date.parse(existing.leaseExpiresAt) <= now.getTime()) return null;
    const result = parseAnalysisOutput(command.output, manifest.frames.map((frame) => frame.stepId), manifest.frames.at(-1)?.stepId);
    existing.inputTokens = counter.parse(command.inputTokens);
    existing.outputTokens = counter.parse(command.outputTokens);
    existing.result = result;
    existing.status = "succeeded";
    if (draft.revision === 0 && existing.baseDraftRevision === 0) {
      draft.document = parseDraftDocument(draftFromAnalysis(draft.document, result), manifest.frames);
      draft.revision += 1;
      draft.updatedAt = timestamp;
      existing.appliedDraftRevision = draft.revision;
    }
  }
  existing.leaseExpiresAt = null;
  existing.updatedAt = timestamp;
  return state;
}
