import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Read-only checks. Do not import the server, load .env, install packages,
// invoke the post-merge hook, or connect to DB/Storage/AI services here.
const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

function assertDependencyOnlyHook(source) {
  const commands = source.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(commands, ["set -euo pipefail", "pnpm install --frozen-lockfile"]);
}

test("the configured post-merge hook only installs locked dependencies", () => {
  const settings = read(".replit");
  const section = settings.match(/\[postMerge\]\s*([^]*?)(?=\n\[|$)/)?.[1];
  assert.ok(section, "postMerge configuration is missing");
  assert.match(section, /^path\s*=\s*"scripts\/post-merge\.sh"\s*$/m);
  assertDependencyOnlyHook(read("scripts/post-merge.sh"));
});

test("the hook guard rejects DB changes and server starts", () => {
  const safe = "#!/bin/bash\nset -euo pipefail\npnpm install --frozen-lockfile\n";
  for (const command of ["pnpm --filter db push", "pnpm --filter @workspace/db push-force",
    "pnpm exec drizzle-kit migrate", "pnpm --filter @workspace/api-server run start"]) {
    assert.throws(() => assertDependencyOnlyHook(safe + command));
  }
});

test("shell hooks retain Linux line endings across Windows checkouts", () => {
  assert.match(read(".gitattributes"), /^\*\.sh\s+text\s+eol=lf\s*$/m);
  assert.ok(!readFileSync(join(root, "scripts/post-merge.sh"), "utf8").includes("\r"));
});

test("the migration test command runs this suite without starting the application", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  assert.equal(scripts["test:migration"], "node scripts/run-tests.mjs migration");
});

function isIgnored(path) {
  const result = spawnSync("git", ["-c", `safe.directory=${root.replace(/\\/g, "/")}`,
    "-c", "core.excludesFile=", "check-ignore", "--no-index", "-z", "--stdin"], {
    cwd: root, input: path + "\0", encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  assert.ok(result.status === 0 || result.status === 1,
    `git check-ignore failed for synthetic path ${path} (status ${result.status})`);
  return result.status === 0;
}

for (const path of [
  ".env", ".env.local", ".env.production", ".env.example.local",
  "artifacts/api-server/.env", "artifacts/showme/.env.local", "processor/.env",
  "keys/signing.pem", "keys/signing.key", "keys/client.p12", "keys/client.pfx",
  "processor/.data/guides.json", "artifacts/api-server/processor/.data/objects/source.mp4",
  "artifacts/api-server/.data/work/frame.jpg", "artifacts/api-server/coverage/report.json",
  ".sites-runtime/profile.json", ".agents/local.md", ".codex/local.json",
  ".wrangler/state/db.sqlite", "work/synthetic-upload.mp4", "outputs/synthetic-frame.jpg",
  "screenshots/private-screen.png",
]) {
  test(`private/generated path is excluded: ${path}`, () => assert.equal(isIgnored(path), true));
}

for (const path of [
  ".env.example", "artifacts/api-server/.env.example", "artifacts/showme/.env.example",
  ".migration-backup/.env.example", ".migration-backup/processor/.env.example",
  ".replit", "replit.nix", "pnpm-lock.yaml", "scripts/post-merge.sh",
  "artifacts/api-server/src/processor/config.ts", "artifacts/api-server/drizzle/0000_slim_raider.sql",
  "artifacts/api-server/tests/example.test.ts", "artifacts/showme/src/lib/processor-client.test.ts",
  "artifacts/showme/public/tutorial.mp4",
]) {
  test(`source/template path stays trackable: ${path}`, () => assert.equal(isIgnored(path), false));
}

test("Replit media checks remain mandatory and do not silently fall back", () => {
  const config = read("artifacts/api-server/src/processor/config.ts");
  const binary = read("artifacts/api-server/src/processor/media/binary-version.ts");
  assert.match(config, /if \(isReplitRuntime\) return commandFallback;/);
  assert.doesNotMatch(config, /spawnSync/);
  assert.match(binary, /timeoutMs = 30_000/);
  assert.match(binary, /securityFloorEnforced = config\.nodeEnv === "production" \|\| config\.isReplitRuntime;/);
  assert.match(binary, /assertReviewedMediaBinaryPair\(ffmpeg, ffprobe, config\.expectedMediaVersion\)/);
});

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

test("historical migration files stay unchanged when new migrations are added", () => {
  const backup = join(root, ".migration-backup/processor/drizzle");
  const active = join(root, "artifacts/api-server/drizzle");
  const names = (directory) => filesBelow(directory).map((path) => relative(directory, path)).sort();
  const activeNames = new Set(names(active));
  for (const name of names(backup)) {
    assert.ok(activeNames.has(name), `historical migration missing: ${name}`);
    const normalized = (directory) => readFileSync(join(directory, name), "utf8").replace(/\r\n/g, "\n");
    if (name.replace(/\\/g, "/") === "meta/_journal.json") {
      const previous = JSON.parse(normalized(backup));
      const current = JSON.parse(normalized(active));
      assert.equal(current.version, previous.version);
      assert.equal(current.dialect, previous.dialect);
      assert.deepEqual(current.entries.slice(0, previous.entries.length), previous.entries);
      continue;
    }
    assert.equal(normalized(active), normalized(backup), `migration changed: ${name}`);
  }
});

test("every preserved processor unit test and helper has an active counterpart", () => {
  const backup = join(root, ".migration-backup/processor/tests");
  const active = join(root, "artifacts/api-server/tests");
  const activeFiles = new Set(filesBelow(active).map((path) => relative(active, path)));
  for (const file of filesBelow(backup)) {
    assert.ok(activeFiles.has(relative(backup, file)), `test/helper missing: ${relative(backup, file)}`);
  }
  for (const file of filesBelow(active)) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /\.migration-backup|["'`]processor\/(src|drizzle)\//,
      `test must target the active package: ${relative(active, file)}`);
  }
  assert.ok(read("artifacts/showme/src/lib/processor-client.test.ts").includes('from "./processor-client.js"'));
});

test("functional tests declare their loaders and HTTP test dependencies directly", () => {
  const api = JSON.parse(read("artifacts/api-server/package.json"));
  const client = JSON.parse(read("artifacts/showme/package.json"));
  assert.equal(api.devDependencies.tsx, "catalog:");
  assert.ok(api.devDependencies.supertest);
  assert.ok(api.devDependencies["@types/supertest"]);
  assert.equal(client.devDependencies.tsx, "catalog:");
  assert.equal(api.scripts.test, "node ../../scripts/run-tests.mjs server");
  assert.equal(client.scripts.test, "node ../../scripts/run-tests.mjs client");
  assert.ok(api.scripts.typecheck.includes("tsconfig.test.json"));
  assert.ok(client.scripts.typecheck.includes("tsconfig.test.json"));
});

test("PostgreSQL verification remains a separate guarded local fixture command", () => {
  const source = read("artifacts/api-server/scripts/verify-postgres.mjs");
  assert.match(source, /process\.argv\[2\] !== "--local-docker"/);
  assert.match(source, /--pull=never/);
  assert.match(source, /127\.0\.0\.1::5432/);
  assert.match(source, /testEnvironment\(process\.env\)/);
  assert.doesNotMatch(read("scripts/run-tests.mjs"), /integration\/postgres|verify-postgres/);
});
