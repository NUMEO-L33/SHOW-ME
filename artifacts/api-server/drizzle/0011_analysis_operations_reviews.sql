CREATE TABLE "analysis_operations_reviews" (
  "deployment_ref" text NOT NULL,
  "version" integer NOT NULL,
  "command_id" text NOT NULL,
  "command_hash" text NOT NULL,
  "actor_ref" text NOT NULL,
  "action" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "analysis_operations_reviews_pk" PRIMARY KEY ("deployment_ref", "version"),
  CONSTRAINT "analysis_operations_version_check" CHECK ("version" > 0 AND "version" < 2147483647),
  CONSTRAINT "analysis_operations_action_check" CHECK ("action" IN ('put', 'revoke')),
  CONSTRAINT "analysis_operations_hash_check" CHECK ("command_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "analysis_operations_projection_check" CHECK ((
    "payload"->>'deploymentRef' = "deployment_ref" AND ("payload"->>'revision')::integer = "version"
    AND ("action" <> 'revoke' OR "payload"->>'state' = 'revoked')) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_operations_command_unique" ON "analysis_operations_reviews" ("command_id");
