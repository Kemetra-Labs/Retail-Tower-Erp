-- 0088_pos_pilot_releases.down.sql
--
-- RT-1292 — rollback for 0088_pos_pilot_releases.sql.
--
-- Drops ONLY what this migration created: the two tables (DROP TABLE removes
-- each with its policies, indexes, CHECK constraints, trigger and the FKs it
-- owns) and the trigger function. Nothing references either table, and
-- `tenants`, `users` and `audit_events` are untouched.
--
-- IT DISCARDS DATA: the pilot release registry and the pilot tenant allowlist.
-- Audit rows `pos.pilot_release.*` and `pos.pilot_tenant.*` are append-only and
-- stay in `audit_events`.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0088-pos-pilot-releases.spec.ts and the
-- full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

DROP TABLE IF EXISTS pos_pilot_tenant_allowlist;
DROP TABLE IF EXISTS pos_pilot_release_registry;
DROP FUNCTION IF EXISTS pos_pilot_release_registry_guard();

COMMIT;
