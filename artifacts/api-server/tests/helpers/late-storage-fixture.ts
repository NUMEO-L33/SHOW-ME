import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Client } from "@replit/object-storage";
import { ReplitObjectStorage } from "../../src/processor/storage.js";

/** Real application adapter, entirely in-memory SDK double. No remote calls,
 * credentials, real bucket or wall-clock sleep; commit happens only on demand. */
export function lateStorageFixture(sourceKey: string, source: Buffer,
  failure: "result" | "rejection", failAt = 1) {
  const prefix = "synthetic-late-storage", name = (key: string) => `${prefix}/${key}`;
  const objects = new Map<string, Buffer>([[name(sourceKey), Buffer.from(source)]]);
  const puts: string[] = [], deletes: string[] = [];
  let late: { key: string; bytes: Buffer } | undefined;
  const client: Pick<Client, "uploadFromFilename" | "downloadAsStream" | "delete"> = {
    async uploadFromFilename(key, file, options) {
      assert.equal(options?.compress, false);
      puts.push(key); const bytes = await readFile(file);
      if (puts.length === failAt) {
        late = { key, bytes };
        if (failure === "rejection") throw new Error("synthetic SDK connection lost");
        return { ok: false, error: { message: "synthetic SDK response lost", statusCode: 503 } };
      }
      objects.set(key, bytes); return { ok: true, value: null };
    },
    downloadAsStream(key) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("synthetic object missing");
      return Readable.from([Buffer.from(bytes)]);
    },
    async delete(key, options) {
      assert.equal(options?.ignoreNotFound, true);
      deletes.push(key); objects.delete(key); return { ok: true, value: null };
    },
  };
  const storage = new ReplitObjectStorage({ prefix, client: client as Client });
  return { storage, puts, deletes, name,
    bytes: (key: string) => objects.get(name(key)),
    commitLate() { assert.ok(late); objects.set(late.key, Buffer.from(late.bytes)); },
  };
}
