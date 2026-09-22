import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { testEnvironment, testGroups } from "../test-environment.mjs";

test("tests drop live settings, cloud credentials and inherited Node options", () => {
  const source = Object.freeze({
    PATH: "/test/bin", HOME: "/test/home", NODE_ENV: "production", NODE_OPTIONS: "--require dangerous.js",
    DATABASE_URL: "fictional-db", GEMINI_API_KEY: "fictional-key", PGHOST: "db.invalid",
    PGUSER: "fictional-user", PGPASSWORD: "fictional-password", REPLIT_DEPLOYMENT: "true",
    REPL_ID: "fictional-repl", REPLIT_OBJECT_STORAGE_BUCKET_ID: "fictional-bucket",
    GOOGLE_APPLICATION_CREDENTIALS: "/fictional/service-account.json", SHOWME_STORAGE: "replit",
    FFMPEG_PATH: "/production/ffmpeg", PORT: "8080", SECRET_ADDED_LATER: "fictional-secret",
  });
  assert.deepEqual(testEnvironment(source), { PATH: "/test/bin", HOME: "/test/home", NODE_ENV: "test", TSX_DISABLE_CACHE: "1" });
});

test("Windows OS plumbing and explicit test-only media paths are preserved", () => {
  const source = { Path: "C:/test/bin", SystemRoot: "C:/Windows", TEMP: "C:/test/tmp",
    SHOWME_TEST_FFMPEG_PATH: "/test/ffmpeg", SHOWME_TEST_FFPROBE_PATH: "/test/ffprobe" };
  assert.deepEqual(testEnvironment(source), { ...source, NODE_ENV: "test", TSX_DISABLE_CACHE: "1" });
});

test("default tests exclude PostgreSQL and external AI probes", () => {
  assert.deepEqual(testGroups([]), ["migration", "server", "client"]);
  for (const name of ["migration", "server", "client"]) assert.deepEqual(testGroups([name]), [name]);
});

test("image-only diagnosis is explicit and does not change default test coverage", () => {
  assert.deepEqual(testGroups(["images"]), ["images"]);
  assert.deepEqual(testGroups([]), ["migration", "server", "client"]);
  assert.throws(() => testGroups(["images", "--watch"]), /PostgreSQL is opt-in/);
});

test("unknown tests and injected node arguments fail closed", () => {
  for (const args of [["postgres"], ["integration"], ["--env-file=.env"], ["--send"], ["server", "--watch"]]) {
    assert.throws(() => testGroups(args), /PostgreSQL is opt-in/);
  }
});

test("file suites are serial without skipping explicit in-test concurrency checks", () => {
  const source = readFileSync(new URL("../run-tests.mjs", import.meta.url), "utf8");
  assert.match(source, /"--test-concurrency=1"/);
  assert.match(source, /\.\.\.files/);
  assert.doesNotMatch(source, /--test-skip-pattern|--test-name-pattern/);
});
