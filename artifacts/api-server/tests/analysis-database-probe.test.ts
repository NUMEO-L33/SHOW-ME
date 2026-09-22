import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { AnalysisDatabaseProbeError, PostgresAnalysisDatabaseProbe } from "../src/processor/analysis-database-probe.js";
import type { ProcessorDatabase } from "../src/processor/repository.js";
import * as schema from "../src/processor/db/schema.js";

// Catalog-shape simulation, not evidence from a PostgreSQL engine.
const tables = [schema.guides, schema.guideSteps, schema.guideDrafts, schema.analysisRuns, schema.analysisBudgetWindows,
  schema.analysisReservations, schema.analysisBatchesTable, schema.analysisAccountingControls, schema.analysisRequestAttempts,
  schema.analysisProviderQuotaCharges, schema.analysisCountAttempts].map(getTableConfig);
function simulatedCatalog(kind: string): unknown[] {
  if (kind === "relations") return tables.map((t) => ({ name: t.name, usable: true }));
  if (kind === "columns") return tables.flatMap((t) => t.columns.map((c) => ({ table: t.name, name: c.name, type: c.getSQLType(), notNull: c.notNull })));
  if (kind === "keys") return tables.flatMap((t) => [
    ...t.columns.filter((c) => c.primary).map((c) => ({ table: t.name, columns: [c.name], primary: true })),
    ...t.primaryKeys.map((k) => ({ table: t.name, columns: k.columns.map((c) => c.name), primary: true })),
    ...t.indexes.filter((i) => i.config.unique && !i.config.where).map((i) => ({ table: t.name,
      columns: i.config.columns.map((c) => "name" in c ? c.name : "invalid"), primary: false })),
  ]);
  if (kind === "checks") return tables.flatMap((t) => t.checks.map((c) => ({ table: t.name, name: c.name, validated: true,
    definition: c.name === "analysis_count_status_check" ? "CHECK ((status = ANY (ARRAY['reserved'::text, 'sending'::text, 'launch_claimed'::text, 'settled'::text, 'uncertain'::text, 'overrun'::text, 'released'::text])))" : "CHECK (fixture)" })));
  if (kind === "control") return [{ payload: { halted: false } }];
  return [];
}

const denied = (error: unknown) => {
  assert.ok(error instanceof AnalysisDatabaseProbeError);
  assert.equal(error.message, "ANALYSIS_DATABASE_UNAVAILABLE");
  return true;
};
const signal = () => new AbortController().signal;
const stamp = new Date("2026-09-18T12:00:00Z");
function fixture(timeoutMs?: number) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const configs: unknown[] = [];
  let now = stamp.valueOf(); let active = 0;
  const handler = { execute: async (query: { sql: string }): Promise<{ rows: unknown[] }> => {
    if (query.sql.includes("analysis-db:state")) return { rows: [{ readOnly: "on", defaultReadOnly: "off", inRecovery: false, atMs: now }] };
    if (query.sql.includes("analysis-db:migrations")) return { rows: readMigrationFiles({ migrationsFolder: "drizzle" }).map((m) => ({ hash: m.hash, createdAt: String(m.folderMillis) })) };
    return { rows: simulatedCatalog(/analysis-db:(\w+)/.exec(query.sql)?.[1] ?? "") };
  } };
  const database = { async transaction(operation: (tx: unknown) => unknown, config: unknown) {
    configs.push(config); active += 1;
    try { return await operation({ execute: async (command: SQL) => {
      const query = new PgDialect().sqlToQuery(command); calls.push(query); return handler.execute(query);
    } }); } finally { active -= 1; }
  } } as unknown as ProcessorDatabase;
  return { database, calls, configs, handler, setTime: (value: number) => { now = value; }, active: () => active,
    probe: new PostgresAnalysisDatabaseProbe({ database, migrationsFolder: "drizzle", timeoutMs, clock: () => new Date(now) }) };
}

test("database inspection uses a bounded read-only transaction and does not repair an absent schema", async () => {
  const f = fixture(); const original = f.handler.execute;
  f.handler.execute = async (q) => q.sql.includes("analysis-db:relations") ? { rows: [] } : original(q);
  await assert.rejects(f.probe.inspect(signal()), denied);
  assert.deepEqual(f.configs, [{ isolationLevel: "repeatable read", accessMode: "read only" }]);
  assert.match(f.calls[0].sql, /SET LOCAL statement_timeout = '2s'/);
  assert.match(f.calls[1].sql, /SET LOCAL lock_timeout = '1s'/);
  assert.equal(f.active(), 0);
  assert.equal(f.calls.length, 5);
  for (const call of f.calls) assert.ok(!/\b(CREATE|ALTER|DROP|INSERT INTO|UPDATE .*SET|DELETE FROM|FOR UPDATE)\b/i.test(call.sql));
});

