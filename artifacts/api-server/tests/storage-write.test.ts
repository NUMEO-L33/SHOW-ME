import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Client } from "@replit/object-storage";
import { LocalStorage, ReplitObjectStorage, StorageWriteSettledError } from "../src/processor/storage.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "showme-storage-write-")), source = join(root, "synthetic.txt");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(source, "synthetic fixture");
  return { root, source };
}

test("local write evidence covers preflight and awaited filesystem failures; normal writes still finish", async t => {
  const { root, source } = await fixture(t), storage = new LocalStorage(join(root, "objects"));
  await assert.rejects(storage.putFile("safe.txt", join(root, "missing")), StorageWriteSettledError);
  await assert.rejects(storage.putFile("../escape", source), StorageWriteSettledError);
  await storage.putFile("blocker", source);
  await assert.rejects(storage.putFile("blocker/child", source), StorageWriteSettledError);
  await storage.putFile("copy.txt", source);
  await storage.putFile("copy.txt", join(storage.root, "copy.txt"));
  assert.deepEqual(await readFile(join(storage.root, "copy.txt")), await readFile(source));
});

test("Replit preflight failures are settled only before invoking the SDK", async t => {
  const { root, source } = await fixture(t); let calls = 0;
  const client: Pick<Client, "uploadFromFilename"> = {
    async uploadFromFilename() { calls++; throw new Error("must not dispatch"); },
  };
  const storage = new ReplitObjectStorage({ client: client as Client });
  for (const [key, file] of [["safe", join(root, "missing")], ["../escape", source], ["safe", root]]) {
    await assert.rejects(storage.putFile(key, file), e => e instanceof StorageWriteSettledError
      && e.message === "STORAGE_WRITE_FAILED_SETTLED" && e.cause === undefined);
  }
  assert.equal(calls, 0);
});

for (const statusCode of [400, 403, 429, 503])
test(`Replit SDK error result ${statusCode} never claims remote write settlement`, async t => {
  const { source } = await fixture(t); let calls = 0;
  const client: Pick<Client, "uploadFromFilename"> = {
    async uploadFromFilename() { calls++; return { ok: false, error: { statusCode, message: "synthetic" } }; },
  };
  const storage = new ReplitObjectStorage({ client: client as Client });
  await assert.rejects(storage.putFile("synthetic.txt", source), e => e instanceof Error && !(e instanceof StorageWriteSettledError));
  assert.equal(calls, 1);
});

test("Replit SDK rejection stays unknown; successful receipt completes without automatic retry", async t => {
  const { source } = await fixture(t); let calls = 0;
  const client: Pick<Client, "uploadFromFilename"> = {
    async uploadFromFilename(key, file, options) {
      calls++; assert.equal(key, "showme/synthetic.txt"); assert.equal(file, source);
      assert.deepEqual(options, { compress: false });
      if (calls === 1) throw new Error("synthetic disconnect");
      return { ok: true, value: null };
    },
  };
  const storage = new ReplitObjectStorage({ client: client as Client });
  await assert.rejects(storage.putFile("synthetic.txt", source), e => e instanceof Error && !(e instanceof StorageWriteSettledError));
  assert.equal(calls, 1);
  await storage.putFile("synthetic.txt", source); assert.equal(calls, 2);
});
