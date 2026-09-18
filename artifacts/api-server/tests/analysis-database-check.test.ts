import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";
import { Pool, Client } from "pg";
import { databaseCheckMode, databaseCheckPoolOptions, runAnalysisDatabaseCheck } from "../src/processor/analysis-database-check.js";

const flags = ["--configured-database", "--read-only"];
const signal = () => new AbortController().signal;
const fictional = "postgresql://private-user:private-password@database.invalid/private-db?sslmode=require";

test("database check requires both explicit flags, has help, and rejects all extra action/target arguments", () => {
  assert.equal(databaseCheckMode(flags), "inspect"); assert.equal(databaseCheckMode([...flags].reverse()), "inspect");
  assert.equal(databaseCheckMode(["--help"]), "help");
  for (const args of [[], flags.slice(0, 1), flags.slice(1), [...flags, "--help"], [flags[0], flags[0]],
    [...flags, "--migrate"], [...flags, "--send"], [...flags, fictional], ["--url", fictional]]) {
    assert.equal(databaseCheckMode(args), "invalid");
  }
});

test("database targets are explicit, TLS-verified remotely and bounded to one connection", () => {
  const config = databaseCheckPoolOptions(fictional);
  assert.equal(config.host, "database.invalid"); assert.equal(config.port, 5432);
  assert.equal(config.user, "private-user"); assert.equal(config.password, "private-password"); assert.equal(config.database, "private-db");
  assert.deepEqual(config.ssl, { rejectUnauthorized: true }); assert.equal(config.connectionString, undefined);
  assert.equal(config.max, 1); assert.equal(config.connectionTimeoutMillis, 3000);
  assert.equal(config.statement_timeout, 2000); assert.equal(config.lock_timeout, 1000);
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    assert.equal(databaseCheckPoolOptions(`postgres://u:p@${host}:6543/db`).ssl, false);
  }
  assert.deepEqual(databaseCheckPoolOptions(fictional.replace("require", "verify-full")).ssl, { rejectUnauthorized: true });
  assert.equal(databaseCheckPoolOptions("postgres://u:p%40ss@127.0.0.1/db").password, "p@ss");
});

test("missing, redirected, weakened or advanced connection targets are rejected without echoing input", () => {
  const base = "postgresql://u:p@database.invalid/db";
  for (const value of [undefined, "", " ", "http://u:p@host/db", "postgres://u:p@host/", "postgres://host/db",
    "postgres://u@host/db", "postgres://u:p@host/db#secret", "postgres://u:p@host:0/db", "postgres://u:p@host/a%2Fb",
    "postgres://u:p%00@host/db", base, `${base}?sslmode=disable`, `${base}?sslmode=no-verify`, `${base}?sslmode=prefer`,
    `${base}?sslmode=verify-ca`, `${base}?sslmode=require&sslmode=disable`, `${base}?sslmode=require&host=other.invalid`,
    `${base}?sslmode=require&options=private`, `${base}?sslrootcert=private-path`, `${base}?channel_binding=require`,
    `${base}?sslmode=require&uselibpqcompat=true`, "x".repeat(8193)]) {
    assert.throws(() => databaseCheckPoolOptions(value), /^Error: ANALYSIS_DATABASE_TARGET_INVALID$/);
  }
});

test("help and invalid flags neither read connection settings nor acquire a connection", async (t) => {
  const connect = t.mock.method(Pool.prototype, "connect", () => { throw new Error("unexpected-connection"); });
  const env = new Proxy({}, { get() { throw new Error("must-not-read-settings"); } });
  for (const args of [[], ["--help"], [...flags, "--migrate"]]) {
    const result = await runAnalysisDatabaseCheck({ args, env, signal: signal() });
    assert.equal(result.exitCode, args[0] === "--help" ? 0 : 2);
  }
  assert.equal(connect.mock.callCount(), 0);
});

test("invalid target and pre-cancelled checks never connect or leak configuration/abort reasons", async (t) => {
  const connect = t.mock.method(Pool.prototype, "connect", () => { throw new Error("unexpected-connection"); });
  const controller = new AbortController(); controller.abort(new Error("private-abort-reason"));
  for (const [DATABASE_URL, abort] of [[undefined, signal()], ["private-invalid-url", signal()], [fictional, controller.signal]] as const) {
    const result = await runAnalysisDatabaseCheck({ args: flags, env: { DATABASE_URL }, signal: abort });
    assert.equal(result.exitCode, 1); assert.equal(JSON.parse(result.output).ready, false);
    assert.ok(!result.output.includes("private"));
  }
  assert.equal(connect.mock.callCount(), 0);
});

test("database driver failures expose only fixed status and never become an AI permit", async (t) => {
  t.mock.method(Pool.prototype, "connect", () => { throw new Error(`${fictional} private-error-detail`); });
  const result = await runAnalysisDatabaseCheck({ args: flags, env: { DATABASE_URL: fictional }, signal: signal() });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.output), { kind: "analysis-database-check", scope: "database-only", status: "failed",
    ready: false, authorizesAnalysis: false, changesApplied: false });
});

test("a nonresponsive loopback server is bounded and closes the check's connection", async (t) => {
  const sockets = new Set<Socket>(); let connections = 0;
  const server = createServer((socket) => { connections += 1; sockets.add(socket); socket.resume(); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((done) => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const started = performance.now();
  const result = await runAnalysisDatabaseCheck({ args: flags,
    env: { DATABASE_URL: `postgres://u:p@127.0.0.1:${address.port}/db` }, signal: signal() });
  assert.equal(result.exitCode, 1); assert.equal(JSON.parse(result.output).status, "failed");
  assert.equal(connections, 1); assert.ok(performance.now() - started < 7000);
  for (let i = 0; sockets.size && i < 50; i += 1) await new Promise((done) => setTimeout(done, 10));
  assert.equal(sockets.size, 0);
});

test("CLI defaults do not connect, start the app or consume otherwise configured credentials", async () => {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(process.execPath, ["--import", "tsx", resolve("src/processor/analysis-database-check.ts")], {
      env: { ...process.env, DATABASE_URL: fictional, PORT: "invalid", NODE_ENV: "production", GEMINI_API_KEY: "private-fake-key" },
      encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 16384,
    }, (error, stdout, stderr) => done({ code: typeof error?.code === "number" ? error.code : error ? -1 : 0, stdout, stderr }));
  });
  assert.equal(result.code, 2); assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).status, "arguments-required"); assert.ok(!result.stdout.includes("private"));
});

test("command is opt-in, tied to its own migrations and absent from startup/HTTP hooks", async () => {
  const source = await readFile("src/processor/analysis-database-check.ts", "utf8");
  assert.ok(!/runDatabaseMigrations|\.\/config\.js|dotenv|createStorage|readFile|fetch\(/.test(source));
  assert.ok(source.includes('new URL("../../drizzle/", import.meta.url)'));
  for (const path of ["src/processor/index.ts", "src/processor/server.ts"]) {
    assert.ok(!(await readFile(path, "utf8")).includes("analysis-database-check"));
  }
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pkg.scripts["check:analysis-db"], "node --import tsx src/processor/analysis-database-check.ts");
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name !== "check:analysis-db") assert.ok(!String(command).includes("analysis-database-check"));
  }
  // Driver construction is offline; connection fields are explicit rather than libpq fallbacks.
  const client = new Client(databaseCheckPoolOptions(fictional));
  assert.equal(client.host, "database.invalid"); assert.equal(client.database, "private-db");
});
