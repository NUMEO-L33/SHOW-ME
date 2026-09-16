import { createHash } from "node:crypto";
import { z } from "zod";

import { assessProviderQuota, providerQuotaDay, providerQuotaLimitsSchema, providerQuotaWindow } from "./analysis-provider-quota.js";
import { parseAnalysisSend, type AnalysisSendCommand } from "./analysis-send.js";
import { GEMINI_TEST_MODEL } from "./gemini/request.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().safe();
const canonicalTime = z.string().datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const commandSchema = z.object({
  requestKey: hash, projectRef: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), model: z.literal(GEMINI_TEST_MODEL),
  inputTokenBound: positive, limits: providerQuotaLimitsSchema, notAfter: z.string().datetime(),
}).strict();
const receiptSchema = z.object({
  requestKey: hash, scopeKey: hash, chargedAt: canonicalTime, validUntil: canonicalTime,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), inputTokenBound: positive,
}).strict().superRefine((value, ctx) => {
  const start = Date.parse(value.chargedAt); const end = Date.parse(value.validUntil);
  if (!(end > start && end - start <= 5000) || providerQuotaDay(new Date(start)) !== value.day ||
      providerQuotaDay(new Date(end - 1)) !== value.day) ctx.addIssue({ code: "custom", message: "Invalid charge window" });
});
export type AnalysisQuotaCharge = z.infer<typeof commandSchema>;
export type AnalysisQuotaReceipt = z.infer<typeof receiptSchema>;
export class AnalysisQuotaChargeError extends Error {
  override name = "AnalysisQuotaChargeError";
  constructor(readonly code: "PROVIDER_QUOTA_UNAVAILABLE" | "PROVIDER_QUOTA_LIMIT" | "PROVIDER_QUOTA_REPLAY" = "PROVIDER_QUOTA_UNAVAILABLE") { super(code); }
}
export function parseQuotaCharge(raw: unknown): AnalysisQuotaCharge {
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) throw new AnalysisQuotaChargeError();
  return parsed.data;
}
export function parseQuotaReceipt(raw: unknown): AnalysisQuotaReceipt {
  try {
    const parsed = receiptSchema.safeParse(raw);
    if (!parsed.success) throw new AnalysisQuotaChargeError();
    return parsed.data;
  } catch { throw new AnalysisQuotaChargeError(); }
}
export function quotaRequestKey(guideId: string, raw: AnalysisSendCommand): string {
  const command = parseAnalysisSend(raw);
  // No owner/lease in this identity: a takeover cannot recharge/reissue the same send.
  return createHash("sha256").update(JSON.stringify([guideId, command.runId, command.batchIndex,
    command.ordinal, command.dispatchId, command.inputFingerprint])).digest("hex");
}
export function quotaScopeKey(projectRef: string, model: string): string {
  return createHash("sha256").update(JSON.stringify([projectRef, model])).digest("hex");
}
export function quotaCoverageStart(at: Date): string {
  return new Date(Math.min(Date.parse(providerQuotaWindow(at).startsAt), at.valueOf() - 60_000)).toISOString();
}

/**
 * A durable charge precedes the read-only locked launch. Never refund, renew, or
 * replay it. Holding until the LAST possible send instant prevents slow lock/
 * commit acknowledgement from aging out minute usage before the request starts.
 */
export function prepareQuotaCharge(raw: AnalysisQuotaCharge, receipts: readonly AnalysisQuotaReceipt[], at: Date): AnalysisQuotaReceipt {
  const command = parseQuotaCharge(raw);
  const scopeKey = quotaScopeKey(command.projectRef, command.model);
  const previous = receipts.map(parseQuotaReceipt);
  if (previous.some((r) => r.requestKey === command.requestKey)) throw new AnalysisQuotaChargeError("PROVIDER_QUOTA_REPLAY");
  const start = at.valueOf();
  const window = providerQuotaWindow(at);
  const end = Math.min(start + 5000, Date.parse(command.notAfter), Date.parse(window.endsAt));
  if (end <= start) throw new AnalysisQuotaChargeError();
  const since = quotaCoverageStart(at);
  const attempts = previous.filter((r) => r.scopeKey === scopeKey).map((r) => {
    if (Date.parse(r.chargedAt) > start) throw new AnalysisQuotaChargeError();
    return { attemptId: r.requestKey, sentAt: new Date(Math.min(start, Date.parse(r.validUntil) - 1)).toISOString(), inputTokenBound: r.inputTokenBound };
  }).filter((r) => r.sentAt >= since);
  const assessment = assessProviderQuota({ projectRef: command.projectRef, model: command.model, limits: command.limits,
    at, nextInputTokenBound: command.inputTokenBound,
    ledger: { projectRef: command.projectRef, model: command.model, observedAt: at.toISOString(), completeSince: since, attempts } });
  if (!assessment.fits) throw new AnalysisQuotaChargeError("PROVIDER_QUOTA_LIMIT");
  return parseQuotaReceipt({ requestKey: command.requestKey, scopeKey, inputTokenBound: command.inputTokenBound,
    chargedAt: at.toISOString(), validUntil: new Date(end).toISOString(), day: window.day });
}

export function assertQuotaPermit(raw: unknown, command: AnalysisQuotaCharge, at: Date): void {
  const receipt = parseQuotaReceipt(raw); const expected = parseQuotaCharge(command);
  if (!Number.isFinite(at.valueOf()) || receipt.requestKey !== expected.requestKey ||
      receipt.scopeKey !== quotaScopeKey(expected.projectRef, expected.model) || receipt.inputTokenBound !== expected.inputTokenBound ||
      Date.parse(receipt.chargedAt) > at.valueOf() || Date.parse(receipt.validUntil) <= at.valueOf() ||
      Date.parse(receipt.validUntil) > Date.parse(expected.notAfter) || providerQuotaDay(at) !== receipt.day) throw new AnalysisQuotaChargeError();
}

/** Trusted server dependency; never constructed from an HTTP report or env boolean. */
export interface AnalysisQuotaStore {
  /** Must return only AFTER a unique charge commits. An ambiguous acknowledgement must reject. */
  consume(command: AnalysisQuotaCharge, signal: AbortSignal, beforeCommit: () => void): Promise<AnalysisQuotaReceipt>;
}
