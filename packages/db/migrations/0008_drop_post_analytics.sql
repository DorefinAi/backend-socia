-- Post analytics removed from Socia (the digital dashboard covers it). DESTRUCTIVE: post_metrics and every
-- row in it are dropped (the 1h/6h/24h/3d/7d snapshots, and the older 6-hourly X numbers GET /posts showed).
-- audit_log_action_idx only served the desk analytics. trend_watches and the trend_items cluster columns
-- from 0007 stay (Web Scraper); so does stories_org_created_idx (status counts use it too).
DROP TABLE IF EXISTS "post_metrics" CASCADE;--> statement-breakpoint
DROP INDEX IF EXISTS "audit_log_action_idx";
