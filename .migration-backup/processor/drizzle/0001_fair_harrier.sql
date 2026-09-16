ALTER TABLE "guides" ADD COLUMN "processing_attempt_id" text;--> statement-breakpoint
ALTER TABLE "guides" ADD COLUMN "processing_attempt_count" integer DEFAULT 0 NOT NULL;