test("a complete simulated catalog returns database-only observations, never runtime/AI authority", async (t) => {
  let fetches = 0; t.mock.method(globalThis, "fetch", async () => { fetches += 1; throw new Error("no network"); });
  const f = fixture(); const report = await f.probe.inspect(signal());
  assert.equal(report.authorizesAnalysis, false); assert.equal(report.scope, "database-only");
  assert.equal(report.observedAt, stamp.toISOString()); assert.equal(fetches, 0);
  assert.equal(f.calls.length, 9);
  assert.equal(JSON.stringify(report).includes("connection"), false);
  assert.equal((await f.probe.inspect(signal())).authorizesAnalysis, false);
});

test("catalog table names bind as one PostgreSQL array, not a row of separate parameters", async () => {
  const f = fixture(); await f.probe.inspect(signal());
  const queries = f.calls.filter((q) => /analysis-db:(relations|columns|keys|checks)/.test(q.sql));
  assert.equal(queries.length, 4);
  for (const query of queries) {
    assert.match(query.sql, /ANY\(\$1::text\[\]\)/);
    assert.deepEqual(query.params, [tables.map((table) => table.name)]);
  }
});

test("database clock uses numeric epoch milliseconds independent of raw driver timestamp parsing", async () => {
  const f = fixture(); const original = f.handler.execute;
  f.handler.execute = async (q) => q.sql.includes("analysis-db:state") ? {
    rows: [{ readOnly: "on", defaultReadOnly: "off", inRecovery: false, atMs: stamp.valueOf() }],
  } : original(q);
  assert.equal((await f.probe.inspect(signal())).observedAt, stamp.toISOString());
  assert.match(f.calls[2].sql, /floor\(extract\(epoch FROM clock_timestamp\(\)\) \* 1000\)::double precision AS "atMs"/);
});

for (const kind of ["relations", "columns", "keys", "checks", "control"]) {
  test(`missing or malformed ${kind} facts cannot produce a database observation`, async () => {
    for (const row of [undefined, { unexpected: "private" }]) {
      const f = fixture(); const original = f.handler.execute;
      f.handler.execute = async (q) => {
        if (!q.sql.includes(`analysis-db:${kind}`)) return original(q);
        return { rows: row === undefined ? [] : [row] };
      };
      await assert.rejects(f.probe.inspect(signal()), denied);
    }
  });
}

test("schema differences, weak/old count status and halted or malformed control are refused", async () => {
  const mutations: Array<[string, (rows: any[]) => void]> = [
    ["relations", (rows) => { rows[0].usable = false; }],
    ["relations", (rows) => { rows[0].name = "other-table"; }],
    ["columns", (rows) => { rows[0].type = "bigint"; }],
    ["columns", (rows) => { rows[0].notNull = false; }],
    ["keys", (rows) => { rows[0].primary = false; }],
    ["keys", (rows) => { rows[0].columns = ["wrong-column"]; }],
    ["checks", (rows) => { rows[0].validated = false; }],
    ["checks", (rows) => { rows.find((r) => r.name === "analysis_count_status_check").definition = "CHECK (true)"; }],
    ["checks", (rows) => { const r = rows.find((r) => r.name === "analysis_count_status_check"); r.definition = r.definition.replace("'launch_claimed'::text, ", ""); }],
    ["control", (rows) => { rows[0].payload = { halted: true }; }],
    ["control", (rows) => { rows[0].payload = { halted: false, unexpected: "private" }; }],
  ];
  for (const [kind, mutate] of mutations) {
    const f = fixture(); const original = f.handler.execute;
    f.handler.execute = async (q) => { const result = await original(q);
      if (q.sql.includes(`analysis-db:${kind}`)) mutate(result.rows);
      return result; };
    await assert.rejects(f.probe.inspect(signal()), denied);
  }
});

test("pre-abort does not acquire a database connection or inspect any rows", async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort(new Error("private-reason"));
  await assert.rejects(f.probe.inspect(controller.signal), denied);
  assert.deepEqual(f.configs, []); assert.deepEqual(f.calls, []);
});

test("database/driver and local migration errors are sanitized", async () => {
  const f = fixture(); f.handler.execute = async () => { throw new Error("postgres://private/password"); };
  await assert.rejects(f.probe.inspect(signal()), denied);
  const missing = new PostgresAnalysisDatabaseProbe({ database: f.database, migrationsFolder: "__absent_migration_fixture__" });
  await assert.rejects(missing.inspect(signal()), denied);
  assert.equal(f.configs.length, 1);
});

test("wrong transaction mode, default read-only, recovery, clock skew and malformed rows fail closed", async () => {
  for (const extra of [{ readOnly: "off" }, { defaultReadOnly: "on" }, { inRecovery: true },
    { atMs: stamp.valueOf() - 5001 }, { atMs: "not-a-date" }, { atMs: null }, { atMs: NaN },
    { atMs: Infinity }, { atMs: 8_640_000_000_000_001 }, { atMs: 1.5 }, { private: "unexpected" }]) {
    const f = fixture(); const original = f.handler.execute;
    f.handler.execute = async (q) => q.sql.includes("analysis-db:state") ? {
      rows: [{ readOnly: "on", defaultReadOnly: "off", inRecovery: false, atMs: stamp.valueOf(), ...extra }],
    } : original(q);
    await assert.rejects(f.probe.inspect(signal()), denied);
    assert.equal(f.calls.length, 3);
  }
});

