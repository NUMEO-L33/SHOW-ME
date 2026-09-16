import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { inspectAnalysisPreflight, formatAnalysisPreflight, preflightOutputMode } from "../src/processor/analysis-preflight.js";
import { verifyAnalysisReadiness } from "../src/processor/analysis-admission.js";
import { GEMINI_TEST_MODEL, GEMINI_PROMPT_VERSION } from "../src/processor/gemini/request.js";

const fictional = () => ({ DATABASE_URL: "postgresql://private-user:private-password@db.invalid:5432/private-db",
  SHOWME_STORAGE: "replit", CORS_ORIGINS: "https://private-site.invalid", ASSET_TICKET_SECRET: Buffer.alloc(32, 42).toString("base64url"),
  EXPECTED_MEDIA_VERSION: "8.1.2", GEMINI_API_KEY: "fictional-private-google-key", REPLIT_OBJECT_STORAGE_BUCKET_ID: "private-bucket" });

test("offline preflight lists required missing settings without clients or environment mutation", () => {
  const env = Object.freeze({}); const report = inspectAnalysisPreflight(env);
  assert.equal(report.checks.length, 6); assert.ok(report.checks.every((c) => c.state === "missing"));
  assert.equal(report.settingsShapeValid, false); assert.equal(report.ready, false); assert.equal(report.enablesAnalysis, false);
  assert.equal(report.networkCalls, 0); assert.equal(report.changesApplied, false); assert.equal(report.unverified.length, 8);
  assert.equal(report.storageBucketSelection, "default-unverified");
});

test("complete settings and historical approval flags cannot become current readiness", () => {
  const env = Object.freeze({ ...fictional(), SHOWME_GEMINI_FREE_TIER_CONFIRMED: "true", SHOWME_GEMINI_SYNTHETIC_CONSENT: "synthetic-screens-only-v1" });
  const report = inspectAnalysisPreflight(env); assert.equal(report.settingsShapeValid, true);
  assert.equal(report.ready, false); assert.equal(report.enablesAnalysis, false); assert.equal(report.unverified.length, 8);
  assert.throws(() => verifyAnalysisReadiness({ raw: report, input: { guideId: "guide", frameCount: 1,
    inputFingerprint: "a".repeat(64), model: GEMINI_TEST_MODEL, promptVersion: GEMINI_PROMPT_VERSION },
    readiness: { async inspect() { return report; }, isCurrent: () => true }, spending: { mode: "free_only" }, clock: () => new Date(), signal: new AbortController().signal }));
});

test("reports never include secret values, connection components, bucket IDs or arbitrary invalid input", () => {
  const env = fictional(); const output = JSON.stringify(inspectAnalysisPreflight(env)) + formatAnalysisPreflight(inspectAnalysisPreflight(env));
  for (const value of [...Object.values(env).filter((v) => !["replit", "8.1.2"].includes(v)), "private-user", "private-password", "db.invalid", "private-db"]) {
    assert.ok(!output.includes(value), value);
  }
  const malformed = { ...env, CORS_ORIGINS: "https://secret-user:secret-password@private.invalid/leak?key=private-api-key" };
  const bad = JSON.stringify(inspectAnalysisPreflight(malformed)); assert.ok(!bad.includes("secret-password")); assert.ok(!bad.includes("private-api-key"));
});

test("deployment setting syntax rejects unsafe URLs, local storage, weak keys and unknown version forms", () => {
  const invalid: Record<string, string[]> = {
    DATABASE_URL: ["https://private.invalid", "postgres://", "postgresql://db.invalid/", "postgresql://db.invalid/db#private"],
    SHOWME_STORAGE: ["local", "private-driver"], CORS_ORIGINS: ["*", "https://*", "https://*.site.invalid", "http://localhost:5173", "https://site.invalid/path", "https://site.invalid,", "https://u:p@site.invalid"],
    ASSET_TICKET_SECRET: ["too-short", "!".repeat(45)], EXPECTED_MEDIA_VERSION: ["latest", "8.1", "8.1.2-secret"],
    GEMINI_API_KEY: ["short", "private key with spaces", "x".repeat(4097)],
  };
  for (const [name, values] of Object.entries(invalid)) for (const value of values) {
    const report = inspectAnalysisPreflight({ ...fictional(), [name]: value });
    assert.equal(report.checks.find((c) => c.name === name)?.state, "invalid", name); assert.equal(report.settingsShapeValid, false);
  }
});

test("default bucket remains a valid configuration choice; explicit invalid prefixes are not ignored", () => {
  const env: Record<string, string> = fictional(); delete env.REPLIT_OBJECT_STORAGE_BUCKET_ID;
  assert.equal(inspectAnalysisPreflight(env).settingsShapeValid, true);
  for (const prefix of ["..", "a/../b", "a//b", "\0"]) {
    assert.equal(inspectAnalysisPreflight({ ...env, REPLIT_OBJECT_STORAGE_PREFIX: prefix }).settingsShapeValid, false);
  }
  assert.equal(inspectAnalysisPreflight({ ...env, REPLIT_OBJECT_STORAGE_PREFIX: "showme/tests" }).settingsShapeValid, true);
});

test("preflight exposes no live, write, migrate or send flag", () => {
  assert.equal(preflightOutputMode([]), "text"); assert.equal(preflightOutputMode(["--json"]), "json");
  assert.equal(preflightOutputMode(["--help"]), "help");
  for (const args of [["--live"], ["--migrate"], ["--send"], ["--json", "--json"], ["--key", "private"]]) {
    assert.throws(() => preflightOutputMode(args), /^Error: PREFLIGHT_ARGUMENTS_INVALID$/);
  }
});

test("standalone CLI is safe even with production flags, invalid server config and unreachable database", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/processor/analysis-preflight.ts"), "--json"], {
    encoding: "utf8", timeout: 15000, windowsHide: true,
    env: { ...process.env, ...fictional(), NODE_ENV: "production", REPLIT_DEPLOYMENT: "true", PORT: "not-a-number" },
  });
  assert.equal(result.status, 2, result.stderr); const report = JSON.parse(result.stdout);
  assert.equal(report.settingsShapeValid, true); assert.equal(report.ready, false); assert.equal(report.networkCalls, 0);
  assert.ok(!result.stderr.includes("private")); assert.ok(!result.stdout.includes("private-password"));
});
