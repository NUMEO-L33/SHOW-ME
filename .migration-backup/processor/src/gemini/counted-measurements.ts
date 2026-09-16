import { z } from "zod";
import { AnalysisAdmissionError, verifyAnalysisReadiness, type AnalysisAdmissionReadiness } from "../analysis-admission.js";
import { analysisWorkOwnerSchema } from "../analysis-accounting-contract.js";
import { countBindingHash, parseCountRecord, type AnalysisCountCommand } from "../analysis-count-accounting.js";
import { analysisFundingPolicySchema } from "../analysis-funding.js";
import type { PostgresGuideRepository } from "../repository.js";
import { auditGeminiInput, verifyGeminiInputBound, type AnalysisInputBoundVerifier } from "./input-bound.js";
import { GeminiInputMeasurements, type AnalysisInputMeasurementVerifier, type MeasurementLookup, type MeteredGeminiInputCounter } from "./input-measurement.js";
import { TOKEN_PROBE_ENDPOINT, buildTokenCountRequest, readTokenCountResponse } from "./count-request.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL, type AnalysisInput } from "./request.js";

const contextSchema = z.object({ guideId: z.string().min(1).max(128), runId: z.string().min(1).max(128),
  batchIndex: z.number().int().min(0).max(5), generationOrdinal: z.union([z.literal(0), z.literal(1)]),
  frameCount: z.number().int().min(1).max(24), owner: analysisWorkOwnerSchema, policy: analysisFundingPolicySchema }).strict();
export type AnalysisCountContext = z.infer<typeof contextSchema>;
export type CountRepository = Pick<PostgresGuideRepository, "countDispatchContract" | "executeAnalysisCount" |
  "claimAnalysisCountLaunch" | "launchAnalysisCount" | "listPendingAnalysisCounts">;
