import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { parseAccountingControl } from "./analysis-accounting-contract.js";
import { activationForGrant, analysisActivationSchema, type AnalysisActivation } from "./analysis-activation.js";
import { syntheticInputGrantSchema } from "./analysis-synthetic-input.js";
import { ANALYSIS_OPERATIONS_REVIEW_MAX_MS, analysisOperationsReviewSchema,
  analysisOperationsCheckNames, checkAnalysisOperationsReview, type AnalysisOperationsReview } from "./analysis-operations-review.js";

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const version = z.number().int().min(0).max(2_147_483_646);
const base = { commandId: z.string().uuid(), expectedVersion: version };
export const analysisOperationsCommandSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("put"), review: analysisOperationsReviewSchema }).strict(),
  z.object({ ...base, type: z.literal("revoke"), deploymentRef: id, reviewId: id }).strict(),
]);
export type AnalysisOperationsCommand = z.infer<typeof analysisOperationsCommandSchema>;
export const analysisActivationCommandSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("activate"), deploymentRef: id, reviewId: id,
    expectedReviewVersion: version.positive(), grant: syntheticInputGrantSchema }).strict(),
  z.object({ ...base, type: z.literal("deactivate"), deploymentRef: id }).strict(),
]);
const activationEventSchema = z.object({ version: version.positive(), commandId: z.string().uuid(),
  commandHash: z.string().regex(/^[a-f0-9]{64}$/), actorRef: id, action: z.enum(["activate", "deactivate"]),
  deploymentRef: id, createdAt: z.string().datetime(), command: analysisActivationCommandSchema,
  activation: analysisActivationSchema.nullable() }).strict().refine(entry => entry.action === entry.command.type &&
    entry.commandId === entry.command.commandId && entry.version === entry.command.expectedVersion + 1 &&
    entry.deploymentRef === entry.command.deploymentRef &&
    (entry.action === "activate" ? entry.activation?.id === entry.commandId : entry.activation === null));
function activationEvent(row: Record<string, unknown>) {
  const payload = row.payload as Record<string, unknown>;
  const parsed = activationEventSchema.safeParse({ version: row.version, commandId: row.command_id,
    commandHash: row.command_hash, actorRef: row.actor_ref, action: row.action, deploymentRef: row.deployment_ref,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    command: payload?.command, activation: payload?.activation });
  if (!parsed.success || digest(JSON.stringify(parsed.data.command)) !== parsed.data.commandHash) fail();
  if (parsed.data.command.type === "activate") {
    const a = parsed.data.activation;
    if (!a || a.deploymentRef !== parsed.data.command.deploymentRef ||
        JSON.stringify(activationForGrant(parsed.data.commandId, parsed.data.command.grant, {
          deploymentRef: a.deploymentRef, projectRef: a.projectRef, credentialRef: a.credentialRef, storageRef: a.storageRef })) !== JSON.stringify(a)) fail();
  }
  return parsed.data;
}
const entrySchema = z.object({ deploymentRef: id, version: version.positive(), commandId: z.string().uuid(),
  commandHash: z.string().regex(/^[a-f0-9]{64}$/), actorRef: id, action: z.enum(["put", "revoke"]),
  createdAt: z.string().datetime(), review: analysisOperationsReviewSchema }).strict().refine((entry) =>
  entry.review.deploymentRef === entry.deploymentRef && entry.review.revision === entry.version &&
  Date.parse(entry.review.recordedAt) <= Date.parse(entry.createdAt) &&
  (entry.action === "put" ? entry.review.state !== "revoked" && entry.review.reviewerRef === entry.actorRef : entry.review.state === "revoked"));
export type AnalysisOperationsEntry = z.infer<typeof entrySchema>;
export const analysisOperationsObservationSchema = z.object({
  kind: z.literal("operations-db-observation"), authorizesAnalysis: z.literal(false),
  observedAt: z.string().datetime(), halted: z.boolean(), entry: entrySchema.nullable(),
}).strict();
export type AnalysisOperationsObservation = z.infer<typeof analysisOperationsObservationSchema>;
type QueryClient = Pick<PoolClient, "query">;
type Options = { pool: Pick<Pool, "connect">; writerRoles?: readonly string[]; timeoutMs?: number };

