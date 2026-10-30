-- Owner console (handoff/owner-console-contract.md §2, §4): changes made through /owner are not made by a user, so
-- the audit row names its actor as text ("owner:<name>") with actor_id null. Additive and not destructive: one
-- nullable column, existing rows keep null (their actor is actor_id, as before).
ALTER TABLE "audit_log" ADD COLUMN "actor" text;
