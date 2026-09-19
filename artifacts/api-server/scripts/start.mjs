import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

export const runtimeBindingPath = fileURLToPath(new URL("../../../.local/showme/runtime-db.json", import.meta.url));
export const usesDevelopmentBinding = env => !!env.REPL_ID && !["1", "true"].includes(env.REPLIT_DEPLOYMENT);
const unavailable = () => { throw new Error("SHOWME_RUNTIME_DATABASE_SETUP_REQUIRED"); };

/** Development-only selection, not a secret manager or an OS isolation boundary. */
export function runtimeEnvironment(source, binding) {
  if (!usesDevelopmentBinding(source)) return { ...source };
  if (![undefined, "", "development"].includes(source.NODE_ENV) || !binding ||
      Object.keys(binding).sort().join() !== "connectionString,kind,replId" ||
      binding.kind !== "showme-development-runtime-v1" || binding.replId !== source.REPL_ID ||
      typeof binding.connectionString !== "string" || binding.connectionString.length > 8192) unavailable();
  let url;
  try { url = new URL(binding.connectionString); } catch { unavailable(); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "helium" ||
      (url.port && url.port !== "5432") || url.hash || !/^showme_runtime_[a-z0-9_]{1,40}$/.test(url.username) ||
      !/^[a-f0-9]{64}$/.test(url.password) || !/^\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname) ||
      [...url.searchParams].length !== 1 || url.searchParams.get("sslmode") !== "disable") unavailable();
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !/^PG/i.test(key) &&
    !["DATABASE_URL", "SHOWME_OPERATOR_DATABASE_URL", "SHOWME_MIGRATION_DATABASE_URL", "NODE_OPTIONS"].includes(key)));
  env.DATABASE_URL = binding.connectionString;
  env.SHOWME_DATABASE_MIGRATIONS = "verify-only";
  env.SHOWME_ANALYSIS_MODE = source.SHOWME_ANALYSIS_MODE || "off";
  if (env.SHOWME_ANALYSIS_MODE === "off") delete env.GEMINI_API_KEY;
  return env;
}

export async function readRuntimeBinding(path = runtimeBindingPath) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 8192 || stat.nlink !== 1 ||
        (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) unavailable();
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const env = runtimeEnvironment(process.env, usesDevelopmentBinding(process.env) ? await readRuntimeBinding() : undefined);
    const child = spawn(process.execPath, ["--enable-source-maps", fileURLToPath(new URL("../dist/index.mjs", import.meta.url))],
      { env, stdio: "inherit", windowsHide: true });
    const stop = signal => child.kill(signal);
    process.once("SIGINT", () => stop("SIGINT")); process.once("SIGTERM", () => stop("SIGTERM"));
    child.once("error", () => { console.error("SHOWME_RUNTIME_START_FAILED"); process.exitCode = 1; });
    child.once("exit", code => { process.exitCode = code ?? 1; });
  } catch { console.error("SHOWME_RUNTIME_DATABASE_SETUP_REQUIRED (no credential details)"); process.exitCode = 1; }
}
