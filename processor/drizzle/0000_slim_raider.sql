CREATE TYPE "public"."guide_status" AS ENUM('uploading', 'queued', 'probing', 'extracting', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "guide_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"guide_id" text NOT NULL,
	"position" integer NOT NULL,
	"short_label" text NOT NULL,
	"instruction" text NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"representative_timestamp_ms" integer,
	"representative_frame_key" text,
	"thumbnail_frame_key" text,
	"frame_width" integer,
	"frame_height" integer,
	"elements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guides" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text,
	"slug" text NOT NULL,
	"edit_token_hash" text NOT NULL,
	"title" text NOT NULL,
	"status" "guide_status" DEFAULT 'uploading' NOT NULL,
	"status_message" text DEFAULT '영상을 업로드하고 있어요.' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"original_object_key" text NOT NULL,
	"source_filename" text NOT NULL,
	"source_mime_type" text NOT NULL,
	"source_size_bytes" bigint NOT NULL,
	"duration_ms" integer,
	"source_width" integer,
	"source_height" integer,
	"display_width" integer,
	"display_height" integer,
	"rotation_degrees" integer,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guide_steps" ADD CONSTRAINT "guide_steps_guide_id_guides_id_fk" FOREIGN KEY ("guide_id") REFERENCES "public"."guides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guide_steps_guide_position_unique" ON "guide_steps" USING btree ("guide_id","position");--> statement-breakpoint
CREATE INDEX "guide_steps_guide_id_idx" ON "guide_steps" USING btree ("guide_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guides_slug_unique" ON "guides" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "guides_status_updated_at_idx" ON "guides" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "guides_owner_id_idx" ON "guides" USING btree ("owner_id");