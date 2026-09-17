import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { captureLinuxChildState } from "../image-process-linux.mjs";
import { testEnvironment } from "../test-environment.mjs";

const childState = () => ({ pid: 123, exitCode: null, signalCode: null, killed: false });
function stat({ pid = 123, parent = 45, start = 678, command = "private ) name" } = {}) {
  const fields = Array(22).fill("0");
  Object.assign(fields, { 0: "S", 1: String(parent), 7: "81", 9: "2", 11: "7", 12: "3", 17: "4", 19: String(start) });
  return `${pid} (${command}) ${fields.join(" ")}\n`;
}
const status = "Name:\tprivate-command\nState:\tS (sleeping)\nThreads:\t4\nVmRSS:\t1234 kB\n" +
  "voluntary_ctxt_switches:\t9\nnonvoluntary_ctxt_switches:\t2\nSecret:\tprivate-value\n";
function setup(files = {}) {
  const paths = [];
  return {
    paths,
    options: { platform: "linux", parentPid: 45, read: async (path) => {
      paths.push(path);
      return ({ stat: stat(), status, wchan: "pipe_read\n", ...files })[path.split("/").at(-1)];
    } },
  };
}

test("OS sample reads only owned-child stat/status/wchan and emits selected metadata", async () => {
  const { options, paths } = setup();
  const result = await captureLinuxChildState(childState(), options);
  assert.deepEqual(result, {
    available: true,
    stat: { state: "S", userTicks: 7, systemTicks: 3, minorFaults: 81, majorFaults: 2, threads: 4 },
    status: { state: "S", threads: 4, rssKiB: 1234, voluntarySwitches: 9, involuntarySwitches: 2 },
    kernelWait: "pipe_read",
  });
  assert.deepEqual(paths, ["/proc/123/stat", "/proc/123/status", "/proc/123/wchan", "/proc/123/stat"]);
  assert.doesNotMatch(JSON.stringify(result), /private|parent|startTicks|\/proc/);
});

test("unsupported OS and ended/invalid child do not access proc", async () => {
  const { options, paths } = setup();
  assert.deepEqual(await captureLinuxChildState(childState(), { ...options, platform: "win32" }),
    { available: false, reason: "not-linux" });
  for (const change of [{ pid: undefined }, { pid: -1 }, { pid: "../secret" }, { exitCode: 0 }, { signalCode: "SIGKILL" }, { killed: true }]) {
    assert.deepEqual(await captureLinuxChildState({ ...childState(), ...change }, options),
      { available: false, reason: "not-running" });
  }
  assert.deepEqual(paths, []);
});

test("missing/malformed proc identity is unavailable and never leaks errors", async () => {
  for (const value of [null, "", "private-error", stat({ start: "9007199254740992" })]) {
    const { options } = setup({ stat: value });
    assert.deepEqual(await captureLinuxChildState(childState(), options), { available: false, reason: "stat-unavailable" });
  }
  const { options } = setup();
  options.read = async () => { throw new Error("private-path-and-secret"); };
  assert.deepEqual(await captureLinuxChildState(childState(), options), { available: false, reason: "stat-unavailable" });
});

test("unrelated PID/parent rejects metadata collection", async () => {
  for (const change of [{ pid: 124 }, { parent: 46 }]) {
    const { options, paths } = setup({ stat: stat(change) });
    assert.deepEqual(await captureLinuxChildState(childState(), options), { available: false, reason: "not-owned-child" });
    assert.deepEqual(paths, ["/proc/123/stat"]);
  }
});

test("identity changes or child exit during reads discard the entire sample", async () => {
  for (const mode of ["start", "parent", "pid", "missing", "exit"]) {
    const child = childState();
    let reads = 0;
    const { options } = setup();
    options.read = async (path) => {
      if (!path.endsWith("/stat")) return "";
      if (++reads === 1) return stat();
      if (mode === "exit") child.exitCode = 0;
      if (mode === "missing") return null;
      return stat({ [mode]: 999 });
    };
    assert.deepEqual(await captureLinuxChildState(child, options), { available: false, reason: "child-changed" });
  }
});

test("hidden wait symbols and absent fields remain unknown, not healthy zeroes", async () => {
  for (const wchan of [null, "0\n", "", "secret/path\n", "kernel_wait\nprivate-value", "a".repeat(129)]) {
    const { options } = setup({ status: null, wchan });
    const result = await captureLinuxChildState(childState(), options);
    assert.equal(result.available, true);
    assert.equal(result.status, null);
    assert.equal(result.kernelWait, null);
  }
  const { options } = setup({ status: "State:\t?\nThreads:\t-1\nVmRSS:\tnope\n" });
  assert.deepEqual((await captureLinuxChildState(childState(), options)).status,
    { state: null, threads: null, rssKiB: null, voluntarySwitches: null, involuntarySwitches: null });
});

test("real own-child sample uses Linux proc or explicitly reports unsupported OS", { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ["-e", 'process.stdin.resume(); process.stdout.write("ready");'], {
    env: testEnvironment(process.env), stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  });
  const closed = once(child, "close");
  try {
    await once(child.stdout, "data");
    const result = await captureLinuxChildState(child);
    if (process.platform === "linux") {
      assert.equal(result.available, true);
      assert.ok(result.stat.threads >= 1);
      assert.ok(result.stat.userTicks >= 0);
      assert.ok(result.status.threads >= 1);
    } else {
      assert.deepEqual(result, { available: false, reason: "not-linux" });
    }
  } finally {
    child.kill();
    await closed;
  }
});
