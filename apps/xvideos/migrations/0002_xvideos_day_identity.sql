CREATE TABLE "xvideos"."scan_request" (
	"org_id" uuid NOT NULL,
	"day" date NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scan_request_org_id_day_pk" PRIMARY KEY("org_id","day")
);
--> statement-breakpoint
DROP INDEX "xvideos"."clip_org_fingerprint";--> statement-breakpoint
ALTER TABLE "xvideos"."scan_request" ADD CONSTRAINT "scan_request_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clip_org_day_fingerprint" ON "xvideos"."clip" USING btree ("org_id","day","fingerprint");