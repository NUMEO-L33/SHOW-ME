import { z } from "zod";
import { boundedRequest, ProcessorClientError } from "./processor-client.js";
import { getStoredAnalysis, parseAnalysisRun, type AnalysisRunView, type StoredAnalysis } from "./analysis-review.js";
import type { DraftIdentity, DraftSnapshot } from "./draft-client.js";

export const ANALYSIS_CONSENT_VERSION = "screen-analysis-v1";
export const ANALYSIS_POLL_MS = 5_000;
export const ANALYSIS_MAX_POLLS = 24;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const ticketSchema = z.object({
  version: z.literal(1), guideId: z.string().min(1).max(128), runId: uuid,
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  baseDraftRevision: z.number().int().min(0).max(2_147_483_646),
  consentVersion: z.literal(ANALYSIS_CONSENT_VERSION),
}).strict();
export type AnalysisTicket = z.infer<typeof ticketSchema>;
const availabilitySchema = z.object({ consentVersion: z.literal(ANALYSIS_CONSENT_VERSION),
  startAvailable: z.boolean(), reason: z.literal("ANALYSIS_UNAVAILABLE").nullable(),
}).strict().refine(v => v.startAvailable === (v.reason === null));
export type AnalysisAvailability = z.infer<typeof availabilitySchema>;
export type AnalysisStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const analysisRecoveryKey = (guideId: string) => `showme:analysis-run:${encodeURIComponent(guideId)}`;

