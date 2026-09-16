import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { createAssetTicket, verifyAssetTicket } from "../src/processor/asset-token.js";

test("asset tickets are guide-scoped, signed, and expire", () => {
  const secret = randomBytes(32);
  const now = 1_800_000_000_000;
  const { token, expiresAt } = createAssetTicket(secret, "guide-a", now, 10_000);
  assert.equal(expiresAt, now + 10_000);
  assert.equal(verifyAssetTicket(secret, token, "guide-a", now + 9_999), true);
  assert.equal(verifyAssetTicket(secret, token, "guide-b", now), false);
  assert.equal(verifyAssetTicket(secret, `${token}x`, "guide-a", now), false);
  assert.equal(verifyAssetTicket(secret, token, "guide-a", now + 10_000), false);
});
