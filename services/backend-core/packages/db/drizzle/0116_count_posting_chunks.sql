-- 0116_count_posting_chunks — Jira RT-1423 (RT-292 Inventory Gate 6; owner authorization 2026-11-16).
--
-- A Count Session is posted through the EXISTING ERPNext posting feed as `inventory_count` work items,
-- one per chunk of at most 100 lines (posting-feed.yaml 1.15.0-draft). A chunk is a row of
-- `erpnext_posting_status` (the feed's cursor, retry budget and ack machinery are reused, no second feed),
-- with a frozen body in `count_posting_lines`.
--
-- Changes (all additive; every existing row stays valid):
--   1. erpnext_posting_status: `sale_id` becomes nullable (a chunk has no sale); `kind` gains
--      'inventory_count'; `status` gains the terminal 'verified_noop' (ERP already held every target:
--      no document exists, so it can never be 'posted'); four chunk columns; a shape CHECK that ties the
--      chunk columns to the kind in both directions; a UNIQUE (tenant, session, chunk) key, which is the
--      database backstop of idempotent emission (the index itself is migration 0117, built CONCURRENTLY); a
--      composite FK to count_sessions.
--   2. count_posting_lines: the frozen body of a chunk (item and warehouse references, the ABSOLUTE
--      counted target, the unit) plus the per-line result the Connector reported. Immutable body: the feed
--      reads only these rows, never the live maps, so a later re-map cannot retarget a posted count.
--   3. tenant_inventory_settings: `count_sessions_changed_at` / `_by` record who last switched Count Sessions
--      on or off (the activation switch itself, `count_sessions_enabled`, is 0114's, default OFF).
--   4. inventory_effect_integration: `confirmed` may carry no document when the reason is the count
--      no-op (`count_verified_noop`): a count correction whose ERP target was already reached is
--      confirmed without a new ERP document, and never with a fabricated one.
--
-- Locking: a first transaction holds ACCESS EXCLUSIVE only for the nullable/DROP NOT NULL changes (metadata,
-- instant) and the constraint swaps; new CHECKs and the FK are added NOT VALID there. A SECOND transaction
-- validates them (SHARE UPDATE EXCLUSIVE) and builds the unique index, after the exclusive locks are released. Every existing row has sale_id set and the new columns NULL, so validation always passes.
-- Rollback: 0116_count_posting_chunks.down.sql (refuses while any chunk exists).

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE erpnext_posting_status
  ALTER COLUMN sale_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS count_session_id       UUID,
  ADD COLUMN IF NOT EXISTS count_chunk            INTEGER,
  ADD COLUMN IF NOT EXISTS count_chunk_total      INTEGER,
  ADD COLUMN IF NOT EXISTS count_posting_datetime TEXT;

ALTER TABLE erpnext_posting_status
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_kind_valid,
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_status_valid,
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_count_shape,
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_count_chunk_bounds,
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_count_datetime_format,
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_noop_only_count,
  DROP CONSTRAINT IF EXISTS fk_erpnext_posting_status_count_session;

ALTER TABLE erpnext_posting_status
  ADD CONSTRAINT erpnext_posting_status_kind_valid
    CHECK (kind IN ('sale_post', 'reversal', 'inventory_count')) NOT VALID,
  ADD CONSTRAINT erpnext_posting_status_status_valid
    CHECK (status IN ('pending', 'posted', 'failed_transient', 'permanently_rejected', 'verified_noop')) NOT VALID,
  ADD CONSTRAINT erpnext_posting_status_count_shape
    CHECK ((kind = 'inventory_count'
            AND sale_id IS NULL
            AND count_session_id IS NOT NULL AND count_chunk IS NOT NULL
            AND count_chunk_total IS NOT NULL AND count_posting_datetime IS NOT NULL)
        OR (kind <> 'inventory_count'
            AND sale_id IS NOT NULL
            AND count_session_id IS NULL AND count_chunk IS NULL
            AND count_chunk_total IS NULL AND count_posting_datetime IS NULL)) NOT VALID,
  ADD CONSTRAINT erpnext_posting_status_count_chunk_bounds
    CHECK (count_chunk IS NULL OR (count_chunk >= 1 AND count_chunk <= count_chunk_total)) NOT VALID,
  ADD CONSTRAINT erpnext_posting_status_count_datetime_format
    CHECK (count_posting_datetime IS NULL
        OR count_posting_datetime ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$') NOT VALID,
  ADD CONSTRAINT erpnext_posting_status_noop_only_count
    CHECK (status <> 'verified_noop' OR (kind = 'inventory_count' AND document_ref IS NULL)) NOT VALID,
  ADD CONSTRAINT fk_erpnext_posting_status_count_session
    FOREIGN KEY (count_session_id, tenant_id, store_id)
    REFERENCES count_sessions (id, tenant_id, store_id) ON DELETE RESTRICT NOT VALID;

CREATE TABLE IF NOT EXISTS count_posting_lines (
  intent_id          UUID          NOT NULL,
  tenant_id          UUID          NOT NULL,
  line_seq           INTEGER       NOT NULL,
  tenant_product_ref UUID          NOT NULL,
  erpnext_item_ref   TEXT          NOT NULL,
  warehouse_ref      TEXT          NOT NULL,
  counted_quantity   NUMERIC(19,4) NOT NULL,
  unit               TEXT          NOT NULL,
  result             TEXT,
  verified_qty_after TEXT,
  refusal_code       TEXT,
  refusal_message    TEXT,
  resulted_at        TIMESTAMPTZ,
  PRIMARY KEY (intent_id, line_seq),
  CONSTRAINT uq_count_posting_lines_product UNIQUE (intent_id, tenant_product_ref),
  CONSTRAINT fk_count_posting_lines_intent
    FOREIGN KEY (intent_id, tenant_id)
    REFERENCES erpnext_posting_status (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_count_posting_lines_product
    FOREIGN KEY (tenant_product_ref, tenant_id)
    REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT count_posting_lines_seq_positive CHECK (line_seq >= 1),
  CONSTRAINT count_posting_lines_quantity_non_negative CHECK (counted_quantity >= 0),
  CONSTRAINT count_posting_lines_item_ref_length CHECK (char_length(erpnext_item_ref) BETWEEN 1 AND 140),
  CONSTRAINT count_posting_lines_warehouse_ref_length CHECK (char_length(warehouse_ref) BETWEEN 1 AND 180),
  CONSTRAINT count_posting_lines_unit_length CHECK (char_length(unit) BETWEEN 1 AND 140),
  CONSTRAINT count_posting_lines_result_allowed
    CHECK (result IS NULL OR result IN ('adjusted', 'verified_noop', 'rejected')),
  CONSTRAINT count_posting_lines_result_pair
    CHECK ((result IS NULL) = (resulted_at IS NULL)),
  CONSTRAINT count_posting_lines_refusal_when_rejected
    CHECK ((result = 'rejected') = (refusal_code IS NOT NULL)),
  CONSTRAINT count_posting_lines_refusal_message_length
    CHECK (refusal_message IS NULL OR char_length(refusal_message) <= 1000),
  CONSTRAINT count_posting_lines_qty_after_when_verified
    CHECK (verified_qty_after IS NULL OR result IN ('adjusted', 'verified_noop'))
);

CREATE INDEX IF NOT EXISTS idx_count_posting_lines_tenant ON count_posting_lines (tenant_id);

ALTER TABLE count_posting_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE count_posting_lines FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS count_posting_lines_tenant_read ON count_posting_lines;
DROP POLICY IF EXISTS count_posting_lines_tenant_insert ON count_posting_lines;
DROP POLICY IF EXISTS count_posting_lines_tenant_update ON count_posting_lines;

CREATE POLICY count_posting_lines_tenant_read ON count_posting_lines FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY count_posting_lines_tenant_insert ON count_posting_lines FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY count_posting_lines_tenant_update ON count_posting_lines FOR UPDATE
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

ALTER TABLE inventory_effect_integration
  DROP CONSTRAINT IF EXISTS inventory_effect_integration_confirmed_document;

ALTER TABLE inventory_effect_integration
  ADD CONSTRAINT inventory_effect_integration_confirmed_document
    CHECK (state <> 'confirmed' OR erp_document_ref IS NOT NULL
        OR state_reason IS NOT DISTINCT FROM 'count_verified_noop') NOT VALID;

ALTER TABLE tenant_inventory_settings
  ADD COLUMN IF NOT EXISTS count_sessions_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS count_sessions_changed_by UUID;

ALTER TABLE tenant_inventory_settings
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_count_sessions_change_pair;
ALTER TABLE tenant_inventory_settings
  ADD CONSTRAINT tenant_inventory_settings_count_sessions_change_pair
    CHECK ((count_sessions_changed_at IS NULL) = (count_sessions_changed_by IS NULL));

COMMIT;

-- Second transaction: validation. The first transaction's exclusive locks are released at its COMMIT, so
-- these scans hold only SHARE UPDATE EXCLUSIVE (readers and writers go on); they never extend the
-- schema-change window. The unique chunk index is its own CONCURRENTLY migration (0117, single statement). Every existing row is a
-- sale row with the chunk columns NULL, so validation always passes. A failed validation leaves the
-- constraints NOT VALID and the migration re-runnable (each ADD is preceded by its own DROP IF EXISTS).
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE erpnext_posting_status VALIDATE CONSTRAINT erpnext_posting_status_kind_valid;
ALTER TABLE erpnext_posting_status VALIDATE CONSTRAINT erpnext_posting_status_status_valid;
ALTER TABLE erpnext_posting_status VALIDATE CONSTRAINT erpnext_posting_status_count_shape;
ALTER TABLE erpnext_posting_status VALIDATE CONSTRAINT erpnext_posting_status_count_chunk_bounds;
ALTER TABLE erpnext_posting_status VALIDATE CONSTRAINT erpnext_posting_status_count_datetime_format;
ALTER TABLE erpnext_posting_status VALIDATE CONSTRAINT erpnext_posting_status_noop_only_count;
ALTER TABLE erpnext_posting_status VALIDATE CONSTRAINT fk_erpnext_posting_status_count_session;

ALTER TABLE inventory_effect_integration VALIDATE CONSTRAINT inventory_effect_integration_confirmed_document;

COMMIT;
