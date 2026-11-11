-- 0093_sale_quarantine_items.sql
--
-- POS sale quarantine store (Jira RT-1312 Phase 3(b); RT-1124 F1 and F20,
-- RT-1125 R-02; owner decision D1, RT-1312 comment 16359).
-- [GATED] migration, authorized by RT-1312 Phase 3 item 1(b) ("[GATED:
-- migration] expected") and the owner's go for Phase 3(b) in chat on
-- 2026-11-11.
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/pos-sales/sale-quarantine.yaml 1.0.0-draft
--     (`posQuarantineSale`)
--   - packages/contracts/openapi/sale-sync-ops/sale-sync-ops.yaml 1.3.0-draft
--     (`consoleListQuarantinedSales`, `consoleGetQuarantinedSale`,
--     `consoleRepairQuarantinedSale`, `consoleWriteOffQuarantinedSale`)
--   - packages/db/__tests__/migration/0093-sale-quarantine-items.spec.ts
--
-- One new table, `sale_quarantine_items`: one row per sale the till could not
-- get captured (refused for good by `captureSale`, or held after a re-pair)
-- and uploaded for a Console repair. `id` IS the contract's `quarantineRef`
-- (UUIDv7, supplied by the runtime; the default is only a fallback).
--
--   Provenance       (tenant_id, source_system, external_id) is UNIQUE: the
--                    upload's natural key, the same dedup key as `sales`
--                    (FR-050). Tenant-wide, not per store: an upload of a
--                    provenance another store quarantined is the
--                    non-disclosing 409 `quarantine_conflict`.
--   The till's claim reason_kind, till_http_status, till_error_code,
--                    till_recorded_at, previous_terminal_id and
--                    idempotency_key are recorded as uploaded (first upload
--                    wins) and never trusted for any decision. The CHECKs
--                    mirror the contract's QuarantineReason rules.
--   The body         sale_body is the capture body, stored verbatim (a JSON
--                    object; not validated as a capture request).
--                    facts_digest is the sha256 hex of its sale facts (the
--                    RT-1206 rule: the body without the fields capture leaves
--                    out of payload_hash), so the same-facts check of a repeat
--                    upload still works after the body is purged. The
--                    summary_* columns are read from the body at upload
--                    (decision C5) and stay after a purge.
--   State            open -> captured | already-captured | written-off, for
--                    good. resolved_at is set exactly when not open; sale_id
--                    exactly when captured or already-captured;
--                    write_off_note exactly when written-off. The body may be
--                    purged (sale_body NULL, body_purged_at set) only on a
--                    captured or already-captured item (decision P3: an open
--                    or written-off item keeps it).
--   Repairs          repair_count and the last_repair_* columns (set together;
--                    a status or code only on a `refused` outcome).
--   Conflicts        upload_conflict_count: same-store uploads of the
--                    provenance whose facts differed.
--
-- Cross-tenant and cross-store integrity: composite FKs pin every reference to
-- the row's tenant AND store: (tenant_id, store_id) -> stores,
-- (device_id, tenant_id, store_id) and (previous_terminal_id, tenant_id,
-- store_id) -> devices (id, tenant_id, store_id), and (sale_id, tenant_id,
-- store_id) -> sales (id, tenant_id, store_id). A NULL previous_terminal_id or
-- sale_id skips its composite FK (MATCH SIMPLE). The devices FKs do not look at
-- revoked_at: the earlier pairing is usually revoked, and naming it is a
-- historical fact.
--
-- RLS: ENABLE + FORCE. SELECT, INSERT and UPDATE tenant policies (an upload
-- conflict, a repair and a write-off are UPDATEs). NO DELETE policy.
--
-- Grants: none here. Production grants the domain role SELECT and INSERT, and
-- column-level UPDATE on the mutable columns, outside migrations:
-- docs/operations/sql/sale-quarantine-items-domain-grants.sql (deploy/README.md
-- step 2). The API refuses to boot without them (DOMAIN_REQUIRED_GRANTS,
-- apps/api/src/auth/grants/).
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / section XIV): BUSINESS-CLASS with
-- monetary and possibly personal data INSIDE sale_body (line amounts, tenders,
-- payer references, the receipt operator name), as on the capture request it
-- copies. Retention (decision P3): an open item keeps its body indefinitely; a
-- captured or already-captured item has it purged 30 days after resolution
-- (the sale fact is then the record); a written-off item keeps it under the
-- normal audit retention (for a paid sale never recorded it is the only
-- evidence). Item metadata (no body) follows the audit retention. The purge job
-- is not part of this migration.
--
-- Deploy window: none. The table is new and empty; nothing writes it until the
-- quarantine runtime ships with it. Apply 0093 and the grants script before
-- the API that uses them rolls out (migrate is step 1, grants step 2).
--
-- Lock impact: ONE transaction. The table is created empty. The FKs take SHARE
-- ROW EXCLUSIVE on `tenants`, `stores`, `devices` and `sales` while the
-- migration commits; nothing is rewritten. Well under a second (lock_timeout
-- 2s).
--
-- Reversal: 0093_sale_quarantine_items.down.sql REFUSES while any item exists;
-- otherwise it drops the table.

