import { sql } from "drizzle-orm";
import {
  bigint,
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
}, (table) => [
  primaryKey({ columns: [table.guideId, table.id] }),
  index("analysis_runs_guide_status_idx").on(table.guideId, table.status),
]);

export type GuideRow = typeof guides.$inferSelect;
export type NewGuideRow = typeof guides.$inferInsert;
export type GuideStepRow = typeof guideSteps.$inferSelect;
export type NewGuideStepRow = typeof guideSteps.$inferInsert;
