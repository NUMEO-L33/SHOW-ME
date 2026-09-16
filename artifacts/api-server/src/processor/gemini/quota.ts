import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { GeminiError, type RequestPermit } from "./provider.js";

export const GEMINI_SMOKE_DAILY_REQUESTS = 10;

/**
 * Local smoke-test safety cap, not a production/distributed billing budget.
 * Every attempted request consumes an atomic file slot, even on failure.
 * Reopening this directory does not reset usage. Do not delete quota files.
 */
export function createLocalRequestPermit(directory: string, now: () => Date = () => new Date()): RequestPermit {
  return async (signal) => {
    if (signal.aborted) throw new GeminiError("GEMINI_CANCELLED");
    try {
      const day = now().toISOString().slice(0, 10);
      const dayDirectory = join(directory, day);
      await mkdir(dayDirectory, { recursive: true });
      for (let index = 1; index <= GEMINI_SMOKE_DAILY_REQUESTS; index += 1) {
        if (signal.aborted) throw new GeminiError("GEMINI_CANCELLED");
        let file;
        try { file = await open(join(dayDirectory, `${index}.reserved`), "wx", 0o600); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
        try {
          await file.writeFile("reserved\n", "utf8");
          await file.sync();
        } finally { await file.close(); }
        if (signal.aborted) throw new GeminiError("GEMINI_CANCELLED");
        return;
      }
    } catch (error) {
      if (error instanceof GeminiError) throw error;
      // Unknown/corrupt storage state fails closed, without leaking paths.
      throw new GeminiError("GEMINI_LOCAL_LIMIT");
    }
    throw new GeminiError("GEMINI_LOCAL_LIMIT");
  };
}
