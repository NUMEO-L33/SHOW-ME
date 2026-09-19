import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { test } from "node:test";
import { PostgresAnalysisOperationsStore, operationsActorRef } from "../src/processor/analysis-operations-store.js";
import { GEMINI_TEST_MODEL } from "../src/processor/gemini/request.js";
import { operationsReviewFixture } from "./helpers/operations-review-fixture.js";

const now = new Date("2026-09-19T12:00:00.000Z");
function review() {
  const limit = { requests: 100, inputTokens: 1000000, outputTokens: 1000000, costMicrousd: 1000000 };
  const r = operationsReviewFixture(now, { version: "fixture", accountingOnly: true, price: { model: GEMINI_TEST_MODEL,
    version: "fixture", inputMicrousdPerMillionTokens: 100000, outputMicrousdPerMillionTokens: 200000 },
    maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 8192, transientRetries: 0, globalLimit: limit, guideLimit: limit });
  r.reviewerRef = operationsActorRef("fixture_operator"); return r;
}
type Row = Record<string, unknown>;
function fixture(timeoutMs?: number) {
  const state = { rows: [] as Row[], control: { halted: false } as { halted: boolean } | undefined,
    sessionRole: "fixture_operator", activeRole: "fixture_operator", failHalt: false, skipHalt: false, loseCommit: false, rollbackFails: false,
    at: now.valueOf(), connections: 0, releases: [] as boolean[], events: [] as string[] };
  let before: { rows: Row[]; control: typeof state.control } | undefined;
  let hook: ((sql: string) => Promise<void>) | undefined;
  const client = { async query(sql: string, values: unknown[] = []) {
    state.events.push(sql); if (hook) await hook(sql);
    if (sql.startsWith("BEGIN")) { before = structuredClone({ rows: state.rows, control: state.control }); return { rows: [] }; }
    if (sql === "ROLLBACK") {
      if (state.rollbackFails) throw new Error("private rollback failure");
      if (before) { state.rows = before.rows; state.control = before.control; before = undefined; } return { rows: [] };
    }
    if (sql === "COMMIT") { before = undefined; if (state.loseCommit) { state.loseCommit = false; throw new Error("private lost COMMIT"); } return { rows: [] }; }
    if (sql.startsWith("SET LOCAL")) return { rows: [] };
    if (sql.includes("session_user")) return { rows: [{ session_role: state.sessionRole, active_role: state.activeRole }] };
    if (sql.includes("FROM public.analysis_accounting_controls")) return { rows: state.control ? [{ payload: state.control, at_ms: state.at }] : [] };
    if (sql.includes("clock_timestamp()")) return { rows: [{ at_ms: state.at }] };
    if (sql.startsWith("SELECT *")) {
      const rows = state.rows.filter((r) => sql.includes("command_id =") ? r.command_id === values[0] : r.deployment_ref === values[0]);
      return { rows: structuredClone(rows.sort((a, b) => Number(b.version) - Number(a.version)).slice(0, 1)) };
    }
    if (sql.startsWith("INSERT")) {
      const row = { deployment_ref: values[0], version: values[1], command_id: values[2], command_hash: values[3], actor_ref: values[4],
        action: values[5], payload: JSON.parse(String(values[6])), created_at: values[7] };
      state.rows.push(structuredClone(row)); return { rows: [structuredClone(row)] };
    }
    if (sql.startsWith("UPDATE")) {
      if (state.failHalt) throw new Error("private halt failure");
      if (state.skipHalt) return { rows: [] };
      state.control = { halted: true }; return { rows: [{ payload: state.control }] };
    }
    assert.fail(sql);
  }, release(destroy?: boolean) { state.releases.push(Boolean(destroy)); } };
  const pool = { async connect() { state.connections++; return client as unknown as PoolClient; } } as Pick<Pool, "connect">;
  const store = new PostgresAnalysisOperationsStore({ pool, writerRoles: ["fixture_operator"], timeoutMs });
  const command = { type: "put" as const, commandId: randomUUID(), expectedVersion: 0, review: review() };
  const signal = () => new AbortController().signal;
  return { state, pool, client, store, command, signal, execute: () => store.execute(command, signal()),
    onQuery: (fn: typeof hook) => { hook = fn; } };
}

