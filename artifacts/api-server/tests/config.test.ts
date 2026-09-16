import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { ConfigurationError, loadConfig } from "../src/processor/config.js";

test("Replit deployment fails closed without durable services and a stable asset secret", () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      REPLIT_DEPLOYMENT: "1",
      SHOWME_STORAGE: "local",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /SHOWME_STORAGE=replit/);
      assert.match(error.message, /CORS_ORIGINS/);
      assert.match(error.message, /ASSET_TICKET_SECRET/);
      assert.match(error.message, /EXPECTED_MEDIA_VERSION/);
      return true;
    },
  );
});

test("Replit deployment resolves Nix media commands and validates bounded resource settings", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    REPLIT_DEPLOYMENT: "true",
    SHOWME_STORAGE: "replit",
    DATABASE_URL: "postgresql://showme:secret@database.invalid/showme",
    CORS_ORIGINS: "https://showme.example",
    ASSET_TICKET_SECRET: randomBytes(32).toString("base64url"),
    EXPECTED_MEDIA_VERSION: "8.1.2",
    MAX_VIDEO_DURATION_MS: "600000",
    QUEUE_CAPACITY: "12",
  });
  assert.equal(config.ffmpegPath, "ffmpeg");
  assert.equal(config.ffprobePath, "ffprobe");
  assert.equal(config.expectedMediaVersion, "8.1.2");
  assert.equal(config.maxVideoDurationMs, 600_000);
  assert.equal(config.queueCapacity, 12);
});

test("Replit preview uses system media binaries and enables production security checks", () => {
  const config = loadConfig({
    NODE_ENV: "development",
    REPL_ID: "preview-repl-id",
  });
  assert.equal(config.isReplitDeployment, false);
  assert.equal(config.isReplitRuntime, true);
  assert.equal(config.ffmpegPath, "ffmpeg");
  assert.equal(config.ffprobePath, "ffprobe");
});

test("non-Replit production requires explicit media executable paths", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /FFMPEG_PATH/);
      assert.match(error.message, /FFPROBE_PATH/);
      return true;
    },
  );
});
