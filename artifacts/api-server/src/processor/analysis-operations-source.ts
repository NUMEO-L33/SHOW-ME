import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AnalysisAdmissionError, analysisAdmissionInputSchema, type AnalysisAdmissionInput } from "./analysis-admission.js";
import { fundingDay } from "./analysis-funding.js";
import { providerQuotaDay } from "./analysis-provider-quota.js";
import { checkAnalysisOperationsReview } from "./analysis-operations-review.js";
import { analysisOperationsObservationSchema, type PostgresAnalysisOperationsStore } from "./analysis-operations-store.js";
import type { AnalysisEvidenceSource, AnalysisOperationsEvidence } from "./analysis-readiness.js";

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const bindingSchema = z.object({ deploymentRef: id, projectRef: id, credentialRef: id, storageRef: id }).strict();
type Options = { store: Pick<PostgresAnalysisOperationsStore, "observe">; binding: z.infer<typeof bindingSchema>;
  clock?: () => Date; timeoutMs?: number };
function unavailable(): never { throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE"); }

/**
 * Reads the DB on EVERY inspect; never refreshes a cached operator observation.
 * isCurrent is a bounded LOCAL guard, not a synchronous remote DB query. Cross-
 * process revocation is enforced by the shared halt lock at admission/count/send.
 * Must only be composed with those existing durable execution paths. No startup,
 * HTTP, environment loader, background polling, automatic unhalt or AI calls.
 */
export class OperationsReviewEvidenceSource implements AnalysisEvidenceSource<AnalysisOperationsEvidence> {
  readonly #store: Options["store"];
  readonly #binding: Options["binding"];
  readonly #clock: () => Date;
  readonly #timeout: number;
  readonly #records = new Map<string, AnalysisOperationsEvidence>();
  #active?: AbortController;
  #lastTime = -Infinity;
  #epoch = 0;
  #latestEntry: unknown;
  constructor(options: Options) {
    const parsed = bindingSchema.safeParse(options.binding); if (!parsed.success) unavailable();
    this.#binding = parsed.data; this.#store = options.store; this.#clock = options.clock ?? (() => new Date());
    this.#timeout = options.timeoutMs ?? 4000;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 4000) unavailable();
  }
  #time() {
    const at = new Date(this.#clock().valueOf());
    if (!Number.isFinite(at.valueOf()) || at.valueOf() < this.#lastTime) { this.clear(); unavailable(); }
    this.#lastTime = at.valueOf(); return at;
  }
  #fresh(evidence: AnalysisOperationsEvidence, at: Date) {
    const checked = new Date(evidence.checkedAt); const expiry = Date.parse(evidence.validUntil);
    if (checked.valueOf() > at.valueOf() || expiry <= at.valueOf() || expiry - checked.valueOf() > 30_000 ||
        fundingDay(at) !== fundingDay(checked) || providerQuotaDay(at) !== providerQuotaDay(checked)) unavailable();
    checkAnalysisOperationsReview(evidence.review, at);
  }
  #prune(at: Date) {
    for (const [key, value] of this.#records) {
      try { this.#fresh(value, at); } catch { this.#records.delete(key); }
    }
  }
  async inspect(raw: AnalysisAdmissionInput, parent: AbortSignal): Promise<AnalysisOperationsEvidence> {
    // One DB operation per instance. Rejected contention does not cancel its owner.
    if (this.#active) unavailable();
    let issued: string | undefined;
    try {
      analysisAdmissionInputSchema.parse(raw);
      const started = this.#time(); this.#prune(started);
      if (parent.aborted || this.#records.size >= 64) unavailable();
      const epoch = this.#epoch; const controller = new AbortController(); this.#active = controller;
      const signal = AbortSignal.any([parent, controller.signal]);
      let abort!: () => void;
      const stopped = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE"));
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      });
      const timer = setTimeout(() => controller.abort(), this.#timeout);
      let operationDone = false; let inspectDone = false;
      const release = () => { if (operationDone && inspectDone && this.#active === controller) this.#active = undefined; };
      const operation = Promise.resolve().then(() => {
        signal.throwIfAborted(); return this.#store.observe(this.#binding.deploymentRef, signal);
      }).finally(() => { operationDone = true; release(); });
      try {
        const observation = analysisOperationsObservationSchema.parse(await Promise.race([operation, stopped]));
        signal.throwIfAborted();
        const at = this.#time(); const entry = observation.entry;
        const observed = Date.parse(observation.observedAt);
        if (epoch !== this.#epoch || observation.halted || !entry || entry.action !== "put" ||
            Math.abs(observed - at.valueOf()) > 5000 || Date.parse(entry.createdAt) > observed ||
            Object.entries(this.#binding).some(([key, value]) => entry.review[key as keyof Options["binding"]] !== value)) unavailable();
        const { review } = checkAnalysisOperationsReview(entry.review, at);
        // Same version with changed contents (including DB-level mutation) is not the same record.
        if (!isDeepStrictEqual(this.#latestEntry, entry)) this.#records.clear();
        this.#latestEntry = structuredClone(entry);
        const checkedAt = new Date(Math.min(started.valueOf(), observed)).toISOString();
        if (Date.parse(review.recordedAt) > Date.parse(checkedAt)) unavailable();
        const evidence: AnalysisOperationsEvidence = { id: randomUUID(), kind: "active-operator-review",
          deploymentRef: this.#binding.deploymentRef, checkedAt,
          validUntil: new Date(Math.min(Date.parse(checkedAt) + 30_000, Date.parse(review.expiresAt))).toISOString(), review };
        this.#fresh(evidence, at);
        this.#records.set(evidence.id, structuredClone(evidence)); issued = evidence.id;
        signal.throwIfAborted(); if (epoch !== this.#epoch) unavailable();
        return structuredClone(evidence);
      } finally {
        clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); inspectDone = true; release();
      }
    } catch {
      if (issued) this.#records.delete(issued);
      this.clear(); unavailable(); // No SQL, record, private path or driver error escapes.
    }
  }
  isCurrent(evidence: AnalysisOperationsEvidence): boolean {
    try {
      const at = this.#time(); this.#prune(at);
      const epoch = this.#epoch;
      const current = this.#records.get(evidence.id);
      if (!current || !isDeepStrictEqual(current, evidence)) return false;
      this.#fresh(current, this.#time());
      return epoch === this.#epoch && this.#records.get(current.id) === current;
    } catch { this.clear(); return false; }
  }
  /** Observed configuration/record changes or failures invalidate all local receipts. */
  clear(): void { this.#epoch++; this.#records.clear(); this.#latestEntry = undefined; this.#active?.abort(); }
}
