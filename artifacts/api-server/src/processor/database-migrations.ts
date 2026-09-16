import path from "node:path";
import { existsSync } from "node:fs";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Applies checked-in migrations after the HTTP listener is available. The
 * readiness routes remain 503 until this finishes, so a hosting probe never
 * promotes a schema-incompatible process and never waits on a closed port.
 */
export async function runDatabaseMigrations(databaseUrl?: string): Promise<void> {
  if (!databaseUrl) return;

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 12_000,
    statement_timeout: 12_000,
    max: 1,
  });
  try {
    const artifactMigrations = path.resolve(process.cwd(), "drizzle");
    const workspaceMigrations = path.resolve(process.cwd(), "artifacts", "api-server", "drizzle");
    await migrate(drizzle(pool), {
      migrationsFolder: existsSync(artifactMigrations) ? artifactMigrations : workspaceMigrations,
    });
  } finally {
    await pool.end();
  }
}
