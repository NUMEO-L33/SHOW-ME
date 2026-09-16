import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL?.trim();

export default defineConfig({
  dialect: "postgresql",
  schema: "./processor/src/db/schema.ts",
  out: "./processor/drizzle",
  strict: true,
  verbose: true,
  dbCredentials: databaseUrl ? { url: databaseUrl } : undefined,
});
