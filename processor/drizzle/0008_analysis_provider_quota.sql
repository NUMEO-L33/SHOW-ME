CREATE TABLE "analysis_provider_quota_charges" (
	"request_key" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"charged_at" text NOT NULL,
	"valid_until" text NOT NULL,
	"day" text NOT NULL,
	"input_token_bound" bigint NOT NULL,
	CONSTRAINT "analysis_provider_quota_hashes_check" CHECK ("analysis_provider_quota_charges"."request_key" ~ '^[a-f0-9]{64}$' AND "analysis_provider_quota_charges"."scope_key" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "analysis_provider_quota_bound_check" CHECK ("analysis_provider_quota_charges"."input_token_bound" > 0 AND "analysis_provider_quota_charges"."input_token_bound" <= 9007199254740991),
	CONSTRAINT "analysis_provider_quota_window_check" CHECK ("analysis_provider_quota_charges"."valid_until" > "analysis_provider_quota_charges"."charged_at"),
	CONSTRAINT "analysis_provider_quota_time_check" CHECK ("analysis_provider_quota_charges"."charged_at" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND "analysis_provider_quota_charges"."valid_until" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND "analysis_provider_quota_charges"."valid_until"::timestamptz <= "analysis_provider_quota_charges"."charged_at"::timestamptz + interval '5 seconds' AND "analysis_provider_quota_charges"."day" = to_char("analysis_provider_quota_charges"."charged_at"::timestamptz AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AND "analysis_provider_quota_charges"."day" = to_char(("analysis_provider_quota_charges"."valid_until"::timestamptz - interval '1 millisecond') AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD'))
);
--> statement-breakpoint
CREATE INDEX "analysis_provider_quota_scope_window_idx" ON "analysis_provider_quota_charges" USING btree ("scope_key","valid_until");
