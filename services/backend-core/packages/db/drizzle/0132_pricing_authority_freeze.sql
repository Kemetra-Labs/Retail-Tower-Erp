-- 0132_pricing_authority_freeze.sql
--
-- Pricing authority tables and the inert legacy price freeze (Jira RT-1485, slice PR-16a-1 of
-- spec 044). [GATED: migration], authorized by the owner in chat on 2026-11-23.
--
-- Source-of-truth artifacts:
--   - services/backend-core/specs/044-pricing-legacy-cutover/plan.md §6.1 (single writable
--     authority, MC-4), §6.2 (freeze mechanism, MC-5), §4.3 step 5 (import watermark row),
--     §6.3 and §8.1 (cutover and rollback run rows), §8.2 R3 (down refuses), §10 (PR-16a-1 AC)
--   - packages/db/__tests__/migration/0132-pricing-authority-freeze.spec.ts
--
-- Three new tables, all FORCE RLS:
--   tenant_pricing_authority  One row per tenant: who may write prices and what POS sells from
--                             (legacy | cutover_in_progress | pricing). Every existing tenant is
--                             seeded `legacy` here, and an AFTER INSERT trigger on tenants gives
--                             every new tenant its `legacy` row, so the row always exists (§6.1;
--                             the §6.2 share lock relies on it). It goes with its tenant
--                             (ON DELETE CASCADE): it is a property of the tenant, not a fact.
--                             Only the cutover and rollback procedures (PR-16b) change it.
--   pricing_import_runs       The legacy import watermark (§4.3 step 5): the import instant T,
--                             the catalog_change_log sequence read at T, the revision published
--                             (null for a no-op run) and the counts by outcome. Written by
--                             PR-16a-2. Kept: no DELETE for any role.
--   pricing_cutover_runs      One row per cutover or rollback attempt, whatever the result
--                             (§6.3, §8.1). Written by PR-16b. Kept: no DELETE for any role.
--
-- The freeze (§6.2): a BEFORE INSERT OR UPDATE OR DELETE trigger on tenant_products and
-- store_product_overrides. While the row's tenant is `cutover_in_progress` or `pricing` it rejects
-- (SQLSTATE 55000, message `pricing_authority_frozen`):
--   - any change of default_price / default_currency_code, or price / currency_code;
--   - an INSERT that sets a price;
--   - a DELETE of a row whose price is set (an override, and also a priced tenant product: deleting
--     it changes the served price just as clearing it would);
--   - moving a priced row to another tenant, store or product (or changing a priced product's id);
--   - under `cutover_in_progress` only: a change of retired_at on a priced override.
-- Every other write goes through untouched and takes no lock: name, is_active, tax_category,
-- aliases, retired_at on a price-less override. While every tenant is `legacy` (the only state
-- this migration creates) the trigger therefore changes nothing: it is inert.
-- A price-relevant write reads the tenant's authority row with SELECT ... FOR SHARE, so a write
-- that starts while a cutover holds the row FOR UPDATE waits and then sees the committed state
-- (§6.2). A tenant with no authority row fails closed (55000).
--
-- The only bypass is a database privilege, not a setting (§6.2):
--   - pricing_projection_writer is a NOLOGIN role. It owns pricing_reverse_project(...), the only
--     code meant to write frozen price columns (the R1 reverse projection of PR-16b uses it).
--   - The trigger lets a frozen write through only when current_user = 'pricing_projection_writer',
--     which is true only inside that SECURITY DEFINER function. No session variable is read.
--   - EXECUTE on the function is revoked from PUBLIC. Only the role and its members can run it;
--     its only member is the migration owner (operator), never the API or worker runtime role.
--     This migration refuses to run when any other role can act as pricing_projection_writer.
-- The role also owns two small helpers, so the runtime role needs no privilege on the authority
-- table beyond what the grants script gives it (SELECT):
--   - pricing_authority_for_share(tenant): the locked read. FOR SHARE needs UPDATE privilege, and
--     the runtime role must never hold UPDATE on the authority table. It answers only inside a
--     trigger (pg_trigger_depth() > 0).
--   - pricing_authority_seed_tenant(): the tenants AFTER INSERT trigger that inserts `legacy`.
-- The role's policies on tenant_pricing_authority let it read and lock every row and insert only
-- `legacy` rows; its UPDATE policy has WITH CHECK (false), so it can lock but never change a row.
--
-- PREREQUISITE (database-roles.md "Before migration 0132"): the production migration owner is
-- NOCREATEROLE, so a superuser (or the managed-PostgreSQL admin) runs, once per cluster, before
-- `migrate up` reaches 0132:
--   CREATE ROLE pricing_projection_writer NOLOGIN;
--   GRANT pricing_projection_writer TO <migration owner>;
-- Without it, 0132 stops with a clear error; earlier migrations stay applied and a re-run resumes
-- at 0132. (Test databases run migrations as a superuser, which creates the role here.)
--
-- Grants: the migration grants pricing_projection_writer what its functions need (SELECT and
-- column-level UPDATE / INSERT on the two legacy tables, INSERT on catalog_change_log, and the
-- authority table). The domain role's SELECT on tenant_pricing_authority is given outside
-- migrations: docs/operations/sql/pricing-authority-domain-grants.sql (deploy/README.md step 2;
-- apps/api/src/auth/grants/pricing-authority.grants.ts).
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS. States, opaque UUIDs (user ids
-- are operational actors), instants, sequence and revision numbers, counts, a short reason
-- (documented "no PII") and run reports holding ids and counts only. No customer reference.
--
-- Deploy window: none. The new tables are created and seeded with one `legacy` row per tenant;
-- the triggers change no behaviour while every tenant is `legacy`.
--
-- Lock impact: ONE transaction, lock_timeout 2s. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on
-- tenants, tenant_products and store_product_overrides until COMMIT: writes to them wait for the
-- rest of this transaction (well under a second; the seed is one row per tenant). Reads continue.
--
-- Reversal: 0132_pricing_authority_freeze.down.sql REFUSES while any authority row is not
-- `legacy` or any run row exists (§8.2 R3); the seeded all-`legacy` rows alone do not block it.

BEGIN;

SET LOCAL lock_timeout = '2s';

-- =============================================================================
-- 1. The bypass role: create it when allowed (test databases), otherwise require it
-- =============================================================================

DO $$
DECLARE
  writer oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pricing_projection_writer') THEN
    BEGIN
      CREATE ROLE pricing_projection_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION '0132: role pricing_projection_writer does not exist and % cannot create it', current_user
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'As a superuser, once per cluster: CREATE ROLE pricing_projection_writer NOLOGIN; '
                  || 'GRANT pricing_projection_writer TO <migration owner>; then re-run migrate '
                  || '(docs/operations/database-roles.md, "Before migration 0132").';
    END;
  END IF;

  SELECT oid INTO writer FROM pg_roles WHERE rolname = 'pricing_projection_writer';

  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE oid = writer AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole)) THEN
    RAISE EXCEPTION '0132: pricing_projection_writer must be NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Nobody but the migration owner may act as the bypass role (SET ROLE, or inherit its privileges).
  IF EXISTS (SELECT 1 FROM pg_auth_members m
              WHERE m.roleid = writer
                AND m.member <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
                AND (m.inherit_option OR m.set_option)) THEN
    RAISE EXCEPTION '0132: a role other than % can act as pricing_projection_writer', current_user
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Revoke that membership; only the migration owner may be a member (spec 044 §6.2).';
  END IF;

  IF NOT pg_has_role(current_user, writer, 'MEMBER') THEN
    RAISE EXCEPTION '0132: % is not a member of pricing_projection_writer and cannot hand it the bypass function', current_user
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'As a superuser: GRANT pricing_projection_writer TO <migration owner>; then re-run migrate.';
  END IF;
