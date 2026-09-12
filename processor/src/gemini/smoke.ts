import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AnalysisContractError } from "../analysis-contract.js";
import { GeminiAnalysisProvider, GeminiError } from "./provider.js";
import { createLocalRequestPermit, GEMINI_SMOKE_DAILY_REQUESTS } from "./quota.js";
import { buildGeminiRequest, GEMINI_MODEL, GEMINI_PROMPT_VERSION } from "./request.js";
import { syntheticAnalysisInput } from "./synthetic.js";

export const SYNTHETIC_CONSENT_VERSION = "synthetic-screens-only-v1";
const outputDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../.data/gemini-smoke");

export function smokeMode(args: string[], env: NodeJS.ProcessEnv): "dry-run" | "live" {
  if (args.length === 0) return "dry-run";
  if (args.length !== 1 || args[0] !== "--live") throw new GeminiError("GEMINI_DISABLED");
  if (!env.GEMINI_API_KEY) throw new GeminiError("GEMINI_KEY_MISSING");
  // These are user confirmations, not automated detection of the Google billing tier.
  if (env.SHOWME_GEMINI_FREE_TIER_CONFIRMED !== "true" ||
      env.SHOWME_GEMINI_SYNTHETIC_CONSENT !== SYNTHETIC_CONSENT_VERSION) throw new GeminiError("GEMINI_DISABLED");
  return "live";
}

export async function runSmoke(args: string[], env: NodeJS.ProcessEnv) {
  const mode = smokeMode(args, env);
  const input = await syntheticAnalysisInput();
  buildGeminiRequest(input);
  await mkdir(outputDirectory, { recursive: true });
  const runDirectory = await mkdtemp(join(outputDirectory, `${mode}-`));
  for (const image of input.images) await writeFile(join(runDirectory, `${image.stepId}.jpg`), image.bytes, { flag: "wx" });
  if (mode === "dry-run") return {
    status: "prepared-not-analyzed", model: GEMINI_MODEL, frames: input.images.length,
    networkCalls: 0, dailyLocalRequestLimit: GEMINI_SMOKE_DAILY_REQUESTS, directory: runDirectory,
  };
  const provider = new GeminiAnalysisProvider({
    apiKey: env.GEMINI_API_KEY!, allowExternalProcessing: true,
    reserveRequest: createLocalRequestPermit(join(outputDirectory, "quota")), transientRetries: 0,
  });
  const result = await provider.analyzeFrames(input, new AbortController().signal);
  if (result.status !== "completed") throw new GeminiError("GEMINI_RESPONSE_INVALID");
  // Only validated synthetic output and aggregate usage; no key, raw response or reasoning.
  await writeFile(join(runDirectory, "result.json"), JSON.stringify({
    model: GEMINI_MODEL, api: "generateContent", promptVersion: GEMINI_PROMPT_VERSION, syntheticOnly: true, ...result,
  }, null, 2), { flag: "wx", mode: 0o600 });
  return { status: "analyzed-synthetic-only", inputTokens: result.inputTokens,
    outputTokensIncludingThinking: result.outputTokens, directory: runDirectory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSmoke(process.argv.slice(2), process.env).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error: unknown) => {
    console.error(JSON.stringify({ status: "failed", code: error instanceof GeminiError ? error.code
      : error instanceof AnalysisContractError ? "AI_INVALID_OUTPUT" : "GEMINI_SMOKE_FAILED",
      httpStatus: error instanceof GeminiError ? error.httpStatus : undefined }));
    process.exitCode = 1;
  });
}
