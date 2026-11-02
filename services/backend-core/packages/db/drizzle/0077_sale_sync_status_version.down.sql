-- 0077_sale_sync_status_version.down.sql
--
-- Rollback for 0077_sale_sync_status_version.sql (RT-1061 / RT-973). Drops the
-- range CHECK and the `sync_status_version` column. The ordering of every sale's
-- sync status is LOST (the status itself stays). Roll back the RT-1061 API and
-- worker first: they read and write the column, and fail without it. A Console
-- that compares versions treats the absent field as unknown (RT-973 §4.4).
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0077-sale-sync-status-version.spec.ts.

BEGIN;

ALTER TABLE sales
  DROP CONSTRAINT IF EXISTS sales_sync_status_version_range;

ALTER TABLE sales
  DROP COLUMN IF EXISTS sync_status_version;

COMMIT;
