CREATE TABLE "xvideos"."clip_draft" (
	"clip_id" uuid PRIMARY KEY NOT NULL,
	"draft" jsonb,
	"held_by" uuid,
	"held_by_name" text,
	"held_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "xvideos"."clip_post" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"clip_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"action" text NOT NULL,
	"text" text,
	"title" text,
	"hashtags" text[],
	"mentions" text[],
	"reason" text,
	"by" uuid,
	"by_name" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" uuid,
	"learned_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "xvideos"."clip_draft" ADD CONSTRAINT "clip_draft_clip_id_clip_id_fk" FOREIGN KEY ("clip_id") REFERENCES "xvideos"."clip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xvideos"."clip_post" ADD CONSTRAINT "clip_post_clip_id_clip_id_fk" FOREIGN KEY ("clip_id") REFERENCES "xvideos"."clip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xvideos"."clip_post" ADD CONSTRAINT "clip_post_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clip_post_standing" ON "xvideos"."clip_post" USING btree ("clip_id") WHERE undone_at is null;--> statement-breakpoint
CREATE INDEX "clip_post_to_learn" ON "xvideos"."clip_post" USING btree ("at") WHERE action = 'posted' and undone_at is null and learned_at is null;