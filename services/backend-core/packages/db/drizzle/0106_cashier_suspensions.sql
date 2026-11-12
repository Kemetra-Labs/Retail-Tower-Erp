-- 0106_cashier_suspensions.sql
--
-- RT-1138 (Story RT-1130, remote cashier suspension) — `[GATED: contract, migration]`.
-- Owner authority: the owner told this session "Yes, implement" for RT-1138 on
-- 2026-11-12 after the gated paths (a new table and a new OpenAPI contract) were
-- named, and confirmed the contract shape (the roster `suspended_cashiers` sync
-- field, owner / tenant_admin writes, per-store scope, no reason text) in chat
-- the same day. Applying it to a lab or live database is NOT authorized.
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/cashier-suspensions.openapi.yaml
--   - packages/contracts/openapi/pos-cashier-admissions.openapi.yaml (roster)
--   - packages/db/src/schema/cashier-suspensions.ts
--   - packages/db/__tests__/migration/0106-cashier-suspensions.spec.ts
--
-- Creates ONE table, `cashier_suspensions`: whether a cashier (a `store_staff`
-- user) is suspended at ONE store. The state is per tenant, store and user.
--
-- DEFAULT SEMANTICS (the rule every reader shares): a cashier with NO row is
-- NOT suspended. So this migration needs NO backfill and every existing
-- cashier reads active by construction. A row exists only for a cashier that
-- was suspended at least once; reactivation flips `status` back to `active`
-- and keeps the row (the history of each change is in `audit_events`, never
-- here). Rows are never deleted.
--
-- A row is one of:
--   status = 'suspended'   the cashier may not be admitted at this store, and
--                          the POS sync lists them as suspended;
--   status = 'active'      the cashier was reactivated; same as no row.
-- `changed_at` / `changed_by_user_id` record the LAST change only.
--
-- RLS: ENABLE + FORCE, the 0036 CASE-GUC form (a bare ::uuid cast throws 22P02
-- on an unset GUC). SELECT, INSERT and UPDATE are limited to the caller's
-- tenant; a tenant can never read or write another tenant's rows, and the
-- store must belong to the same tenant (composite FK below). No DELETE policy.
-- WHO may suspend (owner or tenant_admin, a cookie session) is decided by the
-- API, not by the table: RLS is the tenant wall, not the role check.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS operational state: three ids, an enum state, an actor id (a
-- user id, FK to users) and timestamps. NO PII beyond those ids, NO free-text
-- reason, NO money, NO secret. Retained for the life of the tenant.
-- ---------------------------------------------------------------------------
--
-- Reversal: 0106_cashier_suspensions.down.sql drops ONLY this table. SAFETY:
-- that discards every suspension, so every suspended cashier reads active again
-- (fail-open). The down file refuses while any row has status 'suspended'.
--
-- Runtime grants are provisioned outside migrations:
-- docs/operations/sql/cashier-suspensions-domain-grants.sql (step 2 of
-- deploy/README.md), BEFORE the API that needs it starts.

BEGIN;

-- The foreign keys below take SHARE ROW EXCLUSIVE locks on `tenants`, `stores`
-- and `users`. lock_timeout 2s: if a lock is not granted in time the migration
-- fails and rolls back, instead of queueing behind a long transaction and
-- blocking every sign-in and session write (the 0097, 0101 and 0105 pattern).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS cashier_suspensions (
  tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id            UUID         NOT NULL,
  user_id             UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status              TEXT         NOT NULL,
  changed_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  changed_by_user_id  UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT cashier_suspensions_pkey PRIMARY KEY (tenant_id, store_id, user_id),
  -- Same-tenant store: a row can never point at another tenant's store.
  CONSTRAINT fk_cashier_suspensions_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT cashier_suspensions_status_valid
    CHECK (status IN ('suspended', 'active'))
);

ALTER TABLE cashier_suspensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashier_suspensions FORCE  ROW LEVEL SECURITY;

CREATE POLICY cashier_suspensions_tenant_select ON cashier_suspensions
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY cashier_suspensions_tenant_insert ON cashier_suspensions
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY cashier_suspensions_tenant_update ON cashier_suspensions
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

COMMIT;
