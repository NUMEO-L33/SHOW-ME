// Opt-in diagnostic only. No imports of application startup, .env or SDK auth.
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { CheckFailure, checkPrivateAccess, checkedOrigin, cleanupRun, createRun, safeCode } from "./private-access-check.mjs";
import { assertPreviousProcessStopped, recoveryStore } from "./private-access-recovery.mjs";

export function parseArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { mode: "help" };
  if (args.length === 1 && args[0] === "--cleanup-only") return { mode: "cleanup" };
  if (args[0] === "--run-synthetic" && (args.length === 1 || (args.length === 3 && args[1] === "--origin"))) {
    return { mode: "run", origin: checkedOrigin(args[2] ?? "http://127.0.0.1:8080") };
  }
  throw new CheckFailure("EXPLICIT_OPT_IN_REQUIRED");
}
export async function main(args = process.argv.slice(2)) {
  const report = code => console.log(`PRIVATE_ACCESS_CHECK ${code}`);
  const abort = new AbortController();
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) process.exit(130); // Recovery file remains for a hard stop.
    interrupted = true;
    abort.abort();
    report("STOPPING_THEN_CLEANING");
  };
  try {
    const options = parseArguments(args);
    if (options.mode === "help") {
      console.log("Opt-in synthetic API check; creates one test guide, checks private access, then deletes it. No AI calls.");
      console.log("node scripts/check-private-access.mjs --run-synthetic [--origin https://YOUR-APP.replit.dev]");
      console.log("Default destination: http://127.0.0.1:8080 (API only, not a browser/HTTPS audit).");
      console.log("node scripts/check-private-access.mjs --cleanup-only");
      console.log("Recovery credentials are private in .private-access-check/run.json; never share that file.");
      return 0;
    }
    const store = recoveryStore(fileURLToPath(new URL("../.private-access-check/", import.meta.url)));
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    if (options.mode === "cleanup") {
      const run = await store.read();
      assertPreviousProcessStopped(run);
      await cleanupRun(run);
      await store.clear(run);
      report("TEST_GUIDE_DELETED");
      report("CLEANUP_ONLY_DONE"); // Not an access-check PASS.
    } else {
      await store.assertEmpty();
      report(options.origin.startsWith("http://") || new URL(options.origin).hostname === "localhost" ||
        new URL(options.origin).hostname === "127.0.0.1" ? "TARGET_LOOPBACK_API" : "TARGET_REPLIT_HTTPS_API");
      await checkPrivateAccess(createRun(options.origin), { signal: abort.signal, report,
        saveRecovery: run => store.save(run), clearRecovery: run => store.clear(run) });
    }
    return interrupted ? 130 : 0;
  } catch (error) {
    report(`FAIL ${safeCode(error)}`);
    console.log("If a recovery record remains, use --cleanup-only. Do not upload run.json or delete it to hide an unfinished cleanup.");
    return interrupted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
