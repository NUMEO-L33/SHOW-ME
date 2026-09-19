import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable } from "node:stream";
import { Pool } from "pg";
import { databaseCheckPoolOptions, replitDevelopmentPoolOptions } from "./analysis-database-check.js";
import { analysisOperationsCommandSchema, analysisActivationCommandSchema, operationsActorRef, PostgresAnalysisOperationsStore } from "./analysis-operations-store.js";

const MAX_COMMAND_BYTES = 32 * 1024;
const help = "ShowMe 운영 기록·합성 작업 활성화 관리\n"
  + "--action=status|put|revoke|activate|deactivate --deployment=<대상> --database=<확인한 DB 이름>\n"
  + "put/revoke에는 --confirm-stop이 필요합니다. 명령 JSON은 표준 입력으로 받습니다.\n"
  + "activate에는 --confirm-synthetic-activation, deactivate에는 --confirm-stop이 필요합니다.\n"
  + "전용 SHOWME_OPERATOR_DATABASE_URL의 showme_analysis_operator_<개별이름> 로그인만 사용합니다.\n"
  + "앱 DATABASE_URL/상속된 PG* 설정은 사용하지 않으며 비밀번호를 명령 인수에 넣지 마세요.\n"
  + "승인된 Replit 개발 DB는 --replit-development=<확인한 프로젝트 UUID>를 추가합니다.\n"
  + "기록 저장/철회는 같은 DB의 AI 실행을 중지합니다. 활성화는 현재 승인과 정확한 합성 작업에만 적용됩니다.\n"
  + "자동 재개·권한 생성·배포·AI 직접 호출은 하지 않습니다.\n";

export function operationsAdminArgs(args: readonly string[]) {
  if (args.length === 1 && args[0] === "--help") return { action: "help" as const };
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^(--[a-z-]+)(?:=(.+))?$/.exec(arg);
    if (!match || values.has(match[1]) || !["--action", "--deployment", "--database", "--confirm-stop", "--confirm-synthetic-activation", "--replit-development"].includes(match[1])) return null;
    values.set(match[1], match[2] ?? "");
  }
  const action = values.get("--action"), deployment = values.get("--deployment"), database = values.get("--database");
  const replit = values.get("--replit-development");
  if (!["status", "put", "revoke", "activate", "deactivate"].includes(action ?? "") || !/^[A-Za-z0-9._:-]{1,128}$/.test(deployment ?? "") ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(database ?? "") ||
      (action === "status" || action === "activate" ? values.has("--confirm-stop") : values.get("--confirm-stop") !== "") ||
      (action === "activate" ? values.get("--confirm-synthetic-activation") !== "" : values.has("--confirm-synthetic-activation")) ||
      (replit !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(replit))) return null;
  return { action: action as "status" | "put" | "revoke" | "activate" | "deactivate", deployment: deployment!, database: database!, replit };
}