test("operations writer denies by default before connecting; input cannot supply roles or enable flags", async () => {
  const f = fixture();
  await assert.rejects(new PostgresAnalysisOperationsStore({ pool: f.pool }).execute(f.command, f.signal()), /OPERATIONS_FORBIDDEN/);
  assert.equal(f.state.connections, 0);
  for (const extra of [{ writerRoles: ["fixture_operator"] }, { authorized: true }, { unhalt: true }]) {
    await assert.rejects(f.store.execute({ ...f.command, ...extra }, f.signal()), /OPERATIONS_INVALID/);
  }
  assert.equal(f.state.connections, 0);
});

test("actual DB login, active role and reviewer binding must match configured operator role", async () => {
  for (const kind of ["session", "set-role", "reviewer"]) {
    const f = fixture();
    if (kind === "session") f.state.sessionRole = "app_role";
    if (kind === "set-role") f.state.activeRole = "app_role";
    if (kind === "reviewer") f.command.review.reviewerRef = "untrusted-browser-identity";
    await assert.rejects(f.execute(), /OPERATIONS_FORBIDDEN/);
    assert.equal(f.state.rows.length, 0); assert.equal(f.state.control?.halted, false);
  }
});

test("approved or incomplete pending records append, bind DB identity, and atomically halt without activation", async () => {
  for (const pending of [false, true]) {
    const f = fixture();
    if (pending) { f.command.review.state = "pending"; f.command.review.checks.storageAccess = { status: "unknown" }; }
    const result = await f.execute();
    assert.equal(result.authorizesAnalysis, false); assert.equal(result.replayed, false);
    assert.equal(result.entry.actorRef, operationsActorRef("fixture_operator"));
    assert.equal(f.state.rows.length, 1); assert.equal(f.state.control?.halted, true);
    assert.ok(f.state.events.findIndex((s) => s.includes("FOR UPDATE")) < f.state.events.findIndex((s) => s.startsWith("INSERT")));
    const reopened = new PostgresAnalysisOperationsStore({ pool: f.pool });
    assert.deepEqual(await reopened.readLatest(f.command.review.deploymentRef, f.signal()), result.entry);
    result.entry.review.checks.freeProject = { status: "unknown" };
    assert.equal((await reopened.readLatest(f.command.review.deploymentRef, f.signal()))?.review.checks.freeProject.status, "confirmed");
  }
});

test("unknown approved checks, stale or malformed records cannot write or halt", async () => {
  for (const kind of ["unknown", "expired", "future", "revision", "revoked", "overlong"]) {
    const f = fixture();
    if (kind === "unknown") f.command.review.checks.storageAccess = { status: "unknown" };
    if (kind === "expired") f.command.review.expiresAt = now.toISOString();
    if (kind === "future") f.command.review.recordedAt = new Date(now.valueOf() + 1).toISOString();
    if (kind === "revision") f.command.review.revision = 2;
    if (kind === "revoked") f.command.review.state = "revoked";
    if (kind === "overlong") f.command.review.expiresAt = new Date(now.valueOf() + 86400001).toISOString();
    await assert.rejects(f.execute(), /OPERATIONS_INVALID/);
    assert.equal(f.state.rows.length, 0); assert.equal(f.state.control?.halted, false);
  }
});

test("same command survives lost commit acknowledgement; reuse with different content conflicts", async () => {
  const f = fixture(); f.state.loseCommit = true;
  await assert.rejects(f.execute(), /^AnalysisOperationsStoreError: OPERATIONS_UNAVAILABLE$/);
  assert.equal(f.state.rows.length, 1); assert.equal(f.state.control?.halted, true);
  assert.equal((await f.execute()).replayed, true); assert.equal(f.state.rows.length, 1);
  f.command.review.id = "different";
  await assert.rejects(f.execute(), /OPERATIONS_CONFLICT/); assert.equal(f.state.rows.length, 1);
});

test("CAS prevents stale update/revocation, while revoke preserves the previous immutable event and original observation", async () => {
  const f = fixture(); const first = await f.execute();
  const revoke = { type: "revoke", commandId: randomUUID(), expectedVersion: 1, deploymentRef: f.command.review.deploymentRef, reviewId: f.command.review.id };
  await assert.rejects(f.store.execute({ ...revoke, expectedVersion: 0 }, f.signal()), /OPERATIONS_CONFLICT/);
  await assert.rejects(f.store.execute({ ...revoke, reviewId: "other" }, f.signal()), /OPERATIONS_CONFLICT/);
  const revoked = await f.store.execute(revoke, f.signal());
  assert.equal(revoked.entry.version, 2); assert.equal(revoked.entry.review.state, "revoked");
  assert.equal(revoked.entry.review.recordedAt, first.entry.review.recordedAt);
  assert.equal((f.state.rows[0].payload as { state: string }).state, "approved");
  assert.equal((await f.store.execute(revoke, f.signal())).replayed, true);
  assert.equal((await f.execute()).entry.version, 1); // A replay receipt is NOT the active record.
  assert.equal((await f.store.readLatest(revoke.deploymentRef, f.signal()))?.version, 2);
});

