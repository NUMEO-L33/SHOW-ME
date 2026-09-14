import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";

import { ANALYSIS_CONSENT_VERSION, AnalysisContractError, analysisManifest, parseAnalysisOutput } from "./analysis-contract.js";
import { parseAnalysisState, type AnalysisCommand, type AnalysisRun, type AnalysisState } from "./analysis-state.js";
import type { GuideRepository, GuideWithSteps } from "./domain.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL } from "./gemini/request.js";

export const ANALYSIS_API_MODEL = GEMINI_TEST_MODEL;
export const ANALYSIS_ADMISSION_TIMEOUT_MS = 5_000;
const errors = {
  GUIDE_NOT_FOUND: [404, "가이드를 찾을 수 없어요."],
  ANALYSIS_NOT_FOUND: [404, "분석 작업을 찾을 수 없어요."],
  ANALYSIS_INVALID_REQUEST: [400, "분석 요청 형식을 확인해 주세요."],
  ANALYSIS_CONSENT_REQUIRED: [400, "현재 안내에 따라 화면의 외부 AI 전송에 동의해 주세요."],
  ANALYSIS_JSON_REQUIRED: [415, "요청을 JSON 형식으로 보내 주세요."],
  ANALYSIS_BODY_TOO_LARGE: [413, "분석 요청이 너무 커요. 영상이나 이미지를 요청 본문에 넣지 마세요."],
  ANALYSIS_MEDIA_NOT_READY: [409, "화면 추출이 완료된 영상만 분석할 수 있어요."],
  ANALYSIS_STATE_CHANGED: [409, "분석 또는 편집 상태가 바뀌었어요. 최신 상태를 확인해 주세요."],
  ANALYSIS_UNAVAILABLE: [503, "AI 분석 실행 준비가 아직 완료되지 않았어요."],
  ANALYSIS_ADMISSION_TIMEOUT: [503, "요청 접수 확인이 지연됐어요. 같은 실행 ID로 상태를 확인해 주세요."],
  ANALYSIS_INTERNAL_ERROR: [500, "분석 요청을 처리하지 못했어요."],
} as const;

export class AnalysisApiError extends Error {
  constructor(readonly code: keyof typeof errors) { super(code); }
}

export type AnalysisRequestCommand = Extract<AnalysisCommand, { type: "request" }>;
/**
 * Trusted composition boundary, NOT a public enable flag.
 * A future implementation must atomically reserve the operating budget and
 * persist the run, admit only when its durable worker is ready, and honor the
 * snapshot/consent/idempotency contract. The HTTP layer never calls Google.
 * Startup deliberately supplies no admission until that implementation exists.
 */
export interface AnalysisAdmission {
  request(guideId: string, command: AnalysisRequestCommand, signal: AbortSignal): Promise<AnalysisState | null>;
}

const runIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const requestSchema = z.object({
  runId: runIdSchema,
  baseDraftRevision: z.number().int().min(0).max(2_147_483_646),
  consentVersion: z.string().max(128), externalProcessing: z.boolean(),
}).strict();

function manifestFor(guide: GuideWithSteps) {
  try { return analysisManifest(guide); }
  catch { throw new AnalysisApiError("ANALYSIS_MEDIA_NOT_READY"); }
}

function serializeRun(run: AnalysisRun) {
  // Explicit owner-only DTO: no manifest, object keys, attempt IDs or raw body.
  const result = run.result === null ? null : parseAnalysisOutput(run.result, run.manifest.frames.map((frame) => frame.stepId));
  return {
    runId: run.id, status: run.status, model: run.model,
    baseDraftRevision: run.baseDraftRevision, appliedDraftRevision: run.appliedDraftRevision,
    cancellable: run.status === "queued" || run.status === "running",
    reviewRequired: run.status === "succeeded", result, errorCode: run.errorCode,
    inputTokens: run.inputTokens, outputTokens: run.outputTokens,
    createdAt: run.createdAt, updatedAt: run.updatedAt,
  };
}

function matchingRequest(run: AnalysisRun, command: AnalysisRequestCommand) {
  return run.id === command.runId && run.manifest.fingerprint === command.expectedInputFingerprint &&
    run.baseDraftRevision === command.baseDraftRevision && run.consentVersion === command.consentVersion &&
    run.provider === command.provider && run.model === command.model && run.promptVersion === command.promptVersion;
}

function requireJson(request: Request, _response: Response, next: NextFunction) {
  if (!request.is("application/json")) return next(new AnalysisApiError("ANALYSIS_JSON_REQUIRED"));
  next();
}

async function admit(admission: AnalysisAdmission, guideId: string, command: AnalysisRequestCommand) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AnalysisApiError("ANALYSIS_ADMISSION_TIMEOUT"));
      // Settle the deadline first: a synchronous abort listener must not turn
      // an expected timeout into an unrelated internal-error response.
      controller.abort();
    }, ANALYSIS_ADMISSION_TIMEOUT_MS);
  });
  try { return await Promise.race([admission.request(guideId, command, controller.signal), deadline]); }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}

