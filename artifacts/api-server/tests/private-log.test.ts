import assert from "node:assert/strict";
import { test } from "node:test";
import { privateLogError } from "../src/processor/private-log.js";

test("private logs never inspect or serialize error messages, causes, URLs or payloads", () => {
  const secret = "synthetic-private-file-secret-token";
  const error = new Error(secret, { cause: { secret } });
  Object.defineProperty(error, "message", { get() { throw new Error("must not read"); } });
  for (const value of [error, secret, { message: secret, toString() { throw new Error("must not stringify"); } }]) {
    assert.doesNotMatch(privateLogError(value), /synthetic-private|must not/);
  }
});