END
$$;

-- =============================================================================
-- 2. Tables
-- =============================================================================

-- Run rows first: the authority row names the cutover run that last changed it.
CREATE TABLE pricing_cutover_runs (
  id                       UUID         PRIMARY KEY,
  tenant_id                UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  kind                     TEXT         NOT NULL,
  outcome                  TEXT         NOT NULL,
  started_at               TIMESTAMPTZ  NOT NULL,
  finished_at              TIMESTAMPTZ  NOT NULL,
  -- The fan-out revision a cutover published; null for an abort or a rollback.
  revision_no              BIGINT       NULL,
  -- The catalog_change_log value the flip allocated with nextval (§6.3 step 6, §8.2 R1 step 5).
  authority_flip_sequence  BIGINT       NULL,
  -- Counts, first mismatches and listed events, by id only (no PII, §XIV).
  report                   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id       UUID         NOT NULL,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  correlation_id           UUID         NOT NULL,
  CONSTRAINT pricing_cutover_runs_kind CHECK (kind IN ('cutover', 'rollback')),
  CONSTRAINT pricing_cutover_runs_outcome CHECK (outcome IN ('succeeded', 'aborted')),
  CONSTRAINT pricing_cutover_runs_window CHECK (finished_at >= started_at),
  CONSTRAINT pricing_cutover_runs_flip_positive CHECK (authority_flip_sequence IS NULL OR authority_flip_sequence >= 1),
  CONSTRAINT pricing_cutover_runs_report_object CHECK (jsonb_typeof(report) = 'object'),
  CONSTRAINT pricing_cutover_runs_tenant_id_uk UNIQUE (tenant_id, id),
  CONSTRAINT pricing_cutover_runs_revision_fk FOREIGN KEY (tenant_id, revision_no)
    REFERENCES pricing_revisions (tenant_id, revision_no) ON DELETE RESTRICT
);

