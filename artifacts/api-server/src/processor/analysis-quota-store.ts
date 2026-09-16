import { and, eq, gte, sql } from "drizzle-orm";

import { parseAccountingControl } from "./analysis-accounting-contract.js";
import { AnalysisQuotaChargeError, parseQuotaCharge, parseQuotaReceipt, prepareQuotaCharge, quotaCoverageStart, quotaScopeKey,
  type AnalysisQuotaCharge, type AnalysisQuotaStore } from "./analysis-quota-charge.js";
import { analysisAccountingControls, analysisProviderQuotaCharges } from "./db/schema.js";
import type { ProcessorDatabase } from "./repository.js";

/** Uses the same global lock as accounting/launch, with a separate COMMIT before any external send. */
export class PostgresAnalysisQuotaStore implements AnalysisQuotaStore {
  constructor(private readonly database: ProcessorDatabase) {}

  async consume(raw: AnalysisQuotaCharge, signal: AbortSignal, beforeCommit: () => void) {
    try {
      const command = parseQuotaCharge(raw);
      const guard = () => {
        if (signal.aborted) throw new AnalysisQuotaChargeError();
        const result = beforeCommit();
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => undefined);
          throw new AnalysisQuotaChargeError();
        }
      };
      guard();
      return await this.database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL lock_timeout = '4s'`);
        await transaction.execute(sql`SET LOCAL statement_timeout = '4s'`);
        const [control] = await transaction.select().from(analysisAccountingControls)
          .where(eq(analysisAccountingControls.id, "global")).for("update");
        if (parseAccountingControl(control?.payload).halted) throw new AnalysisQuotaChargeError();
        guard();
        const [existing] = await transaction.select().from(analysisProviderQuotaCharges)
          .where(eq(analysisProviderQuotaCharges.requestKey, command.requestKey)).limit(1);
        if (existing) throw new AnalysisQuotaChargeError("PROVIDER_QUOTA_REPLAY");
        const clock = await transaction.execute<{ at: Date | string }>(sql`SELECT clock_timestamp() AS at`);
        const at = new Date(clock.rows[0].at);
        const rows = await transaction.select().from(analysisProviderQuotaCharges).where(and(
          eq(analysisProviderQuotaCharges.scopeKey, quotaScopeKey(command.projectRef, command.model)),
          gte(analysisProviderQuotaCharges.validUntil, quotaCoverageStart(at)))).limit(100_001);
        if (rows.length > 100_000) throw new AnalysisQuotaChargeError();
        const receipt = prepareQuotaCharge(command, rows.map(parseQuotaReceipt), at);
        guard();
        await transaction.insert(analysisProviderQuotaCharges).values(receipt);
        guard(); // Delayed inserts must still roll back on abort/revocation before COMMIT.
        return receipt;
      }, { isolationLevel: "read committed" });
    } catch (error) {
      if (error instanceof AnalysisQuotaChargeError) throw error;
      throw new AnalysisQuotaChargeError(); // Never expose SQL, project identifiers, or driver messages.
    }
  }
}
