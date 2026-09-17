import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testEnvironment } from "./test-environment.mjs";

// One fixed, isolated test file; not a replacement for the default test runner.
if (process.argv.length !== 2) {
  console.error("Use node scripts/diagnose-images.mjs without arguments.");
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const cwd = join(root, "artifacts/api-server");
  const loader = pathToFileURL(createRequire(join(cwd, "package.json")).resolve("tsx")).href;
  console.log("IMAGE_PROCESS_CHECK", process.version, process.platform);
  console.log("Diagnostic run only: application image budgets apply (4.5s cumulative I/O + 10s decoder); no application environment or .env.");
  const child = spawn(process.execPath, [
    "--import", loader, "--import", new URL("./observe-image-process.mjs", import.meta.url).href,
    "--test", "--test-concurrency=2", "tests/analysis-images.test.ts",
  ], { cwd, env: testEnvironment(process.env), stdio: "inherit", windowsHide: true });
  const interrupt = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const cleanup = () => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  };
  child.once("error", () => { cleanup(); console.error("IMAGE_PROCESS_CHECK_START_FAILED"); process.exitCode = 1; });
  child.once("exit", (code) => {
    cleanup(); console.log("IMAGE_PROCESS_CHECK_EXIT", code);
    process.exitCode = code ?? 1;
  });
}
