import { randomBytes } from "node:crypto";
import { Pool, type PoolConfig } from "pg";
import { PostgresGuideRepository } from "./repository.js";
import { verifyDatabaseMigrations } from "./database-migrations.js";

const histories = new Set(["analysis_operations_reviews", "analysis_activation_events"]);
const statuses = new Set(["analysis_runs", "analysis_count_attempts", "analysis_request_attempts"]);

/** Metadata only: no guide, draft, media or analysis payload is read. */
export async function verifyOperatorRole(pool: Pool, expectedRole: string) {
  const identity = (await pool.query(`SELECT current_user AS role, session_user=current_user AS direct,
    rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS memberships,
    has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if (!identity || identity.role !== expectedRole || !identity.direct ||
    [identity.rolsuper, identity.rolcreatedb, identity.rolcreaterole, identity.rolinherit,
      identity.rolreplication, identity.rolbypassrls, identity.memberships, identity.schema_create].some(Boolean)) throw new Error("SHOWME_OPERATOR_ROLE_INVALID");
  const tables = (await pool.query(`SELECT c.oid, c.relname AS name,
    has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,TRIGGER') AS destructive
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p','v','m','f')`)).rows;
  for (const table of tables) {
    if (table.destructive) throw new Error("SHOWME_OPERATOR_ROLE_INVALID");
    const columns = (await pool.query(`SELECT attname AS name,
      has_column_privilege(current_user,attrelid,attnum,'SELECT') AS read,
      has_column_privilege(current_user,attrelid,attnum,'INSERT') AS insert,
      has_column_privilege(current_user,attrelid,attnum,'UPDATE') AS update,
      has_column_privilege(current_user,attrelid,attnum,'REFERENCES') AS reference
      FROM pg_attribute WHERE attrelid=$1 AND attnum>0 AND NOT attisdropped`, [table.oid])).rows;
    for (const column of columns) {
      const read = histories.has(table.name) || table.name === "analysis_accounting_controls" || (statuses.has(table.name) && column.name === "status");
      const insert = histories.has(table.name);
      const update = table.name === "analysis_accounting_controls" && column.name === "payload";
      if (column.read !== read || column.insert !== insert || column.update !== update || column.reference) throw new Error("SHOWME_OPERATOR_ROLE_INVALID");
    }
  }
  for (const required of [...histories, ...statuses, "analysis_accounting_controls", "guides", "guide_steps", "guide_drafts"]) {
    if (!tables.some(table => table.name === required)) throw new Error("SHOWME_OPERATOR_ROLE_INVALID");
  }
}

/** Explicit operator-only setup; never called by application startup. */
export async function createOperatorRole(options: { admin: Pool; target: PoolConfig; persist: (credentials: { role: string; password: string }) => Promise<void> }) {
  const { admin, target } = options;
  const role = `showme_analysis_operator_dev_${randomBytes(8).toString("hex")}`;
  const password = randomBytes(32).toString("hex");
  const connection = await admin.connect();
  let committed = false;
  let operator: Pool | undefined;
  try {
    const actual = (await connection.query("SELECT current_database() AS database, session_user=current_user AS direct")).rows[0];
    if (actual.database !== target.database || actual.direct !== true) throw new Error();
    await verifyDatabaseMigrations(PostgresGuideRepository.fromPool(admin).database);
    await connection.query("BEGIN");
    await connection.query("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='2000ms'");
    await connection.query("SELECT pg_advisory_xact_lock(1936224111, 1)");
    if ((await connection.query("SELECT 1 FROM pg_roles WHERE rolname ~ '^showme_analysis_operator_' LIMIT 1")).rowCount) throw new Error();
    // Restricted-alphabet random values only; no caller-provided identifier or secret enters DDL.
    await connection.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await connection.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await connection.query(`GRANT SELECT, INSERT ON analysis_operations_reviews, analysis_activation_events TO "${role}"`);
    await connection.query(`GRANT SELECT, UPDATE(payload) ON analysis_accounting_controls TO "${role}"`);
    await connection.query(`GRANT SELECT(status) ON analysis_runs, analysis_count_attempts, analysis_request_attempts TO "${role}"`);
    await connection.query("COMMIT"); committed = true;
    operator = new Pool({ ...target, user: role, password, max: 1 });
    await verifyOperatorRole(operator, role);
    const wrong = new Pool({ ...target, user: role, password: randomBytes(32).toString("hex"), max: 1 });
    try {
      let denied = false;
      try { await wrong.query("SELECT 1"); } catch (error) { denied = (error as { code?: string }).code === "28P01"; }
      if (!denied) throw new Error();
    } finally { await wrong.end(); }
    await options.persist({ role, password });
    return { created: true as const, role, authenticationChecked: true as const, permissionsChecked: true as const, aiEnabled: false as const };
  } catch {
    await connection.query("ROLLBACK").catch(() => undefined);
    await operator?.end(); operator = undefined;
    if (committed) {
      await connection.query(`DROP OWNED BY "${role}"`);
      await connection.query(`DROP ROLE "${role}"`);
    }
    throw new Error("SHOWME_OPERATOR_ROLE_SETUP_FAILED");
  } finally { await operator?.end(); connection.release(); }
}
