-- Edited by hand: IF NOT EXISTS, because the migrator creates schema xvideos for its journal (xvideos.__migrations)
-- before this runs. Keep the edit if this file is ever generated again.
CREATE SCHEMA IF NOT EXISTS "xvideos";
--> statement-breakpoint
CREATE TABLE "xvideos"."clip" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"folder" text[] NOT NULL,
	"file_name" text NOT NULL,
	"size" bigint NOT NULL,
	"mtime" timestamp with time zone NOT NULL,
	"fingerprint" text NOT NULL,
	"picked" boolean NOT NULL,
	"done" boolean NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'seen' NOT NULL,
	"progress" integer,
	"settled_at" timestamp with time zone,
	"duration_s" real,
	"width" integer,
	"height" integer,
	"video_codec" text,
	"has_audio" boolean,
	"poster_key" text,
	"error" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "xvideos"."clip_evidence" (
	"clip_id" uuid PRIMARY KEY NOT NULL,
	"media_version" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "xvideos"."clip_job" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"clip_id" uuid NOT NULL,
	"step" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "xvideos"."clip" ADD CONSTRAINT "clip_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xvideos"."clip_evidence" ADD CONSTRAINT "clip_evidence_clip_id_clip_id_fk" FOREIGN KEY ("clip_id") REFERENCES "xvideos"."clip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xvideos"."clip_job" ADD CONSTRAINT "clip_job_clip_id_clip_id_fk" FOREIGN KEY ("clip_id") REFERENCES "xvideos"."clip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clip_org_fingerprint" ON "xvideos"."clip" USING btree ("org_id","fingerprint");--> statement-breakpoint
CREATE INDEX "clip_org_status_seen" ON "xvideos"."clip" USING btree ("org_id","status","first_seen_at");--> statement-breakpoint
CREATE INDEX "clip_org_mtime" ON "xvideos"."clip" USING btree ("org_id","mtime" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "clip_job_clip_step" ON "xvideos"."clip_job" USING btree ("clip_id","step");--> statement-breakpoint
CREATE INDEX "clip_job_due" ON "xvideos"."clip_job" USING btree ("step","next_attempt_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "clip_job_lease" ON "xvideos"."clip_job" USING btree ("step","lease_until") WHERE status = 'running';