export async function readOperationsCommand(stream: Readable, signal: AbortSignal): Promise<unknown> {
  const abort = () => stream.destroy(new Error("OPERATIONS_INPUT_CANCELLED"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted(); const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of stream) {
      signal.throwIfAborted(); const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length; if (size > MAX_COMMAND_BYTES) throw new Error("OPERATIONS_INPUT_INVALID");
      chunks.push(bytes);
    }
    signal.throwIfAborted(); return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { signal.removeEventListener("abort", abort); }
}

function report(status: string, extra: Record<string, unknown> = {}) {
  return { kind: "analysis-operations-admin", status, authorizesAnalysis: false, ...extra };
}

/** Explicit shell entry point, authenticated by a dedicated PostgreSQL LOGIN role. Never an HTTP admin route. */
export async function runAnalysisOperationsAdmin(options: { args: readonly string[];
  env: Readonly<Record<string, string | undefined>>; signal: AbortSignal; readCommand: (signal: AbortSignal) => Promise<unknown> }) {
  const args = operationsAdminArgs(options.args);
  if (!args) return { exitCode: 2, output: JSON.stringify(report("arguments-required")) };
  if (args.action === "help") return { exitCode: 0, output: help };
  let pool: Pool | undefined; let writeAttempted = false;
  try {
    options.signal.throwIfAborted();
    const config = args.replit
      ? await replitDevelopmentPoolOptions(options.env.SHOWME_OPERATOR_DATABASE_URL, {
        expectedReplId: args.replit, env: options.env, signal: options.signal })
      : databaseCheckPoolOptions(options.env.SHOWME_OPERATOR_DATABASE_URL);
    if (config.database !== args.database || !/^showme_analysis_operator_[a-z0-9_]{1,38}$/.test(config.user ?? "")) throw new Error("invalid target");
    const role = config.user!;
    let command: ReturnType<typeof analysisOperationsCommandSchema.parse> | undefined;
    let activationCommand: ReturnType<typeof analysisActivationCommandSchema.parse> | undefined;
    if (args.action !== "status") {
      const raw = await options.readCommand(options.signal);
      if (Buffer.byteLength(JSON.stringify(raw), "utf8") > MAX_COMMAND_BYTES) throw new Error("invalid input");
      // Actor identity is assigned from the separately authenticated connection, never a JSON claim.
      if (!raw || typeof raw !== "object" || !("type" in raw) || raw.type !== args.action) throw new Error("invalid input");
      if (raw.type === "put") {
        if (!("review" in raw) || !raw.review || typeof raw.review !== "object" || "reviewerRef" in raw.review) throw new Error("invalid actor");
        command = analysisOperationsCommandSchema.parse({ ...raw, review: { ...raw.review, reviewerRef: operationsActorRef(role) } });
      } else if (raw.type === "activate" || raw.type === "deactivate") activationCommand = analysisActivationCommandSchema.parse(raw);
      else command = analysisOperationsCommandSchema.parse(raw);
      if ((activationCommand?.deploymentRef ?? (command?.type === "put" ? command.review.deploymentRef : command?.deploymentRef)) !== args.deployment) throw new Error("invalid deployment");
    }
    options.signal.throwIfAborted();
    pool = new Pool({ ...config, application_name: "showme-analysis-operations-admin", fallback_application_name: "showme-analysis-operations-admin" });
    const failed = new AbortController(); pool.on("error", () => failed.abort());
    const signal = AbortSignal.any([options.signal, failed.signal]);
    const store = new PostgresAnalysisOperationsStore({ pool, writerRoles: [role] });
    if (!command && !activationCommand) {
      const observation = await store.observe(args.deployment, signal);
      const lastActivationEvent = await store.activationStatus(signal);
      return { exitCode: 0, output: JSON.stringify(report("observed", { halted: observation.halted,
        version: observation.entry?.version ?? 0, state: observation.entry?.review.state ?? "missing",
        reviewId: observation.entry?.review.id ?? null,
        lastActivationVersion: lastActivationEvent?.version ?? 0,
        lastActivationAction: lastActivationEvent?.action ?? null })) };
    }
    writeAttempted = true;
    if (activationCommand) {
      const result = await store.executeActivation(activationCommand, signal);
      return { exitCode: 0, output: JSON.stringify(report("recorded", { activationVersion: result.entry.version,
        action: result.entry.action, activationId: result.entry.activation?.id ?? null, replayed: result.replayed,
        writeOutcome: "confirmed", requiresCurrentStatusCheck: true })) };
    }
    const result = await store.execute(command!, signal);
    return { exitCode: 0, output: JSON.stringify(report("recorded", { version: result.entry.version,
      state: result.entry.review.state, replayed: result.replayed, writeOutcome: "confirmed",
      // An idempotent receipt may precede a later change. It is NOT current runtime permission.
      requiresCurrentStatusCheck: true })) };
  } catch {
    return { exitCode: 1, output: JSON.stringify(report("failed", { writeOutcome: writeAttempted ? "unknown" : "not-attempted" })) };
  } finally { await pool?.end().catch(() => undefined); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const deadline = setTimeout(stop, 15_000);
  const watchdog = setTimeout(() => { console.log(JSON.stringify(report("failed", { writeOutcome: "unknown" }))); process.exit(1); }, 20_000);
  try {
    const result = await runAnalysisOperationsAdmin({ args: process.argv.slice(2), env: process.env, signal: controller.signal,
      readCommand: (signal) => readOperationsCommand(process.stdin, signal) });
    console.log(result.output); process.exitCode = result.exitCode;
  } catch { console.log(JSON.stringify(report("failed", { writeOutcome: "unknown" }))); process.exitCode = 1; }
  finally { clearTimeout(deadline); clearTimeout(watchdog); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
