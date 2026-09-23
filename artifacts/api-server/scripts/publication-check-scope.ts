import type { GuideRepository } from "../src/processor/domain.js";
import type { Pool } from "pg";
import { publicationRecoveryQuerySchema } from "../src/processor/publication-jobs.js";
import { publicationExpiryQuerySchema } from "../src/processor/publication-lifecycle.js";

const refused = () => new Error("SYNTHETIC_DATABASE_SCOPE_REFUSED");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Diagnostic-only facade. Unknown methods fail closed; global scans are narrowed
 * in SQL BEFORE LIMIT, never by reading all application rows and filtering later. */
export function publicationCheckScope(repository: GuideRepository, guideId: string,
  track?: <T>(operation: Promise<T>) => Promise<T>): GuideRepository {
  if (!uuid.test(guideId)) throw refused();
  const byGuide = new Set(["getGuideById", "getGuideBySlug", "verifyEditToken", "claimProcessingAttempt", "updateStatus",
    "completeProcessingAttempt", "replaceSteps", "executeAnalysisCommand", "getAnalysisState", "getPublicationJob",
    "getPublicationOwnerStatus", "executePublicationCommand", "getPublicationState", "commitPublication",
    "stopPublication", "listPrivacyAssetBatches", "executePrivacyAssetCommand", "deleteGuide", "listSteps"]);
  const scoped = new Proxy(repository, { get(target, name) {
    if (name === "then") return undefined;
    if (name === "listPublicationRecovery") return (raw: unknown, now?: Date) => {
      const query = publicationRecoveryQuerySchema.parse(raw);
      if (query.guideId && query.guideId !== guideId) throw refused();
      return target.listPublicationRecovery({ ...query, guideId }, now);
    };
    if (name === "listExpiredPublications") return (raw: unknown, now?: Date) => {
      const query = publicationExpiryQuerySchema.parse(raw);
      if (query.guideId && query.guideId !== guideId) throw refused();
      return target.listExpiredPublications({ ...query, guideId }, now);
    };
    if (name === "getAccessiblePublication") return async (...args: Parameters<GuideRepository["getAccessiblePublication"]>) => {
      const state = await target.getPublicationState(guideId);
      if (!state?.head || args[0].slug !== state.head.publicSlug) return null;
      return target.getAccessiblePublication(...args);
    };
    if (name === "createGuide") return (input: Parameters<GuideRepository["createGuide"]>[0]) => {
      if (input.id !== guideId || input.slug !== guideId) throw refused();
      return target.createGuide(input);
    };
    if (typeof name === "string" && byGuide.has(name)) return (id: string, ...args: unknown[]) => {
      if (id !== guideId) throw refused();
      const method = Reflect.get(target, name) as (...args: unknown[]) => unknown;
      return method.call(target, id, ...args);
    };
    throw refused();
  } });
  if (!track) return scoped;
  return new Proxy(scoped, { get(target, name) {
    const method = Reflect.get(target, name);
    return typeof method === "function" ? (...args: unknown[]) => track(Promise.resolve().then(() => method(...args))) : method;
  } });
}

/** Parameterized reads of this generated identity only; never count/list user rows. */
export async function verifyPublicationCheckRemoved(pool: Pick<Pool, "query">, guideId: string) {
  if (!uuid.test(guideId)) throw refused();
  const tables = ["guide_steps", "guide_drafts", "analysis_runs", "publication_jobs", "publication_heads",
    "guide_publications", "guide_assets", "private_media_cleanup"];
  const sql = ["SELECT id FROM guides WHERE id=$1", ...tables.map(table => `SELECT guide_id FROM ${table} WHERE guide_id=$1`)].join(" UNION ALL ");
  const result = await pool.query(`SELECT EXISTS (${sql}) AS remaining`, [guideId]);
  if (result.rows.length !== 1 || result.rows[0].remaining !== false) throw refused();
}

/** Refuse before creating a guide if this existing login cannot finish cleanup. */
export async function verifyPublicationCheckPrivileges(pool: Pick<Pool, "query">) {
  const tables = ["guides", "guide_steps", "guide_drafts", "guide_assets", "publication_jobs", "publication_heads", "guide_publications"];
  const result = await pool.query(`SELECT name, has_table_privilege('public.' || name,'SELECT') AS readable,
    has_table_privilege('public.' || name,'INSERT') AS insertable,
    has_table_privilege('public.' || name,'UPDATE') AS updatable,
    has_table_privilege('public.' || name,'DELETE') AS deletable
    FROM unnest($1::text[]) AS name`, [tables]);
  if (result.rows.length !== tables.length || tables.some(name => {
    const rows = result.rows.filter(row => row.name === name);
    return rows.length !== 1 || rows[0].readable !== true || rows[0].insertable !== true || rows[0].deletable !== true ||
      rows[0].updatable !== (name !== "guide_publications");
  })) throw refused();
}
