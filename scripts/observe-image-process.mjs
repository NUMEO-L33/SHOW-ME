// Opt-in diagnostic preload only. Never import from application/default tests.
// https://nodejs.org/download/release/v24.13.0/docs/api/diagnostics_channel.html#event-child_process
import { subscribe } from "node:diagnostics_channel";
import { writeSync } from "node:fs";
import { captureLinuxChildState } from "./image-process-linux.mjs";

const records = [];
const isDecoder = (child) => Array.isArray(child.spawnargs) &&
  child.spawnargs.includes("mjpeg") && child.spawnargs.includes("rawvideo");
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const flag = (value) => typeof value === "boolean" ? value : null;
const emit = (name, value) => writeSync(1, `${name} ${JSON.stringify(value)}\n`);
function snapshot({ child, started }, index) {
  return {
    index, elapsedMs: Math.round(performance.now() - started),
    pidAssigned: Number.isInteger(child.pid), killed: child.killed,
    exitCode: child.exitCode, signalCode: child.signalCode,
    inputBytes: count(child.stdin?.bytesWritten),
    inputEnded: flag(child.stdin?.writableEnded),
    inputFinished: flag(child.stdin?.writableFinished),
    inputPendingBytes: count(child.stdin?.writableLength),
    outputBytes: count(child.stdout?.bytesRead),
    outputEnded: flag(child.stdout?.readableEnded),
    outputBufferedBytes: count(child.stdout?.readableLength),
  };
}
subscribe("child_process", ({ process: child }) => {
  if (records.length >= 32) return;
  // This notification precedes spawnargs/stdio assignment. Inspect later.
  const record = { child, started: performance.now() };
  records.push(record);
  const timer = setTimeout(() => {
    if (!isDecoder(child) || child.exitCode !== null || child.signalCode !== null || child.killed) return;
    const index = records.filter(({ child: item }) => isDecoder(item)).indexOf(record);
    emit("IMAGE_PROCESS_WAIT", snapshot(record, index));
    // Async, bounded /proc metadata reads only after a stall. No warm-up, pipe
    // consumption, child listeners or changes to the existing 4.5s deadline.
    const sampleStarted = performance.now();
    void captureLinuxChildState(child).then((os) => {
      emit("IMAGE_PROCESS_OS_STATE", {
        index, elapsedMs: Math.round(performance.now() - record.started),
        sampleMs: Math.round(performance.now() - sampleStarted), os,
      });
    }, () => emit("IMAGE_PROCESS_OS_STATE", { index, os: { available: false, reason: "sample-failed" } }));
  }, 3500);
  timer.unref();
});
process.once("exit", () => {
  const decoders = records.filter(({ child }) => isDecoder(child));
  emit("IMAGE_PROCESS_FINAL", {
    decoderCount: decoders.length, observedProcesses: records.length,
    observationLimitReached: records.length === 32, decoders: decoders.map(snapshot),
  });
});
