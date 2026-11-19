-- 0124_shipment_transfers — Jira RT-1513 (RT-291 Inventory Gate 5, slice S2; [GATED: migration]; contract RT-1512,
-- inventory.yaml 1.21.0-draft; posting-feed.yaml 1.17.0-draft, RT-1514; owner rulings O1..O5 in RT-291 comment 17801).
--
-- The shipment Transfer domain: Draft -> Approved/Reserved -> In Transit -> Partially Received -> Received -> Closed.
-- Everything is additive and dark: `tenant_inventory_settings.shipment_transfers_enabled` defaults to false, so no
-- tenant sees a changed behaviour until it is activated.
--
-- Changes:
--   1. tenant_inventory_settings: the per-tenant activation switch (+ who/when) and the delayed-transfer threshold
--      in days (O4, default 3), read by the later alert (RT-1516).
--   2. erpnext_warehouse_map: purpose 'transit' (O2), one active row per tenant with NO store (store_id becomes
--      nullable, tied to the purpose by a CHECK). The Connector verifies it is a Transit warehouse of the same Company.
--   3. inventory_reservations: ONE shared reservation table (O1): item, store/location, quantity, explicit expiry,
--      source type ('transfer' today; RT-1511 reads it, W2 reuses it by widening the CHECK).
--   4. shipment_transfers, _lines, _receipts, _receipt_lines, _discrepancies: the Transfer document. In Transit is the
--      per-line quantity dispatched - received - short_closed, never a Stock Location or an inventory status (G4-1).
--   5. transfer_postings, transfer_posting_lines: the frozen body of one transfer leg work item (as
--      count_posting_lines is for a count chunk): the feed reads only these rows, never the live maps.
--   6. erpnext_posting_status: `kind` gains 'transfer_dispatch' and 'transfer_receive'; the shape CHECK becomes
--      three-way (sale/reversal carry a sale, a count chunk carries the count columns, a transfer leg carries
--      neither). The unique leg key is migration 0125 (built CONCURRENTLY).
--
-- Locking: a first transaction holds ACCESS EXCLUSIVE only for metadata changes and the constraint swap (the new CHECKs
-- are NOT VALID). A SECOND transaction validates them (SHARE UPDATE EXCLUSIVE). Every existing row is a sale,
-- reversal or count row, so validation always passes.
-- Rollback: 0124_shipment_transfers.down.sql (refuses while any transfer, reservation or transfer leg exists).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Per-tenant settings
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_inventory_settings
  ADD COLUMN IF NOT EXISTS shipment_transfers_enabled    BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shipment_transfers_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shipment_transfers_changed_by UUID,
  ADD COLUMN IF NOT EXISTS delayed_transfer_threshold_days INTEGER   NOT NULL DEFAULT 3;

ALTER TABLE tenant_inventory_settings
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_shipment_change_pair,
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_delayed_threshold_range;
ALTER TABLE tenant_inventory_settings
  ADD CONSTRAINT tenant_inventory_settings_shipment_change_pair
    CHECK ((shipment_transfers_changed_at IS NULL) = (shipment_transfers_changed_by IS NULL)),
  ADD CONSTRAINT tenant_inventory_settings_delayed_threshold_range
    CHECK (delayed_transfer_threshold_days BETWEEN 1 AND 90);

-- ---------------------------------------------------------------------------
-- 1b. One definition of a store's business date
-- ---------------------------------------------------------------------------
-- The calendar date, in the store's own time zone, of an instant (default now). The tracked-line expiry check
-- (G7-4: "past its expiry at the source store's business date") and the business date of a transfer leg both need
-- it. SECURITY INVOKER (the default): `stores` is FORCE RLS, so a store of another tenant reads nothing and the
-- function returns NULL, never a date. A SQL function so inventory can use it without importing the `stores`
-- module (which already imports inventory).
CREATE OR REPLACE FUNCTION store_business_date(p_store_id UUID, p_at TIMESTAMPTZ DEFAULT now())
RETURNS DATE
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT (COALESCE(p_at, now()) AT TIME ZONE s.timezone)::date FROM stores s WHERE s.id = p_store_id
$$;

