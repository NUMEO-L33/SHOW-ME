// Opt-in diagnostic metadata only. No command lines, environment, maps or pixels.
// Field definitions: https://docs.kernel.org/filesystems/proc.html
import { open } from "node:fs/promises";

async function readProcText(path) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead <= 4096 ? buffer.toString("utf8", 0, bytesRead) : null;
  } finally { await handle.close(); }
}
const natural = (value) => typeof value === "string" && /^\d+$/.test(value) &&
  Number.isSafeInteger(Number(value)) ? Number(value) : null;
const state = (value) => /^[RSDZTtXxKWPIN]$/.test(value ?? "") ? value : null;

function parseStat(text) {
  if (typeof text !== "string") return null;
  // comm can contain spaces and parentheses. Never include it in the result.
  const head = text.match(/^(\d+) \(/);
  const end = text.lastIndexOf(") ");
  if (!head || end < head[0].length) return null;
  const fields = text.slice(end + 2).trim().split(/\s+/);
  const result = {
    pid: natural(head[1]), parentPid: natural(fields[1]), startTicks: natural(fields[19]),
    state: state(fields[0]), minorFaults: natural(fields[7]), majorFaults: natural(fields[9]),
    userTicks: natural(fields[11]), systemTicks: natural(fields[12]), threads: natural(fields[17]),
  };
  return Object.values(result).some((value) => value === null) ? null : result;
}
function parseStatus(text) {
  if (typeof text !== "string") return null;
  const fields = new Map(text.split("\n").map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon), line.slice(colon + 1).trim()];
  }));
  return {
    state: state(fields.get("State")?.split(/\s+/)[0]),
    threads: natural(fields.get("Threads")),
    rssKiB: natural(fields.get("VmRSS")?.match(/^(\d+) kB$/)?.[1]),
    voluntarySwitches: natural(fields.get("voluntary_ctxt_switches")),
    involuntarySwitches: natural(fields.get("nonvoluntary_ctxt_switches")),
  };
}
const running = (child) => Number.isSafeInteger(child.pid) && child.pid > 0 &&
  child.exitCode === null && child.signalCode === null && !child.killed;

export async function captureLinuxChildState(child, {
  platform = process.platform, parentPid = process.pid, read = readProcText,
} = {}) {
  const unavailable = (reason) => ({ available: false, reason });
  if (platform !== "linux") return unavailable("not-linux");
  if (!running(child)) return unavailable("not-running");
  const pid = child.pid;
  const safeRead = async (name) => {
    try { return await read(`/proc/${pid}/${name}`); } catch { return null; }
  };
  const before = parseStat(await safeRead("stat"));
  if (!before) return unavailable("stat-unavailable");
  if (before.pid !== pid || before.parentPid !== parentPid) return unavailable("not-owned-child");
  const [statusText, waitText] = await Promise.all([safeRead("status"), safeRead("wchan")]);
  const after = parseStat(await safeRead("stat"));
  // Reject samples if the child exited or its identity changed during async reads.
  if (!running(child) || child.pid !== pid || !after || after.pid !== pid ||
      after.parentPid !== parentPid || after.startTicks !== before.startTicks) {
    return unavailable("child-changed");
  }
  const wait = typeof waitText === "string" ? waitText.trim() : "";
  return {
    available: true,
    stat: {
      state: after.state, userTicks: after.userTicks, systemTicks: after.systemTicks,
      minorFaults: after.minorFaults, majorFaults: after.majorFaults, threads: after.threads,
    },
    status: parseStatus(statusText),
    // 0 can mean no wait symbol or insufficient visibility; never label it "running".
    kernelWait: wait !== "0" && /^[A-Za-z_][A-Za-z0-9_.$]{0,127}$/.test(wait) ? wait : null,
  };
}
