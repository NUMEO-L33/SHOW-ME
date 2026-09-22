CREATE TABLE "publication_jobs" (
  "guide_id" text NOT NULL REFERENCES "guides"("id") ON DELETE CASCADE,
  "id" uuid NOT NULL,
  "batch_id" uuid NOT NULL,
  "status" text NOT NULL,
  "available_at" timestamptz,
  "payload" jsonb NOT NULL,
  PRIMARY KEY ("guide_id", "id"),
  CONSTRAINT "publication_jobs_projection_check" CHECK ((
    "guide_id" = "payload"->>'guideId'
    AND "id"::text = "payload"->>'id'
    AND "batch_id"::text = "payload"->>'batchId'
    AND "status" = "payload"->>'status'
    AND "status" IN ('queued', 'running', 'failed', 'cancelled')
    AND "available_at" IS NOT DISTINCT FROM CASE
      WHEN "status" = 'queued' THEN ("payload"->>'createdAt')::timestamptz
      WHEN "status" = 'running' THEN ("payload"->>'leaseExpiresAt')::timestamptz
      ELSE NULL::timestamptz END
    AND ("status" <> 'running' OR "available_at" IS NOT NULL)
  ) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "publication_jobs_batch_unique" ON "publication_jobs" ("batch_id");
--> statement-breakpoint
CREATE INDEX "publication_jobs_due_idx" ON "publication_jobs" ("available_at", "guide_id", "id");
