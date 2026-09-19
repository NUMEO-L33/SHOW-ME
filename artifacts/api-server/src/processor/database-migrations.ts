import path from "node:path";
import { existsSync } from "node:fs";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";
import type { ProcessorDatabase } from "./repository.js";

export function resolveMigrationsFolder(cwd = process.cwd()): string {
  const artifactMigrations = path.resolve(cwd, "drizzle");
  const workspaceMigrations = path.resolve(cwd, "artifacts", "api-server", "drizzle");
  return existsSync(artifactMigrations) ? artifactMigrations : workspaceMigrations;
}

/** Runtime role never repairs or migrates. A separate migration login must apply the exact checked-in history first. */
export async function verifyDatabaseMigrations(database: ProcessorDatabase, migrationsFolder = resolveMigrationsFolder()) {
  try {
    const expected = readMigrationFiles({ migrationsFolder }).map(m => ({ hash: m.hash, at: String(m.folderMillis) }));
    if (!expected.length || expected.length > 100) throw new Error("DATABASE_MIGRATION_CHECK_FAILED");
    await database.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
      await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
      const actual = await tx.execute<{ hash: string; at: string }>(sql`SELECT hash, created_at::text AS at
        FROM drizzle.__drizzle_migrations ORDER BY created_at, id LIMIT 101`);
      if (JSON.stringify(actual.rows) !== JSON.stringify(expected)) throw new Error("mismatch");
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  } catch { throw new Error("DATABASE_MIGRATION_CHECK_FAILED"); }
}

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
      migrationsFolder: resolveMigrationsFolder(),
    });
  } finally {
    await pool.end();
  }
}