CREATE INDEX idx_pricing_cutover_runs_tenant_started
  ON pricing_cutover_runs (tenant_id, started_at DESC);

CREATE TABLE pricing_import_runs (
  id                   UUID         PRIMARY KEY,
  tenant_id            UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- The import instant T (§4.2 MC-1, §4.3 step 2).
  import_instant       TIMESTAMPTZ  NOT NULL,
  -- max(catalog_change_log.sequence) for the tenant at T; 0 when it has none.
  change_log_sequence  BIGINT       NOT NULL,
  -- The legacy_import revision published; null when the diff was empty (a no-op run).
  revision_no          BIGINT       NULL,
  -- Counts by outcome (unchanged, new, changed, gone, ended, cancelled, exceptions by class).
  counts               JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id   UUID         NOT NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  correlation_id       UUID         NOT NULL,
  CONSTRAINT pricing_import_runs_sequence_non_negative CHECK (change_log_sequence >= 0),
  CONSTRAINT pricing_import_runs_counts_object CHECK (jsonb_typeof(counts) = 'object'),
  CONSTRAINT pricing_import_runs_revision_fk FOREIGN KEY (tenant_id, revision_no)
    REFERENCES pricing_revisions (tenant_id, revision_no) ON DELETE RESTRICT
);

CREATE INDEX idx_pricing_import_runs_tenant_instant
  ON pricing_import_runs (tenant_id, import_instant DESC);

CREATE TABLE tenant_pricing_authority (
  tenant_id                UUID         PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  authority                TEXT         NOT NULL DEFAULT 'legacy',
  changed_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Null for the system seed and for tenant creation.
  changed_by_user_id       UUID         NULL,
  changed_in_revision      BIGINT       NULL,
  authority_flip_sequence  BIGINT       NULL,
  run_id                   UUID         NULL,
  -- Short operator reason; documented "no PII".
  reason                   TEXT         NULL,
  CONSTRAINT tenant_pricing_authority_state
    CHECK (authority IN ('legacy', 'cutover_in_progress', 'pricing')),
  CONSTRAINT tenant_pricing_authority_flip_positive
    CHECK (authority_flip_sequence IS NULL OR authority_flip_sequence >= 1),
  CONSTRAINT tenant_pricing_authority_reason_length
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  CONSTRAINT tenant_pricing_authority_revision_fk FOREIGN KEY (tenant_id, changed_in_revision)
    REFERENCES pricing_revisions (tenant_id, revision_no) ON DELETE RESTRICT,
  CONSTRAINT tenant_pricing_authority_run_fk FOREIGN KEY (tenant_id, run_id)
    REFERENCES pricing_cutover_runs (tenant_id, id) ON DELETE RESTRICT
);

