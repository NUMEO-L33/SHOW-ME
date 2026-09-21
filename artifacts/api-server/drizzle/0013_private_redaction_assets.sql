CREATE TABLE "guide_assets" (
  "guide_id" text NOT NULL REFERENCES "guides"("id") ON DELETE RESTRICT,
  "id" uuid PRIMARY KEY,
  "payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "guide_assets_guide_idx" ON "guide_assets" ("guide_id");
