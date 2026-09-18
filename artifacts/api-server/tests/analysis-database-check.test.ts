import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import dns from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";
import { Pool, Client } from "pg";
import { databaseCheckMode, databaseCheckPoolOptions, replitDevelopmentPoolOptions, runAnalysisDatabaseCheck } from "../src/processor/analysis-database-check.js";

const flags = ["--configured-database", "--read-only"];
const signal = () => new AbortController().signal;
const fictional = "postgresql://private-user:private-password@database.invalid/private-db?sslmode=require";
const replId = "00000000-0000-4000-8000-000000000001";
const helium = "postgresql://private-user:private-password@helium/private-db?sslmode=disable";
const replitArgs = [...flags, `--replit-development=${replId}`];
const development = { REPL_ID: replId, NODE_ENV: "development", REPLIT_DEPLOYMENT: "0" };

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

test("Replit development requires one explicit project UUID in addition to both read-only flags", () => {
  assert.equal(databaseCheckMode(replitArgs), "inspect-replit-development");
  assert.equal(databaseCheckMode([...replitArgs].reverse()), "inspect-replit-development");
  for (const args of [[...flags, "--replit-development"], [...flags, "--replit-development="],
    [...flags, "--replit-development=private-invalid"], [...replitArgs, replitArgs[2]],
    replitArgs.slice(1), [...replitArgs, "--help"], [...replitArgs, "--allow-insecure"]]) {
    assert.equal(databaseCheckMode(args), "invalid");
  }
  assert.throws(() => databaseCheckPoolOptions(helium), /ANALYSIS_DATABASE_TARGET_INVALID/);
});

test("approved development profile resolves once and pins a private address without PG fallbacks", async (t) => {
  const lookup = t.mock.method(dns, "lookup", async (hostname: string, options: unknown) => {
    assert.equal(hostname, "helium"); assert.deepEqual(options, { all: true });
    return [{ address: "172.24.0.10", family: 4 }];
  });
  const config = await replitDevelopmentPoolOptions(helium, { expectedReplId: replId, env: {
    ...development, PGHOST: "private-redirect.invalid", PGSSLMODE: "no-verify", PGOPTIONS: "private-options",
  }, signal: signal() });
  assert.equal(lookup.mock.callCount(), 1); assert.equal(config.host, "172.24.0.10");
  assert.equal(new Client(config).host, "172.24.0.10"); assert.equal(config.port, 5432);
  assert.equal(config.ssl, false); assert.equal(config.connectionString, undefined);
  assert.equal(config.user, "private-user"); assert.equal(config.password, "private-password");
  assert.equal(config.max, 1); assert.equal(config.connectionTimeoutMillis, 3000);
  assert.equal(config.options, "-c statement_timeout=2000 -c lock_timeout=1000");
  assert.equal(config.replication, "false");
  for (const env of [{ REPL_ID: replId }, { ...development, REPLIT_DEPLOYMENT: "false" }]) {
    assert.equal((await replitDevelopmentPoolOptions(helium, { expectedReplId: replId, env, signal: signal() })).ssl, false);
  }
});

test("wrong project, published or ambiguous environment, other hosts, ports and TLS profiles fail before DNS", async (t) => {
  const lookup = t.mock.method(dns, "lookup", () => { throw new Error("unexpected-DNS"); });
  for (const env of [{}, { ...development, REPL_ID: "other" }, { ...development, NODE_ENV: "production" },
    { ...development, NODE_ENV: "test" }, { ...development, NODE_ENV: "other" },
    ...["1", "true", "TRUE", "unknown"].map(REPLIT_DEPLOYMENT => ({ ...development, REPLIT_DEPLOYMENT }))]) {
    await assert.rejects(replitDevelopmentPoolOptions(helium, { expectedReplId: replId, env, signal: signal() }), /^Error: ANALYSIS_DATABASE_TARGET_INVALID$/);
  }
  for (const value of [fictional, helium.replace("helium", "10.0.0.1"), helium.replace("helium", "127.0.0.1"),
    helium.replace("helium", "helium.example"), helium.replace("helium", "helium:5433"),
    helium.replace("?sslmode=disable", ""), helium.replace("disable", "require"), `${helium}&host=private-redirect`,
    `${helium}&sslmode=disable`, `${helium}&options=private`, `${helium}&channel_binding=require`]) {
    await assert.rejects(replitDevelopmentPoolOptions(value, { expectedReplId: replId, env: development, signal: signal() }), /ANALYSIS_DATABASE_TARGET_INVALID/);
  }
  assert.equal(lookup.mock.callCount(), 0);
});