-- Run rows are evidence: no DELETE or TRUNCATE for any role (pricing_no_delete, 0121).
CREATE TRIGGER pricing_import_runs_no_delete BEFORE DELETE ON pricing_import_runs
  FOR EACH ROW EXECUTE FUNCTION pricing_no_delete();
CREATE TRIGGER pricing_import_runs_no_delete_truncate BEFORE TRUNCATE ON pricing_import_runs
  FOR EACH STATEMENT EXECUTE FUNCTION pricing_no_delete();
CREATE TRIGGER pricing_cutover_runs_no_delete BEFORE DELETE ON pricing_cutover_runs
  FOR EACH ROW EXECUTE FUNCTION pricing_no_delete();
CREATE TRIGGER pricing_cutover_runs_no_delete_truncate BEFORE TRUNCATE ON pricing_cutover_runs
  FOR EACH STATEMENT EXECUTE FUNCTION pricing_no_delete();

-- =============================================================================
-- 3. Row-level security
-- =============================================================================

DO $$
DECLARE
  -- The empty-GUC CASE guard of 0010 / 0091 / 0097 / 0101 / 0121: '' reads as NULL, never a cast error.
  tenant_match CONSTANT text := 'tenant_id = CASE'
    || ' WHEN current_setting(''app.current_tenant'', true) = '''' THEN NULL'
    || ' ELSE current_setting(''app.current_tenant'', true)::uuid END';
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_pricing_authority', 'pricing_import_runs', 'pricing_cutover_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', t || '_tenant_select', t, tenant_match);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', t || '_tenant_insert', t, tenant_match);
  END LOOP;
  -- Only the authority row changes, and only through the cutover / rollback procedures (PR-16b).
  -- Run rows are written once. No DELETE policy anywhere.
  EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)',
    'tenant_pricing_authority_tenant_update', 'tenant_pricing_authority', tenant_match, tenant_match);
END
$$;

-- The bypass role's own policies: read and lock every tenant's row (the freeze trigger runs for
-- any tenant's write), insert only `legacy` (tenant creation), never change a row.
CREATE POLICY tenant_pricing_authority_writer_select ON tenant_pricing_authority
  FOR SELECT TO pricing_projection_writer USING (true);
CREATE POLICY tenant_pricing_authority_writer_lock ON tenant_pricing_authority
  FOR UPDATE TO pricing_projection_writer USING (true) WITH CHECK (false);
CREATE POLICY tenant_pricing_authority_writer_insert ON tenant_pricing_authority
  FOR INSERT TO pricing_projection_writer WITH CHECK (authority = 'legacy');

-- =============================================================================
-- 4. What pricing_projection_writer may touch (its functions run as it)
-- =============================================================================

-- Its functions name public tables. PUBLIC normally holds USAGE on schema public; grant it only
-- where an environment revoked that (the schema owner can).
DO $$
BEGIN
  IF NOT has_schema_privilege('pricing_projection_writer', 'public', 'USAGE') THEN
    GRANT USAGE ON SCHEMA public TO pricing_projection_writer;
  END IF;
END
$$;
-- FOR SHARE needs UPDATE on at least one column; the lock policy above refuses every change.
GRANT SELECT, INSERT, UPDATE (changed_at) ON tenant_pricing_authority TO pricing_projection_writer;
GRANT SELECT, UPDATE (default_price, default_currency_code, updated_by, correlation_id)
  ON tenant_products TO pricing_projection_writer;
GRANT SELECT, INSERT, UPDATE (price, currency_code, retired_at, updated_by, correlation_id)
  ON store_product_overrides TO pricing_projection_writer;
-- The catalog_change_log triggers on both legacy tables run as the writing role.
GRANT INSERT ON catalog_change_log TO pricing_projection_writer;

-- =============================================================================
-- 5. Functions
-- =============================================================================

-- The locked authority read (§6.2). SECURITY DEFINER as pricing_projection_writer: FOR SHARE needs
-- UPDATE privilege, which the runtime role must never hold on this table. Answers only inside a
-- trigger, so it cannot be used to read or lock another tenant's row from plain SQL.
CREATE FUNCTION pricing_authority_for_share(p_tenant_id uuid) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  a text;
BEGIN
  IF pg_trigger_depth() < 1 THEN
    RAISE EXCEPTION 'pricing_authority_for_share is only callable from the legacy price freeze trigger'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT authority INTO a FROM tenant_pricing_authority WHERE tenant_id = p_tenant_id FOR SHARE;
  RETURN a;
END
$$;

-- Every new tenant starts on `legacy` (§6.1; MC-11 keeps new tenants on legacy for now).
CREATE FUNCTION pricing_authority_seed_tenant() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO tenant_pricing_authority (tenant_id, authority, reason)
    VALUES (NEW.id, 'legacy', 'tenant created')
    ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NULL;
END
$$;

-- The freeze (§6.2). SECURITY INVOKER on purpose: current_user is the writing role, so the bypass
-- check below sees the real writer.
CREATE FUNCTION pricing_legacy_freeze() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  price_change   boolean := false;
  retire_change  boolean := false;
  touched        uuid[];
  t              uuid;
  a              text;
BEGIN
  IF current_user = 'pricing_projection_writer' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tenant_products' THEN
    IF TG_OP = 'INSERT' THEN
      price_change := NEW.default_price IS NOT NULL OR NEW.default_currency_code IS NOT NULL;
      touched := ARRAY[NEW.tenant_id];
    ELSIF TG_OP = 'UPDATE' THEN
      price_change := NEW.default_price IS DISTINCT FROM OLD.default_price
        OR NEW.default_currency_code IS DISTINCT FROM OLD.default_currency_code
        OR ((NEW.tenant_id, NEW.id) IS DISTINCT FROM (OLD.tenant_id, OLD.id)
            AND (OLD.default_price IS NOT NULL OR NEW.default_price IS NOT NULL));
      touched := ARRAY[OLD.tenant_id, NEW.tenant_id];
    ELSE
      price_change := OLD.default_price IS NOT NULL;
      touched := ARRAY[OLD.tenant_id];
    END IF;
  ELSE
    IF TG_OP = 'INSERT' THEN
      price_change := NEW.price IS NOT NULL OR NEW.currency_code IS NOT NULL;
      touched := ARRAY[NEW.tenant_id];
    ELSIF TG_OP = 'UPDATE' THEN
      price_change := NEW.price IS DISTINCT FROM OLD.price
        OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
        OR ((NEW.tenant_id, NEW.store_id, NEW.product_id) IS DISTINCT FROM (OLD.tenant_id, OLD.store_id, OLD.product_id)
            AND (OLD.price IS NOT NULL OR NEW.price IS NOT NULL));
      retire_change := NEW.retired_at IS DISTINCT FROM OLD.retired_at
        AND (OLD.price IS NOT NULL OR NEW.price IS NOT NULL);
      touched := ARRAY[OLD.tenant_id, NEW.tenant_id];
    ELSE
      price_change := OLD.price IS NOT NULL;
      touched := ARRAY[OLD.tenant_id];
    END IF;
  END IF;

  -- Not price-relevant: no lock, no check (the trigger is inert for these writes).
  IF price_change OR retire_change THEN
    FOREACH t IN ARRAY touched LOOP
      a := pricing_authority_for_share(t);
      IF a IS NULL THEN
        RAISE EXCEPTION 'pricing_authority_missing: tenant % has no tenant_pricing_authority row', t
          USING ERRCODE = 'object_not_in_prerequisite_state',
                HINT = 'Every tenant must have an authority row (spec 044 §6.1); insert its legacy row.';
      END IF;
      IF a <> 'legacy' AND (price_change OR a = 'cutover_in_progress') THEN
        RAISE EXCEPTION 'pricing_authority_frozen: % on % changes a legacy price while tenant % is %',
                        TG_OP, TG_TABLE_NAME, t, a
          USING ERRCODE = 'object_not_in_prerequisite_state',
                HINT = 'Legacy price columns are frozen outside the legacy authority (spec 044 §6.2); '
                    || 'author prices through Pricing, or roll the tenant back (R1).';
      END IF;
    END LOOP;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

-- The only writer of frozen price columns (§6.2). A narrow primitive: it writes the given price
-- for one key and nothing else. The R1 resolution, the Store loop and the sweep are PR-16b.
--   p_store_id null      -> tenant_products.default_price / default_currency_code of the product.
--   p_store_id not null  -> the live override of (store, product): set its price, or clear it; a
--                           price-only override is retired instead of cleared (the row would
--                           otherwise carry no override). No live override and a price -> a
--                           price-only override is inserted. No live override and no price -> nothing.
-- p_price and p_currency_code are both null or both set. The tenant (and store) context is set
-- for this call only: the caller's values are restored before it returns.
CREATE FUNCTION pricing_reverse_project(
  p_tenant_id      uuid,
  p_product_id     uuid,
  p_store_id       uuid,
  p_price          numeric,
  p_currency_code  char(3),
  p_actor_user_id  uuid,
  p_correlation_id uuid
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  n             bigint;
  saved_tenant  text;
  saved_store   text;
BEGIN
  IF p_tenant_id IS NULL OR p_product_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'pricing_reverse_project: tenant, product and actor are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
  IF (p_price IS NULL) <> (p_currency_code IS NULL) THEN
    RAISE EXCEPTION 'pricing_reverse_project: price and currency must both be set or both be null'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Function-level SET of a custom GUC needs superuser on PG15+, so the caller's context is saved
  -- here and restored before returning. On an error the caller's transaction (or savepoint) rolls
  -- these transaction-local settings back with everything else.
  saved_tenant := current_setting('app.current_tenant', true);
  saved_store := current_setting('app.current_store', true);
  PERFORM set_config('app.current_tenant', p_tenant_id::text, true);

  IF p_store_id IS NULL THEN
    UPDATE tenant_products
       SET default_price = p_price, default_currency_code = p_currency_code,
           updated_by = p_actor_user_id, correlation_id = p_correlation_id
     WHERE tenant_id = p_tenant_id AND id = p_product_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
      RAISE EXCEPTION 'pricing_reverse_project: product % not found for tenant %', p_product_id, p_tenant_id
        USING ERRCODE = 'no_data_found';
    END IF;
    PERFORM set_config('app.current_tenant', coalesce(saved_tenant, ''), true);
    RETURN;
  END IF;

  PERFORM set_config('app.current_store', p_store_id::text, true);

  IF p_price IS NOT NULL THEN
    UPDATE store_product_overrides
       SET price = p_price, currency_code = p_currency_code,
           updated_by = p_actor_user_id, correlation_id = p_correlation_id
     WHERE tenant_id = p_tenant_id AND store_id = p_store_id AND product_id = p_product_id
       AND retired_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
      INSERT INTO store_product_overrides
        (tenant_id, store_id, product_id, price, currency_code, created_by, updated_by, correlation_id)
      VALUES
        (p_tenant_id, p_store_id, p_product_id, p_price, p_currency_code,
         p_actor_user_id, p_actor_user_id, p_correlation_id);
    END IF;
  ELSE
    -- Retire a price-only override (clearing it would leave a row with no override).
    UPDATE store_product_overrides
       SET retired_at = now(), updated_by = p_actor_user_id, correlation_id = p_correlation_id
     WHERE tenant_id = p_tenant_id AND store_id = p_store_id AND product_id = p_product_id
       AND retired_at IS NULL AND price IS NOT NULL
       AND is_active IS NULL AND tax_category IS NULL;
    UPDATE store_product_overrides
       SET price = NULL, currency_code = NULL,
           updated_by = p_actor_user_id, correlation_id = p_correlation_id
     WHERE tenant_id = p_tenant_id AND store_id = p_store_id AND product_id = p_product_id
       AND retired_at IS NULL AND price IS NOT NULL;
  END IF;
  PERFORM set_config('app.current_tenant', coalesce(saved_tenant, ''), true);
  PERFORM set_config('app.current_store', coalesce(saved_store, ''), true);
END
$$;

REVOKE ALL ON FUNCTION pricing_reverse_project(uuid, uuid, uuid, numeric, char, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing_authority_seed_tenant() FROM PUBLIC;

-- ALTER ... OWNER TO needs the new owner to hold CREATE on the function's schema. The writer gets
-- it only for these three statements (the schema owner, normally the migration owner as database
-- owner, can grant it), unless it already holds it (the superuser prerequisite may grant it).
DO $$
DECLARE
  granted boolean := false;
BEGIN
  IF NOT has_schema_privilege('pricing_projection_writer', 'public', 'CREATE') THEN
    GRANT CREATE ON SCHEMA public TO pricing_projection_writer;
    granted := true;
    IF NOT has_schema_privilege('pricing_projection_writer', 'public', 'CREATE') THEN
      RAISE EXCEPTION '0132: % cannot give pricing_projection_writer CREATE on schema public to hand it its functions', current_user
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'As a superuser: GRANT CREATE ON SCHEMA public TO pricing_projection_writer; then re-run migrate '
                  || '(docs/operations/database-roles.md, "Before migration 0132").';
    END IF;
  END IF;
  ALTER FUNCTION pricing_authority_for_share(uuid) OWNER TO pricing_projection_writer;
  ALTER FUNCTION pricing_authority_seed_tenant() OWNER TO pricing_projection_writer;
  ALTER FUNCTION pricing_reverse_project(uuid, uuid, uuid, numeric, char, uuid, uuid) OWNER TO pricing_projection_writer;
  IF granted THEN
    REVOKE CREATE ON SCHEMA public FROM pricing_projection_writer;
  END IF;
END
$$;

-- =============================================================================
-- 6. Every tenant has its authority row: new tenants by trigger, existing ones seeded
-- =============================================================================

-- Created before the seed: CREATE TRIGGER locks tenants, so no tenant can be inserted between the
-- seed and the trigger.
CREATE TRIGGER tenants_pricing_authority_seed AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION pricing_authority_seed_tenant();

-- tenants and tenant_pricing_authority are FORCE RLS and the production migration owner is not a
-- superuser: list tenants as platform admin (with the tenant GUC pinned to the nil UUID, since the
-- tenants policy casts it without the empty-GUC guard), then insert each row under its own tenant.
DO $$
DECLARE
  t uuid;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    INSERT INTO tenant_pricing_authority (tenant_id, authority, reason)
      VALUES (t, 'legacy', 'seeded by migration 0132')
      ON CONFLICT (tenant_id) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.is_platform_admin', '', true);
  PERFORM set_config('app.current_tenant', '', true);
END
$$;

-- =============================================================================
-- 7. The freeze triggers (inert while every tenant is `legacy`)
-- =============================================================================

CREATE TRIGGER tenant_products_pricing_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON tenant_products
  FOR EACH ROW EXECUTE FUNCTION pricing_legacy_freeze();
CREATE TRIGGER store_product_overrides_pricing_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON store_product_overrides
  FOR EACH ROW EXECUTE FUNCTION pricing_legacy_freeze();

COMMIT;
