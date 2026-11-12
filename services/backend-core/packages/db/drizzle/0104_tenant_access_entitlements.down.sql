-- 0104_tenant_access_entitlements.down.sql - reverses 0104_tenant_access_entitlements.sql (RT-1353).
--
-- Drops ONLY the `tenant_access_entitlements` table (its trigger, policies and
-- constraints go with it) and the trigger function. DATA LOSS: every stored
-- restriction is discarded, and a tenant that was restricted then reads
-- `unrestricted` (no row = unrestricted). Roll back the RT-1353 API first; with
-- the table gone, the entitlement routes return 500 and the pairing and posting
-- gates would fail their read.

BEGIN;

DROP TABLE IF EXISTS tenant_access_entitlements;
DROP FUNCTION IF EXISTS tenant_access_entitlements_guard();

COMMIT;
