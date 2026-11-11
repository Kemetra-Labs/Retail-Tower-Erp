-- 0094_tracking_resolutions.sql
--
-- Tracking Resolution (Jira RT-451 slice S5, migration M3). [GATED] migration,
-- authorized by the owner on 2026-11-11 (RT-451 comment 16535: "S5 Tracking
-- Resolution runtime: the migration (new resolution table) and the contract
-- change"), with the content of comment 15288's S5 row. 0093 is held by an
-- open PR (RT-1312, #508), so this takes 0094.
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/inventory/inventory.yaml
--       (`bindTrackingResolution`, `TrackingResolution`,
--        `listTrackingResolutionQueue`)
--   - packages/db/__tests__/migration/0094-tracking-resolutions.spec.ts
--
-- 1. `tracking_resolutions` — the recorded, audited Tracking Resolution of one
--    `tracking_unresolved` sale (G7-9 row 4). One per sale, final: a sale is
--    resolved once. `captured_at` is the sale's `received_at` (the queue's
--    order key, `capturedAt`), copied so the resolved half of the queue is
--    read from this table's own index. `command_fingerprint` is SHA-256 over
--    (actor, Idempotency-Key), as the RT-449 safety commands; the raw key is
--    never stored.
-- 2. `tracking_resolution_lines` — the identity bound to each unresolved line,
--    one per sale line. The sale line itself stays INSERT-only: its captured
--    snapshot and its `tracking_class = 'unresolved'` are a record of what the
--    till sent, so the binding lives here and the Inventory effect writers
--    read it (`packages/db/src/helpers/inventory-effects/sale-effects.ts`).
--
-- The bind also sets `sales.tracking_status` from 'tracking_unresolved' to
-- 'tracked' (every classified line now has an identity; 0089's meaning of
-- 'tracked'). `sales` is granted at table level (baseline): no grant change.
--
-- RLS: both tables ENABLE + FORCE with tenant policies for SELECT and INSERT
-- only: a resolution is never changed or removed.
--
-- Grants: SELECT and INSERT for the domain role outside migrations:
-- docs/operations/sql/tracking-resolutions-domain-grants.sql (deploy/README.md
-- step 2). The API refuses to boot without them (DOMAIN_REQUIRED_GRANTS). The
-- worker reads `tracking_resolution_lines` (the sale effect writer) on the
-- same domain role.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS. Opaque UUIDs,
-- a machine reason code, an operator note (no PII by contract), a SHA-256
-- fingerprint and timestamps. No money.
--
-- Deploy window: none. Only the owner-only bind command writes these tables,
-- and only a sale captured `tracking_unresolved` can be bound, which needs
-- tracked selling on (the default-off gate `POS_TRACKED_SELLING_ENABLED` AND
-- the tenant switch of 0086). No tenant can switch it on in this build.
--
-- Lock impact: ONE transaction. Both tables are created empty; their FKs take
-- SHARE ROW EXCLUSIVE on tenants, sales, sale_lines and tracking_identities
-- while the migration commits (brief; nothing is scanned or rewritten).
-- lock_timeout 2s per request, as 0089: if a lock cannot be taken in time the
-- migration rolls back and is re-run.
--
-- Reversal: 0094_tracking_resolutions.down.sql REFUSES while any resolution
-- exists (each one moved stock and emitted an ERP intent); otherwise it drops
-- both tables.

BEGIN;

SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS tracking_resolutions (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id             UUID         NOT NULL,
  sale_id              UUID         NOT NULL,
  captured_at          TIMESTAMPTZ  NOT NULL,
  reason_code          TEXT         NOT NULL,
  note                 TEXT         NOT NULL,
  command_fingerprint  TEXT         NOT NULL,
  resolved_by          UUID         NOT NULL,
  resolved_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- The sale of the same tenant and store.
  CONSTRAINT fk_tracking_resolutions_sale_tenant_store
    FOREIGN KEY (sale_id, tenant_id, store_id) REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT,
  -- The machine reason code pattern of the safety commands (contract `SafetyReasonCode`).
  CONSTRAINT tracking_resolutions_reason_code_shape
    CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- A trimmed, non-blank note of at most 500 characters.
  CONSTRAINT tracking_resolutions_note_shape
    CHECK (char_length(note) BETWEEN 1 AND 500 AND note = btrim(note)),
  CONSTRAINT tracking_resolutions_fingerprint_shape
    CHECK (command_fingerprint ~ '^[0-9a-f]{64}$'),
  -- The target of the lines' same-tenant FK.
  CONSTRAINT uq_tracking_resolutions_id_tenant UNIQUE (id, tenant_id)
);

-- A sale is resolved once (409 `tracking_resolution_already_resolved`).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracking_resolutions_tenant_sale
  ON tracking_resolutions (tenant_id, sale_id);

-- One resolution per command (the Idempotency-Key replay).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracking_resolutions_tenant_fingerprint
  ON tracking_resolutions (tenant_id, command_fingerprint);

-- The queue order (`capturedAt DESC, saleId DESC`), tenant-wide and per store.
CREATE INDEX IF NOT EXISTS idx_tracking_resolutions_tenant_captured
  ON tracking_resolutions (tenant_id, captured_at DESC, sale_id DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_resolutions_tenant_store_captured
  ON tracking_resolutions (tenant_id, store_id, captured_at DESC, sale_id DESC);

CREATE TABLE IF NOT EXISTS tracking_resolution_lines (
  sale_line_id          UUID  PRIMARY KEY REFERENCES sale_lines(id) ON DELETE RESTRICT,
  tenant_id             UUID  NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  resolution_id         UUID  NOT NULL,
  tenant_product_ref    UUID  NOT NULL,
  tracking_identity_id  UUID  NOT NULL,
  CONSTRAINT fk_tracking_resolution_lines_resolution_tenant
    FOREIGN KEY (resolution_id, tenant_id) REFERENCES tracking_resolutions (id, tenant_id) ON DELETE RESTRICT,
  -- A bound identity is always one of the line's own product and tenant.
  CONSTRAINT fk_tracking_resolution_lines_identity_product_tenant
    FOREIGN KEY (tracking_identity_id, tenant_product_ref, tenant_id)
    REFERENCES tracking_identities (id, tenant_product_ref, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_tracking_resolution_lines_resolution
  ON tracking_resolution_lines (resolution_id);

ALTER TABLE tracking_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_resolutions FORCE ROW LEVEL SECURITY;
ALTER TABLE tracking_resolution_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_resolution_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY tracking_resolutions_tenant_read ON tracking_resolutions
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT only: a resolution is never changed or removed.
CREATE POLICY tracking_resolutions_tenant_insert ON tracking_resolutions
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY tracking_resolution_lines_tenant_read ON tracking_resolution_lines
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY tracking_resolution_lines_tenant_insert ON tracking_resolution_lines
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