export function createAnalysisRouter(options: {
  repository: GuideRepository;
  authenticate: (request: Request) => Promise<GuideWithSteps>;
  admission?: AnalysisAdmission;
}) {
  const { repository, authenticate, admission } = options;
  const router = express.Router({ mergeParams: true });
  const json = express.json({ limit: 4096, strict: true, inflate: false });
  const limiter = (limit: number, windowMs: number) => rateLimit({
    limit, windowMs, standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "요청이 많아요. 잠시 뒤 다시 시도해 주세요.", code: "ANALYSIS_RATE_LIMIT" },
  });
  const guides = new WeakMap<Request, GuideWithSteps>();
  router.use((_request, response, next) => { response.setHeader("Cache-Control", "no-store"); next(); });
  const auth = async (request: Request, _response: Response, next: NextFunction) => {
    try { guides.set(request, await authenticate(request)); next(); }
    catch (error) { next(error); }
  };
  async function currentRun(request: Request, runId: string, state: AnalysisState | null) {
    if (!state) throw new AnalysisApiError("ANALYSIS_NOT_FOUND");
    const run = parseAnalysisState(state).runs.find((candidate) => candidate.id === runId);
    if (!run) throw new AnalysisApiError("ANALYSIS_NOT_FOUND");
    // Reauthenticate/re-read after asynchronous storage/admission. A deleted or
    // replaced guide must not return its old analysis as the current result.
    const current = await authenticate(request);
    if (manifestFor(current).fingerprint !== run.manifest.fingerprint) throw new AnalysisApiError("ANALYSIS_STATE_CHANGED");
    return run;
  }

  router.post("/", limiter(10, 15 * 60_000), auth, requireJson, json, async (request, response, next) => {
    try {
      const body = requestSchema.safeParse(request.body);
      if (!body.success) throw new AnalysisApiError("ANALYSIS_INVALID_REQUEST");
      if (!body.data.externalProcessing || body.data.consentVersion !== ANALYSIS_CONSENT_VERSION) {
        throw new AnalysisApiError("ANALYSIS_CONSENT_REQUIRED");
      }
      const guide = guides.get(request)!;
      const command: AnalysisRequestCommand = {
        type: "request", runId: body.data.runId, baseDraftRevision: body.data.baseDraftRevision,
        consentVersion: ANALYSIS_CONSENT_VERSION, provider: "gemini", model: ANALYSIS_API_MODEL,
        promptVersion: GEMINI_PROMPT_VERSION, expectedInputFingerprint: manifestFor(guide).fingerprint,
      };
      const stored = await repository.getAnalysisState(guide.id);
      if (!stored) throw new AnalysisApiError("GUIDE_NOT_FOUND");
      const previous = parseAnalysisState(stored);
      const existing = previous.runs.find((run) => run.id === command.runId);
      let run: AnalysisRun;
      if (existing) {
        if (!matchingRequest(existing, command)) throw new AnalysisApiError("ANALYSIS_STATE_CHANGED");
        // Replay never re-admits, reserves budget, or starts a second worker.
        run = await currentRun(request, command.runId, previous);
      } else {
        if ((previous.draft?.revision ?? 0) !== command.baseDraftRevision ||
            previous.runs.some((candidate) => candidate.status === "queued" || candidate.status === "running")) {
          throw new AnalysisApiError("ANALYSIS_STATE_CHANGED");
        }
        if (!admission) throw new AnalysisApiError("ANALYSIS_UNAVAILABLE");
        const accepted = await admit(admission, guide.id, command);
        if (!accepted) throw new AnalysisApiError("ANALYSIS_STATE_CHANGED");
        run = await currentRun(request, command.runId, accepted);
        if (!matchingRequest(run, command)) throw new AnalysisContractError();
      }
      const active = run.status === "queued" || run.status === "running";
      response.setHeader("Location", `/api/guides/${guide.id}/analysis/${run.id}`);
      response.status(active ? 202 : 200).json({ run: serializeRun(run) });
    } catch (error) { next(error); }
  });

  router.get("/:runId", limiter(60, 60_000), auth, async (request, response, next) => {
    try {
      const id = runIdSchema.safeParse(request.params.runId);
      if (!id.success) throw new AnalysisApiError("ANALYSIS_NOT_FOUND");
      const run = await currentRun(request, id.data, await repository.getAnalysisState(guides.get(request)!.id));
      response.json({ run: serializeRun(run) });
    } catch (error) { next(error); }
  });

  router.post("/:runId/cancel", limiter(30, 60_000), auth, (request, response, next) => {
    if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) > 0) requireJson(request, response, next);
    else next();
  }, json, async (request, response, next) => {
    try {
      if (!z.object({}).strict().safeParse(request.body ?? {}).success) throw new AnalysisApiError("ANALYSIS_INVALID_REQUEST");
      const id = runIdSchema.safeParse(request.params.runId);
      if (!id.success) throw new AnalysisApiError("ANALYSIS_NOT_FOUND");
      const guideId = guides.get(request)!.id;
      const existing = await currentRun(request, id.data, await repository.getAnalysisState(guideId));
      if (existing.status !== "cancelled" && existing.status !== "queued" && existing.status !== "running") {
        throw new AnalysisApiError("ANALYSIS_STATE_CHANGED");
      }
      const cancelled = await repository.executeAnalysisCommand(guideId, { type: "cancel", runId: id.data });
      if (!cancelled) throw new AnalysisApiError("ANALYSIS_STATE_CHANGED");
      const run = await currentRun(request, id.data, cancelled);
      response.json({ run: serializeRun(run) });
    } catch (error) { next(error); }
  });

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    void _next;
    const type = typeof error === "object" && error !== null && "type" in error ? error.type : undefined;
    const code = error instanceof AnalysisApiError ? error.code
      : type === "entity.too.large" ? "ANALYSIS_BODY_TOO_LARGE"
      : type === "entity.parse.failed" ? "ANALYSIS_INVALID_REQUEST"
      : type === "encoding.unsupported" || type === "charset.unsupported" ? "ANALYSIS_JSON_REQUIRED"
      : "ANALYSIS_INTERNAL_ERROR";
    const [status, message] = errors[code];
    // Never forward/log parser bodies, DB messages, credentials or provider errors.
    if (status >= 500) console.error(JSON.stringify({ event: "analysis_http_error", code }));
    response.status(status).json({ error: message, code });
  });
  return router;
}