export class AnalysisOperationsStoreError extends Error {
  override name = "AnalysisOperationsStoreError";
  constructor(readonly code: "OPERATIONS_UNAVAILABLE" | "OPERATIONS_FORBIDDEN" | "OPERATIONS_CONFLICT" | "OPERATIONS_INVALID") { super(code); }
}
function fail(code: AnalysisOperationsStoreError["code"] = "OPERATIONS_UNAVAILABLE"): never { throw new AnalysisOperationsStoreError(code); }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function operationsActorRef(role: string) { return `db-role:${digest(role)}`; }
function parseEntry(row: Record<string, unknown>): AnalysisOperationsEntry {
  const parsed = entrySchema.safeParse({ deploymentRef: row.deployment_ref, version: row.version, commandId: row.command_id,
    commandHash: row.command_hash, actorRef: row.actor_ref, action: row.action,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at, review: row.payload });
  if (!parsed.success) fail();
  return parsed.data;
}
function validatePut(review: AnalysisOperationsReview, at: Date) {
  if (review.state === "revoked") fail("OPERATIONS_INVALID");
  const recorded = Date.parse(review.recordedAt); const expiry = Date.parse(review.expiresAt);
  const observations = analysisOperationsCheckNames.flatMap((name) => {
    const c = review.checks[name]; return c.status === "confirmed" ? [Date.parse(c.observedAt)] : [];
  });
  if (recorded > at.valueOf() || expiry <= at.valueOf() || expiry <= recorded ||
      observations.some((time) => time > recorded) || expiry - Math.min(recorded, ...observations) > ANALYSIS_OPERATIONS_REVIEW_MAX_MS) fail("OPERATIONS_INVALID");
  if (review.state === "approved") {
    try { checkAnalysisOperationsReview(review, at); } catch { fail("OPERATIONS_INVALID"); }
  }
}

/**
 * Internal administrative store. No default write authority, HTTP/env loader,
 * cloud calls, readiness issuance or migration execution. Explicit activation
 * is separate from review writes and is scoped to one immutable synthetic grant.
 * writerRoles is trusted composition, NOT caller input. PostgreSQL authenticates
 * session_user; require current_user to match so SET ROLE cannot impersonate it.
 * A shared DB login identifies a DB principal, not an independently proven human.
 */
