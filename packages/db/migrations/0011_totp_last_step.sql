-- TOTP replay guard: the time step of the last accepted code per user; a code at that step or earlier is
-- refused. Additive and not destructive: one nullable column, existing rows keep null (no code used yet).
ALTER TABLE "users" ADD COLUMN "totp_last_step" bigint;
