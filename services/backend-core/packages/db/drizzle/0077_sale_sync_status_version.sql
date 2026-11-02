-- 0077_sale_sync_status_version.sql
--
-- RT-1061 (RT-973 slice 1, combined with RT-977 slice 1 under RT-977 decision
-- D7). [GATED] migration: approved under the owner delegation of 2026-11-02
-- (captain session), within RT-1061's exact scope. Applying it to the lab, a
-- live database or any deploy is NOT authorized by that approval.
--
-- Decision record: services/backend-core/docs/planning/rt-973-sale-sync-status-ordering.md
-- (§3 E1-E3, §4.1, §7 slice 1).
--
-- Adds `sales.sync_status_version`, the Backend-Core-owned ordering of a sale's
-- `sync_status` across reads (`console-sales` `ConsoleSaleItem.syncStatusVersion`,
-- `sale-sync-ops` `SaleSyncStatus.syncStatusVersion`).
--
--   * Every write that sets `sales.sync_status` adds one to it in the SAME
--     UPDATE: the worker drain (`synced`), the dead-letter producer
--     (`failed-retryable` / `failed-needs-repair`) and the console sale-sync
--     repair (`failed-retryable`). The row lock orders those writes, so a
--     higher value is always the later status; an equal value is the same
--     status. Capture (the INSERT) leaves it at the default 0.
--   * It never decreases and is never reset or repurposed.
--   * Sales that exist before this migration read 0; their first later write
--     moves them to 1.
--
-- It is NOT an optimistic-concurrency version of the sale fact (gate D.1 /
-- FR-070 still hold: no write is conditioned on it); it orders the SaaS-owned
-- mutable `sync_status` column only.
--
-- DATA-LIFECYCLE CLASSIFICATION (§XIV): BUSINESS-class, as `sync_status`
-- (0026). A per-row counter: NO PII, NO money, NO secret. Retention inherits
-- the 0012 long-horizon fact posture.
--
-- RLS / grants: none. The column rides the existing `sales` tenant SELECT and
-- UPDATE policies, like `sync_status` and `processed_at`; the domain role
-- already reads and writes `sales`.
--
-- Lock impact: ACCESS EXCLUSIVE on `sales` for a catalog-only ADD COLUMN.
-- `BIGINT NOT NULL DEFAULT 0` has a constant default, so PostgreSQL 11+ stores
-- it in the catalog and does NOT rewrite the table; the statement commits at
-- once. The CHECK is added NOT VALID (no scan) and validated after COMMIT under
-- SHARE UPDATE EXCLUSIVE, which does not block reads or writes.
--
-- Reversible via 0077_sale_sync_status_version.down.sql.

BEGIN;

ALTER TABLE sales
  ADD COLUMN sync_status_version BIGINT NOT NULL DEFAULT 0;

-- A JSON-safe, non-negative integer (the contracts' `minimum: 0`,
-- `maximum: 9007199254740991`).
ALTER TABLE sales
  ADD CONSTRAINT sales_sync_status_version_range
    CHECK (sync_status_version BETWEEN 0 AND 9007199254740991) NOT VALID;

COMMIT;

ALTER TABLE sales
  VALIDATE CONSTRAINT sales_sync_status_version_range;
