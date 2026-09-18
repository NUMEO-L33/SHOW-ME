import { isDeepStrictEqual } from "node:util";
import { sql, type SQL } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getTableConfig } from "drizzle-orm/pg-core";
import { z } from "zod";

import { parseAccountingControl } from "./analysis-accounting-contract.js";
import type { ProcessorDatabase } from "./repository.js";
import { guides, guideSteps, guideDrafts, analysisRuns, analysisBudgetWindows, analysisReservations,
  analysisBatchesTable, analysisAccountingControls, analysisRequestAttempts, analysisProviderQuotaCharges,
  analysisCountAttempts } from "./db/schema.js";

const tables = [guides, guideSteps, guideDrafts, analysisRuns, analysisBudgetWindows, analysisReservations,
  analysisBatchesTable, analysisAccountingControls, analysisRequestAttempts, analysisProviderQuotaCharges, analysisCountAttempts].map(getTableConfig);
const tableNames = tables.map((table) => table.name);
const migrationSchema = z.array(z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().regex(/^\d{13}$/) }).strict()).min(11).max(100);
const relationSchema = z.array(z.object({ name: z.string(), usable: z.literal(true) }).strict()).length(tableNames.length);
const columnSchema = z.array(z.object({ table: z.string(), name: z.string(), type: z.string(), notNull: z.boolean() }).strict()).max(200);
const keySchema = z.array(z.object({ table: z.string(), columns: z.array(z.string()).min(1), primary: z.boolean() }).strict()).max(100);
const checkSchema = z.array(z.object({ table: z.string(), name: z.string(), validated: z.literal(true), definition: z.string().max(20_000) }).strict()).max(100);
const sort = <T>(values: T[]) => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function unavailable(): never { throw new AnalysisDatabaseProbeError(); }

export class AnalysisDatabaseProbeError extends Error {
  override name = "AnalysisDatabaseProbeError";
  constructor() { super("ANALYSIS_DATABASE_UNAVAILABLE"); }
}
export type AnalysisDatabaseObservation = {
  kind: "analysis-database-observation"; scope: "database-only"; authorizesAnalysis: false; observedAt: string;
  migrationHistory: "matches-local-files"; columnsAndUniqueKeys: "matched";
  checkConstraints: "present-and-validated"; countLaunchStatus: "supported";
  tablePrivileges: "select-insert-update-delete"; accountingControl: "open";
};

/**
 * Explicit read-only inspection of the SAME database object used by the repository.
 * Does not create a connection, run migrations, read guide data, reset a halt or
 * issue readiness. A point-in-time observation is NOT a revocable execution permit.
 * The caller must supply the deployment's trusted migration directory, never HTTP input.
 */
