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

function assertHeadlessMediaDependency(source) {
  assert.match(source, /https:\/\/github\.com\/NixOS\/nixpkgs\/archive\/1559d3daa3ecc813a650b79375ea61b6741b8746\.tar\.gz/);
  assert.match(source, /assert showmePkgs\.ffmpeg_8-headless\.version == "8\.1\.2";/);
  assert.match(source, /deps = \[ showmePkgs\.ffmpeg_8-headless \];/);
  assert.doesNotMatch(source, /ffmpeg_8-full|\.override(?:Attrs)?\b/);
}

test("Replit uses the pinned headless FFmpeg without changing the reviewed version", () => {
  assertHeadlessMediaDependency(read("replit.nix"));
  const loader = read("artifacts/api-server/src/processor/analysis-images.ts");
  const budgets = read("artifacts/api-server/src/processor/analysis-image-policy.ts");
  assert.match(budgets, /ioMs: 4_500/);
  assert.match(budgets, /maxIoMs: 5_000/);
  assert.match(budgets, /decodeMs: 10_000/);
  assert.match(budgets, /maxTotalMs: 15_000/);
  assert.match(loader, /ioTimeoutMs > ANALYSIS_IMAGE_BUDGET.maxIoMs/);
  assert.match(loader, /decodeTimeoutMs > ANALYSIS_IMAGE_BUDGET.decodeMs/);
  assert.match(loader, /await decodeJpeg\(bytes, selected\.width, selected\.height, ffmpegPath, controller\.signal\);/);
  assert.match(loader, /phase\(remainingIoMs\)/);
});

test("the media dependency guard rejects full fallback, unpinned source and version relaxation", () => {
  const source = read("replit.nix");
  for (const changed of [
    source.replaceAll("ffmpeg_8-headless", "ffmpeg_8-full"),
    source.replace("1559d3daa3ecc813a650b79375ea61b6741b8746", "master"),
    source.replace('== "8.1.2"', '== "8.1.0"'),
    source.replace("deps = [ showmePkgs.ffmpeg_8-headless ];", "deps = [ showmePkgs.ffmpeg_8-full ];"),
  ]) assert.throws(() => assertHeadlessMediaDependency(changed));
});

test("headless verification runs the original images once without warm-up or production calls", () => {
  const source = read("scripts/check-replit-media.sh");
  assert.ok(!readFileSync(join(root, "scripts/check-replit-media.sh"), "utf8").includes("\r"));
  assert.match(source, /set -euo pipefail/);
  assert.match(source, /import \.\/replit\.nix \{ inherit pkgs; \}/);
  assert.match(source, /HEADLESS_MEDIA_NOT_SELECTED/);
  assert.match(source, /MEDIA_PAIR_MISMATCH/);
  assert.match(source, /export SHOWME_TEST_FFMPEG_PATH="\$showme_test_ffmpeg"/);
  assert.match(source, /export SHOWME_TEST_FFPROBE_PATH="\$showme_test_ffprobe"/);
  assert.equal((source.match(/exec node scripts\/run-tests\.mjs images/g) ?? []).length, 1);
  assert.doesNotMatch(source, /-version|diagnose-images\.mjs|--test-skip-pattern|DATABASE_URL|GEMINI_API_KEY|run dev|run start|while\s|until\s/);
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

test("media tests share platform-aware tool selection instead of importing bundled binaries directly", () => {
  const directory = join(root, "artifacts/api-server/tests");
  for (const file of filesBelow(directory)) {
    const name = relative(directory, file).replace(/\\/g, "/");
    if (name === "helpers/media-binaries.ts") continue;
    assert.equal(/["']ff(?:mpeg|probe)-static["']/.test(readFileSync(file, "utf8")), false,
      `${name} must select media tools through helpers/media-binaries.ts`);
  }
  for (const name of ["analysis-images", "media", "pipeline", "upload-flow"]) {
    const source = read(`artifacts/api-server/tests/${name}.test.ts`);
    assert.match(source, /import \{ testMediaPaths \} from "\.\/helpers\/media-binaries\.js";/);
    assert.match(source, /const \{ ffmpegPath(?:, ffprobePath)? \} = testMediaPaths\(\);/);
  }
});

test("PostgreSQL verification remains a separate guarded local fixture command", () => {
  const source = read("artifacts/api-server/scripts/verify-postgres.mjs");
  assert.match(source, /process\.argv\[2\] !== "--local-docker"/);
  assert.match(source, /--pull=never/);
  assert.match(source, /127\.0\.0\.1::5432/);
  assert.match(source, /testEnvironment\(process\.env\)/);
  assert.doesNotMatch(read("scripts/run-tests.mjs"), /integration\/postgres|verify-postgres/);
});
