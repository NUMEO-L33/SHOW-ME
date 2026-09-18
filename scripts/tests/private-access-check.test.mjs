import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, lstat, symlink, writeFile, mkdir, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
import { checkedOrigin, checkPrivateAccess, cleanupRun, createRun, safeCode } from "../private-access-check.mjs";
import { syntheticVideo } from "../private-access-fixture.mjs";
import { parseArguments } from "../check-private-access.mjs";
import { recoveryStore, assertPreviousProcessStopped } from "../private-access-recovery.mjs";
import { testEnvironment } from "../test-environment.mjs";

const stepId = "11111111-1111-4111-8111-111111111111";
function harness(override = () => undefined) {
  const run = createRun("http://127.0.0.1:8080");
  const base = `/api/guides/${run.guideId}`;
  const events = [], requests = [];
  let deleted = false, saved = false, removed = false;
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const hidden = () => json({ code: "GUIDE_NOT_FOUND", error: "not found" }, 404);
  const guide = { id: run.guideId, status: "ready", steps: [{ id: stepId,
    frameUrl: `${base}/assets/${stepId}/frame?asset_token=synthetic.ticket`,
    thumbnailUrl: `${base}/assets/${stepId}/thumbnail?asset_token=synthetic.ticket` }] };
  const draft = { guideId: run.guideId, revision: 0, document: { steps: [{ id: stepId }] } };
  const options = { pollMs: 1, cleanupDelayMs: 1, cleanupAttempts: 2,
    report: code => events.push(code),
    saveRecovery: async () => { saved = true; }, clearRecovery: async () => { removed = true; },
    fetchImpl: async (url, init) => {
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      assert.equal(init.referrerPolicy, "no-referrer");
      assert.equal(init.cache, "no-store");
      const parsed = new URL(url), path = parsed.pathname;
      assert.equal(parsed.origin, run.origin);
      assert.ok(!path.includes("analysis"));
      const req = { path, parsed, init, deleted, guide, draft, run, json, hidden };
      requests.push(req);
      const custom = await override(req);
      if (custom) return custom;
      if (path === "/api/healthz") return json({ status: "ok" });
      if (init.method === "POST") {
        assert.ok(saved, "persist recovery before upload");
        assert.equal(path, "/api/guides");
        assert.equal(init.headers["X-ShowMe-Guide-Id"], run.guideId);
        const file = init.body.get("video");
        assert.equal(file.name, `showme-synthetic-access-${run.guideId}.mp4`);
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), syntheticVideo());
        return json({ guideId: run.guideId, status: "queued" }, 202);
      }
      if (init.method === "DELETE") { assert.equal(path, base); deleted = true; return new Response(null, { status: 204 }); }
      const owner = init.headers.Authorization === `Bearer ${run.editToken}`;
      const ticket = parsed.searchParams.get("asset_token") === "synthetic.ticket";
      if (deleted || (!owner && !ticket)) return hidden();
      if (path === base) return json({ guide });
      if (path === `${base}/draft`) return json({ draft });
      return new Response(Buffer.from([255, 216, 255, 217]), { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
    } };
  return { run, options, events, requests, state: () => ({ saved, removed, deleted }) };
}

test("synthetic diagnostic requires explicit opt-in and accepts only constrained destinations", () => {
  assert.deepEqual(parseArguments(["--run-synthetic"]), { mode: "run", origin: "http://127.0.0.1:8080" });
  assert.equal(parseArguments(["--cleanup-only"]).mode, "cleanup");
  assert.equal(checkedOrigin("https://test.pike.replit.dev/"), "https://test.pike.replit.dev");
  assert.equal(checkedOrigin("https://test.replit.app"), "https://test.replit.app");
  for (const args of [[], ["--run-synthetic", "--file", "private.mp4"], ["--cleanup-only", "--origin", "https://a.replit.app"],
    ["--run-synthetic", "--guide-id", stepId]]) assert.throws(() => parseArguments(args));
  for (const url of ["https://example.com", "http://app.replit.dev", "https://a.replit.dev.evil.test", "https://replit.dev",
    "http://127.1:8080", "http://2130706433:8080", "http://localhost/x/..", "https://a.replit.app:8443", "https://u:p@a.replit.app",
    "https://a.replit.dev/?token=secret", "https://a.replit.dev/#token", "https://a.replit.dev/\\bad", " https://a.replit.dev",
    "https://a.replit.dev/./", "http://[::1]:8080"]) assert.throws(() => checkedOrigin(url), url);
});

