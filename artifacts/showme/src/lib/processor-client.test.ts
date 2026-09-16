import assert from "node:assert/strict";
import { test } from "node:test";

import {
  persistRecoverableCredentials,
  ProcessorClientError,
  recoverableCredentialKey,
} from "./processor-client.js";

test("upload credentials must survive an immediate storage read-back", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };

  persistRecoverableCredentials(storage, "active", "new-credentials");
  assert.equal(values.get("active"), "new-credentials");
});

test("a failed credential write aborts upload and restores the previous value", () => {
  let value: string | null = "previous-credentials";
  let failNextWrite = true;
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("quota blocked");
      }
      value = next;
    },
    removeItem: () => { value = null; },
  };

  assert.throws(
    () => persistRecoverableCredentials(storage, "active", "new-credentials"),
    (error: unknown) => {
      assert.ok(error instanceof ProcessorClientError);
      assert.equal(error.code, "CREDENTIAL_PERSISTENCE_REQUIRED");
      return true;
    },
  );
  assert.equal(value, "previous-credentials");
});

test("a storage read-back mismatch is treated as a failed credential write", () => {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };

  assert.throws(
    () => persistRecoverableCredentials(storage, "active", "new-credentials"),
    (error: unknown) => error instanceof ProcessorClientError &&
      error.code === "CREDENTIAL_PERSISTENCE_REQUIRED",
  );
});

test("different guides persist under independent recovery keys", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const firstKey = recoverableCredentialKey("guide-a");
  const secondKey = recoverableCredentialKey("guide-b");
  persistRecoverableCredentials(storage, firstKey, "credentials-a");
  persistRecoverableCredentials(storage, secondKey, "credentials-b");

  storage.removeItem(firstKey);
  assert.equal(values.has(firstKey), false);
  assert.equal(values.get(secondKey), "credentials-b");
});
