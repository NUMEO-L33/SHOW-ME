import { mkdir, open, lstat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { runtimeBindingPath } from "./start.mjs";
import { replitDevelopmentPoolOptions } from "../src/processor/analysis-database-check.ts";
import { createOperatorRole } from "../src/processor/operator-role-setup.ts";

// Operator credentials are never loaded by product startup or committed to Git.
const bindingPath = join(dirname(runtimeBindingPath), "operator-db.json");
let pool, file, ownedFile = false;
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[1] !== "--confirm-create-operator" || !args[0].startsWith("--replit-development=")) throw new Error();
  const replId = args[0].slice("--replit-development=".length);
  if (![undefined, "", "off"].includes(process.env.SHOWME_ANALYSIS_MODE)) throw new Error();
  const target = await replitDevelopmentPoolOptions(process.env.DATABASE_URL, { expectedReplId: replId,
    env: process.env, signal: AbortSignal.timeout(5000) });
  const directory = dirname(bindingPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error();
  file = await open(bindingPath, "wx", 0o600); ownedFile = true;
  pool = new Pool({ ...target, max: 2 });
  const result = await createOperatorRole({ admin: pool, target, persist: async ({ role, password }) => {
    const url = new URL(process.env.DATABASE_URL); url.username = role; url.password = password;
    await file.writeFile(JSON.stringify({ kind: "showme-development-operator-v1", replId, connectionString: url.toString() }));
    await file.sync();
    await file.close(); file = undefined;
  } });
  ownedFile = false;
  console.log(JSON.stringify({ check: "SHOWME_OPERATOR_ROLE_READY", ...result, credentialPrinted: false }));
} catch {
  await file?.close().catch(() => undefined);
  if (ownedFile) await unlink(bindingPath).catch(() => undefined);
  console.error("SHOWME_OPERATOR_SETUP_FAILED (no credential details; existing binding is never overwritten)"); process.exitCode = 1;
} finally { await pool?.end(); }
