// Explicit development acceptance only. Uses the EXISTING runtime binding;
// never reads .env, migrates, grants permissions, starts product workers or AI.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function integrationStorageArgs(args) {
  if (args.length !== 3 || args[2] !== "--confirm-synthetic-database") throw new Error("PUBLICATION_INTEGRATION_REFUSED");
  return args.slice(0, 2);
}

export async function runPublicationIntegrationCheck(args, source, log = console.log) {
  const storageArgs = integrationStorageArgs(args);
  const { publicationStorageTarget, runPublicationStorageCheck } = await import("./check-publication-storage.ts");
  if (publicationStorageTarget(storageArgs, source).mode !== "replit") throw new Error("PUBLICATION_INTEGRATION_REFUSED");
  const { readRuntimeBinding, runtimeEnvironment } = await import("./start.mjs");
  const env = runtimeEnvironment(source, await readRuntimeBinding());
  const { Pool } = await import("pg");
  const { PostgresGuideRepository } = await import("../src/processor/repository.ts");
  const { verifyAnalysisRuntimeRole } = await import("../src/processor/analysis-bootstrap.ts");
  const { verifyDatabaseMigrations } = await import("../src/processor/database-migrations.ts");
  const { verifyPublicationCheckRemoved, verifyPublicationCheckPrivileges } = await import("./publication-check-scope.ts");
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 3, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 10000,
    application_name: "showme-synthetic-publication-check" });
  try {
    const repository = PostgresGuideRepository.fromPool(pool);
    await verifyAnalysisRuntimeRole(pool, AbortSignal.timeout(10_000));
    await verifyDatabaseMigrations(repository.database);
    await verifyPublicationCheckPrivileges(pool);
    log("PUBLICATION_INTEGRATION_CHECK RUNTIME_ROLE_AND_SCHEMA_OK");
    const result = await runPublicationStorageCheck(storageArgs, env, log,
      { repository, verifyRemoved: id => verifyPublicationCheckRemoved(pool, id),
        seedTransaction: work => repository.database.transaction(tx => work(new PostgresGuideRepository(tx))) });
    log(`PUBLICATION_INTEGRATION_CHECK ${result.passed ? "PASS" : "FAIL"}`);
    return result;
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const watchdog = setTimeout(() => { console.error("PUBLICATION_INTEGRATION_CHECK INCOMPLETE_PROCESS_DEADLINE"); process.exit(1); }, 240_000);
  watchdog.unref();
  try { if (!(await runPublicationIntegrationCheck(process.argv.slice(2), process.env)).passed) process.exitCode = 1; }
  catch { console.error("PUBLICATION_INTEGRATION_CHECK REFUSED_OR_FAILED (no connection details)"); process.exitCode = 2; }
}
