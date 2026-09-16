CREATE TABLE "analysis_accounting_controls" (
	"id" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_request_attempts" (
	"guide_id" text NOT NULL,
	"run_id" text NOT NULL,
	"batch_index" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"dispatch_id" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "analysis_request_attempts_guide_id_run_id_batch_index_ordinal_pk" PRIMARY KEY("guide_id","run_id","batch_index","ordinal")
);
--> statement-breakpoint
ALTER TABLE "analysis_request_attempts" ADD CONSTRAINT "analysis_request_attempts_guide_id_run_id_analysis_reservations_guide_id_run_id_fk" FOREIGN KEY ("guide_id","run_id") REFERENCES "public"."analysis_reservations"("guide_id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_request_attempts_dispatch_unique" ON "analysis_request_attempts" USING btree ("guide_id","run_id","dispatch_id");--> statement-breakpoint
CREATE INDEX "analysis_request_attempts_status_idx" ON "analysis_request_attempts" USING btree ("status");
--> statement-breakpoint
-- Seed once via the migration journal, never on ordinary startup/admission.
INSERT INTO "analysis_accounting_controls" ("id", "payload") VALUES ('global', '{"halted":false}'::jsonb);
