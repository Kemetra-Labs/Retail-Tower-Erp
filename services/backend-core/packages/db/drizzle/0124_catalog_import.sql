-- 0124_catalog_import.sql
--
-- Manual product import (CSV / XLSX) staging schema (Jira RT-1503, spec 049
-- slice S2). [GATED: migration], authorized by the owner in the W1 catalogue
-- lead session on 2026-11-19 (plan "RT-1484 + RT-1503", Track B PR-2; RT-1503
-- comments 17823, 17830).
--
-- Source-of-truth artifacts:
--   - services/backend-core/specs/049-manual-product-import/spec.md §8 (batch
--     lifecycle, idempotency, retention), §9.1 (OD-14 A: interim tables, not
--     the pricing change_sets primitive) and §10 (this data model)
--   - contract catalog/catalog-import.yaml (1.0.2-draft, RT-1502)
--   - packages/db/__tests__/migration/0124-catalog-import.spec.ts
--
-- Three new tables. No runtime reads or writes them until RT-1505 / RT-1507;
-- the retention and expiry worker is RT-1503's next PR. No existing table
-- changes.
--
--   catalog_import_mapping_profiles  A tenant's saved column mappings (contract
--                              `saveProfileName`): `entries` maps the exact
--                              trimmed header text to a canonical field or
--                              `ignore`. Unique per (tenant, name); saving
--                              under an existing name is an upsert that keeps
--                              the row's `id` (identity and name never
--                              change, a trigger), so a batch's
--                              `mapping_profile_id` stays valid. An empty or
--                              untrimmed header is refused as a key; a
--                              repeated header is never saved (the runtime
--                              leaves it out: a JSON object cannot hold it).
--   catalog_import_batches     One upload (spec 049 §8.1): the spec 042 §3
--                              state names plus the import-only `expired`,
--                              optimistic `version`, `validation_generation`
--                              (the review-list cursor binding; bumped only by
--                              validate), the file facts (the bytes are never
--                              stored), the header `columns` with samples,
--                              `mapping` / `suggested_mapping` as the
--                              contract's ColumnMapping[] (column number ->
--                              target), the stored `warnings`, `preview_hash`,
--                              `counts`, the stored `publish_summary` (a
--                              publish replay outlives the idempotency TTL),
--                              and the lifecycle instants `expires_at`,
--                              `published_at`, `closed_at`, `rows_purged_at`.
--                              One OPEN batch per tenant (partial unique
--                              index; the upload's 409 import_batch_open).
--                              A batch is created as a draft; identity, mode
--                              and creation facts never change; the version
--                              and the validation generation only move
--                              forward; a closed batch (published, cancelled,
--                              expired) is frozen except for `rows_purged_at`,
--                              set once by the retention purge. Never deleted:
--                              the header is the lasting summary (OD-6).
--   catalog_import_rows        The parsed rows of a batch (OD-6: parsed cell
--                              text only), with the validation outcome, the
--                              issues, `review_reason`, the review decision
--                              and, after publish, the product (provenance,
--                              decision 423). Primary key (tenant_id,
--                              batch_id, row_number), which is also the
--                              keyset order of the review list. Deleted by a
--                              re-upload (the old file's rows) and by the
--                              retention purge; identity and cells never
--                              change.
--
-- Expiry (spec 049 §8.1, §10): `expires_at` is the open batch's last change +
-- 7 days, moved by the runtime on every change and cleared when the batch
-- closes. The worker expires a batch with a conditional UPDATE ... WHERE state
-- IN ('draft', 'validated') AND version = $v AND expires_at <= now(), so a
-- batch changed after it was read is not expired (ix_..._expiry serves it).
--
-- What this migration does NOT enforce (the runtime does; spec 049 §5-§8):
-- the content of `cells`, `outcome`, `issues`, `counts` and `publish_summary`
-- beyond their JSON type; that a mapping names every column once; that a row
-- number is within the batch's data rows; the 7-day arithmetic; the 30-day
-- and 13-month purge ages.
--
-- RLS: ENABLE + FORCE on all three, with tenant policies (the empty-GUC CASE
-- of 0010 / 0091 / 0097 / 0101 / 0121): SELECT, INSERT and UPDATE everywhere;
-- DELETE only on catalog_import_rows (re-upload and the retention purge). NO
-- DELETE policy on the batches (a trigger also refuses DELETE and TRUNCATE for
-- every role) or the mapping profiles.
--
-- Grants: none here. Production grants the domain role SELECT, INSERT and
-- UPDATE on the three tables and DELETE on catalog_import_rows only, outside
-- migrations: docs/operations/sql/catalog-import-domain-grants.sql
-- (deploy/README.md step 2). The API refuses to boot without them
-- (DOMAIN_REQUIRED_GRANTS, apps/api/src/auth/grants/catalog-import.grants.ts).
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS. Catalogue
-- cell text (product names, identifiers, categories, brands, tax categories,
-- prices kept as text and never interpreted), file names, header text,
-- opaque UUIDs (user ids are operational actors), counts and instants. No
-- customer reference. Retention (OD-6): rows of a cancelled or expired batch
-- are deleted 30 days after it closed, rows of a published batch 13 months
-- after publish; the batch header stays.
--
-- Deploy window: none. Every table is new and empty, and no existing table
-- changes. Apply 0124 and the grants script before the API that uses them
-- (migrate is step 1, grants step 2).
--
-- Lock impact: ONE transaction, lock_timeout 2s. The new FKs take SHARE ROW
-- EXCLUSIVE on tenants and tenant_products until COMMIT (writes to them wait
-- for the rest of this transaction, well under a second; the new tables are
-- empty, so there is no validation scan). Reads continue.
--
-- Reversal: 0124_catalog_import.down.sql REFUSES while any batch or mapping
-- profile exists (every row needs a batch); otherwise it drops the three
-- tables and their functions.

BEGIN;

SET LOCAL lock_timeout = '2s';

-- =============================================================================
-- 1. catalog_import_mapping_profiles
-- =============================================================================

CREATE TABLE catalog_import_mapping_profiles (
  id          UUID         PRIMARY KEY,
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name        TEXT         NOT NULL,
  -- {"<exact trimmed header text>": "<canonical field>" | "ignore", ...}
  entries     JSONB        NOT NULL,
  created_by  UUID         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by  UUID         NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Contract saveProfileName: 1-100 characters, at least one non-whitespace.
  CONSTRAINT catalog_import_mapping_profiles_name
    CHECK (char_length(name) BETWEEN 1 AND 100 AND name ~ '\S'),
  CONSTRAINT catalog_import_mapping_profiles_entries_object CHECK (jsonb_typeof(entries) = 'object'),
  CONSTRAINT catalog_import_mapping_profiles_entries_count
    CHECK (jsonb_typeof(entries) <> 'object'
           OR jsonb_array_length(jsonb_path_query_array(entries, '$.*')) BETWEEN 1 AND 50),
  -- A key is a header's exact trimmed text: never empty, never with leading or trailing whitespace.
  CONSTRAINT catalog_import_mapping_profiles_entries_keys
    CHECK (NOT jsonb_path_exists(entries, '$.keyvalue() ? (@.key == "" || @.key like_regex "^\\s|\\s$")')),
  CONSTRAINT catalog_import_mapping_profiles_entries_targets
    CHECK (NOT jsonb_path_exists(entries,
      '$.* ? (!(@.type() == "string" && @ like_regex "^(sku|barcode|plu|name|description|category|brand|tax_category|is_active|price|currency|ignore)$"))')),
  CONSTRAINT catalog_import_mapping_profiles_tenant_name_uk UNIQUE (tenant_id, name),
  -- Composite FK target: a batch names a profile of its own tenant.
  CONSTRAINT catalog_import_mapping_profiles_tenant_id_uk UNIQUE (tenant_id, id)
);

CREATE TRIGGER catalog_import_mapping_profiles_set_updated_at BEFORE UPDATE ON catalog_import_mapping_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- An upsert by name replaces the entries and keeps the row: identity, name and creation facts never change.
CREATE FUNCTION catalog_import_mapping_profiles_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.name <> OLD.name
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'mapping profile %: identity, name and creation facts never change', OLD.id
      USING ERRCODE = 'check_violation',
            HINT = 'Saving under an existing name upserts the entries and keeps the id (spec 049 §10).';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER catalog_import_mapping_profiles_guard BEFORE UPDATE ON catalog_import_mapping_profiles
  FOR EACH ROW EXECUTE FUNCTION catalog_import_mapping_profiles_guard();

-- =============================================================================
-- 2. catalog_import_batches
-- =============================================================================

CREATE TABLE catalog_import_batches (
  id                     UUID         PRIMARY KEY,
  tenant_id              UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  state                  TEXT         NOT NULL DEFAULT 'draft',
  version                INTEGER      NOT NULL DEFAULT 1,
  -- Bumped only by validate; the review-list cursor is bound to it, never to version (§8.1).
  validation_generation  INTEGER      NOT NULL DEFAULT 0,
  mode                   TEXT         NOT NULL,
  -- File facts (the bytes are never stored, OD-6).
  file_name              TEXT         NULL,
  file_size              INTEGER      NOT NULL,
  file_sha256            TEXT         NOT NULL,
  file_kind              TEXT         NOT NULL,
  sheet_name             TEXT         NULL,
  csv_delimiter          TEXT         NULL,
  data_row_count         INTEGER      NOT NULL,
  column_count           INTEGER      NOT NULL,
  parser_version         TEXT         NOT NULL,
  -- The contract's ImportColumn[]: header text and up to three samples per column.
  columns                JSONB        NOT NULL,
  -- The contract's ColumnMapping[] ({columnNumber, target}); NULL until confirmed and again after a re-upload.
  mapping                JSONB        NULL,
  -- Stored, not recomputed on read: what the merchant was shown (§10).
  suggested_mapping      JSONB        NOT NULL DEFAULT '[]',
  mapping_profile_id     UUID         NULL,
  -- The contract's BatchWarning[], set at upload and re-upload; never names this batch.
  warnings               JSONB        NOT NULL DEFAULT '[]',
  preview_hash           TEXT         NULL,
  counts                 JSONB        NULL,
  -- Stored at publish (the replay outlives the idempotency-key TTL, §8.4).
  publish_summary        JSONB        NULL,
  created_by             UUID         NOT NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- An open draft / validated batch's last change + 7 days; NULL once closed.
  expires_at             TIMESTAMPTZ  NULL,
  published_at           TIMESTAMPTZ  NULL,
  -- Set by publish, cancel or expire.
  closed_at              TIMESTAMPTZ  NULL,
  -- Set once by the retention purge when it deletes the batch's rows.
  rows_purged_at         TIMESTAMPTZ  NULL,
  CONSTRAINT catalog_import_batches_state CHECK (state IN (
    'draft', 'validated', 'pending_approval', 'approved', 'published', 'cancelled', 'expired')),
  CONSTRAINT catalog_import_batches_version_positive CHECK (version >= 1),
  CONSTRAINT catalog_import_batches_validation_generation CHECK (validation_generation >= 0),
  CONSTRAINT catalog_import_batches_mode CHECK (mode IN ('create', 'update', 'upsert')),
  CONSTRAINT catalog_import_batches_file_name CHECK (
    file_name IS NULL OR (char_length(file_name) BETWEEN 1 AND 255 AND file_name !~ '[\x01-\x1f\x7f/\\]')),
  CONSTRAINT catalog_import_batches_file_size CHECK (file_size BETWEEN 1 AND 5242880),
  CONSTRAINT catalog_import_batches_file_sha256 CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT catalog_import_batches_file_kind CHECK (file_kind IN ('csv', 'xlsx')),
  -- XLSX names the sheet read and has no delimiter; CSV the reverse.
  CONSTRAINT catalog_import_batches_sheet_name CHECK (
    (file_kind = 'xlsx') = (sheet_name IS NOT NULL) AND (sheet_name IS NULL OR char_length(sheet_name) BETWEEN 1 AND 31)),
  CONSTRAINT catalog_import_batches_csv_delimiter CHECK (
    (file_kind = 'csv') = (csv_delimiter IS NOT NULL)
    AND (csv_delimiter IS NULL OR csv_delimiter IN ('comma', 'semicolon', 'tab'))),
  CONSTRAINT catalog_import_batches_data_row_count CHECK (data_row_count BETWEEN 1 AND 5000),
  CONSTRAINT catalog_import_batches_column_count CHECK (column_count BETWEEN 1 AND 50),
  CONSTRAINT catalog_import_batches_parser_version CHECK (char_length(parser_version) >= 1),
  CONSTRAINT catalog_import_batches_columns CHECK (
    jsonb_typeof(columns) = 'array' AND jsonb_array_length(columns) = column_count),
  -- ColumnMapping[]: each entry {columnNumber: integer 1..50, target: a canonical field or "ignore"}.
  CONSTRAINT catalog_import_batches_mapping CHECK (
    mapping IS NULL OR (
      jsonb_typeof(mapping) = 'array' AND jsonb_array_length(mapping) BETWEEN 1 AND 50
      AND NOT jsonb_path_exists(mapping, '$[*] ? (!(exists(@.columnNumber) && @.columnNumber.type() == "number"
            && @.columnNumber >= 1 && @.columnNumber <= 50 && @.columnNumber.floor() == @.columnNumber
            && @.target.type() == "string"
            && @.target like_regex "^(sku|barcode|plu|name|description|category|brand|tax_category|is_active|price|currency|ignore)$"))'))),
  CONSTRAINT catalog_import_batches_suggested_mapping CHECK (
    jsonb_typeof(suggested_mapping) = 'array' AND jsonb_array_length(suggested_mapping) <= 50
    AND NOT jsonb_path_exists(suggested_mapping, '$[*] ? (!(exists(@.columnNumber) && @.columnNumber.type() == "number"
          && @.columnNumber >= 1 && @.columnNumber <= 50 && @.columnNumber.floor() == @.columnNumber
          && @.target.type() == "string"
          && @.target like_regex "^(sku|barcode|plu|name|description|category|brand|tax_category|is_active|price|currency|ignore)$"))')),
  CONSTRAINT catalog_import_batches_warnings CHECK (jsonb_typeof(warnings) = 'array'),
  CONSTRAINT catalog_import_batches_counts CHECK (counts IS NULL OR jsonb_typeof(counts) = 'object'),
  CONSTRAINT catalog_import_batches_publish_summary CHECK (publish_summary IS NULL OR jsonb_typeof(publish_summary) = 'object'),
  CONSTRAINT catalog_import_batches_preview_hash_format
    CHECK (preview_hash IS NULL OR preview_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- Contract: previewHash is set when validated or published (and in the reserved approval states), NULL otherwise.
  CONSTRAINT catalog_import_batches_preview_hash_state CHECK (
    (state IN ('validated', 'pending_approval', 'approved', 'published')) = (preview_hash IS NOT NULL)),
  -- A validated (or later) batch has a confirmed mapping, counts and a validation generation.
  CONSTRAINT catalog_import_batches_validated_whole CHECK (
    state NOT IN ('validated', 'pending_approval', 'approved', 'published')
    OR (mapping IS NOT NULL AND counts IS NOT NULL AND validation_generation >= 1)),
  CONSTRAINT catalog_import_batches_published CHECK (
    (state = 'published') = (published_at IS NOT NULL)
    AND (state = 'published') = (publish_summary IS NOT NULL)),
  -- Open = draft, validated or the reserved approval states; closed = published, cancelled, expired.
  CONSTRAINT catalog_import_batches_closed CHECK (
    (state IN ('published', 'cancelled', 'expired')) = (closed_at IS NOT NULL)),
  -- Only an open draft / validated batch can expire; closing clears expires_at.
  CONSTRAINT catalog_import_batches_expires_at CHECK ((state IN ('draft', 'validated')) = (expires_at IS NOT NULL)),
  CONSTRAINT catalog_import_batches_rows_purged CHECK (
    rows_purged_at IS NULL OR (closed_at IS NOT NULL AND rows_purged_at >= closed_at)),
  -- Composite FK target: every row is pinned to its batch's tenant.
  CONSTRAINT catalog_import_batches_tenant_id_uk UNIQUE (tenant_id, id),
  CONSTRAINT catalog_import_batches_mapping_profile_fk FOREIGN KEY (tenant_id, mapping_profile_id)
    REFERENCES catalog_import_mapping_profiles (tenant_id, id) ON DELETE RESTRICT
);

-- One OPEN batch per tenant (§8.1): the upload's 409 import_batch_open. The
-- reserved approval states count as open, so OD-12 needs no schema change.
CREATE UNIQUE INDEX ux_catalog_import_batches_one_open
  ON catalog_import_batches (tenant_id)
  WHERE state IN ('draft', 'validated', 'pending_approval', 'approved');
-- The 30-day file_previously_published warning (§8.4).
CREATE INDEX ix_catalog_import_batches_tenant_sha_published
  ON catalog_import_batches (tenant_id, file_sha256, published_at);
-- The expiry sweep (§8.1, §10): open draft / validated batches by expiry.
CREATE INDEX ix_catalog_import_batches_expiry
  ON catalog_import_batches (expires_at)
  WHERE state IN ('draft', 'validated');

CREATE TRIGGER catalog_import_batches_set_updated_at BEFORE UPDATE ON catalog_import_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION catalog_import_batches_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  -- The stored warnings name other batches only (§8.4: excluding the batch itself).
  IF jsonb_path_exists(NEW.warnings, '$[*] ? (@.publishedBatchId == $id)', jsonb_build_object('id', NEW.id::text)) THEN
    RAISE EXCEPTION 'import batch %: a warning cannot name the batch itself', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' OR NEW.version <> 1 OR NEW.validation_generation <> 0 OR NEW.rows_purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'import batch %: a batch is created as a draft at version 1, never validated, rows not purged', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.mode <> OLD.mode
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'import batch %: identity, mode and creation facts never change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version < OLD.version OR NEW.validation_generation < OLD.validation_generation THEN
    RAISE EXCEPTION 'import batch %: the version and the validation generation only move forward', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- A closed batch is the lasting summary: only the purge's rows_purged_at may be set, once.
  IF OLD.closed_at IS NOT NULL THEN
    IF OLD.rows_purged_at IS NOT NULL AND NEW.rows_purged_at IS DISTINCT FROM OLD.rows_purged_at
       OR (to_jsonb(NEW) - 'rows_purged_at' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'rows_purged_at' - 'updated_at') THEN
      RAISE EXCEPTION 'import batch % is %: only rows_purged_at may be set, once', OLD.id, OLD.state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER catalog_import_batches_guard BEFORE INSERT OR UPDATE ON catalog_import_batches
  FOR EACH ROW EXECUTE FUNCTION catalog_import_batches_guard();

-- Refuses DELETE and TRUNCATE on the batches for every role: the header is
-- the lasting summary of an import (OD-6); only its rows are purged.
CREATE FUNCTION catalog_import_batches_no_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '%: % is not permitted; an import batch is kept as its summary', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Cancel or expire the batch; the retention purge deletes its rows only (spec 049 §10, OD-6).';
END
$$;

CREATE TRIGGER catalog_import_batches_no_delete_row BEFORE DELETE ON catalog_import_batches
  FOR EACH ROW EXECUTE FUNCTION catalog_import_batches_no_delete();
CREATE TRIGGER catalog_import_batches_no_delete_truncate BEFORE TRUNCATE ON catalog_import_batches
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_import_batches_no_delete();

-- =============================================================================
-- 3. catalog_import_rows
-- =============================================================================

CREATE TABLE catalog_import_rows (
  tenant_id              UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  batch_id               UUID         NOT NULL,
  -- The source row number; row 1 is the header row.
  row_number             INTEGER      NOT NULL,
  -- The parsed text of each source column, in column order (NULL for a blank cell).
  cells                  JSONB        NOT NULL,
  -- Set by validate; NULL before the first validation.
  status                 TEXT         NULL,
  -- Match result, candidate product ids, field diff, identifier adds (contract RowOutcome).
  outcome                JSONB        NULL,
  -- The contract's RowIssue[].
  issues                 JSONB        NOT NULL DEFAULT '[]',
  -- The §7.3 reason validation sent the row to review; kept when a decision changes the status.
  review_reason          TEXT         NULL,
  -- The review decision, its product (update_product only), actor and time.
  resolution             TEXT         NULL,
  resolution_product_id  UUID         NULL,
  resolved_by            UUID         NULL,
  resolved_at            TIMESTAMPTZ  NULL,
  -- The matched product's updatedAt at validation (the publish stale re-check, §8.2).
  matched_updated_at     TIMESTAMPTZ  NULL,
  -- After publish: the product the row created or updated (provenance, decision 423).
  product_id             UUID         NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT catalog_import_rows_pk PRIMARY KEY (tenant_id, batch_id, row_number),
  CONSTRAINT catalog_import_rows_row_number CHECK (row_number BETWEEN 2 AND 5001),
  CONSTRAINT catalog_import_rows_cells CHECK (
    jsonb_typeof(cells) = 'array' AND jsonb_array_length(cells) BETWEEN 1 AND 50),
  CONSTRAINT catalog_import_rows_status CHECK (status IS NULL OR status IN (
    'ready_create', 'ready_update', 'unchanged', 'needs_review', 'error', 'excluded')),
  CONSTRAINT catalog_import_rows_outcome CHECK (
    (status IS NULL) = (outcome IS NULL) AND (outcome IS NULL OR jsonb_typeof(outcome) = 'object')),
  CONSTRAINT catalog_import_rows_issues CHECK (jsonb_typeof(issues) = 'array'),
  CONSTRAINT catalog_import_rows_review_reason CHECK (
    review_reason IS NULL OR (status IS NOT NULL AND review_reason IN (
      'ambiguous', 'no_identifier', 'sku_mismatch', 'store_scoped_conflict', 'possible_duplicate'))),
  CONSTRAINT catalog_import_rows_resolution CHECK (
    resolution IS NULL OR (status IS NOT NULL AND resolution IN ('create_new', 'update_product', 'exclude'))),
  CONSTRAINT catalog_import_rows_resolution_whole CHECK (
    (resolution IS NULL) = (resolved_at IS NULL) AND (resolution IS NULL) = (resolved_by IS NULL)
    AND (resolution IS NOT DISTINCT FROM 'update_product') = (resolution_product_id IS NOT NULL)),
  CONSTRAINT catalog_import_rows_batch_fk FOREIGN KEY (tenant_id, batch_id)
    REFERENCES catalog_import_batches (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT catalog_import_rows_resolution_product_fk FOREIGN KEY (resolution_product_id, tenant_id)
    REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT catalog_import_rows_product_fk FOREIGN KEY (product_id, tenant_id)
    REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT
);

CREATE TRIGGER catalog_import_rows_set_updated_at BEFORE UPDATE ON catalog_import_rows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A row is replaced by deleting it (re-upload), never edited into another row:
-- identity, cells and creation time never change.
CREATE FUNCTION catalog_import_rows_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.batch_id <> OLD.batch_id OR NEW.row_number <> OLD.row_number
     OR NEW.cells IS DISTINCT FROM OLD.cells OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'import row % of batch %: identity and cells never change', OLD.row_number, OLD.batch_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER catalog_import_rows_guard BEFORE UPDATE ON catalog_import_rows
  FOR EACH ROW EXECUTE FUNCTION catalog_import_rows_guard();

-- =============================================================================
-- 4. Row-level security: ENABLE + FORCE and tenant policies on all three
-- =============================================================================

DO $$
DECLARE
  -- The empty-GUC CASE guard of 0010 / 0091 / 0097 / 0101: '' reads as NULL, never a cast error.
  tenant_match CONSTANT text := 'tenant_id = CASE'
    || ' WHEN current_setting(''app.current_tenant'', true) = '''' THEN NULL'
    || ' ELSE current_setting(''app.current_tenant'', true)::uuid END';
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['catalog_import_mapping_profiles', 'catalog_import_batches', 'catalog_import_rows'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', t || '_tenant_select', t, tenant_match);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', t || '_tenant_insert', t, tenant_match);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)',
      t || '_tenant_update', t, tenant_match, tenant_match);
  END LOOP;
  -- DELETE only on the rows: a re-upload replaces them and the retention purge removes them.
  EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)',
    'catalog_import_rows_tenant_delete', 'catalog_import_rows', tenant_match);
END
$$;

COMMIT;