export class PostgresAnalysisOperationsStore {
  readonly #pool: Options["pool"];
  readonly #roles: ReadonlySet<string>;
  readonly #timeout: number;
  #busy = false;
  constructor(options: Options) {
    this.#pool = options.pool;
    const roles = options.writerRoles ?? [];
    if (roles.length > 8 || roles.some((role) => !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role))) fail("OPERATIONS_INVALID");
    this.#roles = new Set(roles); this.#timeout = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 5000) fail("OPERATIONS_INVALID");
  }
  async #transaction<T>(parent: AbortSignal, readOnly: boolean,
    work: (client: QueryClient, guard: () => void) => Promise<T>): Promise<T> {
    if (parent.aborted || this.#busy) fail();
    this.#busy = true;
    const controller = new AbortController(); const signal = AbortSignal.any([parent, controller.signal]);
    const guard = () => { if (signal.aborted) fail(); };
    let abort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new AnalysisOperationsStoreError("OPERATIONS_UNAVAILABLE"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    const operation = (async () => {
      let client: PoolClient | undefined; let begun = false; let destroy = false;
      try {
        client = await this.#pool.connect(); guard();
        await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN ISOLATION LEVEL READ COMMITTED"); begun = true; guard();
        await client.query("SET LOCAL statement_timeout = '2000ms'; SET LOCAL lock_timeout = '1000ms'; SET LOCAL idle_in_transaction_session_timeout = '5000ms'"); guard();
        const result = await work(client, guard); guard();
        await client.query("COMMIT"); begun = false; guard();
        return result;
      } catch (error) {
        if (client && begun) await client.query("ROLLBACK").catch(() => { destroy = true; });
        if (error instanceof AnalysisOperationsStoreError) throw error;
        destroy = true;
        fail(); // Never surface driver messages, SQL, role names or record contents.
      } finally { client?.release(destroy); this.#busy = false; }
    })();
    try { return await Promise.race([operation, stopped]); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); }
  }
  async #latest(client: QueryClient, deploymentRef: string) {
    const { rows } = await client.query("SELECT * FROM public.analysis_operations_reviews WHERE deployment_ref = $1 ORDER BY version DESC LIMIT 1", [deploymentRef]);
    return rows.length ? parseEntry(rows[0]) : null;
  }
  /** Administrative read only; even an approved record is not an execution permit. */
  async readLatest(deploymentRef: string, signal: AbortSignal): Promise<AnalysisOperationsEntry | null> {
    if (!id.safeParse(deploymentRef).success) fail("OPERATIONS_INVALID");
    return this.#transaction(signal, true, async (client) => this.#latest(client, deploymentRef));
  }
  /** One consistent, read-only DB snapshot. Does not clear a halt or issue permission. */
  async observe(deploymentRef: string, signal: AbortSignal): Promise<AnalysisOperationsObservation> {
    if (!id.safeParse(deploymentRef).success) fail("OPERATIONS_INVALID");
    return this.#transaction(signal, true, async (client, guard) => {
      const state = (await client.query(`SELECT payload, floor(extract(epoch FROM clock_timestamp()) * 1000)::double precision AS at_ms
        FROM public.analysis_accounting_controls WHERE id = 'global'`)).rows; guard();
      if (state.length !== 1 || !Number.isSafeInteger(state[0].at_ms) || Math.abs(state[0].at_ms) > 8_640_000_000_000_000) fail();
      const { halted } = parseAccountingControl(state[0].payload);
      const entry = await this.#latest(client, deploymentRef); guard();
      return { kind: "operations-db-observation", authorizesAnalysis: false,
        observedAt: new Date(state[0].at_ms).toISOString(), halted, entry };
    });
  }
  async execute(raw: unknown, signal: AbortSignal) {
    if (!this.#roles.size) fail("OPERATIONS_FORBIDDEN");
    const parsed = analysisOperationsCommandSchema.safeParse(raw); if (!parsed.success) fail("OPERATIONS_INVALID");
    const command = parsed.data;
    if (command.type === "put" && (command.review.state === "revoked" || command.review.revision !== command.expectedVersion + 1)) fail("OPERATIONS_INVALID");
    const commandHash = digest(JSON.stringify(command));
    const deploymentRef = command.type === "put" ? command.review.deploymentRef : command.deploymentRef;
    return this.#transaction(signal, false, async (client, guard) => {
      const principal = (await client.query("SELECT session_user AS session_role, current_user AS active_role")).rows[0]; guard();
      if (!principal || principal.session_role !== principal.active_role || !this.#roles.has(principal.session_role)) fail("OPERATIONS_FORBIDDEN");
      const actorRef = operationsActorRef(principal.session_role);
      if (command.type === "put" && command.review.reviewerRef !== actorRef) fail("OPERATIONS_FORBIDDEN");
      // SAME first lock as admission, count launch and generation launch. Once a
      // review mutation commits, every process observes a halt before a new send.
      const controls = (await client.query("SELECT payload FROM public.analysis_accounting_controls WHERE id = 'global' FOR UPDATE")).rows; guard();
      if (controls.length !== 1) fail();
      parseAccountingControl(controls[0].payload);
      const old = (await client.query("SELECT * FROM public.analysis_operations_reviews WHERE command_id = $1", [command.commandId])).rows; guard();
      if (old.length) {
        const entry = parseEntry(old[0]);
        if (entry.commandHash !== commandHash || entry.actorRef !== actorRef || entry.deploymentRef !== deploymentRef) fail("OPERATIONS_CONFLICT");
        return { entry, replayed: true as const, authorizesAnalysis: false as const };
      }
      const previous = await this.#latest(client, deploymentRef); guard();
      if ((previous?.version ?? 0) !== command.expectedVersion) fail("OPERATIONS_CONFLICT");
      if (command.type === "revoke" && (!previous || previous.review.id !== command.reviewId || previous.review.state === "revoked")) fail("OPERATIONS_CONFLICT");
      const now = (await client.query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::double precision AS at_ms")).rows[0]?.at_ms; guard();
      if (!Number.isSafeInteger(now)) fail();
      const at = new Date(now);
      const review: AnalysisOperationsReview = command.type === "put" ? command.review :
        { ...previous!.review, state: "revoked", revision: command.expectedVersion + 1 };
      if (command.type === "put") validatePut(review, at);
      const inserted = (await client.query(`INSERT INTO public.analysis_operations_reviews
        (deployment_ref, version, command_id, command_hash, actor_ref, action, payload, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
      [deploymentRef, command.expectedVersion + 1, command.commandId, commandHash, actorRef, command.type, JSON.stringify(review), at])).rows;
      guard(); if (inserted.length !== 1) fail();
      const entry = parseEntry(inserted[0]);
      const halted = (await client.query("UPDATE public.analysis_accounting_controls SET payload = '{\"halted\":true}'::jsonb WHERE id = 'global' RETURNING payload")).rows; guard();
      // A write filtered by DB policy/trigger can succeed without updating a row.
      if (halted.length !== 1 || !parseAccountingControl(halted[0].payload).halted) fail();
      return { entry, replayed: false as const, authorizesAnalysis: false as const };
    });
  }

  async activationStatus(signal: AbortSignal) {
    return this.#transaction(signal, true, async (client) => {
      const rows = (await client.query("SELECT * FROM public.analysis_activation_events ORDER BY version DESC LIMIT 1")).rows;
      return rows.length ? activationEvent(rows[0]) : null;
    });
  }

  /** Read one consistent snapshot; an environment selector cannot supply or renew a grant. */
  async resolveRuntimeActivation(activationId: string,
    binding: Pick<AnalysisActivation, "deploymentRef" | "projectRef" | "credentialRef" | "storageRef">, signal: AbortSignal) {
    if (!z.string().uuid().safeParse(activationId).success || Object.values(binding).some(value => !id.safeParse(value).success)) fail("OPERATIONS_INVALID");
    return this.#transaction(signal, true, async (client, guard) => {
      const rows = (await client.query(`SELECT payload, floor(extract(epoch FROM clock_timestamp())*1000)::double precision AS at_ms
        FROM public.analysis_accounting_controls WHERE id='global'`)).rows; guard();
      if (rows.length !== 1 || !Number.isSafeInteger(rows[0].at_ms)) fail();
      const control = parseAccountingControl(rows[0].payload), at = new Date(rows[0].at_ms);
      if (control.halted || !control.activation || control.activation.id !== activationId ||
          Date.parse(control.activation.expiresAt) <= at.valueOf()) fail();
      const events = (await client.query("SELECT * FROM public.analysis_activation_events ORDER BY version DESC LIMIT 1")).rows; guard();
      if (events.length !== 1) fail();
      const event = activationEvent(events[0]);
      if (event.command.type !== "activate" || event.commandId !== activationId || !event.activation ||
          Date.parse(event.createdAt) > at.valueOf() || JSON.stringify(event.activation) !== JSON.stringify(control.activation) ||
          Object.entries(binding).some(([key, value]) => event.activation![key as keyof AnalysisActivation] !== value)) fail();
      const entry = await this.#latest(client, binding.deploymentRef); guard();
      if (!entry || entry.version !== event.command.expectedReviewVersion || entry.review.id !== event.command.reviewId) fail();
      const { review } = checkAnalysisOperationsReview(entry.review, at);
      const grant = event.command.grant;
      if (Object.entries(binding).some(([key, value]) => review[key as keyof AnalysisOperationsReview] !== value) ||
          grant.deploymentRef !== binding.deploymentRef || grant.input.frameCount !== 2 ||
          Date.parse(grant.createdAt) > at.valueOf() || Date.parse(grant.expiresAt) > Date.parse(review.expiresAt) ||
          Date.parse(grant.expiresAt) - Date.parse(grant.createdAt) > ANALYSIS_OPERATIONS_REVIEW_MAX_MS ||
          grant.inputTokenLimit > review.policy.maxInputTokensPerRequest) fail();
      return { activation: event.activation, grant, observedAt: at.toISOString() };
    });
  }

  /** No automatic resume: an operator must name the exact current review and new grant. */
  async executeActivation(raw: unknown, signal: AbortSignal) {
    if (!this.#roles.size) fail("OPERATIONS_FORBIDDEN");
    const parsed = analysisActivationCommandSchema.safeParse(raw); if (!parsed.success) fail("OPERATIONS_INVALID");
    const command = parsed.data, commandHash = digest(JSON.stringify(command));
    return this.#transaction(signal, false, async (client, guard) => {
      const principal = (await client.query("SELECT session_user AS session_role, current_user AS active_role")).rows[0]; guard();
      if (!principal || principal.session_role !== principal.active_role || !this.#roles.has(principal.session_role)) fail("OPERATIONS_FORBIDDEN");
      const actorRef = operationsActorRef(principal.session_role);
      const controls = (await client.query("SELECT payload FROM public.analysis_accounting_controls WHERE id='global' FOR UPDATE")).rows; guard();
      if (controls.length !== 1) fail();
      const control = parseAccountingControl(controls[0].payload);
      const old = (await client.query("SELECT * FROM public.analysis_activation_events WHERE command_id=$1", [command.commandId])).rows; guard();
      if (old.length) {
        const entry = activationEvent(old[0]);
        if (entry.commandHash !== commandHash || entry.actorRef !== actorRef) fail("OPERATIONS_CONFLICT");
        return { entry, replayed: true as const, authorizesAnalysis: false as const };
      }
      const previous = (await client.query("SELECT * FROM public.analysis_activation_events ORDER BY version DESC LIMIT 1")).rows; guard();
      if ((previous.length ? activationEvent(previous[0]).version : 0) !== command.expectedVersion) fail("OPERATIONS_CONFLICT");
      const atMs = (await client.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::double precision AS at_ms")).rows[0]?.at_ms; guard();
      if (!Number.isSafeInteger(atMs)) fail();
      const at = new Date(atMs);
      let activation: z.infer<typeof analysisActivationSchema> | null = null;
      if (command.type === "activate") {
        // Never replace a live permit or clear an unresolved send/accounting incident.
        if (!control.halted) fail("OPERATIONS_CONFLICT");
        const entry = await this.#latest(client, command.deploymentRef); guard();
        if (!entry || entry.version !== command.expectedReviewVersion || entry.review.id !== command.reviewId) fail("OPERATIONS_CONFLICT");
        let review: AnalysisOperationsReview;
        try { review = checkAnalysisOperationsReview(entry.review, at).review; } catch { fail("OPERATIONS_INVALID"); }
        const grant = command.grant;
        if (grant.deploymentRef !== command.deploymentRef || grant.input.frameCount !== 2 ||
            Date.parse(grant.createdAt) > atMs || Date.parse(grant.expiresAt) <= atMs ||
            Date.parse(grant.expiresAt) - Date.parse(grant.createdAt) > ANALYSIS_OPERATIONS_REVIEW_MAX_MS ||
            Date.parse(grant.expiresAt) > Date.parse(review.expiresAt) || grant.inputTokenLimit > review.policy.maxInputTokensPerRequest) fail("OPERATIONS_INVALID");
        const busy = (await client.query(`SELECT EXISTS(SELECT 1 FROM public.analysis_runs WHERE status IN ('queued','running'))
          OR EXISTS(SELECT 1 FROM public.analysis_count_attempts WHERE status NOT IN ('settled','released'))
          OR EXISTS(SELECT 1 FROM public.analysis_request_attempts WHERE status NOT IN ('settled','released')) AS busy`)).rows[0]?.busy; guard();
        if (busy !== false) fail("OPERATIONS_CONFLICT");
        activation = activationForGrant(command.commandId, grant, { deploymentRef: review.deploymentRef,
          projectRef: review.projectRef, credentialRef: review.credentialRef, storageRef: review.storageRef });
      } else if (control.activation && control.activation.deploymentRef !== command.deploymentRef) fail("OPERATIONS_CONFLICT");
      const inserted = (await client.query(`INSERT INTO public.analysis_activation_events
        (version,command_id,command_hash,actor_ref,action,deployment_ref,payload,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`, [command.expectedVersion + 1, command.commandId, commandHash,
        actorRef, command.type, command.deploymentRef, JSON.stringify({ command, activation }), at])).rows; guard();
      if (inserted.length !== 1) fail();
      const entry = activationEvent(inserted[0]);
      const next = activation ? { halted: false, activation } : { halted: true };
      const updated = (await client.query("UPDATE public.analysis_accounting_controls SET payload=$1::jsonb WHERE id='global' RETURNING payload", [JSON.stringify(next)])).rows; guard();
      if (updated.length !== 1 || JSON.stringify(parseAccountingControl(updated[0].payload)) !== JSON.stringify(parseAccountingControl(next))) fail();
      // A receipt is audit only. Fresh readiness, consent, budget and send checks still apply.
      return { entry, replayed: false as const, authorizesAnalysis: false as const };
    });
  }
}
