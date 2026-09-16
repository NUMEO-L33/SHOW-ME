import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testEnvironment, testGroups } from "./test-environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const suites = {
  migration: { cwd: root, directory: "scripts/tests", extension: ".test.mjs" },
  server: { cwd: join(root, "artifacts/api-server"), directory: "tests", extension: ".test.ts" },
  client: { cwd: join(root, "artifacts/showme"), directory: "src/lib", extension: ".test.ts" },
};

try {
  for (const group of testGroups(process.argv.slice(2))) {
    const suite = suites[group];
    const files = readdirSync(join(suite.cwd, suite.directory), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(suite.extension))
      .map((entry) => join(suite.directory, entry.name)).sort();
    if (!files.length) throw new Error(`No ${group} test files found.`);
    const loader = group === "migration" ? [] : ["--import", pathToFileURL(
      createRequire(join(suite.cwd, "package.json")).resolve("tsx"),
    ).href];
    console.log(`ShowMe ${group}: ${files.length} files; application environment excluded; no .env loaded.`);
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...loader, "--test", "--test-concurrency=2", ...files], {
        cwd: suite.cwd, env: testEnvironment(process.env), stdio: "inherit", windowsHide: true,
      });
      const interrupt = () => child.kill("SIGTERM");
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      const cleanup = () => {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
      };
      child.once("error", (error) => { cleanup(); reject(error); });
      child.once("exit", (status) => { cleanup(); resolve(status ?? 1); });
    });
    if (code !== 0) { process.exitCode = code; break; }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "TEST_RUNNER_FAILED");
  process.exitCode = 1;
}
