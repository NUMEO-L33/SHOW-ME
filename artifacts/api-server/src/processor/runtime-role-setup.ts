import { randomBytes } from "node:crypto";
import { Pool, type PoolConfig } from "pg";
import { verifyAnalysisRuntimeRole } from "./analysis-bootstrap.js";
import { PostgresGuideRepository } from "./repository.js";
import { verifyDatabaseMigrations } from "./database-migrations.js";

/** Operator-only deployment step, never imported by HTTP/product startup. No existing login is altered. */
export async function createRuntimeRole(options: { admin: Pool; target: PoolConfig; persist: (connection: { role: string; password: string }) => Promise<void> }) {
  const { admin, target } = options;
  const role = `showme_runtime_dev_${randomBytes(8).toString("hex")}`;
  const password = randomBytes(32).toString("hex");
  let committed = false;
  const connection = await admin.connect();
  let runtime: Pool | undefined;
  try {
    const actual = (await connection.query("SELECT current_database() AS database, session_user=current_user AS direct")).rows[0];
    if (actual.database !== target.database || actual.direct !== true) throw new Error();
    await verifyDatabaseMigrations(PostgresGuideRepository.fromPool(admin).database);
    await connection.query("BEGIN");
    await connection.query("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='2000ms'");
    // Only cryptographically generated restricted-alphabet identifiers/secrets enter this DDL.
    await connection.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await connection.query(`GRANT USAGE ON SCHEMA public, drizzle TO "${role}"`);
    await connection.query(`GRANT SELECT ON drizzle.__drizzle_migrations, analysis_operations_reviews, analysis_activation_events TO "${role}"`);
    await connection.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON guides, guide_steps, guide_drafts, guide_assets, analysis_runs,
      analysis_budget_windows, analysis_reservations, analysis_batches, analysis_accounting_controls,
      analysis_request_attempts, analysis_provider_quota_charges, analysis_count_attempts TO "${role}"`);
    await connection.query("COMMIT"); committed = true;
    runtime = new Pool({ ...target, user: role, password, max: 2 });
    await verifyAnalysisRuntimeRole(runtime, AbortSignal.timeout(5000));
    await verifyDatabaseMigrations(PostgresGuideRepository.fromPool(runtime).database);
    const wrong = new Pool({ ...target, user: role, password: randomBytes(32).toString("hex"), max: 1 });
    try {
      let denied = false;
      try { await wrong.query("SELECT 1"); } catch (error) { denied = (error as { code?: string }).code === "28P01"; }
      if (!denied) throw new Error();
    } finally { await wrong.end(); }
    await options.persist({ role, password });
    return { created: true as const, role, authenticationChecked: true as const, aiEnabled: false as const };
  } catch {
    await connection.query("ROLLBACK").catch(() => undefined);
    await runtime?.end(); runtime = undefined;
    if (committed) {
      // The newly generated role has never been handed to an application if persistence failed.
      await connection.query(`DROP OWNED BY "${role}"`);
      await connection.query(`DROP ROLE "${role}"`);
    }
    throw new Error("SHOWME_RUNTIME_ROLE_SETUP_FAILED");
  } finally { await runtime?.end(); connection.release(); }
}
