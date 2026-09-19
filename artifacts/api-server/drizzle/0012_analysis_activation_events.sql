CREATE TABLE "analysis_activation_events" (
  "version" integer PRIMARY KEY CHECK ("version" > 0 AND "version" < 2147483647),
  "command_id" uuid NOT NULL UNIQUE,
  "command_hash" text NOT NULL CHECK ("command_hash" ~ '^[a-f0-9]{64}$'),
  "actor_ref" text NOT NULL,
  "action" text NOT NULL CHECK ("action" IN ('activate', 'deactivate')),
  "deployment_ref" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
