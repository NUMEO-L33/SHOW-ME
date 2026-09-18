import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool, type PoolConfig } from "pg";

import { PostgresAnalysisDatabaseProbe } from "./analysis-database-probe.js";
import { PostgresGuideRepository } from "./repository.js";

const flags = ["--configured-database", "--read-only"];
const help = "ShowMe DB 조건 점검\n사용: pnpm --filter @workspace/api-server check:analysis-db --configured-database --read-only\n"
  + "현재 프로세스의 DATABASE_URL에 읽기 전용으로 접속합니다. .env 로딩·migration·복구·서버 시작·AI 전송은 하지 않습니다.\n"
  + "먼저 올바른 프로젝트/개발·운영 환경인지 확인하세요. URL이나 비밀번호를 명령 인수에 넣지 마세요.\n"
  + "종료 코드: 0=DB 부분 점검 통과(AI 준비 완료 아님), 1=점검 실패, 2=명시적 실행 인수 필요.\n";
const migrationsFolder = fileURLToPath(new URL("../../drizzle/", import.meta.url));

export function databaseCheckMode(args: readonly string[]): "help" | "inspect" | "invalid" {
  if (args.length === 1 && args[0] === "--help") return "help";
  return args.length === flags.length && flags.every((flag) => args.includes(flag)) ? "inspect" : "invalid";
}

/** No libpq/environment fallbacks, URL option redirects or TLS downgrades. Never print the returned config. */
export function databaseCheckPoolOptions(value: string | undefined): PoolConfig & { replication: "false" } {
  const invalid = (): never => { throw new Error("ANALYSIS_DATABASE_TARGET_INVALID"); };
  if (!value || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) invalid();
  try {
    const url = new URL(value!);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const user = decodeURIComponent(url.username); const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    const port = url.port ? Number(url.port) : 5432;
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash || !host ||
        (!isIP(host) && !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) ||
        !user || !password || !database || /[\u0000-\u001f\u007f]/.test(user + password + database) ||
        database.includes("/") || !Number.isInteger(port) || port < 1 || port > 65535) invalid();
    // Advanced connection profiles need an explicit review; never silently reinterpret them.
    const entries = [...url.searchParams.entries()];
    if (entries.length > 1 || entries.some(([key]) => key !== "sslmode")) invalid();
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());
    const mode = url.searchParams.get("sslmode");
    if (mode !== "require" && mode !== "verify-full" && !(loopback && (mode === null || mode === "disable"))) invalid();
    return {
      host, port, user, password, database,
      ssl: mode === "require" || mode === "verify-full" ? { rejectUnauthorized: true } : false,
      sslnegotiation: "postgres", options: "-c statement_timeout=2000 -c lock_timeout=1000", replication: "false",
      application_name: "showme-analysis-database-check",
      fallback_application_name: "showme-analysis-database-check", client_encoding: "UTF8",
      max: 1, connectionTimeoutMillis: 3000, query_timeout: 3000,
      statement_timeout: 2000, lock_timeout: 1000, idle_in_transaction_session_timeout: 3000,
    };
  } catch { return invalid(); }
}

function report(status: "passed" | "failed" | "arguments-required" | "target-invalid") {
  return { kind: "analysis-database-check", scope: "database-only", status,
    ready: false, authorizesAnalysis: false, changesApplied: false } as const;
}

/** Explicit standalone inspection. Importing this module never starts inspection or loads app config/.env. */
export async function runAnalysisDatabaseCheck(options: {
  args: readonly string[]; env: Readonly<Record<string, string | undefined>>; signal: AbortSignal;
}) {
  const mode = databaseCheckMode(options.args);
  if (mode === "help") return { exitCode: 0, output: help };
  if (mode !== "inspect") return { exitCode: 2, output: JSON.stringify(report("arguments-required")) };
  let config: PoolConfig;
  try { config = databaseCheckPoolOptions(options.env.DATABASE_URL?.trim()); }
  catch { return { exitCode: 1, output: JSON.stringify(report("target-invalid")) }; }
  if (options.signal.aborted) return { exitCode: 1, output: JSON.stringify(report("failed")) };
  let pool: Pool | undefined; let output = JSON.stringify(report("failed")); let exitCode = 1;
  const stopped = new AbortController();
  try {
    pool = new Pool(config);
    // Idle connection errors must not become raw error events on stdout/stderr.
    pool.on("error", () => stopped.abort());
    const repository = PostgresGuideRepository.fromPool(pool);
    const probe = new PostgresAnalysisDatabaseProbe({ database: repository.database, migrationsFolder });
    const signal = AbortSignal.any([options.signal, stopped.signal]);
    const observation = await probe.inspect(signal);
    signal.throwIfAborted();
    output = JSON.stringify({ ...report("passed"), observation }); exitCode = 0;
  } catch { /* Only the fixed failure report escapes; never a DB error or connection config. */ }
  finally {
    try { await pool?.end(); } catch { stopped.abort(); }
    if (options.signal.aborted || stopped.signal.aborted) { output = JSON.stringify(report("failed")); exitCode = 1; }
  }
  return { exitCode, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  // Last-resort ceiling for this disposable CLI only, never the running server/pool.
  const watchdog = setTimeout(() => { console.log(JSON.stringify(report("failed"))); process.exit(1); }, 10_000);
  try {
    const result = await runAnalysisDatabaseCheck({ args: process.argv.slice(2), env: process.env, signal: controller.signal });
    console.log(result.output); process.exitCode = result.exitCode;
  } catch { console.log(JSON.stringify(report("failed"))); process.exitCode = 1; }
  finally { clearTimeout(watchdog); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
