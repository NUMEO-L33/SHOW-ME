import { AnalysisAdmissionError } from "./analysis-admission.js";
import type { AnalysisAdmission } from "./analysis-api.js";
import type { GuideRepository } from "./domain.js";
import type { Storage } from "./storage.js";

export type ProcessorAnalysisContext = { repository: GuideRepository; storage: Storage };
export type ProcessorAnalysisRuntime = ProcessorAnalysisContext & { admission: AnalysisAdmission; start(): void; stop(): Promise<void> };
export type ProcessorAnalysisFactory = (context: ProcessorAnalysisContext) => ProcessorAnalysisRuntime | Promise<ProcessorAnalysisRuntime>;

/** Trusted startup injection. Configured bootstrap must authenticate its DB-held activation first. */
export async function createAnalysisLifecycle(context: ProcessorAnalysisContext, factory?: ProcessorAnalysisFactory) {
  if (!factory) return undefined;
  const runtime = await factory({ ...context });
  if (runtime.repository !== context.repository || runtime.storage !== context.storage) {
    await runtime.stop().catch(() => undefined);
    throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE");
  }
  let active = false, stopped = false; let closing: Promise<void> | undefined;
  const admission: AnalysisAdmission = { request: async (...args) => {
    if (!active || stopped) throw new AnalysisAdmissionError("ANALYSIS_UNAVAILABLE");
    return runtime.admission.request(...args);
  }, inspectAvailability: async (...args) => {
    if (!active || stopped || !runtime.admission.inspectAvailability) return false;
    try { return await runtime.admission.inspectAvailability(...args) === true && active && !stopped; }
    catch { return false; }
  } };
  return {
    admission,
    start() { if (stopped || active) return; runtime.start(); active = true; },
    stop() {
      active = false; stopped = true;
      // Invoke stop immediately so it invalidates in-flight evidence before the caller closes HTTP/DB.
      if (!closing) { try { closing = Promise.resolve(runtime.stop()); } catch (error) { closing = Promise.reject(error); } }
      return closing;
    },
  };
}
