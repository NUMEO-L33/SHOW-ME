import assert from "node:assert/strict";
import { test } from "node:test";

import { assessProviderQuota, providerQuotaDay, providerQuotaWindow, type ProviderQuotaLimits } from "../src/processor/analysis-provider-quota.js";

const limits: ProviderQuotaLimits = {
  requestsPerMinute: 15, inputTokensPerMinute: 250_000, requestsPerDay: 500, resetTimeZone: "America/Los_Angeles",
};
const at = new Date("2026-09-15T12:00:00.000Z");
const send = (attemptId: string, sentAt = at.toISOString(), inputTokenBound = 1000) => ({ attemptId, sentAt, inputTokenBound });
function fixture(date = at) {
  return { projectRef: "fixture-project", model: "gemini-3.5-flash-lite", observedAt: date.toISOString(),
    completeSince: new Date(date.valueOf() - 26 * 3600_000).toISOString(), attempts: [send("attempt-a", date.toISOString())] };
}
const assess = (ledger: unknown = fixture(), date = at, nextInputTokenBound = 1000, selectedLimits = limits) =>
  assessProviderQuota({ projectRef: "fixture-project", model: "gemini-3.5-flash-lite", limits: selectedLimits, ledger, at: date, nextInputTokenBound });

test("quota windows follow Pacific midnight instead of the app's UTC day", () => {
  assert.equal(providerQuotaDay(new Date("2026-09-15T00:00:00.000Z")), "2026-09-14");
  assert.deepEqual(providerQuotaWindow(at), { day: "2026-09-15", startsAt: "2026-09-15T07:00:00.000Z", endsAt: "2026-09-16T07:00:00.000Z" });
  assert.equal(providerQuotaDay(new Date("2026-09-15T06:59:59.999Z")), "2026-09-14");
  assert.equal(providerQuotaWindow(new Date("2026-09-15T07:00:00.000Z")).startsAt, "2026-09-15T07:00:00.000Z");
});

test("Pacific reset supports both 23-hour and 25-hour DST days", () => {
  for (const [date, start, end, hours] of [
    ["2026-03-08T18:00:00Z", "2026-03-08T08:00:00.000Z", "2026-03-09T07:00:00.000Z", 23],
    ["2026-11-01T18:00:00Z", "2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z", 25],
    ["2026-12-31T18:00:00Z", "2026-12-31T08:00:00.000Z", "2027-01-01T08:00:00.000Z", 24],
  ] as const) {
    const window = providerQuotaWindow(new Date(date));
    assert.equal(window.startsAt, start); assert.equal(window.endsAt, end);
    assert.equal((Date.parse(window.endsAt) - Date.parse(window.startsAt)) / 3600_000, hours);
  }
  assert.throws(() => providerQuotaWindow(new Date(NaN)), /ANALYSIS_QUOTA_EVIDENCE_INVALID/);
});

test("RPM, input TPM and RPD are independent and one row means one API attempt, not one video", () => {
  const result = assess();
  assert.equal(result.fits, true);
  assert.deepEqual(result.remaining, { requestsPerMinute: 14, inputTokensPerMinute: 249_000, requestsPerDay: 499 });
  const ledger = fixture();
  ledger.attempts = Array.from({ length: 15 }, (_, i) => send(`retry-or-send-${i}`));
  assert.deepEqual(assess(ledger).blockedBy, ["RPM"]);
  ledger.attempts = [send("uncertain-keeps-maximum", at.toISOString(), 249_001)];
  assert.deepEqual(assess(ledger).blockedBy, ["INPUT_TPM"]);
  ledger.attempts = Array.from({ length: 500 }, (_, i) => send(`old-${i}`, "2026-09-15T08:00:00Z"));
  assert.deepEqual(assess(ledger).blockedBy, ["RPD"]);
});

test("a rolling minute includes the last millisecond but expires exactly at sixty seconds", () => {
  const ledger = fixture();
  ledger.attempts = [send("expired", "2026-09-15T11:59:00.000Z", 250_000), send("active", "2026-09-15T11:59:00.001Z", 2000)];
  assert.deepEqual(assess(ledger).remaining, { requestsPerMinute: 14, inputTokensPerMinute: 248_000, requestsPerDay: 498 });
});

test("daily reset does not erase previous-day requests still inside the rolling minute", () => {
  const midnight = new Date("2026-09-15T07:00:00.000Z");
  const ledger = fixture(midnight);
  ledger.attempts = [send("yesterday", "2026-09-15T06:59:59.999Z", 3000), send("today", midnight.toISOString(), 2000)];
  assert.deepEqual(assess(ledger, midnight).remaining, { requestsPerMinute: 13, inputTokensPerMinute: 245_000, requestsPerDay: 499 });
  ledger.completeSince = midnight.toISOString();
  assert.throws(() => assess(ledger, midnight), /ANALYSIS_QUOTA_EVIDENCE_INVALID/);
});

test("invalid, stale, wrong-project, partial and dashboard-style evidence fails closed", () => {
  const ledger = fixture();
  for (const raw of [null, {}, { ...ledger, projectRef: "other-project" }, { ...ledger, model: "other-model" },
    { ...ledger, observedAt: new Date(at.valueOf() - 1).toISOString() },
    { ...ledger, observedAt: new Date(at.valueOf() + 1).toISOString() },
    { ...ledger, completeSince: "2026-09-15T11:59:00Z" },
    { ...ledger, period: "28 days", maximumUsage: { RPM: 1, TPM: 2630, RPD: 1 } },
    { ...ledger, attempts: [send("same"), send("same")] },
    { ...ledger, attempts: [send("future", "2026-09-15T12:00:00.001Z")] },
    { ...ledger, attempts: [send("before-coverage", "2026-09-01T12:00:00Z")] },
    { ...ledger, attempts: [send("zero", at.toISOString(), 0)] },
    { ...ledger, attempts: [send("negative", at.toISOString(), -1)] },
    { ...ledger, attempts: [{ ...send("refund"), refunded: true }] },
  ]) assert.throws(() => assess(raw), /ANALYSIS_QUOTA_EVIDENCE_INVALID/);
});

test("integer overflow and invalid next-attempt bounds or limits are rejected", () => {
  const ledger = fixture(); ledger.attempts = [send("a", at.toISOString(), Number.MAX_SAFE_INTEGER), send("b")];
  assert.throws(() => assess(ledger), /ANALYSIS_QUOTA_EVIDENCE_INVALID/);
  for (const bound of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => assess(fixture(), at, bound));
  assert.throws(() => assess(fixture(), at, 1000, { ...limits, requestsPerMinute: 0 }));
  assert.throws(() => assess(fixture(), at, 1000, { ...limits, resetTimeZone: "UTC" } as never));
});

test("limits allow exactly the remaining headroom and never refund a settled attempt", () => {
  const ledger = fixture(); ledger.attempts = [send("sent", at.toISOString(), 249_000)];
  assert.equal(assess(ledger).fits, true); assert.equal(assess(ledger, at, 1001).fits, false);
  assert.deepEqual(assess(ledger, at, 250_001, { ...limits, requestsPerMinute: 1, requestsPerDay: 1 }).blockedBy, ["RPM", "INPUT_TPM", "RPD"]);
  assert.deepEqual(assess(ledger), assess(structuredClone(ledger)));
});
