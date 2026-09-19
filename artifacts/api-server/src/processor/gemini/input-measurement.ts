import { randomUUID } from "node:crypto";
import { z } from "zod";

import { AnalysisAdmissionError } from "../analysis-admission.js";
import { fundingDay } from "../analysis-funding.js";
import { providerQuotaDay } from "../analysis-provider-quota.js";
import { auditGeminiInput, type GeminiInputAudit } from "./input-bound.js";
import { GEMINI_PROMPT_VERSION, GEMINI_TEST_MODEL, type AnalysisInput } from "./request.js";

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const measurementSchema = z.object({
  id, kind: z.literal("countTokens-exact-request"), projectRef: id, inputApprovalId: id,
  inputFingerprint: hash, requestFingerprint: hash,
  model: z.literal(GEMINI_TEST_MODEL), promptVersion: z.literal(GEMINI_PROMPT_VERSION),
  measuredInputTokens: z.number().int().positive().safe(),
  checkedAt: z.string().datetime(), validUntil: z.string().datetime(),
}).strict();
export type GeminiInputMeasurement = z.infer<typeof measurementSchema>;
export type MeasurementLookup = GeminiInputAudit & { projectRef: string };
export interface AnalysisInputMeasurementVerifier {
  /** Offline lookup ONLY: never perform countTokens or any other image transmission. */
  inspect(input: MeasurementLookup, signal: AbortSignal): Promise<unknown>;
  /** Bind the entire record, not just a forgeable/borrowed evidence ID. Synchronous, no I/O. */
  isCurrent(measurement: GeminiInputMeasurement): boolean;
}

