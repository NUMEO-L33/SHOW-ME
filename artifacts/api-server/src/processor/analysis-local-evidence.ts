import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AnalysisAdmissionError, analysisAdmissionInputSchema, type AnalysisAdmissionInput } from "./analysis-admission.js";
import { fundingDay } from "./analysis-funding.js";
import { providerQuotaDay } from "./analysis-provider-quota.js";
import type { AnalysisEvidenceSource } from "./analysis-readiness.js";

type Stamp = { id: string; checkedAt: string; validUntil: string };
type ReadEvidence<T extends Stamp> = (input: AnalysisAdmissionInput, signal: AbortSignal, guard: () => void) =>
  Promise<Omit<T, keyof Stamp> & { expiresAt?: string; observedAt?: string }>;
export function evidenceUnavailable(): never { throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE"); }

/** Local receipts for actual reads, not a persisted approval or a remote revocation channel. */
export class LocalAnalysisEvidence<T extends Stamp> implements AnalysisEvidenceSource<T> {
  readonly #records = new Map<string, T>();
  readonly #clock: () => Date;
  readonly #read: ReadEvidence<T>;
  readonly #current: () => void;
  #active?: AbortController;
  #epoch = 0;
  #lastTime = -Infinity;
  constructor(options: { clock?: () => Date; current: () => void; read: ReadEvidence<T> }) {
    this.#clock = options.clock ?? (() => new Date()); this.#read = options.read; this.#current = options.current;
  }
  #time() {
    const at = new Date(this.#clock().valueOf());
    if (!Number.isFinite(at.valueOf()) || at.valueOf() < this.#lastTime) { this.clear(); evidenceUnavailable(); }
    this.#lastTime = at.valueOf(); return at;
  }
  #fresh(value: Stamp, at: Date) {
    const checked = new Date(value.checkedAt);
    if (checked.valueOf() > at.valueOf() || Date.parse(value.validUntil) <= at.valueOf() ||
        fundingDay(checked) !== fundingDay(at) || providerQuotaDay(checked) !== providerQuotaDay(at)) evidenceUnavailable();
  }
  async inspect(raw: AnalysisAdmissionInput, parent: AbortSignal): Promise<T> {
    if (this.#active) evidenceUnavailable();
    const controller = new AbortController(); const signal = AbortSignal.any([parent, controller.signal]);
    let abort!: () => void; let timer: ReturnType<typeof setTimeout> | undefined;
    let operationDone = false; let inspectDone = false;
    const release = () => { if (operationDone && inspectDone && this.#active === controller) this.#active = undefined; };
    try {
      const input = analysisAdmissionInputSchema.parse(raw); const started = this.#time(); this.#current();
      for (const [id, record] of this.#records) { try { this.#fresh(record, started); } catch { this.#records.delete(id); } }
      signal.throwIfAborted(); if (this.#records.size >= 64) evidenceUnavailable();
      const epoch = this.#epoch; this.#active = controller; const deadline = performance.now() + 4000;
      const guard = () => { signal.throwIfAborted(); this.#current(); this.#time();
        if (epoch !== this.#epoch || performance.now() >= deadline) evidenceUnavailable(); };
      const stopped = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE")); signal.addEventListener("abort", abort, { once: true });
      });
      timer = setTimeout(() => controller.abort(), 4000);
      const operation = Promise.resolve().then(() => { guard(); return this.#read(input, signal, guard); })
        .finally(() => { operationDone = true; release(); });
      const { expiresAt, observedAt, ...data } = await Promise.race([operation, stopped]); guard();
      const at = this.#time(); const observed = observedAt ? Date.parse(observedAt) : started.valueOf();
      if (!Number.isFinite(observed) || Math.abs(observed - at.valueOf()) > 5000) evidenceUnavailable();
      const checked = Math.min(started.valueOf(), observed);
      const record = { ...data, id: randomUUID(), checkedAt: new Date(checked).toISOString(),
        validUntil: new Date(Math.min(checked + 30_000, expiresAt ? Date.parse(expiresAt) : Infinity)).toISOString() } as unknown as T;
      this.#fresh(record, at); guard(); this.#records.set(record.id, structuredClone(record));
      return structuredClone(record);
    } catch { this.clear(); return evidenceUnavailable(); }
    finally { if (timer) clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); controller.abort(); inspectDone = true; release(); }
  }
  isCurrent(evidence: T): boolean {
    try {
      this.#current(); const current = this.#records.get(evidence.id);
      if (!current || !isDeepStrictEqual(current, evidence)) return false;
      this.#fresh(current, this.#time()); return true;
    } catch { this.clear(); return false; }
  }
  clear() { this.#epoch++; this.#records.clear(); this.#active?.abort(); }
}