export class PostgresAnalysisDatabaseProbe {
  readonly #database: ProcessorDatabase;
  readonly #migrationsFolder: string;
  readonly #clock: () => Date;
  readonly #timeoutMs: number;
  #busy = false;
  constructor(options: { database: ProcessorDatabase; migrationsFolder: string; clock?: () => Date; timeoutMs?: number }) {
    this.#database = options.database; this.#migrationsFolder = options.migrationsFolder;
    this.#clock = options.clock ?? (() => new Date()); this.#timeoutMs = options.timeoutMs ?? 4000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 4000) unavailable();
  }
  async inspect(parent: AbortSignal): Promise<AnalysisDatabaseObservation> {
    if (parent.aborted || this.#busy) unavailable();
    const controller = new AbortController(); const signal = AbortSignal.any([parent, controller.signal]);
    const deadline = performance.now() + this.#timeoutMs;
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let abort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new AnalysisDatabaseProbeError());
      signal.addEventListener("abort", abort, { once: true });
    });
    let lastTime = -Infinity;
    const guard = () => {
      const now = this.#clock().valueOf();
      if (signal.aborted || performance.now() >= deadline || !Number.isFinite(now) || now < lastTime) unavailable();
      lastTime = now;
    };
    this.#busy = true;
    let operationDone = false; let inspectDone = false;
    const release = () => { if (operationDone && inspectDone) this.#busy = false; };
    const operation = Promise.resolve().then(async () => {
      guard();
      // Hash the exact checked-in SQL as Drizzle does, but never apply it.
      const expectedMigrations = migrationSchema.parse(readMigrationFiles({ migrationsFolder: this.#migrationsFolder })
        .map((m) => ({ hash: m.hash, createdAt: String(m.folderMillis) })));
      if (new Set(expectedMigrations.map((m) => m.createdAt)).size !== expectedMigrations.length) unavailable();
      return this.#database.transaction(async (tx) => {
        const query = async (command: SQL) => { guard(); const result = await tx.execute(command); guard(); return result.rows; };
        await query(sql`SET LOCAL statement_timeout = '2s'`);
        await query(sql`SET LOCAL lock_timeout = '1s'`);
        // Raw Drizzle timestamps are strings. A numeric epoch is independent of driver/DateStyle parsing.
        const state = z.array(z.object({ readOnly: z.literal("on"), defaultReadOnly: z.literal("off"), inRecovery: z.literal(false),
          atMs: z.number().int().min(0).max(8_640_000_000_000_000) }).strict()).length(1)
          .parse(await query(sql`/* analysis-db:state */ SELECT current_setting('transaction_read_only') AS "readOnly",
            current_setting('default_transaction_read_only') AS "defaultReadOnly", pg_is_in_recovery() AS "inRecovery",
            floor(extract(epoch FROM clock_timestamp()) * 1000)::double precision AS "atMs"`))[0];
        if (Math.abs(state.atMs - lastTime) > 5000) unavailable();
        const history = migrationSchema.parse(await query(sql`/* analysis-db:migrations */
          SELECT hash, created_at::text AS "createdAt" FROM drizzle.__drizzle_migrations ORDER BY created_at, id LIMIT 101`));
        if (!isDeepStrictEqual(history, expectedMigrations)) unavailable();

        const relations = relationSchema.parse(await query(sql`/* analysis-db:relations */
          SELECT c.relname AS name, (c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity
            AND c.oid=to_regclass(quote_ident(c.relname)) AND has_schema_privilege(n.oid,'USAGE')
            AND has_table_privilege(c.oid,'SELECT') AND has_table_privilege(c.oid,'INSERT')
            AND has_table_privilege(c.oid,'UPDATE') AND has_table_privilege(c.oid,'DELETE')) AS usable
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname=ANY(${sql.param(tableNames)}::text[]) LIMIT 12`));
        if (!isDeepStrictEqual(sort(relations.map((r) => r.name)), sort(tableNames))) unavailable();
        const columns = columnSchema.parse(await query(sql`/* analysis-db:columns */
          SELECT c.relname AS "table", a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS "notNull"
          FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname=ANY(${sql.param(tableNames)}::text[]) AND a.attnum>0 AND NOT a.attisdropped LIMIT 201`));
        const expectedColumns = tables.flatMap((t) => t.columns.map((c) => ({ table: t.name, name: c.name, type: c.getSQLType(), notNull: c.notNull })));
        if (!isDeepStrictEqual(sort(columns), sort(expectedColumns))) unavailable();

        const keys = keySchema.parse(await query(sql`/* analysis-db:keys */
          SELECT c.relname AS "table", i.indisprimary AS "primary", ARRAY(SELECT a.attname::text FROM
            unnest(i.indkey) WITH ORDINALITY k(num,pos) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num
            WHERE k.pos<=i.indnkeyatts ORDER BY k.pos) AS columns
          FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname=ANY(${sql.param(tableNames)}::text[]) AND i.indisunique AND i.indisvalid AND i.indisready
            AND i.indimmediate AND i.indpred IS NULL AND i.indexprs IS NULL LIMIT 101`));
        const expectedKeys = tables.flatMap((t) => [
          ...t.columns.filter((c) => c.primary).map((c) => ({ table: t.name, columns: [c.name], primary: true })),
          ...t.primaryKeys.map((k) => ({ table: t.name, columns: k.columns.map((c) => c.name), primary: true })),
          ...t.indexes.filter((i) => i.config.unique && !i.config.where).map((i) => ({ table: t.name,
            columns: i.config.columns.map((c) => { if (!("name" in c) || !c.name) unavailable(); return c.name; }), primary: false })),
        ]);
        if (!isDeepStrictEqual(sort(keys), sort(expectedKeys))) unavailable();
        const checks = checkSchema.parse(await query(sql`/* analysis-db:checks */
          SELECT c.relname AS "table", k.conname AS name, k.convalidated AS validated, pg_get_constraintdef(k.oid) AS definition
          FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname=ANY(${sql.param(tableNames)}::text[]) AND k.contype='c' LIMIT 101`));
        if (!isDeepStrictEqual(sort(checks.map(({ table, name }) => ({ table, name }))),
          sort(tables.flatMap((t) => t.checks.map((c) => ({ table: t.name, name: c.name })))))) unavailable();
        // Explicitly reject 0009's pre-launch check, or a weakened/expanded status check.
        const launch = checks.find((c) => c.table === "analysis_count_attempts" && c.name === "analysis_count_status_check")?.definition;
        const statuses = ["reserved", "sending", "launch_claimed", "settled", "uncertain", "overrun", "released"];
        const expectedLaunch = `CHECK ((status = ANY (ARRAY[${statuses.map((s) => `'${s}'::text`).join(", ")}])))`;
        if (launch?.replace(/\s+/g, "") !== expectedLaunch.replace(/\s+/g, "")) unavailable();
        const controls = await query(sql`/* analysis-db:control */ SELECT payload FROM public.analysis_accounting_controls WHERE id='global' LIMIT 2`);
        if (controls.length !== 1 || parseAccountingControl(controls[0].payload).halted) unavailable();
        guard();
        return { kind: "analysis-database-observation", scope: "database-only", authorizesAnalysis: false, observedAt: new Date(state.atMs).toISOString(),
          migrationHistory: "matches-local-files", columnsAndUniqueKeys: "matched", checkConstraints: "present-and-validated",
          countLaunchStatus: "supported", tablePrivileges: "select-insert-update-delete", accountingControl: "open" } as const;
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    }).finally(() => { operationDone = true; release(); });
    try { const report = await Promise.race([operation, stopped]); guard(); return report; }
    catch { unavailable(); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); inspectDone = true; release(); }
  }
}
