import { randomUUID } from "node:crypto";
import { z } from "zod";

import { AnalysisAdmissionError, analysisAdmissionInputSchema, verifyAnalysisReadiness,
  type AnalysisAdmissionInput, type AnalysisAdmissionReadiness, type AnalysisAdmissionSnapshot } from "./analysis-admission.js";
import { fundingDay } from "./analysis-funding.js";
import { providerQuotaDay } from "./analysis-provider-quota.js";
import { analysisOperationsReviewSchema, checkAnalysisOperationsReview } from "./analysis-operations-review.js";
import { boundedCountPolicySchema } from "./gemini/count-policy.js";

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const stamp = { id, checkedAt: z.string().datetime(), validUntil: z.string().datetime(), deploymentRef: id };
const runtimeSchema = z.object({ ...stamp, kind: z.literal("checked-analysis-runtime"),
  repository: z.literal("postgres-0008"), dispatcher: z.literal("durable-accounted-v1"),
  counting: z.literal("count-accounted-0010-v1"), storage: z.literal("replit"), storageRef: id,
  quotaAccounting: z.literal("app-project-atomic"), projectRef: id, credentialRef: id }).strict();
const inputSchema = z.discriminatedUnion("kind", [z.object({ ...stamp, kind: z.literal("reviewed-analysis-input"),
  input: analysisAdmissionInputSchema, scope: z.literal("approved_synthetic"), inputApprovalId: id,
  boundReviewId: id, inputTokenBound: z.number().int().positive().safe(),
  boundCoverage: z.literal("all-batches-system-schema-metadata-targets-context-envelope"),
}).strict(), z.object({ ...stamp, kind: z.literal("approved-countable-input"),
  input: analysisAdmissionInputSchema, scope: z.literal("approved_synthetic"), inputApprovalId: id,
  inputTokenLimit: z.number().int().positive().safe(), countPolicy: boundedCountPolicySchema,
}).strict()]);
// checkedAt is when the active record/revision was read, NOT when cloud facts were observed.
const operationsSchema = z.object({ ...stamp, kind: z.literal("active-operator-review"),
  review: analysisOperationsReviewSchema }).strict();

export type AnalysisRuntimeEvidence = z.infer<typeof runtimeSchema>;
export type AnalysisApprovedInputEvidence = z.infer<typeof inputSchema>;
export type AnalysisOperationsEvidence = z.infer<typeof operationsSchema>;

/**
 * Server-owned verifier, NOT a JSON loader or a provider enable flag. inspect must
 * obtain current app facts without external AI/image transmission. For operations,
 * it must read the authenticated, active review/revision from a trusted operator
 * store; isCurrent checks locally observed revocation/revision, NOT remote account
 * changes. DB-backed operations sources also require the shared transactional halt
 * checks at admission and actual count/generation launch for cross-process safety.
 * isCurrent must bind the ENTIRE record, synchronously and without I/O.
 * Literal strings and hashes are contracts, not proof that verification occurred.
 */
