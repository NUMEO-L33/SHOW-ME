import { constants, createReadStream } from "node:fs";
import { access, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import { Client, type RequestError, type Result } from "@replit/object-storage";

import type { ProcessorConfig } from "./config.js";

export interface Storage {
  /** Persist a local file under an application-owned object key. */
  putFile(key: string, sourcePath: string): Promise<void>;
  /** Copy an object to a local path so ffmpeg/sharp can work with it. */
  materialize(
    key: string,
    destinationPath: string,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
  /** Open an object without buffering its full contents in memory. */
  openRead(key: string): Promise<Readable>;
  /** Delete one object. Missing objects are treated as already deleted. */
  delete(key: string): Promise<void>;
}

export class StorageOperationError extends Error {
  readonly operation: string;
  readonly key: string;

  constructor(operation: string, key: string, detail: string) {
    super(`Storage ${operation} failed for "${key}": ${detail}`);
    this.name = "StorageOperationError";
    this.operation = operation;
    this.key = key;
  }
}

function normalizedKey(key: string): string {
  const normalized = key.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/");

  if (
    !normalized ||
    normalized.endsWith("/") ||
    normalized.includes("\0") ||
    /[<>:"|?*\u0000-\u001f]/u.test(normalized) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid storage key: "${key}".`);
  }

  return normalized;
}

function resolveInside(root: string, key: string): string {
  const destination = path.resolve(root, ...normalizedKey(key).split("/"));
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Storage key escapes its configured root: "${key}".`);
  }
  return destination;
}

async function assertRegularFile(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`Expected a regular file: ${resolved}`);
  return resolved;
}

async function writeViaStagingFile(
  destinationPath: string,
  write: (stagingPath: string) => Promise<void>,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const destination = path.resolve(destinationPath);
  if (options.signal?.aborted) throw new Error("Storage materialization was aborted before it started.");
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = `${destination}.showme-${process.pid}-${randomUUID()}.tmp`;

  try {
    await write(staging);
    // Remote SDKs do not expose cancellation. A timed-out download may finish
    // later, but it must never publish its staging file after the job aborted.
    if (options.signal?.aborted) throw new Error("Storage materialization was aborted before commit.");
    // Windows does not consistently replace an existing file with rename().
    await rm(destination, { force: true });
    await rename(staging, destination);
    return destination;
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
  }
}

export class LocalStorage implements Storage {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async putFile(key: string, sourcePath: string): Promise<void> {
    const source = await assertRegularFile(sourcePath);
    const destination = resolveInside(this.root, key);
    if (source === destination) return;

    await writeViaStagingFile(destination, (staging) => copyFile(source, staging));
  }

  async materialize(
    key: string,
    destinationPath: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const source = resolveInside(this.root, key);
    await access(source, constants.R_OK);
    const destination = path.resolve(destinationPath);
    if (source === destination) return destination;

    return writeViaStagingFile(destination, (staging) => copyFile(source, staging), options);
  }

  async openRead(key: string): Promise<Readable> {
    const source = resolveInside(this.root, key);
    await access(source, constants.R_OK);
    return createReadStream(source);
  }

  async delete(key: string): Promise<void> {
    await rm(resolveInside(this.root, key), { force: true });
  }
}

type ReplitResult = Result<null, RequestError>;

function assertReplitResult(operation: string, key: string, result: ReplitResult): void {
  if (result.ok) return;
  const status = result.error.statusCode ? `${result.error.statusCode}: ` : "";
  throw new StorageOperationError(operation, key, `${status}${result.error.message}`);
}

export type ReplitStorageOptions = Readonly<{
  bucketId?: string;
  prefix?: string;
  client?: Client;
}>;

export class ReplitObjectStorage implements Storage {
  private readonly client: Client;
  private readonly prefix: string;

  constructor(options: ReplitStorageOptions = {}) {
    this.prefix = (options.prefix ?? "showme").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!this.prefix || this.prefix.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new Error("Replit Object Storage prefix must be a safe, non-empty relative prefix.");
    }

    this.client =
      options.client ?? new Client(options.bucketId ? { bucketId: options.bucketId } : undefined);
  }

  private objectName(key: string): string {
    return `${this.prefix}/${normalizedKey(key)}`;
  }

  async putFile(key: string, sourcePath: string): Promise<void> {
    const source = await assertRegularFile(sourcePath);
    const objectName = this.objectName(key);
    const result = await this.client.uploadFromFilename(objectName, source, { compress: false });
    assertReplitResult("putFile", objectName, result);
  }

  async materialize(
    key: string,
    destinationPath: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const objectName = this.objectName(key);
    return writeViaStagingFile(destinationPath, async (staging) => {
      const result = await this.client.downloadToFilename(objectName, staging, { decompress: true });
      assertReplitResult("materialize", objectName, result);
    }, options);
  }

  async openRead(key: string): Promise<Readable> {
    return this.client.downloadAsStream(this.objectName(key), { decompress: true });
  }

  async delete(key: string): Promise<void> {
    const objectName = this.objectName(key);
    const result = await this.client.delete(objectName, { ignoreNotFound: true });
    assertReplitResult("delete", objectName, result);
  }
}

export type StorageFactoryConfig = Pick<
  ProcessorConfig,
  "storageDriver" | "dataDir" | "replitBucketId" | "replitObjectPrefix"
>;

export function createStorage(config: StorageFactoryConfig): Storage {
  if (config.storageDriver === "local") {
    return new LocalStorage(path.join(config.dataDir, "objects"));
  }

  return new ReplitObjectStorage({
    bucketId: config.replitBucketId,
    prefix: config.replitObjectPrefix,
  });
}
