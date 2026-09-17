import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("private client boot restricts connections and resources; no optional external font or inspection bridge", () => {
  const html = read("artifacts/showme/index.html");
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /connect-src 'self';/);
  assert.match(html, /img-src 'self' data: blob:;/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /base-uri 'none'/);
  assert.doesNotMatch(html, /(?:src|href)="https?:/);
  assert.doesNotMatch(read("artifacts/showme/vite.config.ts"), /vite-plugin-(?:runtime-error-modal|cartographer|dev-banner)/);
});

test("capture lifetime code has no network or persistent-storage API; component requests no audio and discards on pagehide", () => {
  assert.doesNotMatch(read("artifacts/showme/src/lib/screen-capture.ts"), /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB|postMessage)\b/);
  const recorder = read("artifacts/showme/src/components/screen-recorder.tsx");
  assert.match(recorder, /audio: false/);
  assert.match(recorder, /pagehide.*capture\.cancel\(\)/);
  assert.match(recorder, /capture\.dispose\(\)/);
});

test("active processor error-log paths use a fixed privacy formatter instead of raw exception strings", () => {
  for (const file of ["index", "pipeline", "dispatcher", "queue", "asset-lifecycle"]) {
    const source = read(`artifacts/api-server/src/processor/${file}.ts`);
    assert.match(source, /import \{ privateLogError \}/);
    assert.doesNotMatch(source, /instanceof Error \? \w+\.message : String\(\w+\)/);
  }
});
