import type { SQL } from "drizzle-orm";
import { PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { AnalysisFundingLedger } from "../../src/analysis-funding.js";
import type { AnalysisState } from "../../src/analysis-state.js";
import { workAvailableAt } from "../../src/analysis-work.js";
import {
  analysisAccountingControls, analysisBatchesTable, analysisBudgetWindows, analysisRequestAttempts,
  analysisReservations, analysisRuns, guideDrafts, guides, guideSteps,
} from "../../src/db/schema.js";
import type { GuideWithSteps } from "../../src/domain.js";
import { PostgresGuideRepository, type ProcessorDatabase } from "../../src/repository.js";

/** Call-order/transaction-boundary double, NOT a PostgreSQL engine or lock/concurrency test. */
export function postgresAccountingFixture(guide: GuideWithSteps, analysis: AnalysisState, ledger: AnalysisFundingLedger) {
  type Row = Record<string, unknown>;
  const { steps, ...parent } = guide;
  const dates = <T extends { createdAt: string; updatedAt: string }>(row: T) => ({ ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) });
  let tables = new Map<PgTable, Row[]>([
    [guides, [dates(parent)]], [guideSteps, steps.map(dates)],
    [guideDrafts, analysis.draft ? [{ ...dates(analysis.draft), guideId: guide.id }] : []],
    [analysisRuns, analysis.runs.map((run) => {
      const { id, status, ...payload } = run;
      const available = workAvailableAt(run);
      return { guideId: guide.id, id, status, payload, createdAt: new Date(run.createdAt),
        availableAt: available === null ? null : new Date(available), attemptCount: run.attemptCount };
    })],
    [analysisReservations, ledger.reservations],
    [analysisBatchesTable, ledger.batches.map(({ guideId, runId, index, ...payload }) => ({ guideId, runId, index, payload }))],
    [analysisBudgetWindows, ledger.windows.map(({ day, scope, ...payload }) => ({ day, scope, payload }))],
    [analysisAccountingControls, [{ id: "global", payload: ledger.control }]],
    [analysisRequestAttempts, ledger.attempts.map(({ guideId, runId, batchIndex, ordinal, dispatchId, status, ...payload }) => ({ guideId, runId, batchIndex, ordinal, dispatchId, status, payload }))],
  ]);
  const locks: Array<{ table: PgTable; mode: string }> = [];
  const writes: PgTable[] = [];
  const queries: Array<{ table: PgTable; sql: string; params: unknown[]; limit: number }> = [];
  const isolationLevels: Array<string | undefined> = [];
  let clock = new Date("2026-09-14T12:00:00.000Z");
  let failAttemptWrite = false;
  function selected(table: PgTable, condition: SQL | undefined) {
    const rendered = condition ? new PgDialect().sqlToQuery(condition) : { sql: "", params: [] };
    const { params } = rendered;
    return (tables.get(table) ?? []).filter((row) => {
      if (table === analysisAccountingControls || table === guides) return row.id === params[0];
      if (table === analysisBudgetWindows) return row.day === params[0] && row.scope === params[1];
      if (table === analysisRuns && rendered.sql.includes('"analysis_runs"."available_at"')) {
        const due = rendered.sql.includes(" <= ");
        const at = new Date(params[due ? 2 : 1] as string).valueOf();
        const available = row.availableAt instanceof Date ? row.availableAt.valueOf() : NaN;
        const funded = tables.get(analysisReservations)!.some((r) => r.guideId === row.guideId && r.runId === row.id && r.details);
        const ready = tables.get(guides)!.some((g) => g.id === row.guideId && g.status === "ready" && g.errorCode === null);
        return funded && (due ? ready && ["queued", "running"].includes(row.status as string) && available <= at : row.status === "running" && available > at);
      }
      return row.guideId === params[0] && (params.length < 2 || row.runId === params[1]);
    });
  }
  const transaction = {
    execute: async () => ({ rows: [{ now: new Date(clock) }] }),
    select: () => ({ from: (table: PgTable) => {
      let condition: SQL | undefined;
      let limit = Number.MAX_SAFE_INTEGER;
      const query = {
        where(value: SQL) { condition = value; return query; },
        limit(value: number) { limit = value; return query; },
        orderBy() { return query; },
        for(mode: string) { locks.push({ table, mode }); return query; },
        then(resolve: (rows: Row[]) => unknown, reject: (error: unknown) => unknown) {
          if (condition) queries.push({ table, ...new PgDialect().sqlToQuery(condition), limit });
          return Promise.resolve(structuredClone(selected(table, condition).slice(0, limit))).then(resolve, reject);
        },
      };
      return query;
    } }),
    update: (table: PgTable) => ({ set: (values: Row) => ({ where: async (condition: SQL) => {
      writes.push(table);
      for (const row of selected(table, condition)) Object.assign(row, structuredClone(values));
    } }) }),
    insert: (table: PgTable) => ({ values: (values: Row) => ({
      onConflictDoNothing: async () => {
        if (table !== analysisBudgetWindows) throw new Error("fixture supports only provisional budget window inserts");
        writes.push(table);
        const rows = tables.get(table)!;
        if (!rows.some((row) => row.day === values.day && row.scope === values.scope)) rows.push(structuredClone(values));
      },
      onConflictDoUpdate: async () => {
      writes.push(table);
      if (failAttemptWrite && table === analysisRequestAttempts) throw new Error("simulated attempt persistence failure");
      const rows = tables.get(table)!;
      const existing = rows.find((row) => row.guideId === values.guideId && (table === analysisRuns ? row.id === values.id :
        table === guideDrafts ? true : row.runId === values.runId && row.batchIndex === values.batchIndex && row.ordinal === values.ordinal));
      if (existing) Object.assign(existing, structuredClone(values)); else rows.push(structuredClone(values));
    } }) }),
  };
  const database = {
    async transaction<T>(work: (tx: typeof transaction) => Promise<T>, config?: { isolationLevel: string }): Promise<T> {
      isolationLevels.push(config?.isolationLevel);
      const before = new Map([...tables].map(([key, rows]) => [key, structuredClone(rows)]));
      try { return await work(transaction); } catch (error) { tables = before; throw error; }
    },
  };
  return { repository: new PostgresGuideRepository(database as unknown as ProcessorDatabase), locks, writes, queries, isolationLevels,
    rows: (table: PgTable) => structuredClone(tables.get(table)!),
    failAttemptWrite: () => { failAttemptWrite = true; },
    removeControl: () => { tables.set(analysisAccountingControls, []); },
    setClock: (at: Date) => { clock = new Date(at); },
    replaceRows: (table: PgTable, rows: Row[]) => { tables.set(table, structuredClone(rows)); },
  };
}