export interface AnalysisMeasurementStage extends AnalysisInputMeasurementVerifier {
  measureForAnalysis(input: AnalysisInput, scope: MeasurementLookup, context: AnalysisCountContext, signal: AbortSignal): Promise<unknown>;
  recover(signal: AbortSignal): Promise<void>;
}
function unavailable(): never { throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE"); }
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, ms: number): Promise<T> {
  if (parent.aborted) unavailable();
  const controller = new AbortController(); const signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(() => controller.abort(), ms); let abort!: () => void;
  const stopped = new Promise<never>((_yes, no) => { abort = () => no(new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE")); signal.addEventListener("abort", abort, { once: true }); });
  try { const result = await Promise.race([operation(signal), stopped]); signal.throwIfAborted(); return result; }
  catch { unavailable(); }
  finally { clearTimeout(timer); controller.abort(); signal.removeEventListener("abort", abort); }
}
type Options = { repository: CountRepository; readiness: AnalysisAdmissionReadiness; inputBoundVerifier: AnalysisInputBoundVerifier;
  apiKey?: string; allowExternalProcessing?: boolean; fetch?: typeof fetch; clock?: () => Date; timeoutMs?: number };

/** No startup registration. Explicit enable + fresh trusted evidence are BOTH mandatory. */
export class AccountedGeminiInputCounter implements MeteredGeminiInputCounter<AnalysisCountContext> {
  readonly contract = "separately-metered-countTokens-v1" as const;
  readonly #options: Options;
  #inFlight = false;
  constructor(options: Options) {
    this.#options = { ...options };
    const timeout = options.timeoutMs ?? 20_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 20_000) unavailable();
  }
  async execute(rawInput: AnalysisInput, lookup: MeasurementLookup, parent: AbortSignal, rawContext: AnalysisCountContext) {
    const o = this.#options;
    if (parent.aborted || this.#inFlight || o.allowExternalProcessing !== true || !/^[\x21-\x7e]{10,4096}$/.test(o.apiKey ?? "") || o.repository.countDispatchContract !== "postgres-count-0010") unavailable();
    const parsed = contextSchema.safeParse(rawContext); if (!parsed.success) unavailable();
    const context = parsed.data; const input = structuredClone(rawInput); const scope = structuredClone(lookup);
    const clock = o.clock ?? (() => new Date());
    const slot = { runId: context.runId, batchIndex: context.batchIndex, generationOrdinal: context.generationOrdinal };
    let reserved = false; let finalized = false;
    let bindingHash: string | undefined;
    let operationDone = false; let executeDone = false;
    const release = () => { if (operationDone && executeDone) this.#inFlight = false; };
    this.#inFlight = true;
    try {
      return await bounded(async (signal) => {
        try {
          const expected = { guideId: context.guideId, frameCount: context.frameCount, inputFingerprint: scope.inputFingerprint,
            model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION } as const;
          const permission = verifyAnalysisReadiness({ raw: await o.readiness.inspect(expected, signal), input: expected,
            readiness: o.readiness, spending: { mode: "free_only" }, clock, signal });
          const snapshot = permission.snapshot;
          if (snapshot.runtime.counting !== "count-accounted-0010-v1" || snapshot.entitlement.mode !== "free_only" ||
              snapshot.entitlement.projectRef !== scope.projectRef || snapshot.inputApprovalId !== scope.inputApprovalId ||
              JSON.stringify(snapshot.policy) !== JSON.stringify(context.policy)) unavailable();
          const audit = auditGeminiInput(input, scope.inputApprovalId, scope.inputFingerprint);
          if (audit.requestFingerprint !== scope.requestFingerprint || audit.model !== scope.model || audit.promptVersion !== scope.promptVersion) unavailable();
          const bound = verifyGeminiInputBound({ audit, raw: await o.inputBoundVerifier.inspect(structuredClone(audit), signal),
            verifier: o.inputBoundVerifier, maxInputTokens: Math.min(snapshot.policy.maxInputTokensPerRequest, snapshot.runtime.inputTokenBound), clock, signal });
          const binding = { projectRef: scope.projectRef, inputApprovalId: scope.inputApprovalId, inputFingerprint: scope.inputFingerprint,
            requestFingerprint: audit.requestFingerprint, model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION } as const;
          bindingHash = countBindingHash(binding);
          const guard = (lockedClock = clock) => {
            signal.throwIfAborted(); permission.assertCurrent();
            if (auditGeminiInput(input, scope.inputApprovalId, scope.inputFingerprint).requestFingerprint !== audit.requestFingerprint) unavailable();
            bound.assertCurrent(clock()); bound.assertCurrent(lockedClock());
            if (lockedClock().valueOf() >= Date.parse(snapshot.validUntil)) unavailable();
          };
          const execute = (command: AnalysisCountCommand) => o.repository.executeAnalysisCount(context.guideId, command, undefined, () => guard());
          const reserve = { type: "reserve" as const, ...slot, binding, owner: context.owner };
          guard();
          // Mark cleanup eligibility before the await: an acknowledgement can be lost after COMMIT.
          reserved = true;
          const allocated = await execute(reserve);
          if (allocated.replayed || parseCountRecord(allocated.record).status !== "reserved") { reserved = false; unavailable(); }
          guard();
          const sending = { ...reserve, type: "sending" as const, limits: snapshot.entitlement.providerLimits,
            notAfter: new Date(Math.min(Date.parse(snapshot.validUntil), Date.parse(bound.evidence.validUntil))).toISOString() };
          const sent = await execute(sending);
          if (sent.replayed || !sent.quotaReceipt || parseCountRecord(sent.record).status !== "sending") unavailable();
          guard();
          const ticket = await o.repository.claimAnalysisCountLaunch(context.guideId, { ...sending, type: "claim-launch" }, undefined, () => guard());
          guard();
          const body = JSON.stringify(buildTokenCountRequest(input));
          let response: Response | undefined; let responsePromise: Promise<Response> | undefined; let calls = 0;
          const cancelBody = () => { void response?.body?.cancel().catch(() => {}); };
          signal.addEventListener("abort", cancelBody, { once: true });
          try {
            const launched = await o.repository.launchAnalysisCount(ticket, (lockedClock) => {
              guard(lockedClock);
              if (++calls !== 1) unavailable();
              responsePromise = (o.fetch ?? globalThis.fetch)(TOKEN_PROBE_ENDPOINT, { method: "POST", redirect: "error", signal,
                headers: { "content-type": "application/json", "x-goog-api-key": o.apiKey! }, body }).then((r) => {
                response = r; if (signal.aborted) { cancelBody(); unavailable(); } return r;
              });
              void responsePromise.catch(() => undefined);
            }, undefined, guard);
            if (!launched || !responsePromise || calls !== 1) unavailable();
            const reply = await responsePromise;
            if (!reply.ok) unavailable();
            const totalTokens = await readTokenCountResponse(reply, signal);
            signal.throwIfAborted();
            // Settlement is numeric-only: it must not require consent still to be active after a send.
            const result = await o.repository.executeAnalysisCount(context.guideId,
              { type: "settle", ...slot, bindingHash, usage: { status: "known", totalTokens } });
            const record = parseCountRecord(result.record); finalized = true;
            if (result.replayed || result.halted || record.status !== "settled" || record.bindingHash !== bindingHash ||
                record.usage?.status !== "known" || record.usage.totalTokens !== totalTokens ||
                totalTokens > bound.evidence.totalInputTokenUpperBound || totalTokens > snapshot.runtime.inputTokenBound) unavailable();
            guard(); return { totalTokens };
          } finally { signal.removeEventListener("abort", cancelBody); cancelBody(); }
        } finally { operationDone = true; release(); }
      }, parent, o.timeoutMs ?? 20_000);
    } catch {
      if (reserved && !finalized && bindingHash) {
        // Bounded bookkeeping only; never retry a provider or recreate a reservation.
        const cleanupHash = bindingHash;
        const settle: AnalysisCountCommand = { type: "settle", ...slot, bindingHash: cleanupHash, usage: { status: "unknown" } };
        try { await bounded(() => o.repository.executeAnalysisCount(context.guideId, settle), new AbortController().signal, 2000); }
        catch { try { await bounded(() => o.repository.executeAnalysisCount(context.guideId,
          { type: "release", ...slot, bindingHash: cleanupHash }), new AbortController().signal, 2000); } catch { /* Durable maximum remains for recovery. */ } }
      }
      unavailable();
    } finally { executeDone = true; release(); }
  }
}

/** The dispatcher receives this ONE object for explicit counting and offline lookup. */
export class AccountedGeminiMeasurements implements AnalysisMeasurementStage {
  readonly #cache: GeminiInputMeasurements<AnalysisCountContext>;
  readonly #repository: CountRepository;
  #recoveryCursor?: string;
  constructor(options: Options) {
    this.#repository = options.repository;
    this.#cache = new GeminiInputMeasurements({ counter: new AccountedGeminiInputCounter(options), clock: options.clock });
  }
  async measureForAnalysis(input: AnalysisInput, scope: MeasurementLookup, context: AnalysisCountContext, signal: AbortSignal) {
    const audit = auditGeminiInput(input, scope.inputApprovalId, scope.inputFingerprint);
    if (audit.requestFingerprint !== scope.requestFingerprint || audit.model !== scope.model || audit.promptVersion !== scope.promptVersion) unavailable();
    return this.#cache.measure(input, scope, signal, structuredClone(context));
  }
  inspect(input: MeasurementLookup, signal: AbortSignal) { return this.#cache.inspect(input, signal); }
  isCurrent(record: Parameters<AnalysisInputMeasurementVerifier["isCurrent"]>[0]) { return this.#cache.isCurrent(record); }
  clear() { this.#cache.clear(); }
  async recover(signal: AbortSignal): Promise<void> {
    const rows = await bounded(() => this.#repository.listPendingAnalysisCounts(20, this.#recoveryCursor), signal, 5000);
    if (!rows.length) this.#recoveryCursor = undefined;
    for (const raw of rows) {
      signal.throwIfAborted(); const r = parseCountRecord(raw); this.#recoveryCursor = r.requestKey;
      try { await bounded((s) => this.#repository.executeAnalysisCount(r.guideId, { type: "recover", runId: r.runId,
        batchIndex: r.batchIndex, generationOrdinal: r.generationOrdinal, bindingHash: r.bindingHash }, undefined, () => s.throwIfAborted()), signal, 5000); }
      catch { if (signal.aborted) unavailable(); /* Active leases stay reserved; cursor avoids head-of-line starvation. */ }
    }
  }
}
