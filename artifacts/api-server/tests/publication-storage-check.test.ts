import assert from "node:assert/strict";
import test from "node:test";
import { publicationStorageTarget, runPublicationStorageCheck, syntheticObjectAllowed } from "../scripts/check-publication-storage.js";
import { attemptFrameObjectKey } from "../src/processor/asset-lifecycle.js";

const project = "00000000-0000-4000-8000-000000000001";
const args = [`--replit-development=${project}`, "--confirm-synthetic-storage"];
const env = { REPL_ID: project, NODE_ENV: "development", SHOWME_ANALYSIS_MODE: "off", REPLIT_OBJECT_STORAGE_BUCKET_ID: "synthetic-bucket" };

test("synthetic storage check requires explicit matching development target and storage consent", () => {
  assert.deepEqual(publicationStorageTarget(args, env), { mode: "replit", bucketId: "synthetic-bucket", prefix: "showme" });
  assert.deepEqual(publicationStorageTarget(args, { ...env, REPLIT_OBJECT_STORAGE_PREFIX: "private/showme" }),
    { mode: "replit", bucketId: "synthetic-bucket", prefix: "private/showme" });
  for (const invalid of [[], [args[0]], [...args, "--extra"], [project, args[1]], [args[0], "--yes"],
    ["--replit-development=invalid", args[1]]]) assert.throws(() => publicationStorageTarget(invalid, env), /REFUSED/);
  for (const change of [
    { REPL_ID: "different" }, { NODE_ENV: "production" }, { NODE_ENV: "test" }, { REPLIT_DEPLOYMENT: "1" },
    { SHOWME_ANALYSIS_MODE: "enabled" }, { REPLIT_OBJECT_STORAGE_BUCKET_ID: undefined },
    { REPLIT_OBJECT_STORAGE_BUCKET_ID: "../other" }, { REPLIT_OBJECT_STORAGE_PREFIX: "../existing" },
    { REPLIT_OBJECT_STORAGE_PREFIX: "/showme" }, { REPLIT_OBJECT_STORAGE_PREFIX: "showme//other" },
    { REPLIT_OBJECT_STORAGE_PREFIX: "showme/../../other" }, { REPLIT_OBJECT_STORAGE_PREFIX: "a".repeat(201) },
  ]) assert.throws(() => publicationStorageTarget(args, { ...env, ...change }), /REFUSED/);
});

test("local synthetic mode is test-only and refusal precedes side effects", async () => {
  assert.deepEqual(publicationStorageTarget(["--local-synthetic"], { NODE_ENV: "test" }), { mode: "local" });
  assert.throws(() => publicationStorageTarget(["--local-synthetic"], env), /REFUSED/);
  const logs: string[] = [];
  await assert.rejects(runPublicationStorageCheck([], {}, line => logs.push(line)), /REFUSED/);
  assert.deepEqual(logs, []);
});

test("synthetic storage keys admit only the new guide's two source frames and rendered pair", () => {
  const root = `guides/${project}/`, batch = "00000000-0000-4000-8000-000000000002";
  for (const key of [attemptFrameObjectKey(project, 1, 1, "frame"), attemptFrameObjectKey(project, 1, 1, "thumbnail"),
    `${root}private-redactions/${batch}/0-frame.png`, `${root}private-redactions/${batch}/0-thumbnail.png`])
    assert.equal(syntheticObjectAllowed(key, project), true, key);
  for (const key of ["", `${root}source.mp4`, `${root}../other`, `${root}attempts/2/frames/frame-001.jpg`,
    `${root}attempts/1/frames/frame-002.jpg`, `guides/${batch}/attempts/1/frames/frame-001.jpg`,
    `${root}private-redactions/${"-".repeat(36)}/0-frame.png`, `${root}private-redactions/${batch}/1-frame.png`,
    `${root}private-redactions/${batch}/../0-frame.png`, `https://example.invalid/${root}attempts/1/frames/frame-001.jpg`])
    assert.equal(syntheticObjectAllowed(key, project), false, key);
  assert.equal(syntheticObjectAllowed("guides/../attempts/1/frames/frame-001.jpg", ".."), false);
});

test("synthetic publication check exercises real local rendering and HTTP withdrawal then cleans its fixtures", { timeout: 210_000 }, async () => {
  const logs: string[] = [];
  const result = await runPublicationStorageCheck(["--local-synthetic"], { NODE_ENV: "test",
    SHOWME_TEST_FFMPEG_PATH: process.env.SHOWME_TEST_FFMPEG_PATH,
    SHOWME_TEST_FFPROBE_PATH: process.env.SHOWME_TEST_FFPROBE_PATH,
    // Live application configuration must never be forwarded to the fixture.
    DATABASE_URL: "postgres://must-not-connect.invalid/private", GEMINI_API_KEY: "must-not-use",
    REPLIT_OBJECT_STORAGE_BUCKET_ID: "must-not-use", SHOWME_ANALYSIS_MODE: "enabled" }, line => logs.push(line));
  assert.deepEqual(result, { passed: true, mode: "local", remoteObjectsRemoved: false, localFixtureRemoved: true,
    pendingIO: false, applicationDatabaseUsed: false, externalAIUsed: false, publicListener: false }, logs.join("\n"));
  for (const marker of ["SOURCE_ROUNDTRIP_OK", "PROCESSED_PIXELS_AND_SOURCE_PRESERVATION_OK", "WITHDRAWAL_AND_PROCESSED_DELETION_OK"])
    assert.ok(logs.some(line => line.endsWith(marker)), marker);
  assert.equal(logs.some(line => /must-not-|CLEANUP_PENDING/.test(line)), false);
});

test("failed synthetic rendering still cleans only its isolated fixture and never reports success", { timeout: 210_000 }, async () => {
  const logs: string[] = [];
  await assert.rejects(runPublicationStorageCheck(["--local-synthetic"], { NODE_ENV: "test",
    FFMPEG_PATH: "showme-nonexistent-synthetic-decoder", SHOWME_TEST_FFPROBE_PATH: process.env.SHOWME_TEST_FFPROBE_PATH },
  line => logs.push(line)));
  assert.ok(logs.some(line => line === "PUBLICATION_STORAGE_CHECK FAILED publication"));
  const final = logs.find(line => line.startsWith("PUBLICATION_STORAGE_CHECK FAIL {"));
  assert.ok(final);
  const result = JSON.parse(final.slice("PUBLICATION_STORAGE_CHECK FAIL ".length));
  assert.equal(result.passed, false); assert.equal(result.localFixtureRemoved, true); assert.equal(result.pendingIO, false);
  assert.equal(logs.some(line => line.startsWith("PUBLICATION_STORAGE_CHECK PASS") || line.includes("CLEANUP_PENDING")), false);
});
