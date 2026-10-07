import { createReadStream, existsSync } from "node:fs";
import path from "node:path";

const MAX_SHELL_BYTES = 64 * 1024;
/** Same supported working directories as the API migration loader: artifact or workspace root. */
export function publicPageShellPath(cwd = process.cwd()) {
  return existsSync(path.join(cwd, "drizzle")) ? path.resolve(cwd, "../showme/dist/public/index.html")
    : path.resolve(cwd, "artifacts/showme/dist/public/index.html");
}

async function boundedHtml(chunks: AsyncIterable<Uint8Array>, signal: AbortSignal) {
  const bytes: Buffer[] = []; let size = 0;
  for await (const chunk of chunks) {
    signal.throwIfAborted(); size += chunk.byteLength;
    if (size > MAX_SHELL_BYTES || bytes.length >= 4096) throw new Error("PUBLIC_PAGE_SHELL_UNAVAILABLE");
    bytes.push(Buffer.from(chunk));
  }
  signal.throwIfAborted(); return Buffer.concat(bytes).toString("utf8");
}

export function createPublicPageShell(mode: "development" | "production" | "test", filename = publicPageShellPath()) {
  return async (signal: AbortSignal): Promise<string> => {
    if (mode !== "development") return boundedHtml(createReadStream(filename, { signal }), signal);
    // Only the fixed local Vite root. No incoming headers/cookies/URL, redirect, guide ID or media is forwarded.
    const response = await fetch("http://127.0.0.1:20116/", { signal, redirect: "error", credentials: "omit" });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html") || !response.body) {
      await response.body?.cancel(); throw new Error("PUBLIC_PAGE_SHELL_UNAVAILABLE");
    }
    return boundedHtml(response.body, signal);
  };
}