test("valid owner -> denied no-key/wrong-key -> valid owner -> acknowledged deletion, without AI", async () => {
  const h = harness();
  await checkPrivateAccess(h.run, h.options);
  assert.deepEqual(h.state(), { saved: true, removed: true, deleted: true });
  assert.equal(h.events.at(-1), "PASS");
  const denied = h.requests.filter(r => !r.deleted && r.init.method === "GET" && r.path !== "/api/healthz" &&
    !r.parsed.search && r.init.headers.Authorization !== `Bearer ${h.run.editToken}`);
  assert.equal(denied.length, 8);
  assert.equal(h.requests.filter(r => r.init.method === "POST").length, 1);
  assert.ok(!JSON.stringify(h.events).includes(h.run.editToken));
  assert.ok(!JSON.stringify(h.events).includes(h.run.guideId));
});

for (const variant of ["missing-key", "wrong-key", "html-denial", "leaky-denial"]) {
  test(`diagnostic catches ${variant} and still deletes its test guide`, async () => {
    const h = harness(r => {
      if (r.deleted || !r.path.endsWith("/draft")) return;
      const auth = r.init.headers.Authorization;
      if (variant === "missing-key" && !auth || variant === "wrong-key" && auth && auth !== `Bearer ${r.run.editToken}`) return r.json({ draft: r.draft });
      if (!auth && variant === "html-denial") return new Response("login page", { status: 404 });
      if (!auth && variant === "leaky-denial") return r.json({ code: "GUIDE_NOT_FOUND", document: "SYNTHETIC" }, 404);
    });
    await assert.rejects(checkPrivateAccess(h.run, h.options));
    assert.equal(h.state().deleted, true);
    assert.equal(h.state().removed, true);
    assert.ok(!h.events.includes("PASS"));
  });
}

test("a nonexistent guide is not a passing negative access check", async () => {
  const h = harness(r => r.init.method === "GET" && r.path.endsWith(r.run.guideId) ? r.hidden() : undefined);
  await assert.rejects(checkPrivateAccess(h.run, h.options));
  assert.ok(!h.events.includes("NO_KEY_AND_WRONG_KEY_DENIED"));
  assert.ok(!h.events.includes("PASS"));
});

for (const variant of ["deleted-mid-check", "no-store-missing", "wrong-upload-id", "external-image", "foreign-guide-image"]) {
  test(`positive-control or destination failure: ${variant}`, async () => {
    let ownerReads = 0;
    const h = harness(r => {
      if (r.deleted) return;
      if (variant === "wrong-upload-id" && r.init.method === "POST") return r.json({ guideId: stepId }, 202);
      if (r.path.endsWith(r.run.guideId) && r.init.method === "GET" && r.init.headers.Authorization === `Bearer ${r.run.editToken}`) {
        if (variant === "deleted-mid-check" && ++ownerReads > 1) return r.hidden();
        if (variant === "external-image") r.guide.steps[0].frameUrl = "https://evil.example/frame";
        if (variant === "foreign-guide-image") r.guide.steps[0].frameUrl = `/api/guides/${stepId}/assets/${stepId}/frame?asset_token=x`;
        if (variant === "no-store-missing") return new Response(JSON.stringify({ guide: r.guide }), { headers: { "content-type": "application/json" } });
      }
    });
    await assert.rejects(checkPrivateAccess(h.run, h.options));
    assert.ok(!h.events.includes("PASS"));
    assert.equal(h.state().deleted, true);
    assert.ok(h.requests.filter(r => r.init.method === "DELETE").every(r => r.path.endsWith(h.run.guideId)));
  });
}

for (const status of [404, 202, 503]) {
  test(`DELETE ${status} is not completed deletion and keeps the recovery credential`, async () => {
    const h = harness(r => r.init.method === "DELETE" ? r.json(status === 202 ? { status: "deleting" } : { code: "GUIDE_NOT_FOUND" }, status) : undefined);
    await assert.rejects(checkPrivateAccess(h.run, h.options), { code: "CLEANUP_UNCONFIRMED" });
    assert.equal(h.state().removed, false);
    assert.ok(!h.events.includes("PASS"));
  });
}

