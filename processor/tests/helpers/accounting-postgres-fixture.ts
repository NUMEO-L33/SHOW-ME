import type { SQL } from "drizzle-orm";
import { PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { AnalysisFundingLedger } from "../../src/analysis-funding.js";
import type { AnalysisState } from "../../src/analysis-state.js";
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
    [analysisRuns, analysis.runs.map(({ id, status, ...payload }) => ({ guideId: guide.id, id, status, payload }))],
    [analysisReservations, ledger.reservations],
    [analysisBatchesTable, ledger.batches.map(({ guideId, runId, index, ...payload }) => ({ guideId, runId, index, payload }))],
    [analysisBudgetWindows, ledger.windows.map(({ day, scope, ...payload }) => ({ day, scope, payload }))],
    [analysisAccountingControls, [{ id: "global", payload: ledger.control }]],
    [analysisRequestAttempts, ledger.attempts.map(({ guideId, runId, batchIndex, ordinal, dispatchId, status, ...payload }) => ({ guideId, runId, batchIndex, ordinal, dispatchId, status, payload }))],
  ]);
  const locks: Array<{ table: PgTable; mode: string }> = [];
  const writes: PgTable[] = [];
  let failAttemptWrite = false;
  function selected(table: PgTable, condition: SQL | undefined) {
    const params = condition ? new PgDialect().sqlToQuery(condition).params : [];
    return (tables.get(table) ?? []).filter((row) => {
      if (table === analysisAccountingControls || table === guides) return row.id === params[0];
      if (table === analysisBudgetWindows) return row.day === params[0] && row.scope === params[1];
      return row.guideId === params[0] && (params.length < 2 || row.runId === params[1]);
    });
  }
  const transaction = {
    select: () => ({ from: (table: PgTable) => {
      let condition: SQL | undefined;
      let limit = Number.MAX_SAFE_INTEGER;
      const query = {
        where(value: SQL) { condition = value; return query; },
        limit(value: number) { limit = value; return query; },
        orderBy() { return query; },
        for(mode: string) { locks.push({ table, mode }); return query; },
        then(resolve: (rows: Row[]) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve(structuredClone(selected(table, condition).slice(0, limit))).then(resolve, reject);
        },
      };
      return query;
    } }),
    update: (table: PgTable) => ({ set: (values: Row) => ({ where: async (condition: SQL) => {
      writes.push(table);
      for (const row of selected(table, condition)) Object.assign(row, structuredClone(values));
    } }) }),
    insert: (table: PgTable) => ({ values: (values: Row) => ({ onConflictDoUpdate: async () => {
      writes.push(table);
      if (failAttemptWrite) throw new Error("simulated attempt persistence failure");
      const rows = tables.get(table)!;
      const existing = rows.find((row) => row.guideId === values.guideId && row.runId === values.runId &&
        row.batchIndex === values.batchIndex && row.ordinal === values.ordinal);
      if (existing) Object.assign(existing, structuredClone(values)); else rows.push(structuredClone(values));
    } }) }),
  };
  const database = {
    async transaction<T>(work: (tx: typeof transaction) => Promise<T>): Promise<T> {
      const before = new Map([...tables].map(([key, rows]) => [key, structuredClone(rows)]));
      try { return await work(transaction); } catch (error) { tables = before; throw error; }
    },
  };
  return { repository: new PostgresGuideRepository(database as unknown as ProcessorDatabase), locks, writes,
    rows: (table: PgTable) => structuredClone(tables.get(table)!),
    failAttemptWrite: () => { failAttemptWrite = true; },
    removeControl: () => { tables.set(analysisAccountingControls, []); },
  };
}
