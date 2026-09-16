import { z } from "zod";

const positive = z.number().int().positive().safe();
const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const providerQuotaLimitsSchema = z.object({
  requestsPerMinute: positive,
  inputTokensPerMinute: positive,
  requestsPerDay: positive,
  resetTimeZone: z.literal("America/Los_Angeles"),
}).strict();
export type ProviderQuotaLimits = z.infer<typeof providerQuotaLimitsSchema>;

export class AnalysisQuotaEvidenceError extends Error {
  override name = "AnalysisQuotaEvidenceError";
  constructor() { super("ANALYSIS_QUOTA_EVIDENCE_INVALID"); }
}

const pacific = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
});
function timestamp(date: Date) {
  const value = date.valueOf();
  if (!Number.isFinite(value) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 9998) {
    throw new AnalysisQuotaEvidenceError();
  }
  return value;
}
export function providerQuotaDay(date: Date): string {
  timestamp(date);
  const parts = pacific.formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Actual Pacific midnights, including 23/25-hour DST days; never a fixed UTC-8 offset. */
export function providerQuotaWindow(date: Date) {
  const at = timestamp(date);
  const day = providerQuotaDay(date);
  const boundary = (low: number, high: number, after: boolean) => {
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      const candidate = providerQuotaDay(new Date(middle));
      if (after ? candidate <= day : candidate < day) low = middle;
      else high = middle;
    }
    return new Date(high).toISOString();
  };
  const span = 26 * 60 * 60 * 1000;
  return { day, startsAt: boundary(at - span, at, false), endsAt: boundary(at, at + span, true) };
}

const ledgerSchema = z.object({
  projectRef: id, model: id,
  observedAt: z.string().datetime(), completeSince: z.string().datetime(),
  // One row per authorized send attempt (including retries and uncertain outcomes).
  // Keep the conservative input bound; settlement must not refund provider rate usage.
  attempts: z.array(z.object({
    attemptId: id, sentAt: z.string().datetime(), inputTokenBound: positive,
  }).strict()).max(100_000),
}).strict();

/**
 * Pure, conservative window calculation, NOT a send permit or live quota verifier.
 * A future adapter must read a complete project/model send ledger and charge the
 * next attempt in the SAME shared DB lock. Other apps/keys in that project must
 * also be accounted for. Dashboard 28-day maxima are not ledger observations.
 */
export function assessProviderQuota(options: {
  projectRef: string; model: string; limits: ProviderQuotaLimits;
  ledger: unknown; at: Date; nextInputTokenBound: number;
}) {
  const limits = providerQuotaLimitsSchema.safeParse(options.limits);
  const ledger = ledgerSchema.safeParse(options.ledger);
  const next = positive.safeParse(options.nextInputTokenBound);
  const at = timestamp(options.at);
  const window = providerQuotaWindow(options.at);
  const minuteStart = at - 60_000;
  const dayStart = Date.parse(window.startsAt);
  if (!limits.success || !ledger.success || !next.success ||
      ledger.data.projectRef !== options.projectRef || ledger.data.model !== options.model ||
      Date.parse(ledger.data.observedAt) !== at ||
      Date.parse(ledger.data.completeSince) > Math.min(minuteStart, dayStart)) throw new AnalysisQuotaEvidenceError();
  const seen = new Set<string>();
  let minuteRequests = 0; let minuteInputTokens = 0; let dayRequests = 0;
  for (const attempt of ledger.data.attempts) {
    const sentAt = Date.parse(attempt.sentAt);
    if (seen.has(attempt.attemptId) || sentAt > at || sentAt < Date.parse(ledger.data.completeSince)) {
      throw new AnalysisQuotaEvidenceError();
    }
    seen.add(attempt.attemptId);
    if (sentAt >= dayStart) dayRequests += 1;
    if (sentAt > minuteStart) {
      minuteRequests += 1;
      minuteInputTokens += attempt.inputTokenBound;
      if (!Number.isSafeInteger(minuteInputTokens)) throw new AnalysisQuotaEvidenceError();
    }
  }
  const remaining = {
    requestsPerMinute: Math.max(0, limits.data.requestsPerMinute - minuteRequests),
    inputTokensPerMinute: Math.max(0, limits.data.inputTokensPerMinute - minuteInputTokens),
    requestsPerDay: Math.max(0, limits.data.requestsPerDay - dayRequests),
  };
  const blockedBy: Array<"RPM" | "INPUT_TPM" | "RPD"> = [];
  if (remaining.requestsPerMinute < 1) blockedBy.push("RPM");
  if (remaining.inputTokensPerMinute < next.data) blockedBy.push("INPUT_TPM");
  if (remaining.requestsPerDay < 1) blockedBy.push("RPD");
  return { fits: blockedBy.length === 0, blockedBy, remaining, window };
}
