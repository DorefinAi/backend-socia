-- Per-rule negative phrases for hashtag rules: a rule does not fire from a sentence that also has one of them
-- (handoff/e2e-report.md: "हादसा टल गया", an accident averted, was tagged #RoadAccident). Additive and not
-- destructive: one column, default empty, so every existing rule behaves as before except the accident rule.
ALTER TABLE "hashtag_rules" ADD COLUMN "negative_phrases" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- The accident topic rule (seeded by apps/api/scripts/local-dev.ts) gets the averted/escaped phrases. Only
-- rules still on the empty default are touched, so a list the desk has set is never overwritten; updated_at
-- moves so the compose worker reloads its rules.
UPDATE "hashtag_rules"
SET "negative_phrases" = ARRAY['टल', 'टला', 'टली', 'टले', 'होने से बचा', 'होने से बची', 'होने से बचे', 'होने से बच गया', 'होने से बच गई', 'बाल-बाल बचा', 'बाल-बाल बची', 'बाल-बाल बचे', 'averted', 'narrowly escaped', 'narrowly avoided', 'near miss']::text[], "updated_at" = now()
WHERE "match_type" = 'entity' AND "name" IN ('हादसा', 'दुर्घटना') AND "negative_phrases" = '{}'::text[];
