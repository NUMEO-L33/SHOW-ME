import { prepareQuotaCharge, type AnalysisQuotaReceipt, type AnalysisQuotaStore } from "../../src/analysis-quota-charge.js";

/** In-memory transaction double ONLY. Never a production store or completeness/free-tier proof. */
export function providerQuotaFixture(clock: () => Date) {
  const receipts: AnalysisQuotaReceipt[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const store: AnalysisQuotaStore = {
    consume(command, signal, beforeCommit) {
      const current = tail.then(() => {
        signal.throwIfAborted(); beforeCommit();
        const receipt = prepareQuotaCharge(command, receipts, clock());
        receipts.push(receipt); return structuredClone(receipt);
      });
      tail = current.catch(() => undefined); return current;
    },
  };
  return { ...store, receipts };
}
