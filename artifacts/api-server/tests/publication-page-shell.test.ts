import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { publicPageOrigin } from "../src/processor/public-origin.js";
import { createPublicPageShell, publicPageShellPath } from "../src/processor/publication-page-shell.js";
import { loadConfig } from "../src/processor/config.js";

test("canonical origin is explicit, HTTPS and never borrowed from CORS or runtime Host", () => {
  assert.equal(publicPageOrigin(undefined, false), undefined);
  assert.equal(publicPageOrigin("https://showme.example/", false), "https://showme.example");
  assert.equal(publicPageOrigin("http://127.0.0.1:20116", true), "http://127.0.0.1:20116");
  for (const raw of ["http://showme.example", "//showme.example", "https://name:secret@showme.example", "https://showme.example/path",
    "https://showme.example?x=y", "https://showme.example/#x", "https://showme.example/?", "https://showme.example/#", "javascript:alert(1)", "https://showme.example\\@evil.invalid"])
    assert.throws(() => publicPageOrigin(raw, true));
  assert.throws(() => publicPageOrigin("http://localhost:20116", false));
  assert.equal(loadConfig({ NODE_ENV: "test", CORS_ORIGINS: "https://cors.example" }).publicOrigin, undefined);
  assert.equal(loadConfig({ NODE_ENV: "test", SHOWME_PUBLIC_ORIGIN: "https://showme.example" }).publicOrigin, "https://showme.example");
  assert.throws(() => loadConfig({ NODE_ENV: "test", SHOWME_PUBLIC_ORIGIN: "https://bad/path" }), /SHOWME_PUBLIC_ORIGIN/);
});

test("production shell reads only the built local HTML with bounded bytes and abort support", async t => {
  const root = await mkdtemp(join(tmpdir(), "showme-page-shell-")), file = join(root, "index.html");
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => { assert.fail("no production network fetch"); });
  await writeFile(file, "<html>합성 셸</html>");
  const load = createPublicPageShell("production", file);
  assert.equal(await load(new AbortController().signal), "<html>합성 셸</html>");
  await assert.rejects(load(AbortSignal.abort()));
  await writeFile(file, Buffer.alloc(65537));
  await assert.rejects(load(new AbortController().signal), /PUBLIC_PAGE_SHELL/);
  await assert.rejects(createPublicPageShell("production", join(root, "missing"))(new AbortController().signal));
});

test("development shell fetch is fixed loopback, credential-free, redirect-free and size bounded", async t => {
  const signal = new AbortController().signal, load = createPublicPageShell("development");
  const mock = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], options: Parameters<typeof fetch>[1]) => {
    assert.equal(url, "http://127.0.0.1:20116/");
    assert.deepEqual(options, { signal, redirect: "error", credentials: "omit" });
    return new Response("<html>shell</html>", { headers: { "Content-Type": "text/html" } });
  });
  assert.equal(await load(signal), "<html>shell</html>");
  for (const response of [new Response("{}", { headers: { "Content-Type": "application/json" } }),
    new Response("unavailable", { status: 503 }), new Response("x".repeat(65537), { headers: { "Content-Type": "text/html" } })]) {
    mock.mock.mockImplementation(async () => response);
    await assert.rejects(load(signal), /PUBLIC_PAGE_SHELL/);
  }
});

test("artifact and workspace launch directories resolve the same production shell", () => {
  assert.equal(publicPageShellPath(), resolve("../showme/dist/public/index.html"));
  assert.equal(publicPageShellPath(resolve("../..")), publicPageShellPath());
});

test("share page routing precedes static fallback in development, preview and Replit API routing", async () => {
  const vite = await readFile("../showme/vite.config.ts", "utf8"), artifact = await readFile(".replit-artifact/artifact.toml", "utf8");
  assert.equal((vite.match(/'\/g': 'http:\/\/127\.0\.0\.1:8080'/g) ?? []).length, 2);
  assert.match(artifact, /paths = \["\/api", "\/g"\]/);
  const shell = await readFile("../showme/index.html", "utf8");
  assert.equal(shell.split("<!-- showme:metadata:start -->").length, 2);
  assert.equal(shell.split("<!-- showme:metadata:end -->").length, 2);
});
