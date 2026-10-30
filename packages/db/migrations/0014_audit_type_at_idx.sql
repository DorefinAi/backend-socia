-- The owner console's history (GET /owner/history) reads user changes across orgs, newest first, paged by the keyset
-- (at, id); the existing audit_log_org_type_idx leads with org_id, which that query does not filter on. Additive.
-- A plain CREATE INDEX (the migrator runs in a transaction, so not CONCURRENTLY): it briefly blocks audit writes,
-- which is fine for audit_log's size here.
CREATE INDEX "audit_log_type_at_idx" ON "audit_log" USING btree ("entity_type","at" DESC NULLS LAST,"id" DESC NULLS LAST);
