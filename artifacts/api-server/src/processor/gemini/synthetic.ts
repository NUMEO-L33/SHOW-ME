import { createHash } from "node:crypto";

import type { AnalysisInput } from "./request.js";
import fixture from "./synthetic-fixture.json" with { type: "json" };

// These two screens were generated from the preserved pixel/font algorithm,
// then matched against the historical full-request fingerprint before freezing.
// Encoding again with a different OS/FFmpeg changes JPEG bytes and invalidates
// that comparison. Never update the historical reference to accommodate drift.
// This is deterministic test data, NOT approval for any new external request.

/** No path, upload, screenshot or user data can be supplied to this fixture generator. */
export async function syntheticAnalysisInput(): Promise<AnalysisInput> {
  if (fixture.version !== "synthetic-screens-v1" || fixture.width !== 640 || fixture.height !== 360 || fixture.images.length !== 2) {
    throw new Error("SYNTHETIC_IMAGE_FAILED");
  }
  const targets = fixture.images.map((_, position) => ({
    stepId: `synthetic-${position}`, position, timestampMs: position * 1000 + 500,
    width: fixture.width, height: fixture.height,
  }));
  const images = fixture.images.map((image, position) => {
    const bytes = Buffer.from(image.base64, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== image.sha256 ||
        bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
      throw new Error("SYNTHETIC_IMAGE_FAILED");
    }
    return { stepId: targets[position].stepId, mimeType: "image/jpeg" as const, bytes };
  });
  return { targets, context: [], images };
}
