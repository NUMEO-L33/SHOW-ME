-- Add nullable projections first so existing queued/running/terminal payloads survive.
-- Invalid timestamps/counts fail the migration instead of inventing new scheduling state.
ALTER TABLE "analysis_runs" ADD COLUMN "created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "available_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "attempt_count" integer;--> statement-breakpoint
UPDATE "analysis_runs" SET
  "created_at" = ("payload"->>'createdAt')::timestamptz,
  "attempt_count" = ("payload"->>'attemptCount')::integer,
  "available_at" = CASE
    WHEN "status" = 'queued' THEN ("payload"->>'createdAt')::timestamptz
    WHEN "status" = 'running' THEN ("payload"->>'leaseExpiresAt')::timestamptz
    ELSE NULL::timestamptz END;
--> statement-breakpoint
ALTER TABLE "analysis_runs" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_runs" ALTER COLUMN "attempt_count" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "analysis_runs_work_due_idx" ON "analysis_runs" USING btree ("status","available_at","created_at","guide_id","id");--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_work_projection_check" CHECK ((
    "analysis_runs"."created_at" = ("analysis_runs"."payload"->>'createdAt')::timestamptz
    AND "analysis_runs"."attempt_count" = ("analysis_runs"."payload"->>'attemptCount')::integer
    AND "analysis_runs"."attempt_count" BETWEEN 0 AND 3
    AND ("analysis_runs"."status" <> 'running' OR "analysis_runs"."available_at" IS NOT NULL)
    AND "analysis_runs"."available_at" IS NOT DISTINCT FROM CASE
      WHEN "analysis_runs"."status" = 'queued' THEN ("analysis_runs"."payload"->>'createdAt')::timestamptz
      WHEN "analysis_runs"."status" = 'running' THEN ("analysis_runs"."payload"->>'leaseExpiresAt')::timestamptz
      ELSE NULL::timestamptz END) IS TRUE);
