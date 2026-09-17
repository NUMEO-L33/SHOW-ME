import assert from "node:assert/strict";
import { test } from "node:test";
import { privateDestination, privateProcessorOrigin } from "./private-destination.js";
import { createGuide, getGuide, deleteGuide, retryGuide, boundedRequest, ProcessorClientError } from "./processor-client.js";
import { getDraft } from "./draft-client.js";
import { jobIssueFor } from "./job-feedback.js";

const origin = "https://showme.example";
const identity = { guideId: "synthetic-guide", editToken: "synthetic-key" };
const file = () => new File(["synthetic only"], "synthetic.webm", { type: "video/webm" });

test("only the current origin is eligible; lookalikes, credentials, downgrade and alternate ports fail closed", () => {
  assert.equal(privateProcessorOrigin(origin, origin), origin);
  for (const value of ["https://other.example", "https://showme.example.evil.test", "https://showme.example:444", "http://showme.example", "https://u:p@showme.example", "https://showme.example/#private", "https://showme.example/?token=x", "https://showme.example/path", "//showme.example", "https://showme.example\\@other.example", " https://showme.example"]) {
    assert.equal(privateProcessorOrigin(value, origin), null, value);
  }
  assert.equal(privateDestination("https://other.example/api/guides", origin), null);
  assert.equal(privateProcessorOrigin("http://127.0.0.1:1234", "http://127.0.0.1:1234"), "http://127.0.0.1:1234");
});

test("configured/recovered foreign destinations cannot receive a file, token, draft, retry or deletion", async t => {
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => { sends++; throw new Error("must not send"); });
  for (const baseUrl of ["https://foreign.example", "http://foreign.example", "https://localhost@foreign.example"]) {
    for (const operation of [
      () => createGuide(baseUrl, file(), identity, () => {}),
      () => getGuide(baseUrl, identity.guideId, identity.editToken),
      () => deleteGuide(baseUrl, identity.guideId, identity.editToken),
      () => retryGuide(baseUrl, identity.guideId, identity.editToken),
      () => getDraft({ ...identity, baseUrl }),
    ]) await assert.rejects(operation, error => error instanceof ProcessorClientError && error.code === "PRIVATE_DESTINATION_BLOCKED");
  }
  assert.equal(sends, 0);
  assert.equal(jobIssueFor(new ProcessorClientError("secret", undefined, "PRIVATE_DESTINATION_BLOCKED"), 0).autoRetry, false);
});

test("upload and retry forbid redirects, foreign origin mode, cache and referrer; only confirmed upload reports complete", async t => {
  let sends = 0; const progress: number[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    sends++;
    assert.equal(options.redirect, "error"); assert.equal(options.mode, "same-origin");
    assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
    assert.equal(options.referrerPolicy, "no-referrer");
    if (options.body) {
      assert.equal((options.body as FormData).get("video") instanceof File, true);
      assert.deepEqual(progress, []);
      return Response.json({ guideId: identity.guideId, status: "queued" }, { status: 202 });
    }
    return Response.json({ status: "queued" });
  });
  await createGuide("http://127.0.0.1:1", file(), identity, p => progress.push(p));
  await retryGuide("http://127.0.0.1:1", identity.guideId, identity.editToken);
  assert.equal(sends, 2); assert.deepEqual(progress, [100]);
});

test("pre-aborted requests never call the network; rejected redirects cannot claim completed upload", async t => {
  let sends = 0; const progress: number[] = [];
  t.mock.method(globalThis, "fetch", async () => { sends++; throw new TypeError("redirect rejected"); });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(createGuide("http://127.0.0.1:1", file(), identity, p => progress.push(p), abort.signal), { name: "AbortError" });
  assert.equal(sends, 0);
  await assert.rejects(createGuide("http://127.0.0.1:1", file(), identity, p => progress.push(p)));
  assert.equal(sends, 1); assert.deepEqual(progress, []);
});

test("malformed guide asset URLs cannot cause an external or unrelated resource request", async t => {
  for (const url of ["https://foreign.example/video", "//foreign.example/video", "/api/guides/other/assets/step/frame", "/api/guides/synthetic-guide/assets/step/frame?secret=leak", "/api/guides/synthetic-guide/assets/step/frame#secret"]) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ guide: { id: identity.guideId, status: "ready", progress: 100, steps: [{ id: "step", frameUrl: url }] } }));
    await assert.rejects(getGuide("http://127.0.0.1:1", identity.guideId, identity.editToken), error => error instanceof ProcessorClientError && error.code === "INVALID_RESPONSE");
    mock.mock.restore();
  }
});

test("unrelated API paths are blocked before any request", async t => {
  let sends = 0; t.mock.method(globalThis, "fetch", async () => { sends++; return Response.json({}); });
  await assert.rejects(boundedRequest("http://127.0.0.1:1/collect", {}, async r => r.json()));
  assert.equal(sends, 0);
});
