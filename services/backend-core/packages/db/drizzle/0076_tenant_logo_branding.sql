-- 0076_tenant_logo_branding.sql
--
-- RT-473 S2 (spec 039, RT-472) — `[GATED]` migration. Owner approval: spec 039
-- OD-1 (RT-472 comment 11856, 2026-10-13; reconfirmed RT-473 comment 12971).
-- It was approved as "0046"; that number was taken by later work, so it lands
-- here with the approved content (RT-473 comment 14883). Applying it to a lab
-- or live database is NOT authorized by this change.
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/tenant-branding.openapi.yaml (RT-473 S1)
--   - specs/039-tenant-logo-branding/ (FR-01 … FR-18, OD-1, OD-15)
--   - packages/db/src/schema/tenant-branding.ts
--   - packages/db/__tests__/migration/0076-tenant-logo-branding.spec.ts
--
-- Creates THREE tables (OD-1: Postgres bytea, about 150 KB per tenant):
--
--   tenant_branding_revisions  the per-tenant monotonic write counter
--                              (FR-14a, OD-15). No row = revision 0. Created
--                              by the first write and KEPT across logo
--                              removal, so a revision never repeats. Each
--                              update moves it up by exactly one (trigger).
--   tenant_logos               one logo per tenant (D-1): the normalized
--                              master PNG, its content version (FR-13), the
--                              pipeline version, presentation and warnings.
--   tenant_logo_renditions     the 8 screen renditions (4 slots × 2 scales)
--                              and the 1 receipt rendition of a logo. Deleted
--                              with their logo (ON DELETE CASCADE).
--
-- Only server re-encoded PNG bytes are stored: the original upload and any SVG
-- are never kept (FR-07, §6 privacy). The bytea columns are size-bounded.
--
-- RLS: ENABLE + FORCE on all three, tenant policies on the empty-GUC CASE
-- guard (a bare ::uuid cast throws 22P02 on an unset GUC).
--   * tenant_branding_revisions: SELECT, INSERT, UPDATE. NO DELETE policy.
--   * tenant_logos, tenant_logo_renditions: SELECT, INSERT, UPDATE, DELETE
--     (remove deletes the logo; the cascade removes its renditions).
-- The writes serialize per tenant on a transaction-level advisory lock taken
-- by the API (no table lock and no grant on `tenants` beyond SELECT).
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS tenant configuration: a logo image (re-encoded, every
-- metadata chunk stripped), hashes, dimensions and an enum warning list. NO
-- PII, NO money, NO secret, NO file name. Retained while the tenant keeps the
-- logo; removed by the Console remove operation.
-- ---------------------------------------------------------------------------
--
-- Reversal: 0076_tenant_logo_branding.down.sql drops ONLY these three tables
-- and their trigger function, and so DISCARDS every stored logo and revision.
--
-- Runtime grants are provisioned outside migrations:
-- docs/operations/sql/tenant-branding-domain-grants.sql (step 2 of
-- deploy/README.md), BEFORE the API that needs it starts.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_branding_revisions (
  tenant_id   UUID         PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  revision    BIGINT       NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tenant_branding_revisions_revision_positive CHECK (revision >= 1)
);

CREATE TABLE IF NOT EXISTS tenant_logos (
  tenant_id          UUID         PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  version            TEXT         NOT NULL,
  pipeline_version   TEXT         NOT NULL,
  master_png         BYTEA        NOT NULL,
  master_width       INTEGER      NOT NULL,
  master_height      INTEGER      NOT NULL,
  presentation_card  BOOLEAN      NOT NULL,
  warnings           TEXT[]       NOT NULL DEFAULT '{}',
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tenant_logos_version_shape CHECK (version ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_logos_pipeline_version_shape CHECK (pipeline_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT tenant_logos_master_png_size CHECK (octet_length(master_png) BETWEEN 1 AND 8388608),
  CONSTRAINT tenant_logos_master_dimensions CHECK (master_width BETWEEN 1 AND 4096 AND master_height BETWEEN 1 AND 4096),
  CONSTRAINT tenant_logos_warnings_known CHECK (
    warnings <@ ARRAY['low_contrast', 'receipt_high_black_coverage', 'receipt_thin_strokes']::text[]
    AND array_position(warnings, NULL) IS NULL
  )
);

CREATE TABLE IF NOT EXISTS tenant_logo_renditions (
  tenant_id   UUID         NOT NULL REFERENCES tenant_logos(tenant_id) ON DELETE CASCADE,
  kind        TEXT         NOT NULL,
  scale       SMALLINT     NOT NULL,
  width_px    INTEGER      NOT NULL,
  height_px   INTEGER      NOT NULL,
  -- The receipt's printer dpi (OD-8); NULL for a screen rendition.
  dpi         SMALLINT,
  png         BYTEA        NOT NULL,
  PRIMARY KEY (tenant_id, kind, scale),
  CONSTRAINT tenant_logo_renditions_kind_valid CHECK (kind IN ('boot', 'pairing', 'sign_in', 'lock', 'receipt')),
  CONSTRAINT tenant_logo_renditions_scale_valid CHECK (
    (kind = 'receipt' AND scale = 1) OR (kind <> 'receipt' AND scale IN (1, 2))
  ),
  CONSTRAINT tenant_logo_renditions_dpi_iff_receipt CHECK ((kind = 'receipt') = (dpi IS NOT NULL)),
  CONSTRAINT tenant_logo_renditions_dpi_range CHECK (dpi IS NULL OR dpi BETWEEN 100 AND 600),
  CONSTRAINT tenant_logo_renditions_dimensions CHECK (width_px BETWEEN 1 AND 4096 AND height_px BETWEEN 1 AND 4096),
  CONSTRAINT tenant_logo_renditions_png_size CHECK (octet_length(png) BETWEEN 1 AND 4194304)
);

-- A revision only ever moves up by one, on the same tenant (FR-14a). The
-- application never deletes a revision row (there is no DELETE policy).
CREATE OR REPLACE FUNCTION tenant_branding_revisions_monotonic() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'tenant_branding_revisions: a revision only moves up by one (% -> %)', OLD.revision, NEW.revision
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tenant_branding_revisions_monotonic
  BEFORE UPDATE ON tenant_branding_revisions
  FOR EACH ROW EXECUTE FUNCTION tenant_branding_revisions_monotonic();

ALTER TABLE tenant_branding_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_branding_revisions FORCE  ROW LEVEL SECURITY;
ALTER TABLE tenant_logos ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_logos FORCE  ROW LEVEL SECURITY;
ALTER TABLE tenant_logo_renditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_logo_renditions FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_branding_revisions_tenant_select ON tenant_branding_revisions
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY tenant_branding_revisions_tenant_insert ON tenant_branding_revisions
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY tenant_branding_revisions_tenant_update ON tenant_branding_revisions
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY tenant_logos_tenant_select ON tenant_logos
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY tenant_logos_tenant_insert ON tenant_logos
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY tenant_logos_tenant_update ON tenant_logos
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY tenant_logos_tenant_delete ON tenant_logos
  FOR DELETE USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY tenant_logo_renditions_tenant_select ON tenant_logo_renditions
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY tenant_logo_renditions_tenant_insert ON tenant_logo_renditions
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY tenant_logo_renditions_tenant_update ON tenant_logo_renditions
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY tenant_logo_renditions_tenant_delete ON tenant_logo_renditions
  FOR DELETE USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

COMMIT;
