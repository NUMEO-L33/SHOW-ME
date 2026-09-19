import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import type { ProcessorConfig } from "./config.js";
import type { ProcessorAnalysisFactory } from "./analysis-lifecycle.js";
import { resolveMigrationsFolder, verifyDatabaseMigrations } from "./database-migrations.js";
import { PostgresAnalysisOperationsStore } from "./analysis-operations-store.js";
import { PostgresGuideRepository, analysisPoolForRepository } from "./repository.js";
import { ReplitObjectStorage } from "./storage.js";
import { attachFixedSyntheticAnalysisRuntime, syntheticStorageRef } from "./analysis-synthetic-runtime.js";

export class AnalysisBootstrapError extends Error {
  override name = "AnalysisBootstrapError";
  constructor() { super("ANALYSIS_BOOTSTRAP_UNAVAILABLE"); }
}
function unavailable(): never { throw new AnalysisBootstrapError(); }
const ref = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const settingsSchema = z.object({ mode: z.literal("fixed-synthetic"), activationId: z.string().uuid(),
  deploymentRef: ref, projectRef: ref, credentialRef: ref, apiKey: z.string().regex(/^[\x21-\x7e]{10,4096}$/) }).strict();
export type AnalysisBootstrapSettings = z.infer<typeof settingsSchema>;

/** Only selects an existing operator-authorized DB record. No input/limits/review can come from env. */
export function analysisBootstrapSettings(env: Readonly<Record<string, string | undefined>>, config: ProcessorConfig): AnalysisBootstrapSettings | undefined {
  if (!env.SHOWME_ANALYSIS_MODE || env.SHOWME_ANALYSIS_MODE === "off") return undefined;
  const parsed = settingsSchema.safeParse({ mode: env.SHOWME_ANALYSIS_MODE, activationId: env.SHOWME_ANALYSIS_ACTIVATION_ID,
    deploymentRef: env.SHOWME_ANALYSIS_DEPLOYMENT_REF, projectRef: env.SHOWME_ANALYSIS_PROJECT_REF,
    credentialRef: env.SHOWME_ANALYSIS_CREDENTIAL_REF, apiKey: env.GEMINI_API_KEY });
  if (!parsed.success || env.SHOWME_OPERATOR_DATABASE_URL || env.SHOWME_MIGRATION_DATABASE_URL ||
      !config.databaseUrl || config.databaseMigrationMode !== "verify-only" ||
      config.storageDriver !== "replit" || !config.replitBucketId) unavailable();
  return Object.freeze(parsed.data);
}

/** Read-only authenticated privilege check; never creates roles, grants access or prints a principal/connection. */
export async function verifyAnalysisRuntimeRole(pool: Pick<Pool, "connect">, signal: AbortSignal) {
  let client: PoolClient | undefined;
  let begun = false, destroy = false;
  try {
    signal.throwIfAborted(); client = await pool.connect(); signal.throwIfAborted();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
    await client.query("SET LOCAL statement_timeout='2000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='5000ms'");
    const { rows } = await client.query(`SELECT r.rolname AS role, session_user=current_user AS direct,
      (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS elevated,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships,
      EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=r.oid) AS owns_database,
      EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('public','drizzle') AND nspowner=r.oid) AS owns_schema,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle') AND c.relowner=r.oid) AS owns_objects,
      (has_schema_privilege('public','CREATE') OR has_schema_privilege('drizzle','CREATE')) AS can_create
      FROM pg_roles r WHERE r.rolname=current_user`);
    signal.throwIfAborted();
    const role = rows[0];
    if (rows.length !== 1 || !/^showme_runtime_[a-z0-9_]{1,40}$/.test(role.role) || role.direct !== true ||
        [role.elevated, role.memberships, role.owns_database, role.owns_schema, role.owns_objects, role.can_create].some(v => v !== false)) unavailable();
    const grants = (await client.query(`SELECT name,
      has_table_privilege(name,'SELECT') AS readable,
      (has_table_privilege(name,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
        has_any_column_privilege(name,'INSERT') OR has_any_column_privilege(name,'UPDATE')) AS writable
      FROM unnest(ARRAY['public.analysis_operations_reviews','public.analysis_activation_events','drizzle.__drizzle_migrations']) AS name`)).rows;
    signal.throwIfAborted();
    if (grants.length !== 3 || grants.some(row => row.readable !== true || row.writable !== false)) unavailable();
    await client.query("COMMIT"); begun = false; signal.throwIfAborted();
  } catch {
    destroy = true;
    if (client && begun) await client.query("ROLLBACK").catch(() => undefined);
    unavailable();
  } finally { client?.release(destroy); }
}

/** Actual server bootstrap. Read-only preflight, same API pool/storage, no migration/unhalt/provider call. */
export function configuredAnalysisFactory(raw: AnalysisBootstrapSettings, config: ProcessorConfig,
  testOptions: { fetch?: typeof fetch; migrationsFolder?: string } = {}): ProcessorAnalysisFactory {
  const parsed = settingsSchema.safeParse(raw); if (!parsed.success || config.databaseMigrationMode !== "verify-only") unavailable();
  const settings = parsed.data;
  return async context => {
    try {
      if (!(context.repository instanceof PostgresGuideRepository) || !(context.storage instanceof ReplitObjectStorage)) unavailable();
      const pool = analysisPoolForRepository(context.repository); if (!pool) unavailable();
      const target = context.storage.analysisTarget();
      if (config.storageDriver !== "replit" || !target.bucketId || target.bucketId !== config.replitBucketId || target.prefix !== config.replitObjectPrefix) unavailable();
      const signal = AbortSignal.timeout(10_000);
      await verifyAnalysisRuntimeRole(pool, signal);
      const migrationsFolder = testOptions.migrationsFolder ?? resolveMigrationsFolder();
      await verifyDatabaseMigrations(context.repository.database, migrationsFolder); signal.throwIfAborted();
      const binding = { deploymentRef: settings.deploymentRef, projectRef: settings.projectRef, credentialRef: settings.credentialRef,
        storageRef: syntheticStorageRef(target.bucketId, target.prefix) };
      const resolved = await new PostgresAnalysisOperationsStore({ pool }).resolveRuntimeActivation(settings.activationId, binding, signal);
      signal.throwIfAborted();
      if (Math.abs(Date.now() - Date.parse(resolved.observedAt)) > 5000) unavailable();
      return attachFixedSyntheticAnalysisRuntime(context, { config: { deploymentRef: binding.deploymentRef,
        projectRef: binding.projectRef, credentialRef: binding.credentialRef, bucketId: target.bucketId, prefix: target.prefix },
      grant: resolved.grant, activationId: settings.activationId, apiKey: settings.apiKey,
      allowExternalProcessing: true, ffmpegPath: config.ffmpegPath, migrationsFolder, fetch: testOptions.fetch });
    } catch { return unavailable(); }
  };
}
