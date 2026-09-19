import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { test } from "node:test";
import { operationsAdminArgs, readOperationsCommand, runAnalysisOperationsAdmin } from "../src/processor/analysis-operations-admin.js";

const signal = () => new AbortController().signal;
const args = ["--action=put", "--deployment=test", "--database=test", "--confirm-stop"];
const env = { SHOWME_OPERATOR_DATABASE_URL: "postgresql://showme_analysis_operator_fixture:fictional@127.0.0.1:1/test" };
test("operator command requires a scoped target and explicit stop acknowledgement for writes", () => {
  assert.equal(operationsAdminArgs(args)?.action, "put");
  assert.equal(operationsAdminArgs(["--action=status", "--deployment=test", "--database=test"])?.action, "status");
  for (const flags of [[], args.slice(0, 3), [...args, "--confirm-stop"], [...args, "--role=postgres"],
    [...args, "--enable-ai"], [...args, "--replit-development=wrong"], ["--help", ...args],
    args.map((arg) => arg === "--confirm-stop" ? "--confirm-stop=yes" : arg)]) assert.equal(operationsAdminArgs(flags), null);
});
test("activation has a distinct explicit acknowledgement, never inferred from stop or generic enable", () => {
  const activate = ["--action=activate", "--deployment=test", "--database=test", "--confirm-synthetic-activation"];
  assert.equal(operationsAdminArgs(activate)?.action, "activate");
  for (const invalid of [activate.slice(0, 3), [...activate, "--confirm-stop"],
    activate.map(v => v === "--confirm-synthetic-activation" ? "--confirm-stop" : v),
    activate.map(v => v === "--action=activate" ? "--action=status" : v)]) assert.equal(operationsAdminArgs(invalid), null);
  assert.equal(operationsAdminArgs(args.map(v => v === "--action=put" ? "--action=deactivate" : v))?.action, "deactivate");
});
test("help and invalid arguments never read input or connect; application credentials are not a fallback", async () => {
  const readCommand = async () => { throw new Error("must not read"); };
  assert.equal((await runAnalysisOperationsAdmin({ args: ["--help"], env: {}, signal: signal(), readCommand })).exitCode, 0);
  assert.equal((await runAnalysisOperationsAdmin({ args: [], env, signal: signal(), readCommand })).exitCode, 2);
  const result = await runAnalysisOperationsAdmin({ args, env: { DATABASE_URL: env.SHOWME_OPERATOR_DATABASE_URL }, signal: signal(), readCommand });
  assert.equal(result.exitCode, 1); assert.equal(JSON.parse(result.output).writeOutcome, "not-attempted");
});
test("operator input is bounded JSON and cancellation stops an unfinished stdin read", async () => {
  assert.deepEqual(await readOperationsCommand(Readable.from([Buffer.from('{"type":"put"}')]), signal()), { type: "put" });
  await assert.rejects(readOperationsCommand(Readable.from([Buffer.alloc(32769)]), signal()));
  await assert.rejects(readOperationsCommand(Readable.from([Buffer.from("not json")]), signal()));
  const stream = new PassThrough(); const controller = new AbortController();
  const pending = readOperationsCommand(stream, controller.signal); controller.abort(); await assert.rejects(pending);
  assert.equal(stream.destroyed, true);
});
test("operator target mismatch and ordinary app/admin role are rejected before reading a command", async () => {
  let reads = 0;
  for (const value of [env.SHOWME_OPERATOR_DATABASE_URL.replace("/test", "/other"),
    env.SHOWME_OPERATOR_DATABASE_URL.replace("showme_analysis_operator_fixture", "postgres"),
    env.SHOWME_OPERATOR_DATABASE_URL + "?options=redirect"]) {
    const result = await runAnalysisOperationsAdmin({ args, env: { SHOWME_OPERATOR_DATABASE_URL: value }, signal: signal(), readCommand: async () => { reads++; return {}; } });
    assert.equal(result.exitCode, 1); assert.ok(!result.output.includes(value));
  }
  assert.equal(reads, 0);
});
test("JSON cannot assign an actor, switch deployment/action or lift the body limit", async () => {
  for (const raw of [{ type: "put", review: { reviewerRef: "impersonated" } }, { type: "revoke" },
    { type: "put", review: { deploymentRef: "other" } }, { text: "x".repeat(32769) }]) {
    const result = await runAnalysisOperationsAdmin({ args, env, signal: signal(), readCommand: async () => raw });
    assert.equal(result.exitCode, 1); assert.equal(JSON.parse(result.output).writeOutcome, "not-attempted");
  }
});
