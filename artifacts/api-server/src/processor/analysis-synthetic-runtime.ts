import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { activationForGrant, matchesAnalysisActivation } from "./analysis-activation.js";
import { DurableAnalysisAdmission } from "./analysis-admission.js";
import { PostgresAnalysisDatabaseProbe } from "./analysis-database-probe.js";
import { DurableAnalysisDispatcher } from "./analysis-dispatcher.js";
import { LocalAnalysisEvidence, evidenceUnavailable } from "./analysis-local-evidence.js";
import { OperationsReviewEvidenceSource } from "./analysis-operations-source.js";
import { PostgresAnalysisOperationsStore } from "./analysis-operations-store.js";
import { PostgresAnalysisQuotaStore } from "./analysis-quota-store.js";
import { EvidenceAnalysisReadiness, type AnalysisRuntimeEvidence } from "./analysis-readiness.js";
import { FixedSyntheticInputSource, syntheticInputGrantSchema, type SyntheticInputGrant } from "./analysis-synthetic-input.js";
import { PostgresGuideRepository, analysisPoolForRepository, bindAnalysisActivation } from "./repository.js";
import type { GuideRepository } from "./domain.js";
import type { Storage } from "./storage.js";
import { ReplitObjectStorage, type ReplitStorageOptions } from "./storage.js";
import { AccountedGeminiMeasurements } from "./gemini/counted-measurements.js";
import { GeminiAnalysisProvider } from "./gemini/provider.js";
import { GEMINI_TEST_MODEL } from "./gemini/request.js";

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const configSchema = z.object({ deploymentRef: id, projectRef: id, credentialRef: id,
  bucketId: z.string().min(1).max(256), prefix: z.string().min(1).max(256) }).strict();
type Config = z.infer<typeof configSchema>;

/** Exact configured storage target reference, not a claim about its remote IAM. */
export function syntheticStorageRef(bucketId: string, prefix: string): string {
  return `replit:${createHash("sha256").update(JSON.stringify([bucketId, prefix])).digest("hex")}`;
}

/**
 * Dormant, explicit composition for one approved fixed synthetic guide. All DB
 * components share the provided pool; all image reads share the returned Replit
 * storage. Reuse these returned objects when wiring an API. Construction does
 * not inspect a DB, start a worker, migrate, unhalt, read media or send an AI call.
 * Product startup can attach it only through the authenticated, read-only
 * analysis bootstrap. No HTTP parser can construct a grant or activation.
 */