BEGIN;

SET LOCAL lock_timeout = '2s';

CREATE TABLE sale_quarantine_items (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id                 UUID         NOT NULL,
  device_id                UUID         NOT NULL,
  previous_terminal_id     UUID         NULL,
  source_system            TEXT         NOT NULL,
  external_id              TEXT         NOT NULL,
  idempotency_key          TEXT         NOT NULL,
  reason_kind              TEXT         NOT NULL,
  till_http_status         INTEGER      NULL,
  till_error_code          TEXT         NULL,
  till_recorded_at         TIMESTAMPTZ  NOT NULL,
  received_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  sale_body                JSONB        NULL,
  body_purged_at           TIMESTAMPTZ  NULL,
  facts_digest             TEXT         NOT NULL,
  summary_occurred_at      TIMESTAMPTZ  NULL,
  summary_pos_total        TEXT         NULL,
  summary_currency_code    TEXT         NULL,
  summary_line_count       INTEGER      NULL,
  state                    TEXT         NOT NULL DEFAULT 'open',
  resolved_at              TIMESTAMPTZ  NULL,
  repair_count             INTEGER      NOT NULL DEFAULT 0,
  last_repair_at           TIMESTAMPTZ  NULL,
  last_repair_outcome      TEXT         NULL,
  last_repair_http_status  INTEGER      NULL,
  last_repair_error_code   TEXT         NULL,
  upload_conflict_count    INTEGER      NOT NULL DEFAULT 0,
  sale_id                  UUID         NULL,
  write_off_note           TEXT         NULL,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Bounded text, as on the contract.
  CONSTRAINT sale_quarantine_items_source_system_len
    CHECK (char_length(source_system) BETWEEN 1 AND 100),
  CONSTRAINT sale_quarantine_items_external_id_len
    CHECK (char_length(external_id) BETWEEN 1 AND 200),
  CONSTRAINT sale_quarantine_items_idempotency_key_format
    CHECK (idempotency_key ~ '^[\x21-\x7E]{16,128}$'),

  -- The till's claim (QuarantineReason).
  CONSTRAINT sale_quarantine_items_reason_kind
    CHECK (reason_kind IN ('refused', 'payload_divergence', 'cashier_claim_refused', 'held_previous_pairing')),
  CONSTRAINT sale_quarantine_items_till_http_status
    CHECK (till_http_status IS NULL
           OR (till_http_status BETWEEN 400 AND 499 AND till_http_status NOT IN (401, 425, 429))),
  CONSTRAINT sale_quarantine_items_till_error_code_format
    CHECK (till_error_code IS NULL OR till_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT sale_quarantine_items_held_rules
    CHECK (reason_kind <> 'held_previous_pairing'
           OR (till_http_status IS NULL AND till_error_code IS NULL AND previous_terminal_id IS NOT NULL)),
  CONSTRAINT sale_quarantine_items_divergence_status
    CHECK (reason_kind <> 'payload_divergence' OR till_http_status IS NULL OR till_http_status = 409),
  CONSTRAINT sale_quarantine_items_claim_refused_status
    CHECK (reason_kind <> 'cashier_claim_refused' OR till_http_status IS NULL OR till_http_status = 403),

  -- The body, its digest and summary.
  CONSTRAINT sale_quarantine_items_body_object
    CHECK (sale_body IS NULL OR jsonb_typeof(sale_body) = 'object'),
  CONSTRAINT sale_quarantine_items_body_purged
    CHECK ((sale_body IS NULL) = (body_purged_at IS NOT NULL)),
  CONSTRAINT sale_quarantine_items_body_kept_unless_captured
    CHECK (sale_body IS NOT NULL OR state IN ('captured', 'already-captured')),
  CONSTRAINT sale_quarantine_items_facts_digest_format
    CHECK (facts_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sale_quarantine_items_summary_pos_total_format
    CHECK (summary_pos_total IS NULL OR summary_pos_total ~ '^[0-9]{1,15}(\.[0-9]{1,4})?$'),
  CONSTRAINT sale_quarantine_items_summary_currency_format
    CHECK (summary_currency_code IS NULL OR summary_currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT sale_quarantine_items_summary_line_count
    CHECK (summary_line_count IS NULL OR summary_line_count >= 0),

  -- The state machine.
  CONSTRAINT sale_quarantine_items_state
    CHECK (state IN ('open', 'captured', 'already-captured', 'written-off')),
  CONSTRAINT sale_quarantine_items_resolved
    CHECK ((state = 'open') = (resolved_at IS NULL)),
  CONSTRAINT sale_quarantine_items_resolved_after_received
    CHECK (resolved_at IS NULL OR resolved_at >= received_at),
  CONSTRAINT sale_quarantine_items_sale
    CHECK ((sale_id IS NOT NULL) = (state IN ('captured', 'already-captured'))),
  CONSTRAINT sale_quarantine_items_write_off
    CHECK ((write_off_note IS NOT NULL) = (state = 'written-off')),
  CONSTRAINT sale_quarantine_items_write_off_note_len
    CHECK (write_off_note IS NULL OR char_length(write_off_note) BETWEEN 1 AND 500),

  -- Repairs.
  CONSTRAINT sale_quarantine_items_repair_count
    CHECK (repair_count >= 0),
  CONSTRAINT sale_quarantine_items_last_repair_set
    CHECK ((repair_count > 0) = (last_repair_at IS NOT NULL)
           AND (last_repair_at IS NULL) = (last_repair_outcome IS NULL)),
  CONSTRAINT sale_quarantine_items_last_repair_outcome
    CHECK (last_repair_outcome IS NULL OR last_repair_outcome IN ('captured', 'already-captured', 'refused')),
  CONSTRAINT sale_quarantine_items_last_repair_detail
    CHECK (last_repair_outcome = 'refused'
           OR (last_repair_http_status IS NULL AND last_repair_error_code IS NULL)),
  CONSTRAINT sale_quarantine_items_last_repair_http_status
    CHECK (last_repair_http_status IS NULL OR last_repair_http_status BETWEEN 400 AND 499),
  CONSTRAINT sale_quarantine_items_last_repair_error_code_format
    CHECK (last_repair_error_code IS NULL OR last_repair_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),

  CONSTRAINT sale_quarantine_items_upload_conflict_count
    CHECK (upload_conflict_count >= 0),

  -- Every reference pinned to the row's tenant and store.
  CONSTRAINT fk_sale_quarantine_items_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sale_quarantine_items_device_store_tenant
    FOREIGN KEY (device_id, tenant_id, store_id) REFERENCES devices (id, tenant_id, store_id) ON DELETE RESTRICT,
  -- Skipped while previous_terminal_id is NULL (MATCH SIMPLE).
  CONSTRAINT fk_sale_quarantine_items_previous_terminal_store_tenant
    FOREIGN KEY (previous_terminal_id, tenant_id, store_id) REFERENCES devices (id, tenant_id, store_id) ON DELETE RESTRICT,
  -- Skipped while sale_id is NULL (MATCH SIMPLE).
  CONSTRAINT fk_sale_quarantine_items_sale_store_tenant
    FOREIGN KEY (sale_id, tenant_id, store_id) REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT,

  CONSTRAINT sale_quarantine_items_tenant_id_uk UNIQUE (tenant_id, id),
  -- The upload's natural key (FR-050 provenance), tenant-wide.
  CONSTRAINT sale_quarantine_items_tenant_provenance_uk UNIQUE (tenant_id, source_system, external_id)
);

-- The Console list: a tenant's items in one state, newest-first by id (UUIDv7).
CREATE INDEX idx_sale_quarantine_items_tenant_state_id
  ON sale_quarantine_items (tenant_id, state, id DESC);

CREATE TRIGGER sale_quarantine_items_set_updated_at BEFORE UPDATE ON sale_quarantine_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE sale_quarantine_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_quarantine_items FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_quarantine_items_tenant_select ON sale_quarantine_items
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY sale_quarantine_items_tenant_insert ON sale_quarantine_items
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY sale_quarantine_items_tenant_update ON sale_quarantine_items
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

COMMIT;
