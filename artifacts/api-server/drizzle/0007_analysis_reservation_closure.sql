ALTER TABLE "analysis_reservations" ADD COLUMN "released" jsonb DEFAULT '{"requests":0,"inputTokens":0,"outputTokens":0,"costMicrousd":0}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_reservations" ADD COLUMN "closed_at" text;--> statement-breakpoint
CREATE INDEX "analysis_reservations_open_idx" ON "analysis_reservations" USING btree ("day","guide_id","run_id") WHERE "analysis_reservations"."closed_at" is null;--> statement-breakpoint
ALTER TABLE "analysis_reservations" ADD CONSTRAINT "analysis_reservations_release_check" CHECK (("analysis_reservations"."closed_at" IS NOT NULL OR
    "analysis_reservations"."released" = '{"requests":0,"inputTokens":0,"outputTokens":0,"costMicrousd":0}'::jsonb) IS TRUE);