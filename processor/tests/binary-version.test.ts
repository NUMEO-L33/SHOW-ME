import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertReviewedMediaBinaryPair,
  assertReviewedMediaBinaryVersion,
  parseMediaBinaryVersion,
} from "../src/media/binary-version.js";

test("parses release and distro-suffixed ffmpeg version lines", () => {
  assert.deepEqual(parseMediaBinaryVersion("ffmpeg", "ffmpeg version 9.0.1 Copyright FFmpeg"), {
    product: "ffmpeg",
    raw: "ffmpeg version 9.0.1 Copyright FFmpeg",
    major: 9,
    minor: 0,
    patch: 1,
  });
  assert.equal(
    parseMediaBinaryVersion("ffprobe", "ffprobe version 7.1.5-2ubuntu1\nconfiguration: --enable-gpl").patch,
    5,
  );
});

test("rejects unparseable development snapshots instead of guessing", () => {
  assert.throws(
    () => parseMediaBinaryVersion("ffmpeg", "ffmpeg version N-123456-gdeadbeef"),
    /Unable to parse/,
  );
});

test("accepts each reviewed security branch at its own patch floor", () => {
  for (const version of ["8.0.3", "8.1.2", "9.0.1", "9.0.2"]) {
    assert.doesNotThrow(() =>
      assertReviewedMediaBinaryVersion(parseMediaBinaryVersion("ffmpeg", `ffmpeg version ${version}`)),
    );
  }
});

test("rejects vulnerable patches and unreviewed future branches", () => {
  for (const version of ["8.0.2", "8.1.1", "9.0.0", "7.1.99", "10.0.0"]) {
    assert.throws(() =>
      assertReviewedMediaBinaryVersion(parseMediaBinaryVersion("ffmpeg", `ffmpeg version ${version}`)),
    );
  }
});

test("requires a same-family pair and the deployment's exact reviewed version", () => {
  const ffmpeg = parseMediaBinaryVersion("ffmpeg", "ffmpeg version 8.1.2");
  const ffprobe = parseMediaBinaryVersion("ffprobe", "ffprobe version 8.1.2");
  assert.doesNotThrow(() => assertReviewedMediaBinaryPair(ffmpeg, ffprobe, "8.1.2"));
  assert.throws(
    () => assertReviewedMediaBinaryPair(ffmpeg, ffprobe, "8.1.3"),
    /exactly match/,
  );
  assert.throws(
    () => assertReviewedMediaBinaryPair(
      ffmpeg,
      parseMediaBinaryVersion("ffprobe", "ffprobe version 8.0.3"),
    ),
    /same release family/,
  );
});
