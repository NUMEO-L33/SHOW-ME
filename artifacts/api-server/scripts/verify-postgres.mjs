import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { testEnvironment } from "../../../scripts/test-environment.mjs";

// Deliberately separate from `check`: never reads .env, pulls images, or uses DATABASE_URL.
const exec = promisify(execFile);
const cli = process.env.SHOWME_TEST_DOCKER_BIN ?? "docker";
const host = process.env.SHOWME_TEST_DOCKER_HOST;
if (process.argv[2] !== "--local-docker" || !["npipe:////./pipe/dockerDesktopLinuxEngine", "unix:///var/run/docker.sock"].includes(host)) {
  throw new Error("Explicit --local-docker and an allowlisted local SHOWME_TEST_DOCKER_HOST are required.");
}
const run = randomUUID().replaceAll("-", "");
const name = `showme-b5-${run}`;
const database = `showme_b5_${run}`;
const password = randomUUID(); // Disposable fixture credential, never printed or persisted.
const docker = async (args, timeout = 30_000) => (await exec(cli, ["--host", host, ...args], { timeout, windowsHide: true, maxBuffer: 1024 * 1024 })).stdout.trim();
let created = false;
let child;
let cancelled = false;
const stopChild = () => { cancelled = true; child?.kill(); };
process.once("SIGINT", stopChild); process.once("SIGTERM", stopChild);
try {
  const image = await docker(["image", "inspect", "postgres:16", "--format", "{{.Id}}"]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("A pre-existing local postgres:16 image is required; no image is downloaded.");
  if (cancelled) throw new Error("Cancelled");
  // Clean up by unique label even when run's acknowledgement is lost after creation.
  created = true;
  await docker(["run", "--detach", "--rm", "--pull=never", "--name", name,
    "--label", `showme.b5.run=${run}`, "--cpus=1", "--memory=512m", "--pids-limit=256",
    "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=268435456",
    "--env", `POSTGRES_PASSWORD=${password}`, "--env", `POSTGRES_DB=${database}`, image,
    "postgres", "-c", "max_connections=60"]);
  const port = await docker(["port", name, "5432/tcp"]);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(port);
  if (!match) throw new Error("The fixture must publish only on IPv4 loopback.");
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (cancelled) throw new Error("Cancelled");
    try { await docker(["exec", name, "pg_isready", "-U", "postgres", "-d", database], 5000); ready = true; break; }
    catch { await delay(250); }
  }
  if (!ready) throw new Error("Temporary PostgreSQL did not become ready.");
  if (cancelled) throw new Error("Cancelled");
  console.log(JSON.stringify({ event: "postgres_fixture_ready", container: name, image, loopbackOnly: true, persistentHostMounts: false }));
  const env = { ...testEnvironment(process.env), SHOWME_PG_TEST_RUN: run,
    SHOWME_PG_TEST_URL: `postgresql://postgres:${password}@127.0.0.1:${match[1]}/${database}` };
  for (const key of ["DATABASE_URL", "GEMINI_API_KEY", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]) delete env[key];
  const code = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "integration/postgres.test.ts"],
      { cwd: fileURLToPath(new URL("../", import.meta.url)), env, stdio: "inherit", windowsHide: true });
    child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} catch {
  // Docker invocation errors may contain the temporary password; never echo the command/error.
  console.error("POSTGRES_VERIFICATION_SETUP_FAILED (no application credentials used)"); process.exitCode = 1;
} finally {
  if (created) {
    try {
      const label = await docker(["inspect", name, "--format", '{{index .Config.Labels "showme.b5.run"}}']);
      if (label !== run || name !== `showme-b5-${run}`) throw new Error("Fixture ownership mismatch.");
      await docker(["stop", "--time", "5", name]); // --rm and tmpfs remove only this run's disposable fixture.
      console.log(JSON.stringify({ event: "postgres_fixture_removed", container: name, disposableDataRemoved: true }));
    } catch { console.error(`POSTGRES_FIXTURE_CLEANUP_REQUIRED: ${name}`); process.exitCode = 1; }
  }
  process.removeListener("SIGINT", stopChild); process.removeListener("SIGTERM", stopChild);
}
