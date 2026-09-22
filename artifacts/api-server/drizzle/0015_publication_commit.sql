ALTER TABLE "publication_jobs" DROP CONSTRAINT "publication_jobs_projection_check";
--> statement-breakpoint
ALTER TABLE "publication_jobs" ADD CONSTRAINT "publication_jobs_projection_check" CHECK ((
  "guide_id" = "payload"->>'guideId' AND "id"::text = "payload"->>'id'
  AND "batch_id"::text = "payload"->>'batchId' AND "status" = "payload"->>'status'
  AND "status" IN ('queued', 'running', 'failed', 'cancelled', 'succeeded')
  AND "available_at" IS NOT DISTINCT FROM CASE
    WHEN "status" = 'queued' THEN ("payload"->>'createdAt')::timestamptz
    WHEN "status" = 'running' THEN ("payload"->>'leaseExpiresAt')::timestamptz
    ELSE NULL::timestamptz END
  AND ("status" <> 'running' OR "available_at" IS NOT NULL)
  AND ("status" <> 'succeeded' OR ("payload"->>'phase' = 'committed' AND "payload"->>'leaseExpiresAt' IS NULL))
) IS TRUE);
--> statement-breakpoint
CREATE TABLE "guide_publications" (
  "guide_id" text NOT NULL REFERENCES "guides"("id") ON DELETE CASCADE,
  "id" uuid NOT NULL,
  "batch_id" uuid NOT NULL UNIQUE,
  "payload" jsonb NOT NULL,
  PRIMARY KEY ("guide_id", "id"),
  CONSTRAINT "guide_publications_projection_check" CHECK ((
    "guide_id" = "payload"->>'guideId' AND "id"::text = "payload"->>'id'
    AND "batch_id"::text = "payload"->>'batchId'
  ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "publication_heads" (
  "guide_id" text PRIMARY KEY REFERENCES "guides"("id") ON DELETE CASCADE,
  "version" integer NOT NULL CHECK ("version" > 0),
  "public_slug" text NOT NULL UNIQUE CHECK ("public_slug" ~ '^[A-Za-z0-9_-]{32}$'),
  "active_publication_id" uuid,
  "first_published_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "publication_head_lifetime_check" CHECK (
    "expires_at" = "first_published_at" + interval '360 hours' AND "updated_at" >= "first_published_at"
  ),
  CONSTRAINT "publication_head_snapshot_fk" FOREIGN KEY ("guide_id", "active_publication_id")
    REFERENCES "guide_publications"("guide_id", "id") DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE FUNCTION showme_immutable_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Publication snapshots are immutable'; END $$;
--> statement-breakpoint
CREATE TRIGGER guide_publications_immutable BEFORE UPDATE ON "guide_publications"
  FOR EACH ROW EXECUTE FUNCTION showme_immutable_publication();
--> statement-breakpoint
CREATE FUNCTION showme_fixed_publication_lifetime() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.guide_id IS DISTINCT FROM OLD.guide_id OR NEW.public_slug IS DISTINCT FROM OLD.public_slug
    OR NEW.first_published_at IS DISTINCT FROM OLD.first_published_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'Publication identity and lifetime are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER publication_heads_fixed_lifetime BEFORE UPDATE ON "publication_heads"
  FOR EACH ROW EXECUTE FUNCTION showme_fixed_publication_lifetime();
