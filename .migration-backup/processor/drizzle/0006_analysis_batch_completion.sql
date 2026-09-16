-- Preserve existing descriptors. Missing/invalid status fails instead of resetting completed work.
ALTER TABLE "analysis_batches" ADD COLUMN "status" text;--> statement-breakpoint
UPDATE "analysis_batches" SET "status" = "payload"->>'status';--> statement-breakpoint
ALTER TABLE "analysis_batches" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_batches" ADD CONSTRAINT "analysis_batches_status_check" CHECK (("analysis_batches"."status" IN ('queued', 'succeeded') AND "analysis_batches"."status" = "analysis_batches"."payload"->>'status') IS TRUE);