test("DNS allows only bounded all-private IPv4 results and rejects public, mixed or malformed answers", async (t) => {
  let answers: { address: string; family: number }[] = [];
  t.mock.method(dns, "lookup", async () => answers);
  const resolve = () => replitDevelopmentPoolOptions(helium, { expectedReplId: replId, env: development, signal: signal() });
  for (const address of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.0.1"]) {
    answers = [{ address, family: 4 }]; assert.equal((await resolve()).host, address);
  }
  for (const address of ["8.8.8.8", "127.0.0.1", "169.254.169.254", "172.15.0.1", "172.32.0.1", "192.169.0.1", "10.999.0.1", "::1", "fc00::1", "::ffff:10.0.0.1"]) {
    answers = [{ address, family: address.includes(":") ? 6 : 4 }];
    await assert.rejects(resolve(), /ANALYSIS_DATABASE_TARGET_INVALID/);
  }
  for (const values of [[], [{ address: "10.0.0.1", family: 6 }],
    [{ address: "10.0.0.1", family: 4 }, { address: "8.8.8.8", family: 4 }],
    Array.from({ length: 9 }, () => ({ address: "10.0.0.1", family: 4 }))]) {
    answers = values; await assert.rejects(resolve(), /ANALYSIS_DATABASE_TARGET_INVALID/);
  }
});

test("Replit DNS failure, cancellation and late completion never connect or expose private errors", async (t) => {
  const connect = t.mock.method(Pool.prototype, "connect", () => { throw new Error("unexpected-connection"); });
  const lookup = t.mock.method(dns, "lookup", async (): Promise<{ address: string; family: number }[]> => { throw new Error("private-DNS-error"); });
  const env = { ...development, DATABASE_URL: helium };
  const failed = await runAnalysisDatabaseCheck({ args: replitArgs, env, signal: signal() });
  assert.equal(failed.exitCode, 1); assert.equal(JSON.parse(failed.output).status, "target-invalid");
  assert.ok(!failed.output.includes("private"));
  let complete!: (value: { address: string; family: number }[]) => void;
  lookup.mock.mockImplementation(() => new Promise<{ address: string; family: number }[]>(resolve => { complete = resolve; }));
  const controller = new AbortController();
  const pending = runAnalysisDatabaseCheck({ args: replitArgs, env, signal: controller.signal });
  controller.abort(new Error("private-abort"));
  const cancelled = await pending; assert.equal(cancelled.exitCode, 1); assert.ok(!cancelled.output.includes("private"));
  complete([{ address: "10.0.0.1", family: 4 }]); await new Promise(done => setImmediate(done));
  const before = lookup.mock.callCount();
  await runAnalysisDatabaseCheck({ args: replitArgs, env, signal: controller.signal });
  assert.equal(lookup.mock.callCount(), before); assert.equal(connect.mock.callCount(), 0);
});

test("Replit DNS timeout returns bounded failure and ignores late private results", async (t) => {
  let complete!: (value: { address: string; family: number }[]) => void;
  t.mock.method(dns, "lookup", () => new Promise(resolve => { complete = resolve; }));
  const connect = t.mock.method(Pool.prototype, "connect", () => { throw new Error("unexpected-connection"); });
  const started = performance.now();
  const result = await runAnalysisDatabaseCheck({ args: replitArgs, env: { ...development, DATABASE_URL: helium }, signal: signal() });
  assert.equal(result.exitCode, 1); assert.equal(JSON.parse(result.output).status, "target-invalid");
  assert.ok(performance.now() - started < 4000);
  complete([{ address: "10.0.0.1", family: 4 }]); await new Promise(done => setImmediate(done));
  assert.equal(connect.mock.callCount(), 0);
});

test("Replit option reaches the DB driver only with the validated pinned address", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "10.0.0.10", family: 4 }]);
  let captured: { host: string; ssl: boolean } | undefined;
  const connect = t.mock.method(Pool.prototype, "connect", function (this: Pool & { options: { host: string; ssl: boolean } }) {
    captured = this.options;
    throw new Error("private-driver-error");
  });
  const result = await runAnalysisDatabaseCheck({ args: replitArgs, env: { ...development, DATABASE_URL: helium }, signal: signal() });
  assert.equal(captured?.host, "10.0.0.10"); assert.equal(captured?.ssl, false);
  assert.equal(connect.mock.callCount(), 1); assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.output).status, "failed"); assert.ok(!result.output.includes("private"));
});

test("CLI never infers internal approval from environment or falls back across profiles", async (t) => {
  const lookup = t.mock.method(dns, "lookup", () => { throw new Error("unexpected-DNS"); });
  const connect = t.mock.method(Pool.prototype, "connect", () => { throw new Error("unexpected-connection"); });
  for (const [args, env] of [[flags, { ...development, DATABASE_URL: helium }],
    [replitArgs, { ...development, DATABASE_URL: fictional }],
    [replitArgs, { ...development, DATABASE_URL: helium, REPL_ID: "other-project" }],
    [replitArgs, { ...development, DATABASE_URL: helium, REPLIT_DEPLOYMENT: "1" }]] as const) {
    const result = await runAnalysisDatabaseCheck({ args, env, signal: signal() });
    assert.equal(result.exitCode, 1); assert.equal(JSON.parse(result.output).status, "target-invalid");
    assert.ok(!result.output.includes("private"));
  }
  assert.equal(lookup.mock.callCount(), 0); assert.equal(connect.mock.callCount(), 0);
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
