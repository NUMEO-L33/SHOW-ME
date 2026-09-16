import path from "node:path";

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
    await migrate(drizzle(pool), {
      migrationsFolder: path.resolve(process.cwd(), "processor", "drizzle"),
    });
  } finally {
    await pool.end();
  }
}