export interface AnalysisEvidenceSource<T> {
  inspect(input: AnalysisAdmissionInput, signal: AbortSignal): Promise<unknown>;
  isCurrent(evidence: T): boolean;
}
export interface AnalysisReadinessSources {
  runtime: AnalysisEvidenceSource<AnalysisRuntimeEvidence>;
  approvedInput: AnalysisEvidenceSource<AnalysisApprovedInputEvidence>;
  operations: AnalysisEvidenceSource<AnalysisOperationsEvidence>;
}
type Options = { sources?: AnalysisReadinessSources; clock?: () => Date; timeoutMs?: number };
type Evidence = { runtime: AnalysisRuntimeEvidence; approvedInput: AnalysisApprovedInputEvidence; operations: AnalysisOperationsEvidence };
type Record = { snapshot: AnalysisAdmissionSnapshot; evidence: Evidence };
const sourceNames = ["runtime", "approvedInput", "operations"] as const;
function unavailable(): never { throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE"); }
function requireTrue(value: unknown) {
  if (value !== true) { void Promise.resolve(value).catch(() => undefined); unavailable(); }
}
function fresh(evidence: { checkedAt: string; validUntil: string }, at: Date) {
  const checked = Date.parse(evidence.checkedAt); const expiry = Date.parse(evidence.validUntil);
  if (!Number.isFinite(checked) || !Number.isFinite(expiry) || checked > at.valueOf() || expiry <= at.valueOf() ||
      expiry <= checked || expiry - checked > 30_000 || fundingDay(at) !== fundingDay(new Date(checked)) ||
      providerQuotaDay(at) !== providerQuotaDay(new Date(checked))) unavailable();
}

/**
 * Internal, process-local evidence composition only. No HTTP/env/startup wiring,
 * cloud clients, image bytes, credential values, countTokens, or persistence.
 * No sources means unavailable. Actual trusted sources remain to be implemented
 * and verified for the chosen runtime before this can authorize real execution.
 */
export class EvidenceAnalysisReadiness implements AnalysisAdmissionReadiness {
  readonly #sources?: AnalysisReadinessSources;
  readonly #clock: () => Date;
  readonly #timeoutMs: number;
  readonly #records = new Map<string, Record>();
  readonly #active = new Set<AbortController>();
  #epoch = 0;
  #lastTime = -Infinity;

  constructor(options: Options = {}) {
    // Copy the dependency slots so replacing the caller's options cannot swap a verifier.
    this.#sources = options.sources ? { ...options.sources } : undefined;
    this.#clock = options.clock ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 5000) unavailable();
  }
  private time(): Date {
    const at = new Date(this.#clock().valueOf());
    if (!Number.isFinite(at.valueOf()) || at.valueOf() < this.#lastTime) { this.clear(); unavailable(); }
    this.#lastTime = at.valueOf();
    return at;
  }
  private prune(at: Date) {
    for (const [key, record] of this.#records) {
      try { fresh(record.snapshot, at); } catch { this.#records.delete(key); }
    }
  }
  private check(evidence: Evidence, at: Date) {
    const sources = this.#sources;
    if (!sources) unavailable();
    for (const name of sourceNames) fresh(evidence[name], at);
    checkAnalysisOperationsReview(evidence.operations.review, at);
    requireTrue(sources.runtime.isCurrent(structuredClone(evidence.runtime)));
    requireTrue(sources.approvedInput.isCurrent(structuredClone(evidence.approvedInput)));
    requireTrue(sources.operations.isCurrent(structuredClone(evidence.operations)));
  }
  async inspect(rawInput: AnalysisAdmissionInput, parent: AbortSignal): Promise<AnalysisAdmissionSnapshot> {
    let snapshotId: string | undefined;
    try {
      const input = analysisAdmissionInputSchema.parse(rawInput);
      const sources = this.#sources;
      const started = this.time(); this.prune(started);
      if (!sources || parent.aborted || this.#active.size >= 8 || this.#records.size >= 64) unavailable();
      const epoch = this.#epoch;
      const controller = new AbortController();
      const signal = AbortSignal.any([parent, controller.signal]);
      this.#active.add(controller);
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      let abort!: () => void;
      const stopped = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      // Detached/late sources cannot publish. Keep their slots until ALL actually
      // settle, even if one rejects or ignores cancellation, to bound local work.
      const inspections = sourceNames.map((name) => Promise.resolve().then(async () => {
        signal.throwIfAborted();
        return sources[name].inspect(structuredClone(input), signal);
      }));
      void Promise.allSettled(inspections).then(() => this.#active.delete(controller));
      try {
        const raw = await Promise.race([Promise.all(inspections), stopped]);
        signal.throwIfAborted();
        if (epoch !== this.#epoch) unavailable();
        const evidence: Evidence = { runtime: runtimeSchema.parse(raw[0]),
          approvedInput: inputSchema.parse(raw[1]), operations: operationsSchema.parse(raw[2]) };
        const { runtime, approvedInput, operations } = evidence;
        const { review, basis } = checkAnalysisOperationsReview(operations.review, this.time());
        const at = this.time(); this.prune(at);
        if (epoch !== this.#epoch || this.#records.size >= 64 || at.valueOf() - started.valueOf() >= 30_000 ||
            fundingDay(at) !== fundingDay(started) || providerQuotaDay(at) !== providerQuotaDay(started) ||
            runtime.deploymentRef !== approvedInput.deploymentRef || runtime.deploymentRef !== operations.deploymentRef ||
            runtime.deploymentRef !== review.deploymentRef || runtime.projectRef !== review.projectRef ||
            runtime.credentialRef !== review.credentialRef || runtime.storageRef !== review.storageRef ||
            Date.parse(review.recordedAt) > Date.parse(operations.checkedAt) ||
            Object.entries(input).some(([key, value]) => approvedInput.input[key as keyof AnalysisAdmissionInput] !== value)) unavailable();
        this.check(evidence, at);
        // Never re-date old evidence or extend any source's expiry.
        const records = Object.values(evidence);
        const snapshot: AnalysisAdmissionSnapshot = { ...input, id: randomUUID(),
          checkedAt: new Date(Math.min(...records.map((e) => Date.parse(e.checkedAt)))).toISOString(),
          validUntil: new Date(Math.min(Date.parse(review.expiresAt), ...records.map((e) => Date.parse(e.validUntil)))).toISOString(),
          scope: approvedInput.scope, inputApprovalId: approvedInput.inputApprovalId,
          runtime: { repository: runtime.repository, dispatcher: runtime.dispatcher, counting: runtime.counting,
            ...(approvedInput.kind === "approved-countable-input"
              ? { inputTokenLimit: approvedInput.inputTokenLimit, countPolicy: approvedInput.countPolicy }
              : { inputTokenBound: approvedInput.inputTokenBound, boundIncludes: "prompt-schema-targets-context" as const }) },
          policy: review.policy, entitlement: { mode: "free_only", projectRef: review.projectRef,
            evidenceId: review.id, paidFallback: false, providerLimits: review.providerLimits, operationsBasis: basis } };
        snapshotId = snapshot.id;
        this.#records.set(snapshot.id, { snapshot: structuredClone(snapshot), evidence });
        verifyAnalysisReadiness({ raw: snapshot, input, readiness: this, spending: { mode: "free_only" }, clock: this.#clock, signal });
        if (epoch !== this.#epoch || signal.aborted) unavailable();
        return structuredClone(snapshot);
      } finally {
        clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort();
      }
    } catch {
      if (snapshotId) this.#records.delete(snapshotId);
      unavailable(); // No source error, private identifier, path or abort reason escapes.
    }
  }
  isCurrent(snapshotId: string): boolean {
    try {
      const at = this.time(); this.prune(at);
      const record = this.#records.get(snapshotId);
      if (!record) return false;
      const epoch = this.#epoch;
      this.check(record.evidence, at);
      // Synchronous checks still take time; do not return a lease that expired
      // while a source guard was executing.
      fresh(record.snapshot, this.time());
      // A verifier may revoke everything during its synchronous check.
      return epoch === this.#epoch && this.#records.get(snapshotId) === record;
    } catch { this.#records.delete(snapshotId); return false; }
  }
  /** Observed runtime/key/policy/approval/review changes invalidate published AND in-flight evidence. */
  clear(): void {
    this.#epoch += 1; this.#records.clear();
    for (const controller of this.#active) controller.abort();
  }
}
