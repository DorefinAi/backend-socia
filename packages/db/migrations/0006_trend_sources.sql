ALTER TABLE "trend_items" ADD COLUMN "alert" jsonb;--> statement-breakpoint
ALTER TABLE "trend_runs" ADD COLUMN "alerts" jsonb DEFAULT '[]'::jsonb NOT NULL;