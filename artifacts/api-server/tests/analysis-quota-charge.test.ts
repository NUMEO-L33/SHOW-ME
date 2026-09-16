import assert from "node:assert/strict";
import { test } from "node:test";
import { assertQuotaPermit, parseQuotaReceipt, prepareQuotaCharge, quotaRequestKey, quotaScopeKey, type AnalysisQuotaCharge } from "../src/processor/analysis-quota-charge.js";
import { GEMINI_TEST_MODEL } from "../src/processor/gemini/request.js";
import { providerQuotaFixture } from "./helpers/provider-quota-fixture.js";

const at = new Date("2026-09-15T12:00:00.000Z");
const command: AnalysisQuotaCharge = { requestKey: "a".repeat(64), projectRef: "project", model: GEMINI_TEST_MODEL,
  limits: { requestsPerMinute: 1, inputTokensPerMinute: 2000, requestsPerDay: 100, resetTimeZone: "America/Los_Angeles" },
  inputTokenBound: 1000, notAfter: new Date(at.valueOf() + 30_000).toISOString() };
const next = { ...command, requestKey: "b".repeat(64) };

test("charge permit binds the exact project/model/request and expires after at most five seconds", () => {
  const receipt = prepareQuotaCharge(command, [], at);
  assert.equal(receipt.validUntil, "2026-09-15T12:00:05.000Z");
  assertQuotaPermit(receipt, command, new Date(at.valueOf() + 4999));
  for (const date of [new Date(at.valueOf() - 1), new Date(at.valueOf() + 5000), new Date(NaN)]) assert.throws(() => assertQuotaPermit(receipt, command, date));
  for (const changed of [{ ...next }, { ...command, projectRef: "other" }, { ...command, inputTokenBound: 1 },
    { ...command, notAfter: at.toISOString() }]) assert.throws(() => assertQuotaPermit(receipt, changed, at));
});

test("minute quota ages from the latest possible launch, not the earlier durable booking time", () => {
  const receipt = prepareQuotaCharge(command, [], at);
  for (const elapsed of [0, 4999, 60_000, 64_998]) {
    const date = new Date(at.valueOf() + elapsed);
    assert.throws(() => prepareQuotaCharge({ ...next, notAfter: new Date(date.valueOf() + 10_000).toISOString() }, [receipt], date), /PROVIDER_QUOTA_LIMIT/);
  }
  const date = new Date(at.valueOf() + 64_999);
  assert.ok(prepareQuotaCharge({ ...next, notAfter: new Date(date.valueOf() + 10_000).toISOString() }, [receipt], date));
});

test("permanent replay identity cannot renew a permit after expiry or a restart", async () => {
  const store = providerQuotaFixture(() => at);
  await store.consume(command, new AbortController().signal, () => undefined);
  const persisted = JSON.parse(JSON.stringify(store.receipts));
  const later = new Date(at.valueOf() + 70_000);
  assert.throws(() => prepareQuotaCharge({ ...command, notAfter: new Date(later.valueOf() + 5000).toISOString() }, persisted, later), /PROVIDER_QUOTA_REPLAY/);
});

test("Pacific reset truncates permits but keeps previous-day minute usage after midnight", () => {
  const start = new Date("2026-09-15T06:59:59.000Z"); const midnight = new Date("2026-09-15T07:00:00.000Z");
  const quota = { ...command, notAfter: "2026-09-15T07:00:10.000Z" };
  const receipt = prepareQuotaCharge(quota, [], start);
  assert.equal(receipt.validUntil, midnight.toISOString()); assert.equal(receipt.day, "2026-09-14");
  assert.throws(() => assertQuotaPermit(receipt, quota, midnight));
  assert.throws(() => prepareQuotaCharge({ ...quota, requestKey: next.requestKey }, [receipt], midnight), /PROVIDER_QUOTA_LIMIT/);
  assert.ok(prepareQuotaCharge({ ...quota, requestKey: next.requestKey, limits: { ...quota.limits, requestsPerMinute: 2, requestsPerDay: 1 } }, [receipt], midnight));
});

test("same-day consumed and uncertain permits keep RPD and input charges without refunds", () => {
  const receipt = prepareQuotaCharge(command, [], at);
  assert.throws(() => prepareQuotaCharge({ ...next, limits: { ...next.limits, requestsPerMinute: 2, inputTokensPerMinute: 1999 } }, [receipt], at), /PROVIDER_QUOTA_LIMIT/);
  const later = new Date(at.valueOf() + 70_000);
  assert.throws(() => prepareQuotaCharge({ ...next, notAfter: new Date(later.valueOf() + 5000).toISOString(),
    limits: { ...next.limits, requestsPerDay: 1 } }, [receipt], later), /PROVIDER_QUOTA_LIMIT/);
});

test("different keys of the same project share quota; another project cannot borrow a receipt", () => {
  const receipt = prepareQuotaCharge(command, [], at);
  assert.throws(() => prepareQuotaCharge(next, [receipt], at), /PROVIDER_QUOTA_LIMIT/);
  assert.ok(prepareQuotaCharge({ ...next, projectRef: "another" }, [receipt], at));
  assert.notEqual(quotaScopeKey("project", GEMINI_TEST_MODEL), quotaScopeKey("another", GEMINI_TEST_MODEL));
  const send = { runId: "run", batchIndex: 0, ordinal: 0 as const, dispatchId: "dispatch", inputFingerprint: "c".repeat(64),
    owner: { attemptId: "owner-a", attemptCount: 1 } };
  assert.equal(quotaRequestKey("guide", send), quotaRequestKey("guide", { ...send, owner: { attemptId: "owner-b", attemptCount: 2 } }));
  assert.notEqual(quotaRequestKey("guide", send), quotaRequestKey("another", send));
});

test("invalid or backwards-clock charge evidence and invented receipt fields fail closed", () => {
  const receipt = prepareQuotaCharge(command, [], at);
  for (const raw of [{ ...receipt, validUntil: "2026-09-15T12:00:05.001Z" }, { ...receipt, inputTokenBound: 0 },
    { ...receipt, day: "2026-09-14" }, { ...receipt, renewed: true }]) assert.throws(() => parseQuotaReceipt(raw));
  assert.throws(() => prepareQuotaCharge(next, [receipt], new Date(at.valueOf() - 1)));
  assert.throws(() => prepareQuotaCharge({ ...command, notAfter: at.toISOString() }, [], at));
});

test("twenty serialized contenders consume only available slots (transaction double)", async () => {
  const store = providerQuotaFixture(() => at);
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => store.consume({ ...command,
    requestKey: i.toString(16).padStart(64, "0") }, new AbortController().signal, () => undefined)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1); assert.equal(store.receipts.length, 1);
});
