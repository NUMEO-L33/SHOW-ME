import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { analysisBootstrapSettings, configuredAnalysisFactory, verifyAnalysisRuntimeRole } from "../src/processor/analysis-bootstrap.js";
import { loadConfig } from "../src/processor/config.js";

const config = () => loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://fixture:fake@localhost/fixture",
  SHOWME_STORAGE: "replit", REPLIT_OBJECT_STORAGE_BUCKET_ID: "fictional-bucket", SHOWME_DATABASE_MIGRATIONS: "verify-only" });
const env = () => ({ SHOWME_ANALYSIS_MODE: "fixed-synthetic", SHOWME_ANALYSIS_ACTIVATION_ID: randomUUID(),
  SHOWME_ANALYSIS_DEPLOYMENT_REF: "fictional-deployment", SHOWME_ANALYSIS_PROJECT_REF: "fictional-project",
  SHOWME_ANALYSIS_CREDENTIAL_REF: "fictional-key-version", GEMINI_API_KEY: "fictional-secret-key" });

test("bootstrap is off by default even when a provider key exists; enabled settings are only selectors", () => {
  assert.equal(analysisBootstrapSettings({ GEMINI_API_KEY: "fictional-secret-key" }, config()), undefined);
  assert.equal(analysisBootstrapSettings({ ...env(), SHOWME_ANALYSIS_MODE: "off" }, config()), undefined);
  const raw = env();
  const settings = analysisBootstrapSettings({ ...raw, SHOWME_ANALYSIS_GRANT: "untrusted", SHOWME_ANALYSIS_LIMIT: "999999" }, config());
  assert.deepEqual(settings, { mode: "fixed-synthetic", activationId: raw.SHOWME_ANALYSIS_ACTIVATION_ID,
    deploymentRef: raw.SHOWME_ANALYSIS_DEPLOYMENT_REF, projectRef: raw.SHOWME_ANALYSIS_PROJECT_REF,
    credentialRef: raw.SHOWME_ANALYSIS_CREDENTIAL_REF, apiKey: raw.GEMINI_API_KEY });
  assert.ok(Object.isFrozen(settings));
});

test("enabled bootstrap rejects incomplete selectors and unsafe DB/storage config without exposing values", () => {
  for (const key of Object.keys(env())) {
    const raw: Record<string, string> = env(); raw[key] = key === "SHOWME_ANALYSIS_MODE" ? "personal-video" : "";
    assert.throws(() => analysisBootstrapSettings(raw, config()), /^AnalysisBootstrapError: ANALYSIS_BOOTSTRAP_UNAVAILABLE$/);
  }
  for (const override of [{ databaseUrl: undefined }, { databaseMigrationMode: "automatic" as const },
    { storageDriver: "local" as const }, { replitBucketId: undefined }]) {
    assert.throws(() => analysisBootstrapSettings(env(), { ...config(), ...override }), /ANALYSIS_BOOTSTRAP_UNAVAILABLE/);
  }
  for (const key of ["SHOWME_OPERATOR_DATABASE_URL", "SHOWME_MIGRATION_DATABASE_URL"]) {
    assert.throws(() => analysisBootstrapSettings({ ...env(), [key]: "fictional-privileged-connection" }, config()), /ANALYSIS_BOOTSTRAP_UNAVAILABLE/);
  }
});

function roleFixture() {
  const state = { role: { role: "showme_runtime_fixture", direct: true, elevated: false, memberships: false,
    owns_database: false, owns_schema: false, owns_objects: false, can_create: false },
    grants: Array.from({ length: 3 }, () => ({ readable: true, writable: false })), events: [] as string[],
    releases: [] as boolean[], connections: 0, fail: false };
  const client = { async query(sql: string) {
    state.events.push(sql);
    if (state.fail) throw new Error("fictional-private-connection-detail");
    if (sql.includes("FROM pg_roles")) return { rows: [state.role] };
    if (sql.includes("FROM unnest")) return { rows: state.grants };
    return { rows: [] };
  }, release(destroy?: boolean) { state.releases.push(Boolean(destroy)); } };
  const pool = { async connect() { state.connections++; return client as unknown as PoolClient; } } as Pick<Pool, "connect">;
  return { state, pool };
}

test("runtime privilege check authenticates DB metadata in a read-only transaction", async () => {
  const f = roleFixture(); await verifyAnalysisRuntimeRole(f.pool, new AbortController().signal);
  assert.equal(f.state.events[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(f.state.events.at(-1), "COMMIT"); assert.deepEqual(f.state.releases, [false]);
  assert.ok(!f.state.events.some(s => /^(CREATE|GRANT|INSERT|UPDATE|DELETE)/.test(s)));
});

test("runtime role rejects owner, privileged, inherited or impersonated identities and approval writes", async () => {
  for (const key of ["elevated", "memberships", "owns_database", "owns_schema", "owns_objects", "can_create"] as const) {
    const f = roleFixture(); f.state.role[key] = true;
    await assert.rejects(verifyAnalysisRuntimeRole(f.pool, new AbortController().signal), /ANALYSIS_BOOTSTRAP_UNAVAILABLE/);
    assert.equal(f.state.events.at(-1), "ROLLBACK"); assert.deepEqual(f.state.releases, [true]);
  }
  for (const kind of ["name", "direct", "write", "read", "missing", "error"]) {
    const f = roleFixture();
    if (kind === "name") f.state.role.role = "postgres";
    if (kind === "direct") f.state.role.direct = false;
    if (kind === "write") f.state.grants[0].writable = true;
    if (kind === "read") f.state.grants[1].readable = false;
    if (kind === "missing") f.state.grants.pop();
    if (kind === "error") f.state.fail = true;
    await assert.rejects(verifyAnalysisRuntimeRole(f.pool, new AbortController().signal), /^AnalysisBootstrapError: ANALYSIS_BOOTSTRAP_UNAVAILABLE$/);
    assert.deepEqual(f.state.releases, [true]);
  }
});

test("bootstrap rejects pre-aborted role checks and non-Postgres/non-Replit application objects", async () => {
  const f = roleFixture(); const signal = AbortSignal.abort();
  await assert.rejects(verifyAnalysisRuntimeRole(f.pool, signal), /ANALYSIS_BOOTSTRAP_UNAVAILABLE/);
  assert.equal(f.state.connections, 0);
  const factory = configuredAnalysisFactory(analysisBootstrapSettings(env(), config())!, config());
  await assert.rejects(async () => factory({ repository: {} as never, storage: {} as never }), /ANALYSIS_BOOTSTRAP_UNAVAILABLE/);
});
