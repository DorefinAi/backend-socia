-- Ops logs and heartbeats for the Sentry control centre (dev-docs/ops-logs-contract.md §1): every API / worker log line
-- at OPS_LOG_LEVEL and above (redacted before insert) and one heartbeat row per running process. Additive and not
-- destructive: two new tables, nothing existing is touched. The worker's housekeeping deletes log rows after 14 days
-- (ops_log_at_idx) and heartbeats not beaten for 7 days.
CREATE TABLE "ops_heartbeat" (
	"process" text PRIMARY KEY NOT NULL,
	"system" text NOT NULL,
	"host" text NOT NULL,
	"pid" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"beat_at" timestamp with time zone NOT NULL,
	"info" jsonb
);
--> statement-breakpoint
CREATE TABLE "ops_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"system" text NOT NULL,
	"level" text NOT NULL,
	"logger" text,
	"message" text NOT NULL,
	"slug" text,
	"item_id" text,
	"fields" jsonb
);
--> statement-breakpoint
CREATE INDEX "ops_log_at_idx" ON "ops_log" USING btree ("at");