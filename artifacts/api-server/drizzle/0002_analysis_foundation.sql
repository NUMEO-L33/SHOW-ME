CREATE TABLE "analysis_runs" (
	"guide_id" text NOT NULL,
	"id" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "analysis_runs_guide_id_id_pk" PRIMARY KEY("guide_id","id")
);
--> statement-breakpoint
CREATE TABLE "guide_drafts" (
	"guide_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"input_fingerprint" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_guide_id_guides_id_fk" FOREIGN KEY ("guide_id") REFERENCES "public"."guides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guide_drafts" ADD CONSTRAINT "guide_drafts_guide_id_guides_id_fk" FOREIGN KEY ("guide_id") REFERENCES "public"."guides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_runs_guide_status_idx" ON "analysis_runs" USING btree ("guide_id","status");