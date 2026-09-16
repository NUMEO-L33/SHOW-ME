CREATE TABLE "analysis_batches" (
	"guide_id" text NOT NULL,
	"run_id" text NOT NULL,
	"batch_index" integer NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "analysis_batches_guide_id_run_id_batch_index_pk" PRIMARY KEY("guide_id","run_id","batch_index")
);
--> statement-breakpoint
CREATE TABLE "analysis_budget_windows" (
	"day" text NOT NULL,
	"scope" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "analysis_budget_windows_day_scope_pk" PRIMARY KEY("day","scope")
);
--> statement-breakpoint
CREATE TABLE "analysis_reservations" (
	"guide_id" text NOT NULL,
	"run_id" text NOT NULL,
	"day" text NOT NULL,
	"maximum" jsonb NOT NULL,
	"details" jsonb,
	CONSTRAINT "analysis_reservations_guide_id_run_id_pk" PRIMARY KEY("guide_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "analysis_batches" ADD CONSTRAINT "analysis_batches_guide_id_run_id_analysis_runs_guide_id_id_fk" FOREIGN KEY ("guide_id","run_id") REFERENCES "public"."analysis_runs"("guide_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_reservations_day_idx" ON "analysis_reservations" USING btree ("day");