test("lost upload acknowledgement cleans only its allocated identity and never retries POST", async () => {
  const h = harness(r => { if (r.init.method === "POST") throw new Error(`secret ${r.run.editToken}`); });
  await assert.rejects(checkPrivateAccess(h.run, h.options), { code: "REQUEST_FAILED" });
  assert.equal(h.requests.filter(r => r.init.method === "POST").length, 1);
  assert.equal(h.state().removed, true);
  assert.ok(!JSON.stringify(h.events).includes(h.run.editToken));
});

test("abort after upload still attempts cleanup with a separate signal", async () => {
  const abort = new AbortController();
  const h = harness(r => { if (r.init.method === "POST") abort.abort(); });
  await assert.rejects(checkPrivateAccess(h.run, { ...h.options, signal: abort.signal }));
  const deletion = h.requests.find(r => r.init.method === "DELETE");
  assert.ok(deletion && !deletion.init.signal.aborted);
  assert.equal(h.state().removed, true);
});

test("failed recovery persistence prevents any upload or deletion", async () => {
  const h = harness();
  await assert.rejects(checkPrivateAccess(h.run, { ...h.options, saveRecovery: async () => { throw new Error("disk failure"); } }));
  assert.ok(!h.requests.some(r => r.init.method !== "GET"));
});

test("health failure does not create test state or upload", async () => {
  const h = harness(r => r.path === "/api/healthz" ? r.json({ status: "starting" }, 503) : undefined);
  await assert.rejects(checkPrivateAccess(h.run, h.options));
  assert.deepEqual(h.state(), { saved: false, removed: false, deleted: false });
});

test("response size is bounded and untrusted exception text never becomes a diagnostic code", async () => {
  const h = harness(r => r.path === "/api/healthz" ? r.json({ status: "ok", extra: "x".repeat(140000) }) : undefined);
  await assert.rejects(checkPrivateAccess(h.run, h.options), { code: "RESPONSE_TOO_LARGE" });
  assert.equal(safeCode(new Error("SECRET token=123")), "CHECK_FAILED");
});

