-- 0122_sale_line_pricing_provenance.sql
--
-- Sale-line pricing provenance (Jira RT-1151, RT-282 PR-07). [GATED:
-- migration], authorized by the owner on RT-1151 (D1, D3, D4; comment 17783).
-- Depends on 0100 (the sale_lines (id, sale_id, tenant_id, store_id) key) and
-- follows 0121 (the Retail Pricing core).
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/pos-sales/sales.yaml 1.25.0-draft:
--     `CaptureSaleLine.pricingProvenance`, `PricingProvenance` (the union
--     shared with pricing/price-inquiry.yaml and the POS read-down)
--   - docs/planning/rt-282-pricing-backlog-draft.md PR-07; specs/043 G4-11;
--     specs/041-pricing-domain/rt-1151-implementation-plan.md §5
--   - packages/db/__tests__/migration/0122-sale-line-pricing-provenance.spec.ts
--
-- One new table, sale_line_pricing_provenance: at most one row per sale line,
-- the provenance the till sent with it, stored VERBATIM at capture (owner D3:
-- persisted when present, nothing when absent; never recomputed). APPEND-ONLY
-- for every role: a sale fact is never changed. It is a separate 1:1 table
-- (the 0101 sale_line_promotions pattern) instead of new sale_lines columns, so
-- the hot sale_lines table takes no DDL and no default-value rewrite.
--
-- What it does NOT check (by design, decision 611 / spec 043 G4-13): that the
-- cited price event or revision exists, or that it priced the line at
-- unit_price. A till may sell from a cached revision while offline; a mismatch
-- is an asynchronous Pricing Health finding, never a refused sale. So there is
-- no FK to price_events or pricing_revisions.
--
-- RLS: ENABLE + FORCE with tenant SELECT and INSERT policies (the empty-GUC CASE
-- of 0010 / 0091 / 0097 / 0101 / 0121). No UPDATE or DELETE policy.
--
-- Grants: none here. Production grants the domain role SELECT and INSERT
-- outside migrations: docs/operations/sql/sale-line-pricing-provenance-domain-grants.sql
-- (deploy/README.md step 2). The API refuses to boot without them
-- (DOMAIN_REQUIRED_GRANTS, apps/api/src/auth/grants/sale-line-pricing-provenance.grants.ts).
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS. Enums, opaque
-- UUIDs, a revision number and an opaque catalogue cursor. No customer
-- reference. Retention inherits the sales posture: sale facts are never
-- deleted.
--
-- Deploy window: none. The table is new and empty; no existing table changes.
-- Apply 0122 and the grants script before the API that writes it (migrate is
-- step 1, grants step 2).
--
-- Lock impact: ONE transaction, lock_timeout 2s. The new FK takes SHARE ROW
-- EXCLUSIVE on sale_lines until COMMIT: sale capture waits for the rest of this
-- transaction (milliseconds; the new table is empty, so no validation scan).
-- Reads continue.
--
-- Reversal: 0122_sale_line_pricing_provenance.down.sql REFUSES while any row
-- exists; otherwise it drops the table and its function.

BEGIN;

SET LOCAL lock_timeout = '2s';

CREATE TABLE sale_line_pricing_provenance (
  sale_line_id      UUID         PRIMARY KEY,
  sale_id           UUID         NOT NULL,
  tenant_id         UUID         NOT NULL,
  store_id          UUID         NOT NULL,
  origin            TEXT         NOT NULL,
  source_scope      TEXT         NOT NULL,
  -- origin = pricing only.
  price_event_id    UUID         NULL,
  price_kind        TEXT         NULL,
  pricing_revision  BIGINT       NULL,
  -- origin = legacy only.
  catalog_cursor    TEXT         NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- A line of the same sale, store and tenant (the 0100 key).
  CONSTRAINT fk_sale_line_pricing_provenance_line
    FOREIGN KEY (sale_line_id, sale_id, tenant_id, store_id)
    REFERENCES sale_lines (id, sale_id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT sale_line_pricing_provenance_origin CHECK (origin IN ('pricing', 'legacy')),
  -- Exactly one variant of the union, and nothing of the other (RT-282 PR-06/PR-07).
  CONSTRAINT sale_line_pricing_provenance_variant CHECK (
    (origin = 'pricing'
       AND source_scope IN ('book', 'zone', 'store')
       AND price_event_id IS NOT NULL
       AND price_kind IN ('regular')
       AND pricing_revision IS NOT NULL AND pricing_revision >= 1
       AND catalog_cursor IS NULL)
    OR (origin = 'legacy'
       AND source_scope IN ('legacy_tenant', 'legacy_store')
       AND catalog_cursor IS NOT NULL AND char_length(catalog_cursor) BETWEEN 1 AND 128
       AND price_event_id IS NULL AND price_kind IS NULL AND pricing_revision IS NULL))
);

-- readSale and Pricing Health: the provenance of a sale's lines.
CREATE INDEX idx_sale_line_pricing_provenance_tenant_sale
  ON sale_line_pricing_provenance (tenant_id, sale_id);

-- Refuses UPDATE, DELETE and TRUNCATE for every role: a sale fact never changes.
CREATE FUNCTION sale_line_pricing_provenance_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'A sale line''s pricing provenance is a frozen sale fact (RT-1151, RT-282 PR-07).';
END
$$;

CREATE TRIGGER sale_line_pricing_provenance_append_only_row
  BEFORE UPDATE OR DELETE ON sale_line_pricing_provenance
  FOR EACH ROW EXECUTE FUNCTION sale_line_pricing_provenance_append_only();
CREATE TRIGGER sale_line_pricing_provenance_append_only_truncate
  BEFORE TRUNCATE ON sale_line_pricing_provenance
  FOR EACH STATEMENT EXECUTE FUNCTION sale_line_pricing_provenance_append_only();

DO $$
DECLARE
  -- The empty-GUC CASE guard: '' reads as NULL, never a cast error.
  tenant_match CONSTANT text := 'tenant_id = CASE'
    || ' WHEN current_setting(''app.current_tenant'', true) = '''' THEN NULL'
    || ' ELSE current_setting(''app.current_tenant'', true)::uuid END';
BEGIN
  ALTER TABLE sale_line_pricing_provenance ENABLE ROW LEVEL SECURITY;
  ALTER TABLE sale_line_pricing_provenance FORCE ROW LEVEL SECURITY;
  EXECUTE format('CREATE POLICY sale_line_pricing_provenance_tenant_select ON sale_line_pricing_provenance FOR SELECT USING (%s)', tenant_match);
  EXECUTE format('CREATE POLICY sale_line_pricing_provenance_tenant_insert ON sale_line_pricing_provenance FOR INSERT WITH CHECK (%s)', tenant_match);
END
$$;

COMMIT;
