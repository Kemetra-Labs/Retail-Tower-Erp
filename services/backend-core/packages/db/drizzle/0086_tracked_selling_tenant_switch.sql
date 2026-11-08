-- 0086_tracked_selling_tenant_switch.sql
--
-- The per-tenant tracked-selling switch (Jira RT-451 slice S2, migration M1
-- part 1). [GATED] migration, owner-approved on RT-451: comment 16216 (the
-- revised M1: an on/off state with changed-at and changed-by, false by default
-- for every tenant, additive, no backfill beyond the default) under the owner
-- decisions OD-T1..OD-T7 (comments 16215, 16217). M1's second part, the
-- `tracked_line_validations` table of comment 15288, ships with the TLV that
-- writes it (the next RT-451 S2 PR) as its own migration.
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/inventory/inventory.yaml 1.12.0-draft
--       (`getTrackedSellingSetting` / `setTrackedSellingSetting`)
--   - packages/contracts/openapi/inventory/inventory-safety-feed.yaml
--       1.1.0-draft (`tracked_selling_enabled`)
--   - packages/db/__tests__/migration/0086-tracked-selling-tenant-switch.spec.ts
--
-- Adds THREE columns to `tenant_inventory_settings`:
--
--   tracked_selling_enabled     whether the tenant switched tracked selling on.
--                               NOT NULL DEFAULT false: every existing tenant,
--                               and every tenant without a settings row, is OFF.
--   tracked_selling_changed_at  when the switch last changed; NULL while never
--   tracked_selling_changed_by  who changed it; NULL while never
--
-- Two CHECKs: changed-at and changed-by are both NULL or both set, and the
-- switch can be on only with a recorded change (it never starts on). The
-- history of the switch is the audit trail (`inventory.tracked_selling.update`),
-- not this row, which holds only the current state (comment 16216).
--
-- Tracked selling is in effect for a tenant only while the deployment gate
-- `POS_TRACKED_SELLING_ENABLED` is on AND this column is true. Nothing in this
-- migration turns it on: after it, every tenant reads OFF.
--
-- ADDITIVE: no existing row, policy or constraint changes. RLS is the existing
-- tenant policy on `tenant_inventory_settings` (ENABLE + FORCE, 0056). No new
-- table, so NO new grant: the domain role already holds SELECT, INSERT and
-- UPDATE on it (apps/api/src/auth/grants/baseline.grants.ts).
--
-- Lock: ACCESS EXCLUSIVE on `tenant_inventory_settings` for the length of the
-- statements. A constant NOT NULL default is catalog-only (no rewrite); the
-- table holds one row per tenant, so the CHECK validation is immediate.
--
-- Deploy coupling: the runtime reads and writes these columns with raw SQL.
-- Apply 0086 before the API that reads them is rolled (migrate is step 1 of
-- every release).
--
-- DATA-LIFECYCLE CLASSIFICATION (§XIV): BUSINESS-CLASS. A boolean, a timestamp
-- and an operator UUID per tenant. No PII, no money.
--
-- Reversal: 0086_tracked_selling_tenant_switch.down.sql REFUSES while any
-- tenant has tracked selling switched on; otherwise it drops ONLY these three
-- columns and their two constraints (the audit rows stay).

BEGIN;

ALTER TABLE tenant_inventory_settings
  ADD COLUMN IF NOT EXISTS tracked_selling_enabled    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tracked_selling_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tracked_selling_changed_by UUID;

ALTER TABLE tenant_inventory_settings
  ADD CONSTRAINT tenant_inventory_settings_tracked_selling_change_pair
    CHECK ((tracked_selling_changed_at IS NULL) = (tracked_selling_changed_by IS NULL)),
  ADD CONSTRAINT tenant_inventory_settings_tracked_selling_on_changed
    CHECK (NOT tracked_selling_enabled OR tracked_selling_changed_at IS NOT NULL);

COMMIT;
