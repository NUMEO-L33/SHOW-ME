import assert from "node:assert/strict";
import { test } from "node:test";
import { ScreenCapture, MAX_CAPTURE_BYTES, MAX_CAPTURE_MS, type CaptureState } from "./screen-capture.js";

class Track extends EventTarget {
  stops = 0; readyState = "live";
  stop() { this.stops++; this.readyState = "ended"; }
}
class Recorder {
  state = "inactive"; mimeType = "video/webm"; starts = 0; stops = 0; throwStop = false; throwStart = false;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  start() { this.starts++; if (this.throwStart) throw new Error("private start error"); this.state = "recording"; }
  stop() { this.stops++; if (this.throwStop) throw new Error("private stop error"); this.state = "inactive"; }
  chunk(value = "synthetic") { this.ondataavailable?.({ data: new Blob([value]) }); }
  finish() { this.state = "inactive"; this.onstop?.(); }
}
function fixture(options: { audio?: boolean; prompt?: Promise<MediaStream>; constructorError?: boolean } = {}) {
  const tracks = [new Track(), new Track()]; const recorder = new Recorder();
  const stream = { getTracks: () => tracks, getAudioTracks: () => options.audio ? [tracks[1]] : [], getVideoTracks: () => options.audio ? [tracks[0]] : tracks } as unknown as MediaStream;
  const states: CaptureState[] = []; const files: File[] = []; const errors: string[] = []; let prompts = 0;
  const capture = new ScreenCapture({
    getStream: () => { prompts++; return options.prompt ?? Promise.resolve(stream); },
    makeRecorder: () => { if (options.constructorError) throw new Error("private constructor"); return recorder as unknown as MediaRecorder; },
    onState: state => states.push(state), onElapsed: () => {}, onRecorded: file => files.push(file), onError: error => errors.push(error),
  });
  return { capture, tracks, recorder, stream, states, files, errors, prompts: () => prompts };
}

test("stop ends all capture tracks synchronously, then accepts final bytes exactly once without network", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("capture must not call network"); });
  const f = fixture(); t.after(() => f.capture.dispose()); await f.capture.start(); f.recorder.chunk();
  f.capture.stop();
  assert.ok(f.tracks.every(track => track.readyState === "ended"));
  assert.equal(f.states.at(-1), "stopping"); assert.equal(f.files.length, 0);
  f.recorder.chunk("final"); f.recorder.finish(); f.recorder.finish();
  assert.equal(f.files.length, 1); assert.equal(await f.files[0].text(), "syntheticfinal"); assert.equal(f.states.at(-1), "idle");
});

test("cancel/pagehide and dispose discard buffers and ignore captured late callbacks", async () => {
  for (const dispose of [false, true]) {
    const f = fixture(); await f.capture.start(); f.recorder.chunk();
    const stop = f.recorder.onstop!; const data = f.recorder.ondataavailable!;
    if (dispose) f.capture.dispose(); else f.capture.cancel();
    stop(); data({ data: new Blob(["late"]) });
    assert.ok(f.tracks.every(track => track.readyState === "ended")); assert.equal(f.files.length, 0);
    assert.equal(f.recorder.ondataavailable, null); assert.equal(f.recorder.onerror, null);
    f.capture.dispose();
  }
});

test("late display selection after cancellation/unmount is immediately released; double start cannot open another prompt", async () => {
  for (const dispose of [false, true]) {
    let resolve!: (stream: MediaStream) => void;
    const f = fixture({ prompt: new Promise<MediaStream>(r => { resolve = r; }) });
    const starting = f.capture.start(); await f.capture.start(); assert.equal(f.prompts(), 1);
    if (dispose) f.capture.dispose(); else f.capture.cancel();
    resolve(f.stream); await starting;
    assert.ok(f.tracks.every(track => track.readyState === "ended")); assert.equal(f.recorder.starts, 0); assert.equal(f.files.length, 0);
    f.capture.dispose();
  }
});

test("constructor/start/stop errors and recorder errors always release tracks and never deliver partial files", async () => {
  for (const mode of ["constructor", "start", "stop", "event"]) {
    const f = fixture({ constructorError: mode === "constructor" });
    f.recorder.throwStart = mode === "start"; f.recorder.throwStop = mode === "stop";
    await f.capture.start(); f.recorder.chunk();
    if (mode === "stop") f.capture.stop(); if (mode === "event") f.recorder.onerror?.();
    assert.ok(f.tracks.every(track => track.readyState === "ended")); assert.equal(f.files.length, 0);
    assert.equal(f.errors.length, 1); assert.doesNotMatch(f.errors[0], /private/); f.capture.dispose();
  }
});

test("a missing stop event times out after capture is already ended; late data cannot restore the file", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture(); await f.capture.start(); f.recorder.chunk(); const stop = f.recorder.onstop!;
  f.capture.stop(); assert.ok(f.tracks.every(track => track.readyState === "ended"));
  t.mock.timers.tick(3_000); stop();
  assert.equal(f.files.length, 0); assert.equal(f.errors.length, 1); f.capture.dispose();
});

test("browser sharing stop releases the complete stream, including an already inactive recorder", async () => {
  const f = fixture(); await f.capture.start(); f.recorder.chunk(); f.recorder.state = "inactive";
  f.tracks[0].dispatchEvent(new Event("ended"));
  assert.ok(f.tracks.every(track => track.readyState === "ended")); f.recorder.finish(); assert.equal(f.files.length, 1); f.capture.dispose();
});

test("unexpected audio is rejected before a recorder starts", async () => {
  const f = fixture({ audio: true }); await f.capture.start();
  assert.ok(f.tracks.every(track => track.readyState === "ended")); assert.equal(f.recorder.starts, 0); assert.equal(f.files.length, 0); assert.equal(f.errors.length, 1); f.capture.dispose();
});

test("size overflow discards the file; elapsed time limit stops capture", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100 });
  const f = fixture(); await f.capture.start();
  f.recorder.ondataavailable?.({ data: { size: MAX_CAPTURE_BYTES + 1 } as Blob });
  assert.ok(f.tracks.every(track => track.readyState === "ended")); assert.equal(f.files.length, 0); f.capture.dispose();
  const timed = fixture(); await timed.capture.start(); timed.recorder.chunk();
  t.mock.timers.setTime(100 + MAX_CAPTURE_MS); timed.capture.checkElapsed();
  assert.ok(timed.tracks.every(track => track.readyState === "ended")); timed.recorder.finish(); assert.equal(timed.files.length, 1); timed.capture.dispose();
});
