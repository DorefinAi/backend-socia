-- Per-user preferences that follow a user to any computer; first use: their desk keyboard shortcuts
-- (users.prefs.keyBindings, PUT /me/key-bindings). Additive and not destructive: one column with a constant default,
-- so on Postgres 11+ ADD COLUMN only touches the catalog (no table rewrite) and every existing user reads {}.
-- The short lock_timeout gives up rather than queue behind a long transaction holding users.
SET lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "prefs" jsonb DEFAULT '{}'::jsonb NOT NULL;