async function localServer(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
test("real HTTP redirects receive no follow-up request", async t => {
  let destinationHits = 0;
  const destination = await localServer(t, (_req, res) => { destinationHits++; res.end("must not be reached"); });
  const origin = await localServer(t, (_req, res) => { res.writeHead(307, { Location: `${destination}/stolen` }); res.end(); });
  await assert.rejects(checkPrivateAccess(createRun(origin)));
  assert.equal(destinationHits, 0);
});
test("real HTTP stalled response body respects the request deadline", { timeout: 5000 }, async t => {
  const origin = await localServer(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"status":'); });
  await assert.rejects(checkPrivateAccess(createRun(origin), { requestMs: 80 }), { code: "REQUEST_TIMEOUT" });
});
test("real upload 307 never forwards multipart or the new edit key to its destination", async t => {
  let destinationHits = 0, uploads = 0, deletions = 0;
  const destination = await localServer(t, (_req, res) => { destinationHits++; res.end(); });
  const origin = await localServer(t, (req, res) => {
    req.resume();
    if (req.url === "/api/healthz") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"ok"}'); }
    else if (req.method === "POST") { uploads++; res.writeHead(307, { Location: `${destination}/stolen` }); res.end(); }
    else if (req.method === "DELETE") { deletions++; res.writeHead(204); res.end(); }
    else { res.writeHead(404, { "content-type": "application/json" }); res.end('{"code":"GUIDE_NOT_FOUND"}'); }
  });
  await assert.rejects(checkPrivateAccess(createRun(origin)), { code: "REQUEST_FAILED" });
  assert.equal(uploads, 1);
  assert.equal(deletions, 1);
  assert.equal(destinationHits, 0);
});
test("cleanup-only sends no POST and needs acknowledged deletion", async () => {
  const h = harness();
  await cleanupRun(h.run, h.options);
  assert.equal(h.requests.some(r => r.init.method === "POST"), false);
});

test("private recovery file is exclusive, scoped and removed only for the matching run", async t => {
  const root = await mkdtemp(join(tmpdir(), "showme-access-state-"));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  const store = recoveryStore(join(root, "recovery"));
  const run = createRun("http://127.0.0.1:8080");
  await store.assertEmpty();
  await store.save(run);
  assert.deepEqual(await store.read(), run);
  if (process.platform !== "win32") assert.equal((await lstat(join(root, "recovery/run.json"))).mode & 0o077, 0);
  await assert.rejects(store.assertEmpty(), { code: "RECOVERY_REQUIRED" });
  await assert.rejects(store.save(createRun(run.origin)));
  await assert.rejects(store.clear(createRun(run.origin)));
  assert.throws(() => assertPreviousProcessStopped(run), { code: "CHECK_STILL_RUNNING" });
  await store.clear(run);
  await store.assertEmpty();
  const outside = join(root, "untouched.json");
  await writeFile(outside, JSON.stringify(run));
  // Directory links can be created without Windows developer-mode privileges.
  const link = join(root, "linked");
  await symlink(join(root, "recovery"), link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(recoveryStore(link).assertEmpty(), { code: "RECOVERY_FILE_UNSAFE" });
  assert.equal(await readFile(outside, "utf8"), JSON.stringify(run));
});

test("real CLI failure preserves its recovery key; cleanup-only removes it without creating another guide", { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "showme-access-cli-"));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "scripts"));
  for (const file of ["check-private-access.mjs", "private-access-check.mjs", "private-access-recovery.mjs", "private-access-fixture.mjs"]) {
    await copyFile(new URL(`../${file}`, import.meta.url), join(root, "scripts", file));
  }
  let guideId, token, deleted = false, allowDelete = false, uploads = 0;
  const origin = await localServer(t, (req, res) => {
    req.resume();
    const path = req.url.split("?")[0];
    const json = (body, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    const hidden = () => json({ code: "GUIDE_NOT_FOUND" }, 404);
    if (path === "/api/healthz") return json({ status: "ok" });
    if (req.method === "POST") {
      uploads++; guideId = req.headers["x-showme-guide-id"]; token = req.headers.authorization;
      return json({ guideId, status: "ready" }, 202);
    }
    if (req.method === "DELETE") {
      if (!allowDelete) return hidden();
      deleted = true; res.writeHead(204); res.end(); return;
    }
    if (deleted || (req.headers.authorization !== token && !req.url.includes("asset_token=synthetic.ticket"))) return hidden();
    const base = `/api/guides/${guideId}`;
    if (path === base) return json({ guide: { id: guideId, status: "ready", steps: [{ id: stepId,
      frameUrl: `${base}/assets/${stepId}/frame?asset_token=synthetic.ticket`,
      thumbnailUrl: `${base}/assets/${stepId}/thumbnail?asset_token=synthetic.ticket` }] } });
    if (path.endsWith("/draft")) return json({ draft: { guideId, document: { steps: [{}] } } });
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" }); res.end(Buffer.from([255, 216, 255, 217]));
  });
  const execute = args => promisify(execFile)(process.execPath, [join(root, "scripts/check-private-access.mjs"), ...args], {
    cwd: root, env: testEnvironment(process.env), windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 });
  let output = "";
  await assert.rejects(execute(["--run-synthetic", "--origin", origin]), error => {
    output = error.stdout;
    assert.equal(error.code, 1);
    assert.ok(output.includes("FAIL CLEANUP_UNCONFIRMED"));
    assert.ok(!output.includes("PRIVATE_ACCESS_CHECK PASS"));
    return true;
  });
  const record = JSON.parse(await readFile(join(root, ".private-access-check/run.json"), "utf8"));
  assert.equal(record.guideId, guideId);
  assert.equal(`Bearer ${record.editToken}`, token);
  assert.ok(!output.includes(record.editToken) && !output.includes(guideId));
  allowDelete = true;
  const recovered = await execute(["--cleanup-only"]);
  assert.ok(recovered.stdout.includes("CLEANUP_ONLY_DONE"));
  assert.ok(!recovered.stdout.includes("PRIVATE_ACCESS_CHECK PASS"));
  assert.ok(!recovered.stdout.includes(record.editToken));
  assert.equal(uploads, 1);
  await assert.rejects(lstat(join(root, ".private-access-check/run.json")), { code: "ENOENT" });
  // A fresh CLI run after successful cleanup can pass normally as well.
  deleted = false;
  const passed = await execute(["--run-synthetic", "--origin", origin]);
  assert.ok(passed.stdout.includes("PRIVATE_ACCESS_CHECK PASS"));
  assert.equal(uploads, 2);
});
