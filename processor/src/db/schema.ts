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
export type NewGuideRow = typeof guides.$inferInsert;
export type GuideStepRow = typeof guideSteps.$inferSelect;
export type NewGuideStepRow = typeof guideSteps.$inferInsert;
