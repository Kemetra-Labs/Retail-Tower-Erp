-- 0076_tenant_logo_branding.down.sql - reverses 0076_tenant_logo_branding.sql (RT-473 S2).
--
-- Drops ONLY the three branding tables (their policies, constraints and the
-- revision trigger go with them) and the trigger function. DATA LOSS: every
-- stored tenant logo, its renditions and every tenant's branding revision are
-- discarded. Roll back the RT-473 S2 API first; with the tables gone, the
-- branding routes return 500.

BEGIN;

DROP TABLE IF EXISTS tenant_logo_renditions;
DROP TABLE IF EXISTS tenant_logos;
DROP TABLE IF EXISTS tenant_branding_revisions;
DROP FUNCTION IF EXISTS tenant_branding_revisions_monotonic();

COMMIT;
