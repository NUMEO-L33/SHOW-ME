import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runtimeEnvironment, readRuntimeBinding } from "../../artifacts/api-server/scripts/start.mjs";

const env = { NODE_ENV: "development", REPL_ID: "67fdf570-63d0-47d4-a842-742d022f2eb9", DATABASE_URL: "fictional-admin-url",
  PGUSER: "fictional-admin", PGPASSWORD: "fictional-admin-password", PGDATABASE: "fixture", PGHOST: "helium",
  SHOWME_OPERATOR_DATABASE_URL: "fictional-operator-url", SHOWME_MIGRATION_DATABASE_URL: "fictional-migration-url",
  NODE_OPTIONS: "fictional-preload", GEMINI_API_KEY: "fictional-ai-key", REPLIT_OBJECT_STORAGE_BUCKET_ID: "fictional-bucket" };
const binding = () => ({ kind: "showme-development-runtime-v1", replId: env.REPL_ID,
  connectionString: `postgresql://showme_runtime_fixture:${"a".repeat(64)}@helium:5432/fixture?sslmode=disable` });

test("development launcher passes only the selected runtime DB, forces verify-only and defaults AI off", () => {
  const raw = { ...env }; const configured = binding(); const child = runtimeEnvironment(raw, configured);
  assert.equal(child.DATABASE_URL, configured.connectionString);
  assert.equal(child.SHOWME_DATABASE_MIGRATIONS, "verify-only"); assert.equal(child.SHOWME_ANALYSIS_MODE, "off");
  for (const key of ["PGUSER", "PGPASSWORD", "PGDATABASE", "PGHOST", "SHOWME_OPERATOR_DATABASE_URL",
    "SHOWME_MIGRATION_DATABASE_URL", "NODE_OPTIONS", "GEMINI_API_KEY"]) assert.equal(key in child, false, key);
  assert.equal(child.REPLIT_OBJECT_STORAGE_BUCKET_ID, "fictional-bucket"); assert.deepEqual(raw, env);
});

test("development binding must be complete and project/role/endpoint bound; no administrator fallback", () => {
  const valid = binding();
  for (const invalid of [undefined, {}, { ...valid, replId: "different" }, { ...valid, extra: true },
    { ...valid, connectionString: valid.connectionString.replace("helium", "external.invalid") },
    { ...valid, connectionString: valid.connectionString.replace("showme_runtime_fixture", "postgres") },
    { ...valid, connectionString: valid.connectionString.replace("disable", "require") },
    { ...valid, connectionString: valid.connectionString + "&options=untrusted" }]) {
    assert.throws(() => runtimeEnvironment(env, invalid), /^Error: SHOWME_RUNTIME_DATABASE_SETUP_REQUIRED$/);
  }
});

test("local and deployed starts do not consume a development credential file", () => {
  for (const source of [{ NODE_ENV: "test", DATABASE_URL: "fictional-local" }, { ...env, REPLIT_DEPLOYMENT: "1" }]) {
    assert.deepEqual(runtimeEnvironment(source, undefined), source);
  }
  assert.throws(() => runtimeEnvironment({ ...env, NODE_ENV: "production" }, binding()), /SETUP_REQUIRED/);
});

test("credential file must be present, complete and small; filesystem errors are not credentials", async t => {
  const root = await mkdtemp(join(tmpdir(), "showme-runtime-file-"));
  t.after(() => rm(root, { recursive: true, force: true })); const path = join(root, "runtime.json");
  await assert.rejects(readRuntimeBinding(path));
  await writeFile(path, JSON.stringify(binding()), { mode: 0o600 }); assert.deepEqual(await readRuntimeBinding(path), binding());
  await writeFile(path, "{"); await assert.rejects(readRuntimeBinding(path));
  await writeFile(path, "a".repeat(8193)); await assert.rejects(readRuntimeBinding(path));
  if (process.platform !== "win32") {
    await writeFile(path, JSON.stringify(binding())); await chmod(path, 0o644);
    await assert.rejects(readRuntimeBinding(path)); await chmod(path, 0o600);
    const alias = join(root, "alias.json"); await symlink(path, alias); await assert.rejects(readRuntimeBinding(alias));
  }
});
