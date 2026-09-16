import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { resolveMigrationsFolder } from "../src/processor/database-migrations.js";
import { testMediaPaths } from "./helpers/media-binaries.js";

test("migrations resolve to the active artifact from its package directory", () => {
  const directory = resolveMigrationsFolder(process.cwd());
  assert.equal(directory, resolve("drizzle"));
  assert.ok(existsSync(join(directory, "meta/_journal.json")));
});

test("migrations resolve to the same active artifact from workspace root", () => {
  assert.equal(resolveMigrationsFolder(resolve("../..")), resolve("drizzle"));
});

test("Linux media tests use host tools without enabling npm download hooks", () => {
  assert.deepEqual(testMediaPaths({}, "linux"), { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
});

test("test media overrides must explicitly provide both executables", () => {
  assert.throws(() => testMediaPaths({ SHOWME_TEST_FFMPEG_PATH: "/fixture/ffmpeg" }), /Set both/);
  assert.throws(() => testMediaPaths({ SHOWME_TEST_FFPROBE_PATH: "/fixture/ffprobe" }), /Set both/);
  assert.deepEqual(testMediaPaths({ SHOWME_TEST_FFMPEG_PATH: " /fixture/ffmpeg ", SHOWME_TEST_FFPROBE_PATH: "/fixture/ffprobe" }),
    { ffmpegPath: "/fixture/ffmpeg", ffprobePath: "/fixture/ffprobe" });
});