-- ---------------------------------------------------------------------------
-- 2. The tenant transit warehouse (O2): a map row with no store
-- ---------------------------------------------------------------------------
ALTER TABLE erpnext_warehouse_map
  ALTER COLUMN store_id DROP NOT NULL;

ALTER TABLE erpnext_warehouse_map
  DROP CONSTRAINT IF EXISTS erpnext_warehouse_map_purpose_valid,
  DROP CONSTRAINT IF EXISTS erpnext_warehouse_map_transit_has_no_store;
ALTER TABLE erpnext_warehouse_map
  ADD CONSTRAINT erpnext_warehouse_map_purpose_valid
    CHECK (purpose IN ('stock', 'returns', 'transit')),
  -- A transit row belongs to the tenant, every other purpose to one store.
  ADD CONSTRAINT erpnext_warehouse_map_transit_has_no_store
    CHECK ((purpose = 'transit') = (store_id IS NULL)) NOT VALID;

-- At most one ACTIVE transit warehouse per tenant (the store key above is NULL for it, so the existing
-- (tenant, store, purpose) unique index cannot enforce this).
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_erpnext_warehouse_map_transit_active"
  ON erpnext_warehouse_map (tenant_id)
  WHERE purpose = 'transit' AND retired_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. The shared reservation table (O1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_reservations (
  id                 UUID          PRIMARY KEY,
  tenant_id          UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id           UUID          NOT NULL,
  stock_location_id  UUID          NOT NULL,
  tenant_product_ref UUID          NOT NULL,
  tracking_identity_id UUID,
  quantity           NUMERIC(19,4) NOT NULL,
  expires_at         TIMESTAMPTZ   NOT NULL,
  source_type        TEXT          NOT NULL,
  source_id          UUID          NOT NULL,
  source_line_id     UUID          NOT NULL,
  state              TEXT          NOT NULL DEFAULT 'active',
  state_reason       TEXT,
  state_changed_by   UUID,
  state_changed_at   TIMESTAMPTZ,
  created_by         UUID          NOT NULL,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT fk_inventory_reservations_store
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservations_product
    FOREIGN KEY (tenant_product_ref, tenant_id) REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_reservations_quantity_positive CHECK (quantity > 0),
  -- Widen this list (with its own gated migration) when W2 / RT-2 adds a source.
  CONSTRAINT inventory_reservations_source_type_allowed CHECK (source_type IN ('transfer')),
  CONSTRAINT inventory_reservations_state_allowed CHECK (state IN ('active', 'consumed', 'released', 'expired')),
  -- An active reservation has never been changed; every other state records when and why.
  CONSTRAINT inventory_reservations_state_pair
    CHECK ((state = 'active') = (state_changed_at IS NULL)),
  CONSTRAINT inventory_reservations_reason_length
    CHECK (state_reason IS NULL OR char_length(state_reason) <= 500)
);

-- One live reservation per source line; a re-approval after expiry or release makes a new row.
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_inventory_reservations_active_source"
  ON inventory_reservations (tenant_id, source_type, source_line_id)
  WHERE state = 'active';
-- The Available-to-Sell read (RT-1511): live reservations of a store position.
CREATE INDEX IF NOT EXISTS idx_inventory_reservations_active_position
  ON inventory_reservations (tenant_id, store_id, tenant_product_ref)
  WHERE state = 'active';
-- The expiry sweep.
CREATE INDEX IF NOT EXISTS idx_inventory_reservations_active_expiry
  ON inventory_reservations (tenant_id, expires_at)
  WHERE state = 'active';

-- ---------------------------------------------------------------------------
-- 4. The Transfer document
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shipment_transfers (
  id                       UUID        PRIMARY KEY,
  tenant_id                UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  source_store_id          UUID        NOT NULL,
  destination_store_id     UUID        NOT NULL,
  state                    TEXT        NOT NULL DEFAULT 'draft',
  reason                   TEXT,
  created_by               UUID        NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by              UUID,
  approved_at              TIMESTAMPTZ,
  reservation_expires_at   TIMESTAMPTZ,
  reservation_released_at  TIMESTAMPTZ,
  dispatched_by            UUID,
  dispatched_at            TIMESTAMPTZ,
  dispatch_note            TEXT,
  closed_by                UUID,
  closed_at                TIMESTAMPTZ,
  short_close_reason       TEXT,
  short_close_approved_by  UUID,
  short_close_approved_at  TIMESTAMPTZ,
  cancelled_by             UUID,
  cancelled_at             TIMESTAMPTZ,
  cancel_reason            TEXT,
  receipt_count            INTEGER     NOT NULL DEFAULT 0,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_shipment_transfers_source
    FOREIGN KEY (tenant_id, source_store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipment_transfers_destination
    FOREIGN KEY (tenant_id, destination_store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_shipment_transfers_id_tenant UNIQUE (id, tenant_id),
  -- A move inside one store is a Relocation, not a Transfer (800).
  CONSTRAINT shipment_transfers_stores_differ CHECK (source_store_id <> destination_store_id),
  CONSTRAINT shipment_transfers_state_allowed
    CHECK (state IN ('draft', 'approved', 'in_transit', 'partially_received', 'received', 'closed', 'cancelled')),
  CONSTRAINT shipment_transfers_reason_lengths
    CHECK ((reason IS NULL OR char_length(reason) <= 500)
       AND (dispatch_note IS NULL OR char_length(dispatch_note) <= 500)
       AND (short_close_reason IS NULL OR char_length(short_close_reason) BETWEEN 1 AND 500)
       AND (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 1 AND 500)),
  CONSTRAINT shipment_transfers_approval_pair
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)
       AND (approved_by IS NULL) = (reservation_expires_at IS NULL)),
  CONSTRAINT shipment_transfers_dispatch_pair
    CHECK ((dispatched_by IS NULL) = (dispatched_at IS NULL)),
  CONSTRAINT shipment_transfers_close_pair
    CHECK ((closed_by IS NULL) = (closed_at IS NULL)),
  CONSTRAINT shipment_transfers_short_close_all_or_none
    CHECK ((short_close_reason IS NULL) = (short_close_approved_by IS NULL)
       AND (short_close_reason IS NULL) = (short_close_approved_at IS NULL)),
  CONSTRAINT shipment_transfers_cancel_all_or_none
    CHECK ((cancelled_by IS NULL) = (cancelled_at IS NULL)
       AND (cancelled_by IS NULL) = (cancel_reason IS NULL)),
  CONSTRAINT shipment_transfers_receipt_count_non_negative CHECK (receipt_count >= 0),
  -- Each state needs the columns that lead to it, and none that contradict it.
  CONSTRAINT shipment_transfers_state_draft
    CHECK (state <> 'draft' OR (approved_at IS NULL AND dispatched_at IS NULL AND closed_at IS NULL AND cancelled_at IS NULL)),
  CONSTRAINT shipment_transfers_state_approved
    CHECK (state <> 'approved' OR (approved_at IS NOT NULL AND dispatched_at IS NULL AND closed_at IS NULL AND cancelled_at IS NULL)),
  CONSTRAINT shipment_transfers_state_dispatched
    CHECK (state NOT IN ('in_transit', 'partially_received', 'received', 'closed')
        OR (dispatched_at IS NOT NULL AND cancelled_at IS NULL)),
  CONSTRAINT shipment_transfers_state_closed CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  -- Cancel is only before dispatch (798): a cancelled Transfer never left the source.
  CONSTRAINT shipment_transfers_state_cancelled
    CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)
       AND (state <> 'cancelled' OR dispatched_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_shipment_transfers_tenant_created
  ON shipment_transfers (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_shipment_transfers_source
  ON shipment_transfers (tenant_id, source_store_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_shipment_transfers_destination
  ON shipment_transfers (tenant_id, destination_store_id, created_at DESC, id DESC);
-- The in-transit age scan of the delayed-transfer alert (RT-1516) and the reservation expiry sweep.
CREATE INDEX IF NOT EXISTS idx_shipment_transfers_in_flight
  ON shipment_transfers (tenant_id, dispatched_at)
  WHERE state IN ('in_transit', 'partially_received');

CREATE TABLE IF NOT EXISTS shipment_transfer_lines (
  id                    UUID          PRIMARY KEY,
  tenant_id             UUID          NOT NULL,
  transfer_id           UUID          NOT NULL,
  line_seq              INTEGER       NOT NULL,
  tenant_product_ref    UUID          NOT NULL,
  stocking_unit         TEXT          NOT NULL,
  tracking_identity_id  UUID,
  quantity              NUMERIC(19,4) NOT NULL,
  dispatched_quantity   NUMERIC(19,4) NOT NULL DEFAULT 0,
  received_quantity     NUMERIC(19,4) NOT NULL DEFAULT 0,
  short_closed_quantity NUMERIC(19,4) NOT NULL DEFAULT 0,
  dispatch_movement_id  UUID,
  CONSTRAINT fk_shipment_transfer_lines_transfer
    FOREIGN KEY (transfer_id, tenant_id) REFERENCES shipment_transfers (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipment_transfer_lines_product
    FOREIGN KEY (tenant_product_ref, tenant_id) REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipment_transfer_lines_dispatch_movement
    FOREIGN KEY (dispatch_movement_id, tenant_id) REFERENCES stock_movements (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_shipment_transfer_lines_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT uq_shipment_transfer_lines_seq UNIQUE (transfer_id, line_seq),
  CONSTRAINT shipment_transfer_lines_seq_range CHECK (line_seq BETWEEN 1 AND 100),
  CONSTRAINT shipment_transfer_lines_unit_length CHECK (char_length(stocking_unit) BETWEEN 1 AND 140),
  CONSTRAINT shipment_transfer_lines_quantity_positive CHECK (quantity > 0),
  -- The whole approved quantity is dispatched, or nothing is (to send less, cancel and create a new Transfer).
  CONSTRAINT shipment_transfer_lines_dispatched_all_or_none
    CHECK (dispatched_quantity = 0 OR dispatched_quantity = quantity),
  CONSTRAINT shipment_transfer_lines_non_negative
    CHECK (received_quantity >= 0 AND short_closed_quantity >= 0),
  -- In Transit (dispatched - received - short_closed) can never go negative: no fabricated or over quantity (813).
  CONSTRAINT shipment_transfer_lines_in_transit_non_negative
    CHECK (received_quantity + short_closed_quantity <= dispatched_quantity),
  CONSTRAINT shipment_transfer_lines_dispatch_movement_pair
    CHECK ((dispatched_quantity > 0) = (dispatch_movement_id IS NOT NULL))
);

-- One line per product (and per tracking identity for a tracked product) in one Transfer.
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_shipment_transfer_lines_product"
  ON shipment_transfer_lines (transfer_id, tenant_product_ref, COALESCE(tracking_identity_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS shipment_transfer_receipts (
  id           UUID        PRIMARY KEY,
  tenant_id    UUID        NOT NULL,
  transfer_id  UUID        NOT NULL,
  receipt_seq  INTEGER     NOT NULL,
  received_by  UUID        NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note         TEXT,
  CONSTRAINT fk_shipment_transfer_receipts_transfer
    FOREIGN KEY (transfer_id, tenant_id) REFERENCES shipment_transfers (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_shipment_transfer_receipts_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT uq_shipment_transfer_receipts_seq UNIQUE (transfer_id, receipt_seq),
  CONSTRAINT shipment_transfer_receipts_seq_positive CHECK (receipt_seq >= 1),
  CONSTRAINT shipment_transfer_receipts_note_length CHECK (note IS NULL OR char_length(note) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_shipment_transfer_receipts_transfer
  ON shipment_transfer_receipts (tenant_id, transfer_id, received_at, id);

CREATE TABLE IF NOT EXISTS shipment_transfer_receipt_lines (
  receipt_id        UUID          NOT NULL,
  tenant_id         UUID          NOT NULL,
  line_seq          INTEGER       NOT NULL,
  transfer_line_id  UUID          NOT NULL,
  quantity          NUMERIC(19,4) NOT NULL,
  inventory_status  TEXT          NOT NULL,
  stock_location_id UUID          NOT NULL,
  movement_id       UUID          NOT NULL,
  PRIMARY KEY (receipt_id, line_seq),
  CONSTRAINT fk_shipment_transfer_receipt_lines_receipt
    FOREIGN KEY (receipt_id, tenant_id) REFERENCES shipment_transfer_receipts (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipment_transfer_receipt_lines_line
    FOREIGN KEY (transfer_line_id, tenant_id) REFERENCES shipment_transfer_lines (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipment_transfer_receipt_lines_movement
    FOREIGN KEY (movement_id, tenant_id) REFERENCES stock_movements (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_shipment_transfer_receipt_lines_line UNIQUE (receipt_id, transfer_line_id),
  CONSTRAINT shipment_transfer_receipt_lines_seq_range CHECK (line_seq BETWEEN 1 AND 100),
  CONSTRAINT shipment_transfer_receipt_lines_quantity_positive CHECK (quantity > 0),
  CONSTRAINT shipment_transfer_receipt_lines_status_allowed
    CHECK (inventory_status IN ('sellable', 'return_inspection', 'quality_hold', 'damaged', 'expired', 'recall_hold'))
);

-- A short-close writes the quantity still in transit off as an approved loss (812). V1 keeps that in Backend-Core
-- only: the ERP leg of a short-close is NOT decided (posting-feed.yaml 1.16.0/1.17.0 note), so `erp_state` stays
-- 'not_emitted' and these rows are the drift list a later issue reconciles.
CREATE TABLE IF NOT EXISTS shipment_transfer_discrepancies (
  id                UUID          PRIMARY KEY,
  tenant_id         UUID          NOT NULL,
  transfer_id       UUID          NOT NULL,
  transfer_line_id  UUID          NOT NULL,
  kind              TEXT          NOT NULL,
  quantity          NUMERIC(19,4) NOT NULL,
  reason            TEXT          NOT NULL,
  approved_by       UUID          NOT NULL,
  approved_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  erp_state         TEXT          NOT NULL DEFAULT 'not_emitted',
  CONSTRAINT fk_shipment_transfer_discrepancies_transfer
    FOREIGN KEY (transfer_id, tenant_id) REFERENCES shipment_transfers (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipment_transfer_discrepancies_line
    FOREIGN KEY (transfer_line_id, tenant_id) REFERENCES shipment_transfer_lines (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_shipment_transfer_discrepancies_line_kind UNIQUE (transfer_line_id, kind),
  CONSTRAINT shipment_transfer_discrepancies_kind_allowed CHECK (kind IN ('short_close')),
  CONSTRAINT shipment_transfer_discrepancies_quantity_positive CHECK (quantity > 0),
  CONSTRAINT shipment_transfer_discrepancies_reason_length CHECK (char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT shipment_transfer_discrepancies_erp_state_allowed CHECK (erp_state IN ('not_emitted'))
);

CREATE INDEX IF NOT EXISTS idx_shipment_transfer_discrepancies_transfer
  ON shipment_transfer_discrepancies (tenant_id, transfer_id);

-- ---------------------------------------------------------------------------
-- 5. The frozen body of one transfer leg work item
-- ---------------------------------------------------------------------------
-- The work item row itself is `erpnext_posting_status` (the feed's cursor, retry budget and ack machinery are
-- reused, no second feed). Every reference below is resolved and FROZEN when the leg is emitted, so a later re-map
-- cannot retarget a posted leg.
CREATE TABLE IF NOT EXISTS transfer_postings (
  intent_id                UUID NOT NULL,
  tenant_id                UUID NOT NULL,
  transfer_id              UUID NOT NULL,
  receipt_id               UUID,
  source_warehouse_ref     TEXT,
  transit_warehouse_ref    TEXT NOT NULL,
  destination_warehouse_ref TEXT,
  dispatch_document_ref    TEXT,
  posting_datetime         TEXT NOT NULL,
  business_date            DATE NOT NULL,
  PRIMARY KEY (intent_id),
  CONSTRAINT fk_transfer_postings_intent
    FOREIGN KEY (intent_id, tenant_id) REFERENCES erpnext_posting_status (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_transfer_postings_transfer
    FOREIGN KEY (transfer_id, tenant_id) REFERENCES shipment_transfers (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_transfer_postings_receipt
    FOREIGN KEY (receipt_id, tenant_id) REFERENCES shipment_transfer_receipts (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT transfer_postings_ref_length
    CHECK (char_length(transit_warehouse_ref) BETWEEN 1 AND 180
       AND (source_warehouse_ref IS NULL OR char_length(source_warehouse_ref) BETWEEN 1 AND 180)
       AND (destination_warehouse_ref IS NULL OR char_length(destination_warehouse_ref) BETWEEN 1 AND 180)),
  CONSTRAINT transfer_postings_datetime_format
    CHECK (posting_datetime ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'),
  -- A dispatch leg names its source warehouse; a receipt leg names its destination and the confirmed dispatch
  -- document (it is released only after the dispatch is confirmed, 886).
  CONSTRAINT transfer_postings_leg_shape
    CHECK ((receipt_id IS NULL
            AND source_warehouse_ref IS NOT NULL AND destination_warehouse_ref IS NULL AND dispatch_document_ref IS NULL)
        OR (receipt_id IS NOT NULL
            AND source_warehouse_ref IS NULL AND destination_warehouse_ref IS NOT NULL AND dispatch_document_ref IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_transfer_postings_transfer ON transfer_postings (tenant_id, transfer_id);

CREATE TABLE IF NOT EXISTS transfer_posting_lines (
  intent_id          UUID          NOT NULL,
  tenant_id          UUID          NOT NULL,
  line_seq           INTEGER       NOT NULL,
  transfer_line_id   UUID          NOT NULL,
  dispatch_line_seq  INTEGER,
  erpnext_item_ref   TEXT          NOT NULL,
  erpnext_batch_ref  TEXT,
  quantity           NUMERIC(19,4) NOT NULL,
  unit               TEXT          NOT NULL,
  PRIMARY KEY (intent_id, line_seq),
  CONSTRAINT fk_transfer_posting_lines_intent
    FOREIGN KEY (intent_id, tenant_id) REFERENCES erpnext_posting_status (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_transfer_posting_lines_line
    FOREIGN KEY (transfer_line_id, tenant_id) REFERENCES shipment_transfer_lines (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT transfer_posting_lines_seq_range CHECK (line_seq BETWEEN 1 AND 100),
  CONSTRAINT transfer_posting_lines_dispatch_seq_range
    CHECK (dispatch_line_seq IS NULL OR dispatch_line_seq BETWEEN 1 AND 100),
  CONSTRAINT transfer_posting_lines_quantity_positive CHECK (quantity > 0),
  CONSTRAINT transfer_posting_lines_item_ref_length CHECK (char_length(erpnext_item_ref) BETWEEN 1 AND 140),
  CONSTRAINT transfer_posting_lines_batch_ref_length
    CHECK (erpnext_batch_ref IS NULL OR char_length(erpnext_batch_ref) BETWEEN 1 AND 140),
  CONSTRAINT transfer_posting_lines_unit_length CHECK (char_length(unit) BETWEEN 1 AND 140)
);

-- ---------------------------------------------------------------------------
-- RLS: ENABLE + FORCE on every new table; SELECT / INSERT / UPDATE policies keyed on app.current_tenant (the empty
-- GUC resolves to NULL, so it sees nothing); NO DELETE policy.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'inventory_reservations', 'shipment_transfers', 'shipment_transfer_lines', 'shipment_transfer_receipts',
    'shipment_transfer_receipt_lines', 'shipment_transfer_discrepancies', 'transfer_postings', 'transfer_posting_lines'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_tenant_read', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_tenant_insert', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_tenant_update', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (tenant_id = CASE WHEN current_setting(''app.current_tenant'', true) = '''' THEN NULL ELSE current_setting(''app.current_tenant'', true)::uuid END)',
      tbl || '_tenant_read', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (tenant_id = CASE WHEN current_setting(''app.current_tenant'', true) = '''' THEN NULL ELSE current_setting(''app.current_tenant'', true)::uuid END)',
      tbl || '_tenant_insert', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (tenant_id = CASE WHEN current_setting(''app.current_tenant'', true) = '''' THEN NULL ELSE current_setting(''app.current_tenant'', true)::uuid END) WITH CHECK (tenant_id = CASE WHEN current_setting(''app.current_tenant'', true) = '''' THEN NULL ELSE current_setting(''app.current_tenant'', true)::uuid END)',
      tbl || '_tenant_update', tbl);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. erpnext_posting_status: two new kinds and a three-way shape
-- ---------------------------------------------------------------------------
ALTER TABLE erpnext_posting_status
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_kind_valid,
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_count_shape;

ALTER TABLE erpnext_posting_status
  ADD CONSTRAINT erpnext_posting_status_kind_valid
    CHECK (kind IN ('sale_post', 'reversal', 'inventory_count', 'transfer_dispatch', 'transfer_receive')) NOT VALID,
  ADD CONSTRAINT erpnext_posting_status_count_shape
    CHECK ((kind = 'inventory_count'
            AND sale_id IS NULL
            AND count_session_id IS NOT NULL AND count_chunk IS NOT NULL
            AND count_chunk_total IS NOT NULL AND count_posting_datetime IS NOT NULL)
        OR (kind IN ('transfer_dispatch', 'transfer_receive')
            AND sale_id IS NULL
            AND count_session_id IS NULL AND count_chunk IS NULL
            AND count_chunk_total IS NULL AND count_posting_datetime IS NULL)
        OR (kind IN ('sale_post', 'reversal')
            AND sale_id IS NOT NULL
            AND count_session_id IS NULL AND count_chunk IS NULL
            AND count_chunk_total IS NULL AND count_posting_datetime IS NULL)) NOT VALID;

COMMIT;

-- Second transaction: validation. The exclusive locks of the first are released at its COMMIT, so these scans hold
-- only SHARE UPDATE EXCLUSIVE and never extend the schema-change window. Every existing row is a sale, reversal or
-- count row (no transfer leg can exist yet, and no transit map row), so validation always passes. A failed
-- validation leaves the constraints NOT VALID and the migration re-runnable (each ADD follows its own DROP IF EXISTS).
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE erpnext_warehouse_map VALIDATE CONSTRAINT erpnext_warehouse_map_transit_has_no_store;
ALTER TABLE erpnext_posting_status VALIDATE CONSTRAINT erpnext_posting_status_kind_valid;
ALTER TABLE erpnext_posting_status VALIDATE CONSTRAINT erpnext_posting_status_count_shape;

COMMIT;