test("migration history must match every trusted local hash and timestamp, not just the last version", async () => {
  const mutations = [
    (rows: Array<{ hash: string; createdAt: string }>) => { rows[0].hash = "a".repeat(64); },
    (rows: Array<{ hash: string; createdAt: string }>) => { rows[0].createdAt = rows[1].createdAt; },
    (rows: Array<{ hash: string; createdAt: string }>) => { rows.pop(); },
    (rows: Array<{ hash: string; createdAt: string }>) => { rows.push(rows[0]); },
    (rows: Array<{ hash: string; createdAt: string }>) => { rows.reverse(); },
  ];
  for (const mutate of mutations) {
    const f = fixture(); const original = f.handler.execute;
    f.handler.execute = async (q) => { const result = await original(q);
      if (q.sql.includes("analysis-db:migrations")) mutate(result.rows as Array<{ hash: string; createdAt: string }>);
      return result; };
    await assert.rejects(f.probe.inspect(signal()), denied);
    assert.equal(f.calls.length, 4);
  }
});

test("caller timeout and cancellation retain the slot until a stalled database operation really settles", async (t) => {
  // Exercise an already-started query, not whether migration file reads happen
  // to fit inside 30 ms on a busy machine. Product deadlines stay unchanged.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let elapsed = 0; t.mock.method(performance, "now", () => elapsed);
  for (const abort of [false, true]) {
    const f = fixture(abort ? 4000 : 30); let finish!: () => void, begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    f.handler.execute = () => new Promise((resolve) => { finish = () => resolve({ rows: [] }); begin(); });
    const controller = new AbortController();
    const pending = f.probe.inspect(controller.signal); const rejection = assert.rejects(pending, denied);
    await started;
    if (abort) controller.abort(new Error("private-reason"));
    else { elapsed += 30; t.mock.timers.tick(30); }
    await rejection; assert.equal(f.active(), 1);
    await assert.rejects(f.probe.inspect(signal()), denied); assert.equal(f.configs.length, 1);
    finish(); await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.active(), 0); assert.equal(f.calls.length, 1);
    f.handler.execute = async () => ({ rows: [] });
    await assert.rejects(f.probe.inspect(signal()), denied); assert.equal(f.configs.length, 2);
  }
});

test("deadline before a DB operation begins releases the slot without claiming an active query", async (t) => {
  let calls = 0; t.mock.method(performance, "now", () => calls++ === 0 ? 0 : 30);
  const f = fixture(30);
  await assert.rejects(f.probe.inspect(signal()), denied);
  assert.equal(f.active(), 0); assert.equal(f.calls.length, 0); assert.equal(f.configs.length, 0);
});

test("late pool acquisition after abort cannot start inspection queries", async () => {
  let acquired!: () => void; let queries = 0;
  const database = { async transaction(operation: (tx: unknown) => unknown) {
    await new Promise<void>((resolve) => { acquired = resolve; });
    return operation({ execute: async () => { queries += 1; return { rows: [] }; } });
  } } as unknown as ProcessorDatabase;
  const probe = new PostgresAnalysisDatabaseProbe({ database, migrationsFolder: "drizzle" });
  const controller = new AbortController(); const pending = probe.inspect(controller.signal);
  const rejection = assert.rejects(pending, denied);
  await new Promise<void>((resolve) => setImmediate(resolve)); controller.abort(); await rejection;
  acquired(); await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(queries, 0);
});

test("invalid or backward clocks and invalid timeouts never produce a database observation", async () => {
  for (const value of [NaN, Infinity, stamp.valueOf() - 1]) {
    const f = fixture(); f.handler.execute = async () => { f.setTime(value); return { rows: [] }; };
    await assert.rejects(f.probe.inspect(signal()), denied);
    assert.equal(f.calls.length, 1);
  }
  for (const timeoutMs of [0, -1, 4001, 1.5, NaN]) assert.throws(() => fixture(timeoutMs), denied);
});

test("database probe is absent from startup/HTTP and imports no runtime config, provider or migrator execution", async () => {
  const source = await readFile("src/processor/analysis-database-probe.ts", "utf8");
  assert.ok(!/runDatabaseMigrations|process\.env|globalThis\.fetch|new Pool\(|\.\/config\.js/.test(source));
  for (const path of ["src/processor/index.ts", "src/processor/server.ts"]) {
    const startup = await readFile(path, "utf8"); assert.ok(!startup.includes("analysis-database-probe"));
  }
});
