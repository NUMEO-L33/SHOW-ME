import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CheckFailure, validateRun } from "./private-access-check.mjs";

const refuse = () => { throw new CheckFailure("RECOVERY_FILE_UNSAFE"); };
export function recoveryStore(directory) {
  const file = join(directory, "run.json");
  async function checkDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077))) refuse();
  }
  async function read() {
    await checkDirectory();
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2048) refuse();
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || actual.nlink !== 1 || actual.size > 2048 || actual.ino !== info.ino ||
          (process.platform !== "win32" && (actual.mode & 0o077))) refuse();
      const data = await handle.readFile("utf8");
      return validateRun(JSON.parse(data));
    } finally { await handle.close(); }
  }
  return {
    async assertEmpty() {
      await checkDirectory();
      try { await lstat(file); }
      catch (error) { if (error?.code === "ENOENT") return; throw new CheckFailure("RECOVERY_FILE_UNSAFE"); }
      throw new CheckFailure("RECOVERY_REQUIRED");
    },
    async save(run) {
      validateRun(run);
      await checkDirectory();
      const handle = await open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(run)); await handle.sync(); }
      finally { await handle.close(); }
    },
    read,
    async clear(run) {
      const stored = await read();
      if (stored.guideId !== run.guideId || stored.editToken !== run.editToken || stored.origin !== run.origin) refuse();
      await unlink(file); // Only this tool's exact recovery file, never a directory.
    },
  };
}

export function assertPreviousProcessStopped(run) {
  try { process.kill(run.pid, 0); }
  catch (error) { if (error?.code === "ESRCH") return; throw new CheckFailure("RECOVERY_PROCESS_UNCERTAIN"); }
  // PID reuse may conservatively block cleanup; never terminate the process.
  throw new CheckFailure("CHECK_STILL_RUNNING");
}