type RuntimeOptions = {
  pool: Pool; config: Config; grant: SyntheticInputGrant; migrationsFolder: string; ffmpegPath: string;
  apiKey?: string; allowExternalProcessing?: boolean;
  /** Exact ID from the separately authenticated activation command; no implicit resume. */
  activationId?: string;
  /** Trusted transport injection for tests; never accepted from HTTP. */
  fetch?: typeof fetch; storageClient?: ReplitStorageOptions["client"];
  attached?: { repository: PostgresGuideRepository; storage: ReplitObjectStorage };
};
export function createFixedSyntheticAnalysisRuntime(options: RuntimeOptions) {
  const parsed = configSchema.safeParse(options.config); if (!parsed.success) evidenceUnavailable();
  const config = parsed.data;
  if (config.bucketId.trim() !== config.bucketId || !/^[A-Za-z0-9_/-]+$/.test(config.prefix) ||
      config.prefix.split("/").some((part) => !part || part === "." || part === "..") ||
      options.grant.deploymentRef !== config.deploymentRef) evidenceUnavailable();
  const binding = { deploymentRef: config.deploymentRef, projectRef: config.projectRef, credentialRef: config.credentialRef,
    storageRef: syntheticStorageRef(config.bucketId, config.prefix) };
  const grant = syntheticInputGrantSchema.parse(options.grant);
  const activation = options.activationId ? activationForGrant(options.activationId, grant, binding) : undefined;
  const repository = options.attached?.repository ?? PostgresGuideRepository.fromPool(options.pool);
  const storage = options.attached?.storage ?? new ReplitObjectStorage({ bucketId: config.bucketId, prefix: config.prefix, client: options.storageClient });
  if (analysisPoolForRepository(repository) !== options.pool || storage.analysisTarget().bucketId !== config.bucketId ||
      storage.analysisTarget().prefix !== config.prefix || (options.attached && options.storageClient)) evidenceUnavailable();
  const probe = new PostgresAnalysisDatabaseProbe({ database: repository.database, migrationsFolder: options.migrationsFolder });
  const approvedInput = new FixedSyntheticInputSource({ grant, repository, storage, ffmpegPath: options.ffmpegPath });
  if (activation) bindAnalysisActivation(repository, activation);
  const operations = new OperationsReviewEvidenceSource({ store: new PostgresAnalysisOperationsStore({ pool: options.pool }), binding });
  const enabled = !!activation && options.allowExternalProcessing === true && /^[\x21-\x7e]{10,4096}$/.test(options.apiKey ?? "");
  let stopped = false;
  const runtime = new LocalAnalysisEvidence<AnalysisRuntimeEvidence>({
    current: () => { if (stopped || !enabled) evidenceUnavailable(); },
    read: async (_input, signal, guard) => {
      const observation = await probe.inspect(signal); guard();
      const control = await repository.getAnalysisAccountingControl(); guard();
      if (control.halted || !matchesAnalysisActivation(control.activation, activation, grant.input.guideId, new Date())) evidenceUnavailable();
      return { ...binding, kind: "checked-analysis-runtime", observedAt: observation.observedAt,
        repository: "postgres-0008", dispatcher: "durable-accounted-v1", counting: "count-accounted-0010-v1",
        storage: "replit", quotaAccounting: "app-project-atomic" };
    },
  });
  const readiness = new EvidenceAnalysisReadiness({ sources: { runtime, approvedInput, operations } });
  const measurements = new AccountedGeminiMeasurements({ repository, readiness, apiKey: options.apiKey,
    allowExternalProcessing: enabled, fetch: options.fetch });
  const provider = new GeminiAnalysisProvider({ apiKey: options.apiKey ?? "", allowExternalProcessing: enabled,
    model: GEMINI_TEST_MODEL, transientRetries: 0, fetch: options.fetch,
    reserveRequest: async () => { if (stopped || !enabled) evidenceUnavailable(); } }); // Private: reachable only via this dispatcher.
  const dispatcher = new DurableAnalysisDispatcher({ repository, readiness, provider,
    inputMeasurementStage: measurements, loadImage: approvedInput.loadImage,
    quotaStore: new PostgresAnalysisQuotaStore(repository.database) });
  const admission = new DurableAnalysisAdmission({ repository, readiness });
  return Object.freeze({ repository, storage, readiness, admission,
    start: () => { if (enabled && !stopped) dispatcher.start(); },
    tick: () => enabled && !stopped ? dispatcher.tick() : Promise.resolve("disabled" as const),
    getStatus: () => dispatcher.getStatus(),
    /** Permanent local shutdown. DB-wide review revocation continues to use the shared halt lock. */
    async stop() {
      stopped = true; approvedInput.revoke(); runtime.clear(); operations.clear(); readiness.clear(); measurements.clear();
      await dispatcher.stop(); // The caller owns the pool; never close another component's DB connections.
    },
  });
}

/** Attach to the API's already constructed DB/storage, never a parallel connection target. */
export function attachFixedSyntheticAnalysisRuntime(context: { repository: GuideRepository; storage: Storage },
  options: Omit<RuntimeOptions, "pool" | "attached" | "storageClient">) {
  if (!(context.repository instanceof PostgresGuideRepository) || !(context.storage instanceof ReplitObjectStorage)) evidenceUnavailable();
  const pool = analysisPoolForRepository(context.repository); if (!pool) evidenceUnavailable();
  return createFixedSyntheticAnalysisRuntime({ ...options, pool, attached: { repository: context.repository, storage: context.storage } });
}
