import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  GUIDE_STATUSES,
  type GuideStatus,
  type SceneGraphElement,
} from "../domain.js";
import type { AnalysisRun } from "../analysis-state.js";
import type { DraftDocument } from "../analysis-contract.js";
import type { AnalysisBudgetWindow, AnalysisReservation, AnalysisStoredBatch } from "../analysis-funding.js";
import type { AnalysisAccountingControl, AnalysisRequestAttempt } from "../analysis-accounting-contract.js";
import type { AnalysisCountRecord } from "../analysis-count-accounting.js";
import type { AnalysisOperationsReview } from "../analysis-operations-review.js";
import type { PrivacyAssetBatch } from "../privacy-assets.js";

export const guideStatusEnum = pgEnum("guide_status", GUIDE_STATUSES);

export const guides = pgTable(
  "guides",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id"),
    slug: text("slug").notNull(),
    editTokenHash: text("edit_token_hash").notNull(),
    title: text("title").notNull(),
    status: guideStatusEnum("status").$type<GuideStatus>().notNull().default("uploading"),
    statusMessage: text("status_message").notNull().default("영상을 업로드하고 있어요."),
    progress: integer("progress").notNull().default(0),
    originalObjectKey: text("original_object_key").notNull(),
    sourceFilename: text("source_filename").notNull(),
    sourceMimeType: text("source_mime_type").notNull(),
    sourceSizeBytes: bigint("source_size_bytes", { mode: "number" }).notNull(),
    durationMs: integer("duration_ms"),
    sourceWidth: integer("source_width"),
    sourceHeight: integer("source_height"),
    displayWidth: integer("display_width"),
    displayHeight: integer("display_height"),
    rotationDegrees: integer("rotation_degrees"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    processingAttemptId: text("processing_attempt_id"),
    processingAttemptCount: integer("processing_attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("guides_slug_unique").on(table.slug),
    index("guides_status_updated_at_idx").on(table.status, table.updatedAt),
    index("guides_owner_id_idx").on(table.ownerId),
  ],
);

export const guideSteps = pgTable(
  "guide_steps",
  {
    id: text("id").primaryKey(),
    guideId: text("guide_id")
      .notNull()
      .references(() => guides.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    shortLabel: text("short_label").notNull(),
    instruction: text("instruction").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    representativeTimestampMs: integer("representative_timestamp_ms"),
    representativeFrameKey: text("representative_frame_key"),
    thumbnailFrameKey: text("thumbnail_frame_key"),
    frameWidth: integer("frame_width"),
    frameHeight: integer("frame_height"),
    elements: jsonb("elements")
      .$type<SceneGraphElement[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("guide_steps_guide_position_unique").on(table.guideId, table.position),
    index("guide_steps_guide_id_idx").on(table.guideId),
  ],
);

export const guideDrafts = pgTable("guide_drafts", {
  guideId: text("guide_id").primaryKey().references(() => guides.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  inputFingerprint: text("input_fingerprint").notNull(),
  document: jsonb("document").$type<DraftDocument>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
});

// RESTRICT is deliberate: object cleanup must commit before guide deletion.
export const guideAssets = pgTable("guide_assets", {
  guideId: text("guide_id").notNull().references(() => guides.id, { onDelete: "restrict" }),
  id: uuid("id").primaryKey(),
  payload: jsonb("payload").$type<PrivacyAssetBatch>().notNull(),
}, table => [index("guide_assets_guide_idx").on(table.guideId)]);

export const analysisRuns = pgTable("analysis_runs", {
  guideId: text("guide_id").notNull().references(() => guides.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  status: text("status").$type<AnalysisRun["status"]>().notNull(),
  payload: jsonb("payload").$type<Omit<AnalysisRun, "id" | "status">>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  availableAt: timestamp("available_at", { withTimezone: true, mode: "date" }),
  attemptCount: integer("attempt_count").notNull(),
}, (table) => [
  primaryKey({ columns: [table.guideId, table.id] }),
  index("analysis_runs_guide_status_idx").on(table.guideId, table.status),
  index("analysis_runs_work_due_idx").on(table.status, table.availableAt, table.createdAt, table.guideId, table.id),
  check("analysis_runs_work_projection_check", sql`(
    ${table.createdAt} = (${table.payload}->>'createdAt')::timestamptz
    AND ${table.attemptCount} = (${table.payload}->>'attemptCount')::integer
    AND ${table.attemptCount} BETWEEN 0 AND 3
    AND (${table.status} <> 'running' OR ${table.availableAt} IS NOT NULL)
    AND ${table.availableAt} IS NOT DISTINCT FROM CASE
      WHEN ${table.status} = 'queued' THEN (${table.payload}->>'createdAt')::timestamptz
      WHEN ${table.status} = 'running' THEN (${table.payload}->>'leaseExpiresAt')::timestamptz
      ELSE NULL::timestamptz END) IS TRUE`),
]);

// Accounting survives guide deletion. Only batch payloads cascade with runs.
export const analysisBudgetWindows = pgTable("analysis_budget_windows", {
  day: text("day").notNull(), scope: text("scope").notNull(),
  payload: jsonb("payload").$type<Omit<AnalysisBudgetWindow, "day" | "scope">>().notNull(),
}, (table) => [primaryKey({ columns: [table.day, table.scope] })]);

export const analysisReservations = pgTable("analysis_reservations", {
  guideId: text("guide_id").notNull(), runId: text("run_id").notNull(), day: text("day").notNull(),
  maximum: jsonb("maximum").$type<AnalysisReservation["maximum"]>().notNull(),
  released: jsonb("released").$type<AnalysisReservation["released"]>().notNull()
    .default(sql`'{"requests":0,"inputTokens":0,"outputTokens":0,"costMicrousd":0}'::jsonb`),
  closedAt: text("closed_at"),
  details: jsonb("details").$type<AnalysisReservation["details"]>(),
}, (table) => [primaryKey({ columns: [table.guideId, table.runId] }), index("analysis_reservations_day_idx").on(table.day),
  index("analysis_reservations_open_idx").on(table.day, table.guideId, table.runId).where(sql`${table.closedAt} is null`),
  check("analysis_reservations_release_check", sql`(${table.closedAt} IS NOT NULL OR
    ${table.released} = '{"requests":0,"inputTokens":0,"outputTokens":0,"costMicrousd":0}'::jsonb) IS TRUE`),
]);

export const analysisBatchesTable = pgTable("analysis_batches", {
  guideId: text("guide_id").notNull(), runId: text("run_id").notNull(), index: integer("batch_index").notNull(),
  status: text("status").$type<AnalysisStoredBatch["status"]>().notNull(),
  payload: jsonb("payload").$type<Omit<AnalysisStoredBatch, "guideId" | "runId" | "index">>().notNull(),
}, (table) => [
  primaryKey({ columns: [table.guideId, table.runId, table.index] }),
  foreignKey({ columns: [table.guideId, table.runId], foreignColumns: [analysisRuns.guideId, analysisRuns.id] }).onDelete("cascade"),
  check("analysis_batches_status_check", sql`(${table.status} IN ('queued', 'succeeded') AND ${table.status} = ${table.payload}->>'status') IS TRUE`),
]);

// Seeded exactly once by migration. All accounting writers lock this row first.
export const analysisAccountingControls = pgTable("analysis_accounting_controls", {
  id: text("id").primaryKey(),
  payload: jsonb("payload").$type<AnalysisAccountingControl>().notNull(),
});

// Numeric accounting survives guide/run deletion through the retained reservation.
export const analysisRequestAttempts = pgTable("analysis_request_attempts", {
  guideId: text("guide_id").notNull(), runId: text("run_id").notNull(), batchIndex: integer("batch_index").notNull(),
  ordinal: integer("ordinal").notNull(), dispatchId: text("dispatch_id").notNull(),
  status: text("status").$type<AnalysisRequestAttempt["status"]>().notNull(),
  payload: jsonb("payload").$type<Omit<AnalysisRequestAttempt, "guideId" | "runId" | "batchIndex" | "ordinal" | "dispatchId" | "status">>().notNull(),
}, (table) => [
  primaryKey({ columns: [table.guideId, table.runId, table.batchIndex, table.ordinal] }),
  uniqueIndex("analysis_request_attempts_dispatch_unique").on(table.guideId, table.runId, table.dispatchId),
  index("analysis_request_attempts_status_idx").on(table.status),
  foreignKey({ columns: [table.guideId, table.runId], foreignColumns: [analysisReservations.guideId, analysisReservations.runId] }).onDelete("restrict"),
]);

export type GuideRow = typeof guides.$inferSelect;
// No guide FK: deletion must never refund provider rate usage or allow a replay.
export const analysisProviderQuotaCharges = pgTable("analysis_provider_quota_charges", {
  requestKey: text("request_key").primaryKey(),
  scopeKey: text("scope_key").notNull(),
  chargedAt: text("charged_at").notNull(),
  validUntil: text("valid_until").notNull(),
  day: text("day").notNull(),
  inputTokenBound: bigint("input_token_bound", { mode: "number" }).notNull(),
}, (table) => [
  index("analysis_provider_quota_scope_window_idx").on(table.scopeKey, table.validUntil),
  check("analysis_provider_quota_hashes_check", sql`${table.requestKey} ~ '^[a-f0-9]{64}$' AND ${table.scopeKey} ~ '^[a-f0-9]{64}$'`),
  check("analysis_provider_quota_bound_check", sql`${table.inputTokenBound} > 0 AND ${table.inputTokenBound} <= 9007199254740991`),
  check("analysis_provider_quota_window_check", sql`${table.validUntil} > ${table.chargedAt}`),
  check("analysis_provider_quota_time_check", sql`${table.chargedAt} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND ${table.validUntil} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND ${table.validUntil}::timestamptz <= ${table.chargedAt}::timestamptz + interval '5 seconds' AND ${table.day} = to_char(${table.chargedAt}::timestamptz AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AND ${table.day} = to_char((${table.validUntil}::timestamptz - interval '1 millisecond') AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD')`),
]);

// Independent countTokens slots. Never cascade numeric accounting on guide deletion.
export const analysisCountAttempts = pgTable("analysis_count_attempts", {
  requestKey: text("request_key").primaryKey(), guideId: text("guide_id").notNull(), runId: text("run_id").notNull(),
  batchIndex: integer("batch_index").notNull(), generationOrdinal: integer("generation_ordinal").notNull(),
  status: text("status").$type<AnalysisCountRecord["status"]>().notNull(),
  payload: jsonb("payload").$type<Omit<AnalysisCountRecord, "requestKey" | "guideId" | "runId" | "batchIndex" | "generationOrdinal" | "status">>().notNull(),
}, (table) => [
  uniqueIndex("analysis_count_slot_unique").on(table.guideId, table.runId, table.batchIndex, table.generationOrdinal),
  index("analysis_count_pending_idx").on(table.status, table.guideId, table.runId),
  foreignKey({ columns: [table.guideId, table.runId], foreignColumns: [analysisReservations.guideId, analysisReservations.runId] }).onDelete("restrict"),
  check("analysis_count_identity_check", sql`(${table.requestKey} ~ '^[a-f0-9]{64}$' AND ${table.batchIndex} BETWEEN 0 AND 5 AND ${table.generationOrdinal} BETWEEN 0 AND 1 AND ${table.payload}->>'operation' = 'countTokens' AND ${table.payload}->>'bindingHash' ~ '^[a-f0-9]{64}$' AND ${table.payload}->>'scopeKey' ~ '^[a-f0-9]{64}$') IS TRUE`),
  check("analysis_count_status_check", sql`${table.status} IN ('reserved','sending','launch_claimed','settled','uncertain','overrun','released')`),
  check("analysis_count_maximum_check", sql`((${table.payload}->'maximum'->>'requests')::numeric = 1 AND (${table.payload}->'maximum'->>'inputTokens')::numeric > 0 AND (${table.payload}->'maximum'->>'outputTokens')::numeric = 0 AND (${table.payload}->'maximum'->>'costMicrousd')::numeric > 0 AND (${table.payload}->>'accountingInputRate')::numeric > 0 AND (${table.payload}->>'accountingInputRate')::numeric <= 9007199254740991) IS TRUE`),
  ...["requests", "inputTokens", "outputTokens", "costMicrousd"].map((field) => check(`analysis_count_${field}_check`, sql`((${table.payload}->'maximum'->>${sql.raw(`'${field}'`)})::numeric BETWEEN 0 AND 9007199254740991 AND (${table.payload}->'charged'->>${sql.raw(`'${field}'`)})::numeric BETWEEN 0 AND (${table.payload}->'maximum'->>${sql.raw(`'${field}'`)})::numeric AND trunc((${table.payload}->'maximum'->>${sql.raw(`'${field}'`)})::numeric) = (${table.payload}->'maximum'->>${sql.raw(`'${field}'`)})::numeric AND trunc((${table.payload}->'charged'->>${sql.raw(`'${field}'`)})::numeric) = (${table.payload}->'charged'->>${sql.raw(`'${field}'`)})::numeric) IS TRUE`)),
]);

export type NewGuideRow = typeof guides.$inferInsert;
// Administrative append-only API; no guide FK and no automatic seed/approval.
export const analysisOperationsReviews = pgTable("analysis_operations_reviews", {
  deploymentRef: text("deployment_ref").notNull(), version: integer("version").notNull(),
  commandId: text("command_id").notNull(), commandHash: text("command_hash").notNull(),
  actorRef: text("actor_ref").notNull(), action: text("action").$type<"put" | "revoke">().notNull(),
  payload: jsonb("payload").$type<AnalysisOperationsReview>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
}, (table) => [
  primaryKey({ name: "analysis_operations_reviews_pk", columns: [table.deploymentRef, table.version] }),
  uniqueIndex("analysis_operations_command_unique").on(table.commandId),
  check("analysis_operations_version_check", sql`${table.version} > 0 AND ${table.version} < 2147483647`),
  check("analysis_operations_action_check", sql`${table.action} IN ('put', 'revoke')`),
  check("analysis_operations_hash_check", sql`${table.commandHash} ~ '^[a-f0-9]{64}$'`),
  check("analysis_operations_projection_check", sql`(${table.payload}->>'deploymentRef' = ${table.deploymentRef} AND
    (${table.payload}->>'revision')::integer = ${table.version} AND (${table.action} <> 'revoke' OR ${table.payload}->>'state' = 'revoked')) IS TRUE`),
]);
export type GuideStepRow = typeof guideSteps.$inferSelect;
export const analysisActivationEvents = pgTable("analysis_activation_events", {
  version: integer("version").primaryKey(), commandId: uuid("command_id").notNull().unique(),
  commandHash: text("command_hash").notNull(), actorRef: text("actor_ref").notNull(),
  action: text("action").$type<"activate" | "deactivate">().notNull(), deploymentRef: text("deployment_ref").notNull(),
  payload: jsonb("payload").notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
}, table => [check("analysis_activation_events_version_check", sql`${table.version}>0 AND ${table.version}<2147483647`),
  check("analysis_activation_events_command_hash_check", sql`${table.commandHash} ~ '^[a-f0-9]{64}$'`),
  check("analysis_activation_events_action_check", sql`${table.action} IN ('activate','deactivate')`)]);
export type NewGuideStepRow = typeof guideSteps.$inferInsert;
