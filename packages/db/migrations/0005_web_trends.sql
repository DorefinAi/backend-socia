CREATE TABLE "trend_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"type" text NOT NULL,
	"window" text NOT NULL,
	"rank" integer NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"platform" text NOT NULL,
	"source_name" text NOT NULL,
	"reason_why" text DEFAULT '' NOT NULL,
	"super_tag" text NOT NULL,
	"sub_tag" text DEFAULT '' NOT NULL,
	"district" text,
	"volume" text DEFAULT '' NOT NULL,
	"growth" text DEFAULT '' NOT NULL,
	"shares" text DEFAULT '' NOT NULL,
	"headline" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"published_at" timestamp with time zone,
	"image_url" text,
	"image_source" text,
	"og_checked" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trend_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"query" text,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "trend_items" ADD CONSTRAINT "trend_items_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_items" ADD CONSTRAINT "trend_items_run_id_trend_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."trend_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_runs" ADD CONSTRAINT "trend_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trend_items_run_idx" ON "trend_items" USING btree ("run_id","type","window","rank");--> statement-breakpoint
CREATE INDEX "trend_items_url_idx" ON "trend_items" USING btree ("url");--> statement-breakpoint
CREATE INDEX "trend_runs_org_idx" ON "trend_runs" USING btree ("org_id","trigger","finished_at");