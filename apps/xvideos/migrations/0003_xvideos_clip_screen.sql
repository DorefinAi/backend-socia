CREATE TABLE "xvideos"."clip_screen" (
	"clip_id" uuid PRIMARY KEY NOT NULL,
	"screen_version" text NOT NULL,
	"read" jsonb NOT NULL,
	"headline" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "xvideos"."clip_screen" ADD CONSTRAINT "clip_screen_clip_id_clip_id_fk" FOREIGN KEY ("clip_id") REFERENCES "xvideos"."clip"("id") ON DELETE cascade ON UPDATE no action;