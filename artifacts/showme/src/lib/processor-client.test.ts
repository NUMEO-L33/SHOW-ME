import assert from "node:assert/strict";
import { test } from "node:test";

import {
  persistRecoverableCredentials,
  ProcessorClientError,
  recoverableCredentialKey,
  getGuide,
  deleteGuide,
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

test("a valid guide response is read with scoped credentials and no redirects", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { Authorization: "Bearer synthetic-token" });
    return Response.json({ guide: { id: "test-id", status: "ready", progress: 100, title: "Synthetic", steps: [{ id: "step", frameUrl: "/api/guides/test-id/assets/step/frame" }] } });
  });
  const guide = await getGuide("http://127.0.0.1:1", "test-id", "synthetic-token");
  assert.equal(guide.status, "ready");
  assert.equal(guide.steps[0].frameUrl, "http://127.0.0.1:1/api/guides/test-id/assets/step/frame");
});

test("missing guides remain explicit 404 errors, not empty ready results", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "가이드를 찾을 수 없어요.", code: "GUIDE_NOT_FOUND" }, { status: 404 }));
  await assert.rejects(getGuide("http://127.0.0.1:1", "test-id", "synthetic-token"), (error: unknown) => error instanceof ProcessorClientError && error.status === 404);
});

test("HTML, mismatched IDs, absent steps and impossible progress fail response validation", async (t) => {
  for (const body of [null, { guide: { id: "other", status: "ready", progress: 100, steps: [{}] } }, { guide: { id: "test-id", status: "ready", progress: 100, steps: [] } }, { guide: { id: "test-id", status: "queued", progress: 101, steps: [] } }]) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json(body));
    await assert.rejects(getGuide("http://127.0.0.1:1", "test-id", "synthetic-token"), (error: unknown) => error instanceof ProcessorClientError && error.code === "INVALID_RESPONSE");
    mock.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async () => new Response("<html>Replit login</html>"));
  await assert.rejects(getGuide("http://127.0.0.1:1", "test-id", "synthetic-token"), (error: unknown) => error instanceof ProcessorClientError && error.code === "INVALID_RESPONSE");
});

test("only 204 confirms deletion, 202 remains pending, 404/401/503 retain an error", async (t) => {
  for (const status of [204, 202, 404, 401, 503, 200]) {
    const mock = t.mock.method(globalThis, "fetch", async () => status === 204 ? new Response(null, { status }) : Response.json({ status: "deleting" }, { status }));
    if (status === 204 || status === 202) assert.deepEqual(await deleteGuide("http://127.0.0.1:1", "test-id", "synthetic-token"), { pending: status === 202 });
    else await assert.rejects(deleteGuide("http://127.0.0.1:1", "test-id", "synthetic-token"));
    mock.mock.restore();
  }
});

test("stalled requests time out without an unbounded wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", (_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
  const request = getGuide("http://127.0.0.1:1", "test-id", "synthetic-token");
  const result = assert.rejects(request, (error: unknown) => error instanceof ProcessorClientError && error.code === "REQUEST_TIMEOUT");
  t.mock.timers.tick(15_000);
  await result;
});

test("external cancellation remains AbortError and aborts the actual request", async (t) => {
  t.mock.method(globalThis, "fetch", (_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
  const abort = new AbortController();
  const request = deleteGuide("http://127.0.0.1:1", "test-id", "synthetic-token", abort.signal);
  const result = assert.rejects(request, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  abort.abort();
  await result;
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
