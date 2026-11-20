-- Sign-in attempts for the Sentry control centre (dev-docs/ops-status-contract.md §5): login_event, append-only,
-- written by the API's login handlers (never failing a sign-in), pruned after 90 days by the worker's housekeeping.
--
-- Additive only: one new, empty table, its index and a foreign key to users (ON DELETE SET NULL). No existing table
-- or row changes. Safe to apply while the API and worker run; the pre-0031 code simply never writes to it.
CREATE TABLE "login_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"app" text NOT NULL,
	"username" text NOT NULL,
	"user_id" uuid,
	"ip" text,
	"user_agent" text,
	"result" text NOT NULL,
	CONSTRAINT "login_event_result_check" CHECK ("login_event"."result" IN ('success', 'bad_password', 'totp_failed', 'locked', 'unknown_user'))
);
--> statement-breakpoint
ALTER TABLE "login_event" ADD CONSTRAINT "login_event_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_event_at_idx" ON "login_event" USING btree ("at" DESC NULLS LAST);