function invalid(): never { throw new ProcessorClientError("분석 응답을 확인하지 못했어요.", undefined, "INVALID_RESPONSE"); }
function storageError(): never { throw new ProcessorClientError("분석 복구 기록을 보관할 수 없어요.", undefined, "ANALYSIS_RECOVERY_UNAVAILABLE"); }
function url(identity: DraftIdentity, suffix = "") {
  return `${identity.baseUrl.replace(/\/+$/, "")}/api/guides/${encodeURIComponent(identity.guideId)}/analysis${suffix}`;
}
function headers(identity: DraftIdentity, base: DraftSnapshot) {
  if (identity.guideId !== base.guideId) invalid();
  return { Authorization: `Bearer ${identity.editToken}`, "X-ShowMe-Input-Fingerprint": base.inputFingerprint };
}
async function json(response: Response): Promise<unknown> {
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = z.object({ code: z.string().max(80) }).safeParse(raw);
    throw new ProcessorClientError("분석 요청을 확인하지 못했어요.", response.status, code.success ? code.data.code : undefined);
  }
  return raw;
}
export async function getAnalysisAvailability(identity: DraftIdentity, base: DraftSnapshot, signal?: AbortSignal) {
  return boundedRequest(url(identity, "/capabilities"), { method: "GET", headers: headers(identity, base), signal }, async response => {
    const parsed = availabilitySchema.safeParse(await json(response));
    if (!parsed.success) invalid();
    return parsed.data;
  });
}
export async function requestAnalysis(identity: DraftIdentity, base: DraftSnapshot, frameIds: string[], ticket: AnalysisTicket, signal?: AbortSignal) {
  const parsed = ticketSchema.safeParse(ticket);
  if (!parsed.success || ticket.guideId !== base.guideId || ticket.inputFingerprint !== base.inputFingerprint ||
      ticket.baseDraftRevision !== base.revision || !base.persisted || base.revision === 0) invalid();
  return boundedRequest(url(identity), { method: "POST", headers: { ...headers(identity, base), "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ runId: ticket.runId, baseDraftRevision: ticket.baseDraftRevision, consentVersion: ticket.consentVersion, externalProcessing: true }),
  }, async response => {
    const run = parseAnalysisRun(await json(response), base, frameIds, ticket.runId);
    if (run.baseDraftRevision !== ticket.baseDraftRevision) invalid();
    return run;
  });
}
export async function readAnalysisRun(identity: DraftIdentity, base: DraftSnapshot, frameIds: string[], runId: string, signal?: AbortSignal) {
  if (!uuid.safeParse(runId).success) invalid();
  return boundedRequest(url(identity, `/${runId}`), { method: "GET", headers: headers(identity, base), signal },
    async response => parseAnalysisRun(await json(response), base, frameIds, runId));
}
export async function cancelAnalysisRun(identity: DraftIdentity, base: DraftSnapshot, frameIds: string[], runId: string, signal?: AbortSignal) {
  if (!uuid.safeParse(runId).success) invalid();
  return boundedRequest(url(identity, `/${runId}/cancel`), { method: "POST", headers: headers(identity, base), signal },
    async response => parseAnalysisRun(await json(response), base, frameIds, runId));
}

export type AnalysisTransport = {
  availability: typeof getAnalysisAvailability;
  latest: (identity: DraftIdentity, base: DraftSnapshot, signal?: AbortSignal) => Promise<StoredAnalysis>;
  start: typeof requestAnalysis; read: typeof readAnalysisRun; cancel: typeof cancelAnalysisRun;
};
const transport: AnalysisTransport = { availability: getAnalysisAvailability,
  latest: async (...args) => (await getStoredAnalysis(...args)).analysis,
  start: requestAnalysis, read: readAnalysisRun, cancel: cancelAnalysisRun };
export type AnalysisSessionState = {
  busy: boolean; phase: "idle" | "checking" | "starting" | "cancelling" | "uncertain" | "error" | AnalysisRunView["status"];
  availability: AnalysisAvailability | null; run: AnalysisRunView | null;
  message: string | null; canStart: boolean; pollingPaused: boolean; frameCount: number;
};

export function analysisSessionFailure(error: unknown): string {
  if (error instanceof ProcessorClientError) {
    if (error.code === "ANALYSIS_RECOVERY_UNAVAILABLE") return "복구 기록을 안전하게 저장할 수 없어 새 분석을 시작하지 않았어요. 브라우저 저장 공간을 확인해 주세요.";
    if (error.code === "ANALYSIS_UNAVAILABLE") return "서버의 안전한 실행 준비가 끝나지 않아 새 분석을 시작하지 않았어요.";
    if (error.status === 429) return "분석 또는 요청 한도에 도달했어요. 자동 재시도하지 않습니다. 잠시 뒤 상태를 확인해 주세요.";
    if (error.status === 409) return "다른 창의 편집 또는 분석 상태가 바뀌었어요. 현재 편집은 유지했어요. 저장본과 분석 상태를 확인해 주세요.";
    if ([401, 403, 404].includes(error.status ?? 0)) return "분석 상태나 접근 권한을 확인하지 못했어요. 새 요청을 만들지 않고 현재 편집과 복구 기록을 유지합니다.";
  }
  return "서버 응답을 확인하지 못했어요. 요청이 접수됐을 수도 있어 새 분석을 만들지 않습니다. ‘상태 다시 확인’을 눌러 주세요.";
}

/** No provider access. A lost POST stays pinned to its pre-persisted UUID;
 * reload, polling, visibility and recovery can issue GETs only. */
export class AnalysisSession {
  state: AnalysisSessionState = { busy: false, phase: "idle", availability: null, run: null, message: null, canStart: false, pollingPaused: false, frameCount: 0 };
  private base: DraftSnapshot;
  private frames: string[] = [];
  private pending: AnalysisTicket | null = null;
  private request: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polls = 0;
  private visible = true;
  private disposed = false;
  constructor(private identity: DraftIdentity, base: DraftSnapshot, private storage: AnalysisStorage,
    private notify: (state: AnalysisSessionState) => void, private api: AnalysisTransport = transport) {
    this.base = structuredClone(base);
  }
  updateBase(base: DraftSnapshot) {
    if (base.guideId !== this.base.guideId || base.inputFingerprint !== this.base.inputFingerprint) { this.dispose(); return; }
    this.base = structuredClone(base);
    this.publish({});
  }
  private publish(patch: Partial<AnalysisSessionState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.state.canStart = !this.state.busy && !this.pending && this.frames.length > 0 && this.base.persisted && this.base.revision > 0 &&
      this.state.phase !== "error" && this.state.phase !== "uncertain" && Boolean(this.state.availability?.startAvailable) && !this.state.run?.cancellable;
    this.notify(structuredClone(this.state));
  }
  private record(): AnalysisTicket | null {
    try {
      const raw = this.storage.getItem(analysisRecoveryKey(this.identity.guideId));
      if (raw === null) return null;
      const value = ticketSchema.parse(JSON.parse(raw));
      if (value.guideId !== this.base.guideId || value.inputFingerprint !== this.base.inputFingerprint) storageError();
      return value;
    } catch { return storageError(); }
  }
  private clearRecord(runId: string) {
    const stored = this.record();
    if (stored?.runId === runId) {
      this.storage.removeItem(analysisRecoveryKey(this.identity.guideId));
      if (this.record()?.runId === runId) storageError();
    }
    this.pending = null;
  }
  private remember(ticket: AnalysisTicket) {
    try {
      if (this.record()) storageError();
      this.storage.setItem(analysisRecoveryKey(this.identity.guideId), JSON.stringify(ticket));
      if (JSON.stringify(this.record()) !== JSON.stringify(ticket)) storageError();
      this.pending = ticket;
    } catch { storageError(); }
  }
  private begin(phase: AnalysisSessionState["phase"]) {
    if (this.disposed || this.request) return null;
    clearTimeout(this.timer);
    const abort = new AbortController(); this.request = abort;
    this.publish({ phase, busy: true, message: null });
    return abort;
  }
  private accept(run: AnalysisRunView | null) {
    if (run && !run.cancellable && this.pending?.runId === run.runId) this.clearRecord(run.runId);
    this.publish({ run, phase: run?.status ?? "idle", message: null });
  }
  private finish(abort: AbortController) {
    if (this.request !== abort) return;
    this.request = null; this.publish({ busy: false }); this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.disposed || this.request || !this.visible || !["queued", "running"].includes(this.state.phase)) return;
    if (this.polls >= ANALYSIS_MAX_POLLS) { this.publish({ pollingPaused: true }); return; }
    this.timer = setTimeout(() => { this.polls++; void this.refresh(false); }, ANALYSIS_POLL_MS);
  }
  setVisible(visible: boolean) { this.visible = visible; clearTimeout(this.timer); if (visible) this.schedule(); }
  async refresh(manual = true) {
    const abort = this.begin("checking"); if (!abort) return;
    if (manual) { this.polls = 0; this.publish({ pollingPaused: false }); }
    const base = structuredClone(this.base);
    try {
      this.pending = this.record();
      const latest = await this.api.latest(this.identity, base, abort.signal);
      if (abort.signal.aborted) return;
      this.frames = latest.frameIds;
      this.publish({ frameCount: this.frames.length });
      let run = latest.run;
      // Never infer "not submitted" from a 404 or from an unrelated latest run.
      if (this.pending && run?.runId !== this.pending.runId) {
        run = await this.api.read(this.identity, base, this.frames, this.pending.runId, abort.signal);
      }
      if (abort.signal.aborted) return;
      this.accept(run);
      // Capability failure must not hide an already observed active run/cancel.
      try {
        const availability = await this.api.availability(this.identity, base, abort.signal);
        if (!abort.signal.aborted) this.publish({ availability });
      } catch { if (!abort.signal.aborted) this.publish({ availability: null, message: "새 분석의 실행 조건을 확인하지 못했어요. 기존 작업의 조회·취소는 계속 사용할 수 있어요." }); }
    } catch (error) {
      if (!abort.signal.aborted) this.publish({ phase: this.pending ? "uncertain" : "error", message: analysisSessionFailure(error), availability: null });
    } finally { this.finish(abort); }
  }
  async start(consent: { externalProcessing: boolean; nonSensitive: boolean; base: DraftSnapshot }, runId: string) {
    if (!this.state.canStart || !consent.externalProcessing || !consent.nonSensitive ||
        JSON.stringify(consent.base) !== JSON.stringify(this.base)) return;
    const abort = this.begin("starting"); if (!abort) return;
    const base = structuredClone(this.base);
    let ticket: AnalysisTicket | undefined;
    try {
      ticket = ticketSchema.parse({ version: 1, guideId: base.guideId, runId, inputFingerprint: base.inputFingerprint,
        baseDraftRevision: base.revision, consentVersion: ANALYSIS_CONSENT_VERSION });
      this.remember(ticket); // Must be durable before the first POST.
      const run = await this.api.start(this.identity, base, this.frames, ticket, abort.signal);
      if (!abort.signal.aborted) this.accept(run);
    } catch (error) {
      // Only explicit pre-admission rejections may release this UUID. Unknown
      // 5xx/timeouts/network failures may have persisted a run and stay pinned.
      if (ticket && error instanceof ProcessorClientError &&
          ["ANALYSIS_UNAVAILABLE", "ANALYSIS_CONSENT_REQUIRED", "ANALYSIS_INVALID_REQUEST", "ANALYSIS_BUDGET_LIMIT", "ANALYSIS_RATE_LIMIT", "ANALYSIS_STATE_CHANGED"].includes(error.code ?? "")) {
        try { this.clearRecord(ticket.runId); } catch { /* preserve ambiguity */ }
      }
      if (!abort.signal.aborted) this.publish({ phase: this.pending ? "uncertain" : "error", message: analysisSessionFailure(error), availability: null });
    } finally { this.finish(abort); }
  }
  async cancel() {
    const run = this.state.run;
    if (!run?.cancellable) return;
    const abort = this.begin("cancelling"); if (!abort) return;
    try {
      const next = await this.api.cancel(this.identity, this.base, this.frames, run.runId, abort.signal);
      if (!abort.signal.aborted) this.accept(next);
    } catch (error) {
      if (!abort.signal.aborted) this.publish({ phase: "uncertain", message: "취소 완료를 확인하지 못했어요. 이미 진행된 외부 처리는 멈추지 않았을 수 있습니다. 상태를 다시 확인해 주세요." });
    } finally { this.finish(abort); }
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.request?.abort(); this.request = null; }
}
