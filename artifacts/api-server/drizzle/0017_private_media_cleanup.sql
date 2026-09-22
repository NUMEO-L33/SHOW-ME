CREATE TABLE "private_media_cleanup" (
  "guide_id" text PRIMARY KEY REFERENCES "guides"("id") ON DELETE RESTRICT,
  "id" uuid NOT NULL UNIQUE,
  "payload" jsonb NOT NULL,
  CONSTRAINT "private_media_cleanup_projection_check" CHECK ((
    "guide_id" = "payload"->>'guideId' AND "id"::text = "payload"->>'id'
  ) IS TRUE)
);
