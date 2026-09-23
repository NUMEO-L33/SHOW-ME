import assert from "node:assert/strict";
import test from "node:test";
import { integrationStorageArgs, runPublicationIntegrationCheck } from "../../artifacts/api-server/scripts/check-publication-integration.mjs";

test("combined storage and database check needs a separate explicit database confirmation before imports or I/O", async () => {
  const storage = ["--replit-development=00000000-0000-4000-8000-000000000001", "--confirm-synthetic-storage"];
  assert.deepEqual(integrationStorageArgs([...storage, "--confirm-synthetic-database"]), storage);
  for (const args of [[], storage, [...storage, "--yes"], [...storage, "--confirm-synthetic-database", "--extra"]]) {
    assert.throws(() => integrationStorageArgs(args), /REFUSED/);
    await assert.rejects(runPublicationIntegrationCheck(args, { DATABASE_URL: "never-connect" }), /REFUSED/);
  }
});