test("halt failure, missing control or corrupt prior row fail closed and roll back the whole change", async () => {
  for (const kind of ["halt-write", "halt-skipped", "control", "corrupt"]) {
    const f = fixture();
    if (kind === "halt-write") f.state.failHalt = true;
    if (kind === "halt-skipped") f.state.skipHalt = true;
    if (kind === "control") f.state.control = undefined;
    if (kind === "corrupt") f.state.rows = [{ deployment_ref: f.command.review.deploymentRef, version: 1, payload: { secret: "no echo" } }];
    const before = structuredClone({ rows: f.state.rows, control: f.state.control });
    await assert.rejects(f.execute(), /^AnalysisOperationsStoreError: OPERATIONS_UNAVAILABLE$/);
    assert.deepEqual({ rows: f.state.rows, control: f.state.control }, before);
  }
});

test("abort after INSERT rolls back without halt; broken rollback destroys only the owned client", async () => {
  for (const broken of [false, true]) {
    const f = fixture(); const controller = new AbortController(); f.state.rollbackFails = broken;
    f.onQuery(async (sql) => { if (sql.startsWith("INSERT")) controller.abort(new Error("private reason")); });
    await assert.rejects(f.store.execute(f.command, controller.signal), /OPERATIONS_UNAVAILABLE/);
    await new Promise((r) => setImmediate(r));
    assert.equal(f.state.control?.halted, false); assert.equal(f.state.releases[0], broken);
    if (!broken) assert.equal(f.state.rows.length, 0);
  }
});

test("late connection after timeout issues no SQL and retains the slot until it actually releases", async () => {
  const f = fixture(); let finish!: (client: PoolClient) => void; let connections = 0;
  const store = new PostgresAnalysisOperationsStore({ pool: { connect() { connections++; return new Promise((resolve) => { finish = resolve; }); } } as Pick<Pool, "connect">,
    writerRoles: ["fixture_operator"], timeoutMs: 20 });
  await assert.rejects(store.execute(f.command, f.signal()), /OPERATIONS_UNAVAILABLE/);
  await assert.rejects(store.execute(f.command, f.signal()), /OPERATIONS_UNAVAILABLE/); assert.equal(connections, 1);
  finish(f.client as unknown as PoolClient); await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.state.events, []); assert.deepEqual(f.state.releases, [false]);
});

test("configuration and pre-abort are bounded; admin store has no startup/HTTP binding or reset API", async () => {
  const f = fixture();
  for (const timeoutMs of [0, -1, 5001, NaN]) assert.throws(() => new PostgresAnalysisOperationsStore({ pool: f.pool, timeoutMs }), /OPERATIONS_INVALID/);
  for (const role of ["", "public", "admin;DROP TABLE", "a".repeat(64)]) {
    // 'public' is not an authenticatable login but is a valid configured spelling; server identity still must match.
    if (role !== "public") assert.throws(() => new PostgresAnalysisOperationsStore({ pool: f.pool, writerRoles: [role] }), /OPERATIONS_INVALID/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.store.execute(f.command, controller.signal), /OPERATIONS_UNAVAILABLE/); assert.equal(f.state.connections, 0);
  for (const path of ["src/processor/server.ts", "src/processor/index.ts"]) assert.ok(!(await readFile(path, "utf8")).includes("analysis-operations-store"));
  assert.equal("resume" in f.store, false); assert.equal("unhalt" in f.store, false);
});

test("operations observation reads control and latest record in one read-only snapshot without unhalting", async () => {
  const f = fixture(); await f.execute(); const before = structuredClone(f.state.rows); f.state.events.length = 0;
  const observed = await f.store.observe(f.command.review.deploymentRef, f.signal());
  assert.equal(observed.halted, true); assert.equal(observed.authorizesAnalysis, false);
  assert.equal(observed.observedAt, now.toISOString()); assert.equal(observed.entry?.version, 1);
  assert.deepEqual(f.state.rows, before); assert.equal(f.state.control?.halted, true);
  assert.equal(f.state.events[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.ok(!f.state.events.some((s) => /^(INSERT|UPDATE|DELETE)/.test(s)));
  f.state.control = undefined;
  await assert.rejects(f.store.observe(f.command.review.deploymentRef, f.signal()), /OPERATIONS_UNAVAILABLE/);
});