function unavailable(): never { throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE"); }
const identity = (input: MeasurementLookup | GeminiInputMeasurement) => JSON.stringify([
  input.projectRef, input.model, input.promptVersion, input.inputApprovalId, input.inputFingerprint, input.requestFingerprint,
]);

/** Exact measured input, checked against the approved generation ceiling; not a pre-count upper-bound proof. */
export function verifyGeminiInputMeasurement(options: {
  raw: unknown; input: MeasurementLookup; verifier: AnalysisInputMeasurementVerifier;
  maxInputTokens: number; clock: () => Date; signal: AbortSignal;
}) {
  const parsed = measurementSchema.safeParse(options.raw);
  if (!parsed.success) unavailable();
  const measurement = parsed.data;
  if (identity(measurement) !== identity(options.input) || !Number.isSafeInteger(options.maxInputTokens) ||
      options.maxInputTokens < measurement.measuredInputTokens) unavailable();
  const initial = options.clock().valueOf();
  const assertCurrent = (at = options.clock()) => {
    const time = at.valueOf(); const checked = Date.parse(measurement.checkedAt); const expiry = Date.parse(measurement.validUntil);
    if (options.signal.aborted || !Number.isFinite(initial) || !Number.isFinite(time) || time < initial || checked > time ||
        expiry <= time || expiry <= checked || expiry - checked > 30_000 ||
        fundingDay(at) !== fundingDay(new Date(checked)) || providerQuotaDay(at) !== providerQuotaDay(new Date(checked))) unavailable();
    // Pass a copy so a verifier cannot mutate the record after validation.
    const current: unknown = options.verifier.isCurrent(structuredClone(measurement));
    if (current !== true) { void Promise.resolve(current).catch(() => undefined); unavailable(); }
  };
  assertCurrent();
  return { measurement: structuredClone(measurement), assertCurrent };
}

/**
 * Trusted count-stage dependency, intentionally NOT supplied by startup.
 * execute must separately persist countTokens usage/attempt identity and enforce
 * consent, current guide ownership, reviewed bound OR explicit bounded-count approval, and request quota BEFORE
 * transmission. An existing generateContent send permit is NOT valid here.
 * The complete request must be counted, and no hidden retries are permitted.
 */
export interface MeteredGeminiInputCounter<TContext = undefined> {
  readonly contract: "separately-metered-countTokens-v1";
  execute(input: AnalysisInput, scope: MeasurementLookup, signal: AbortSignal, context: TContext): Promise<{ totalTokens: number }>;
}

/**
 * Concrete, process-local short-lived measurement cache. Empty after restart;
 * never a durable usage ledger. No public method imports JSON/evidence from HTTP,
 * historical probe files, environment flags or a user-supplied token number.
 */
export class GeminiInputMeasurements<TContext = undefined> implements AnalysisInputMeasurementVerifier {
  readonly #counter?: MeteredGeminiInputCounter<TContext>;
  readonly #clock: () => Date;
  readonly #timeoutMs: number;
  readonly #records = new Map<string, GeminiInputMeasurement>();
  #epoch = 0;
  #lastTime = -Infinity;
  #inFlight = false;
  #activeController?: AbortController;

  constructor(options: { counter?: MeteredGeminiInputCounter<TContext>; clock?: () => Date; timeoutMs?: number } = {}) {
    this.#counter = options.counter;
    this.#clock = options.clock ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 20_000) unavailable();
  }
  private time() {
    const at = new Date(this.#clock().valueOf());
    if (!Number.isFinite(at.valueOf()) || at.valueOf() < this.#lastTime) { this.clear(); unavailable(); }
    this.#lastTime = at.valueOf();
    return at;
  }
  private prune(at: Date) {
    for (const [key, record] of this.#records) {
      if (Date.parse(record.validUntil) <= at.valueOf() || fundingDay(at) !== fundingDay(new Date(record.checkedAt)) ||
          providerQuotaDay(at) !== providerQuotaDay(new Date(record.checkedAt))) this.#records.delete(key);
    }
  }
  /** Explicit measurement stage; inspect below can NEVER trigger this operation. */
  async measure(rawInput: AnalysisInput, scope: { projectRef: string; inputApprovalId: string; inputFingerprint: string },
    signal: AbortSignal, context?: TContext): Promise<GeminiInputMeasurement> {
    if (!this.#counter || this.#counter.contract !== "separately-metered-countTokens-v1" || this.#inFlight || signal.aborted ||
        !id.safeParse(scope.projectRef).success || !id.safeParse(scope.inputApprovalId).success || !hash.safeParse(scope.inputFingerprint).success) unavailable();
    const input = structuredClone(rawInput);
    const audit: MeasurementLookup = { ...auditGeminiInput(input, scope.inputApprovalId, scope.inputFingerprint), projectRef: scope.projectRef };
    const key = identity(audit); const started = this.time(); this.prune(started);
    if (this.#records.size >= 64 && !this.#records.has(key)) unavailable();
    this.#records.delete(key); // A new attempt cannot fall back to the preceding measurement.
    const epoch = this.#epoch;
    const controller = new AbortController(); const combined = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE"));
      combined.addEventListener("abort", onAbort, { once: true });
    });
    this.#inFlight = true;
    this.#activeController = controller;
    let executorDone = false; let measureDone = false;
    const release = () => {
      if (executorDone && measureDone && this.#activeController === controller) {
        this.#inFlight = false; this.#activeController = undefined;
      }
    };
    // Keep this latch until the actual executor settles, even if it ignores abort.
    // A timed-out count cannot silently overlap another local measurement.
    const operation = Promise.resolve().then(() => {
      combined.throwIfAborted();
      return this.#counter!.execute(input, structuredClone(audit), combined, context as TContext);
    }).finally(() => { executorDone = true; release(); });
    try {
      const result = z.object({ totalTokens: z.number().int().positive().safe() }).strict().parse(await Promise.race([operation, cancelled]));
      const completed = this.time();
      if (combined.aborted || epoch !== this.#epoch || completed.valueOf() - started.valueOf() >= 30_000 ||
          fundingDay(completed) !== fundingDay(started) || providerQuotaDay(completed) !== providerQuotaDay(started) ||
          auditGeminiInput(input, audit.inputApprovalId, audit.inputFingerprint).requestFingerprint !== audit.requestFingerprint) unavailable();
      const measurement = measurementSchema.parse({ id: randomUUID(), kind: "countTokens-exact-request", projectRef: audit.projectRef,
        inputApprovalId: audit.inputApprovalId, inputFingerprint: audit.inputFingerprint, requestFingerprint: audit.requestFingerprint,
        model: audit.model, promptVersion: audit.promptVersion, measuredInputTokens: result.totalTokens,
        checkedAt: started.toISOString(), validUntil: new Date(started.valueOf() + 30_000).toISOString() });
      this.#records.set(key, measurement);
      return structuredClone(measurement);
    } catch { unavailable(); }
    finally { clearTimeout(timer); combined.removeEventListener("abort", onAbort); controller.abort(); measureDone = true; release(); }
  }
  async inspect(input: MeasurementLookup, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) unavailable();
    this.prune(this.time());
    const record = this.#records.get(identity(input));
    return record ? structuredClone(record) : null;
  }
  isCurrent(measurement: GeminiInputMeasurement): boolean {
    try {
      this.prune(this.time());
      const parsed = measurementSchema.safeParse(measurement);
      if (!parsed.success) return false;
      const record = this.#records.get(identity(parsed.data));
      return Boolean(record && Object.entries(record).every(([key, value]) => parsed.data[key as keyof GeminiInputMeasurement] === value));
    } catch { return false; }
  }
  /** Revocation also invalidates any count currently in flight. */
  clear(): void { this.#epoch += 1; this.#records.clear(); this.#activeController?.abort(); }
}
