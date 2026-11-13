-- The decision log (reporter-prior brief §2) and the nightly reporter features (§7).
--
-- post_decisions: one row per breaking draft. The worker writes the PROPOSAL half when it composes the draft
-- (every hashtag and handle the draft carried or offered, with the stable rule id and the reason core gave,
-- and what the file name said about the reporter); the API writes the OUTCOME half once, when the desk
-- decides (Copy & Posted, Mark posted, Reject): the final text, its hashtags and handles, each item's fate
-- and the rework ratio. A decided row is append-only: the trigger below refuses any change to it except
-- "void" (an undo of Copy & Posted, a restore of a rejected draft), which moves the outcome into `voided`
-- and clears it for the next decision, and marking the proposal stale (a re-saved file rewrote the draft
-- after the decision). Nothing is ever lost or rewritten.
--
-- reporter_features: one snapshot per reporter per IST day, built by the maintenance worker from decisions
-- made BEFORE that day started (L5). A snapshot is never overwritten (the trigger refuses UPDATE). Nothing
-- reads these yet.
--
-- post_decision_amendments is NOT created: no source of the desk's published tweets exists in the code
-- (phase 1 posts by hand, Copy & Posted records no link), so there is nothing to reconcile against.
--
-- Additive and not destructive: two new tables, no change to an existing one. Drafts composed before this
-- have no decision row; a desk action on such a draft logs nothing.
-- The short lock_timeout gives up rather than queue behind a long transaction (the foreign keys take a
-- SHARE ROW EXCLUSIVE lock on orgs, post_drafts, stories and users for a moment).
SET lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "post_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"proposal_rev" integer DEFAULT 1 NOT NULL,
	"filename_raw" text,
	"slot_raw" text,
	"reporter_token" text,
	"bureau_code" text,
	"bureau_district" text,
	"reporter_handle" text,
	"reporter_status" text NOT NULL,
	"story_class" text,
	"district" text,
	"district_from" text,
	"logic_version" text NOT NULL,
	"compose_version" text NOT NULL,
	"draft_text" text NOT NULL,
	"proposals" jsonb NOT NULL,
	"proposal_stale" boolean DEFAULT false NOT NULL,
	"explore" boolean DEFAULT false NOT NULL,
	"decision" text,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"reject_reason" text,
	"final_text" text,
	"final_hashtags" text[],
	"final_handles" text[],
	"item_outcomes" jsonb,
	"rework_ratio" real,
	"voided" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "post_decisions_outcome_whole" CHECK (("post_decisions"."decided_at" IS NULL) = ("post_decisions"."decision" IS NULL)),
	CONSTRAINT "post_decisions_rework_range" CHECK ("post_decisions"."rework_ratio" IS NULL OR "post_decisions"."rework_ratio" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reporter_features" (
	"org_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"reporter" text NOT NULL,
	"n" integer NOT NULL,
	"features" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reporter_features_org_id_snapshot_date_reporter_pk" PRIMARY KEY("org_id","snapshot_date","reporter")
);
--> statement-breakpoint
ALTER TABLE "post_decisions" ADD CONSTRAINT "post_decisions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_decisions" ADD CONSTRAINT "post_decisions_draft_id_post_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."post_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_decisions" ADD CONSTRAINT "post_decisions_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_decisions" ADD CONSTRAINT "post_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reporter_features" ADD CONSTRAINT "reporter_features_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_decisions_draft_key" ON "post_decisions" USING btree ("draft_id");--> statement-breakpoint
-- The nightly features read decided rows by reporter
CREATE INDEX "post_decisions_reporter_idx" ON "post_decisions" USING btree ("org_id","reporter_token","decided_at");--> statement-breakpoint
-- The weekly reporter-status report reads a week of proposals
CREATE INDEX "post_decisions_proposed_idx" ON "post_decisions" USING btree ("org_id","proposed_at");--> statement-breakpoint
-- A decided row's proposal and outcome never change. Two changes are allowed:
--   void:  decision and every outcome column cleared, the old outcome appended to `voided`, nothing else touched;
--   stale: proposal_stale false -> true, nothing else touched.
-- `voided` itself only ever grows (its existing entries stay a prefix of the new value).
CREATE FUNCTION "post_decisions_append_only"() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  kept jsonb;
  outcome_cols text[] := ARRAY['decision', 'decided_at', 'decided_by', 'reject_reason', 'final_text', 'final_hashtags', 'final_handles', 'item_outcomes', 'rework_ratio', 'voided'];
BEGIN
  SELECT COALESCE(jsonb_agg(e ORDER BY i), '[]'::jsonb) INTO kept
    FROM jsonb_array_elements(NEW."voided") WITH ORDINALITY AS t(e, i)
   WHERE i <= jsonb_array_length(OLD."voided");
  IF kept IS DISTINCT FROM OLD."voided" THEN
    RAISE EXCEPTION 'post_decisions %: voided outcomes are append-only', OLD."id";
  END IF;
  IF OLD."decided_at" IS NULL THEN
    RETURN NEW;
  END IF;
  -- stale: only the flag moves, and only one way
  IF NOT OLD."proposal_stale" AND NEW."proposal_stale"
     AND (to_jsonb(NEW) - 'proposal_stale') = (to_jsonb(OLD) - 'proposal_stale') THEN
    RETURN NEW;
  END IF;
  -- void: the proposal half untouched, the outcome cleared and kept as the newest voided entry
  IF NEW."decision" IS NULL AND NEW."decided_at" IS NULL AND NEW."decided_by" IS NULL AND NEW."reject_reason" IS NULL
     AND NEW."final_text" IS NULL AND NEW."final_hashtags" IS NULL AND NEW."final_handles" IS NULL
     AND NEW."item_outcomes" IS NULL AND NEW."rework_ratio" IS NULL
     AND jsonb_array_length(NEW."voided") = jsonb_array_length(OLD."voided") + 1
     AND NEW."voided" -> -1 ->> 'decision' = OLD."decision"
     AND NEW."voided" -> -1 ->> 'finalText' IS NOT DISTINCT FROM OLD."final_text"
     AND (to_jsonb(NEW) - outcome_cols) = (to_jsonb(OLD) - outcome_cols) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'post_decisions %: a decided row is append-only (only a void or marking it stale may change it)', OLD."id";
END
$fn$;--> statement-breakpoint
CREATE TRIGGER "post_decisions_append_only" BEFORE UPDATE ON "post_decisions" FOR EACH ROW EXECUTE FUNCTION "post_decisions_append_only"();--> statement-breakpoint
-- A day's snapshot is what the worker knew that night: never rewritten
CREATE FUNCTION "reporter_features_no_update"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'reporter_features: snapshot % of % is never overwritten', OLD."snapshot_date", OLD."reporter";
END
$fn$;--> statement-breakpoint
CREATE TRIGGER "reporter_features_no_update" BEFORE UPDATE ON "reporter_features" FOR EACH ROW EXECUTE FUNCTION "reporter_features_no_update"();
