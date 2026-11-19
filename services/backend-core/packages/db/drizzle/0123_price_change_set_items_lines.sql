-- 0123_price_change_set_items_lines.sql
--
-- Price Change Set content: item lists, items, validations with their stored
-- Impact Preview, and materialized lines (Jira RT-1151, RT-282 PR-05; owner
-- decision D5(a): RT-1151 creates the Change Set content tables in their own
-- migration, comment 17783; design per the independent review of #718,
-- owner-approved 2026-11-19: first-class item-list and validation rows that
-- store the preview, and a per-line result record). [GATED: migration].
-- Depends on 0121 (change_sets, price_books, price_zones, price_events,
-- price_zone_memberships, pricing_revision_issued_here).
--
-- Source-of-truth artifacts:
--   - services/backend-core/specs/042-price-change-set-lifecycle/plan.md §3
--     (versioned drafts, staleness), §4.2-§4.3 (items, materialization), §5
--     (line classes), §6 (the stored Impact Preview), §10 (per-line
--     before/after record, Q-B5)
--   - packages/contracts/openapi/pricing/price-change-sets.yaml 1.0.0-draft:
--     `PriceChangeItem`, `PriceChangeSetPreview`, `PreviewSummary`,
--     `PreviewLine`, `PreviewMembershipChange`, `LineClass`
--   - packages/db/__tests__/migration/0123-price-change-set-items-lines.spec.ts
--
-- Six new tables, plus two triggers on 0121's change_sets. No runtime reads or
-- writes them until RT-1484 (PR-10).
--
--   price_change_set_item_lists   One row per write of a set's item list
--                                 (create, or a PATCH that sends `items`),
--                                 at the draft version it was written at,
--                                 with its item count. An empty replacement is
--                                 a row with item_count 0; a header-only edit
--                                 writes none and keeps the earlier list. The
--                                 current list is the latest row.
--   price_change_set_items        The authored `PriceChangeItem`s of a list,
--                                 written only by the transaction that wrote
--                                 the list, exactly item_count of them
--                                 (checked at COMMIT): a list is sealed.
--   price_change_set_validations  One row per `validate`, at the draft version
--                                 it validated: the item list it used (the
--                                 set's current one, never empty), the head
--                                 revision, the preview and target-Store-set
--                                 hashes, the sensitivity, the preview summary
--                                 and the target Stores with their time zones
--                                 (Q-B8), and the counts of its lines and
--                                 preview rows (checked at COMMIT). A
--                                 validation that materializes no line is
--                                 still a row. Sealed like a list.
--   price_change_set_lines        The lines a validation materialized (§4.3):
--                                 one (scope target, product, sell unit) row,
--                                 or one Zone move, with its concrete price,
--                                 class and the ids it replaces. Written only
--                                 by the validation's transaction. Immutable,
--                                 except new_event_id and result_ids, set once
--                                 by the transaction that published the set
--                                 (§10, Q-B5: the event the line became, and
--                                 the remainder events and membership rows
--                                 its publish wrote).
--   price_change_set_preview_lines        The stored per-Store preview rows
--                                 (`PreviewLine`), written by the validation's
--                                 transaction.
--   price_change_set_preview_memberships  The stored Zone-membership changes
--                                 (`PreviewMembershipChange`), one per Zone
--                                 move line, written likewise.
--
--   change_sets (0121) gains two triggers (section 5): a set leaves `draft`
--   (except to `cancelled`, and except `legacy_import`) only with the
--   validation of its current item list at its version, whose hashes,
--   sensitivity and revision it carries; outside `draft` that binding never
--   changes; blocking lines block submit, approve and publish; every return
--   to `draft` increments the version; and at COMMIT a publish's per-line
--   record is complete.
--
-- Concurrency: the list and validation insert triggers lock the set's
-- change_sets row FOR NO KEY UPDATE, so two writers of one set's content (two
-- validates, or an edit and a validate) serialize on that row instead of
-- deadlocking; the second then sees the version or state the first moved and
-- is refused, or hits the primary key.
--
-- RLS: ENABLE + FORCE with tenant SELECT and INSERT policies on all six,
-- UPDATE on lines only (bounded by the guard). No DELETE policy.
--
-- Grants: none here. Production grants the domain role SELECT and INSERT on
-- all six and column-level UPDATE (new_event_id, result_ids) on lines,
-- outside migrations: docs/operations/sql/price-change-set-content-domain-grants.sql
-- (deploy step 2). The API refuses to boot without them
-- (DOMAIN_REQUIRED_GRANTS, apps/api/src/auth/grants/price-change-set-content.grants.ts).
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS. Authored
-- items, materialized prices, the preview shown to the approver, finding
-- codes. No customer reference. Kept: a published set's validation, lines and
-- preview are its audit record.
--
-- Deploy window: none. Six new, empty tables and a trigger on 0121's
-- change_sets, which is unused before RT-1484. Apply 0123 and the grants
-- script before the API that uses them.
--
-- Lock impact: ONE transaction, lock_timeout 2s. CREATE TRIGGER takes SHARE
-- ROW EXCLUSIVE on change_sets; the new FKs take SHARE ROW EXCLUSIVE on
-- change_sets, price_books, price_zones, stores, tenant_products and
-- price_events (all but stores and tenant_products new and unused). Reads of
-- stores and tenant_products continue.
--
-- Reversal: 0123_price_change_set_items_lines.down.sql REFUSES while any of
-- the six tables holds a row; otherwise it drops them, their functions and
-- change_sets' two triggers.

BEGIN;

SET LOCAL lock_timeout = '2s';

-- Refuses UPDATE, DELETE and TRUNCATE (on lines, DELETE and TRUNCATE) for every role.
CREATE FUNCTION price_change_set_content_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'A Change Set''s content is kept: an edit writes a new version (RT-1151, spec 042 §3, §10).';
END
$$;

-- =============================================================================
-- 1. price_change_set_item_lists and price_change_set_items
-- =============================================================================

CREATE TABLE price_change_set_item_lists (
  tenant_id           UUID         NOT NULL,
  change_set_id       UUID         NOT NULL,
  change_set_version  INTEGER      NOT NULL,
  item_count          INTEGER      NOT NULL,
  -- The writing transaction, forced by the insert trigger: only it adds items.
  list_xact           XID8         NOT NULL DEFAULT pg_current_xact_id(),
  created_by_user_id  UUID         NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  correlation_id      UUID         NOT NULL,
  CONSTRAINT price_change_set_item_lists_pk PRIMARY KEY (tenant_id, change_set_id, change_set_version),
  CONSTRAINT price_change_set_item_lists_set_fk FOREIGN KEY (tenant_id, change_set_id)
    REFERENCES change_sets (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_item_lists_version_positive CHECK (change_set_version >= 1),
  -- The contract caps a set at 500 items (CreatePriceChangeSetRequest.items).
  CONSTRAINT price_change_set_item_lists_item_count CHECK (item_count BETWEEN 0 AND 500)
);

-- A list is written only while its set is a draft at exactly that version,
-- and never at a version that already has a validation.
CREATE FUNCTION price_change_set_item_lists_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state text;
  v_version integer;
BEGIN
  SELECT cs.state, cs.version INTO v_state, v_version
    FROM public.change_sets cs
   WHERE cs.tenant_id = NEW.tenant_id AND cs.id = NEW.change_set_id
     FOR NO KEY UPDATE;
  IF v_state IS DISTINCT FROM 'draft' OR v_version IS DISTINCT FROM NEW.change_set_version THEN
    RAISE EXCEPTION 'price_change_set_item_lists: change set % is % at version %, not a draft at version %',
      NEW.change_set_id, v_state, v_version, NEW.change_set_version
      USING ERRCODE = 'check_violation';
  END IF;
  -- A validation pins the list it used: none is written at or below a validated version.
  IF EXISTS (SELECT 1 FROM public.price_change_set_validations v
              WHERE v.tenant_id = NEW.tenant_id AND v.change_set_id = NEW.change_set_id
                AND v.change_set_version >= NEW.change_set_version) THEN
    RAISE EXCEPTION 'price_change_set_item_lists: change set % is already validated at version %; an edit starts a new version',
      NEW.change_set_id, NEW.change_set_version
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.list_xact := pg_current_xact_id();
  NEW.created_at := now();
  RETURN NEW;
END
$$;

-- At COMMIT a list holds exactly item_count items.
CREATE FUNCTION price_change_set_item_lists_complete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.price_change_set_items i
   WHERE i.tenant_id = NEW.tenant_id AND i.change_set_id = NEW.change_set_id
     AND i.change_set_version = NEW.change_set_version;
  IF n IS DISTINCT FROM NEW.item_count THEN
    RAISE EXCEPTION 'price_change_set_item_lists: change set % version % has % item(s), its list says %',
      NEW.change_set_id, NEW.change_set_version, n, NEW.item_count
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER price_change_set_item_lists_before_insert BEFORE INSERT ON price_change_set_item_lists
  FOR EACH ROW EXECUTE FUNCTION price_change_set_item_lists_before_insert();
CREATE CONSTRAINT TRIGGER price_change_set_item_lists_complete AFTER INSERT ON price_change_set_item_lists
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION price_change_set_item_lists_complete();
CREATE TRIGGER price_change_set_item_lists_append_only_row BEFORE UPDATE OR DELETE ON price_change_set_item_lists
  FOR EACH ROW EXECUTE FUNCTION price_change_set_content_append_only();
CREATE TRIGGER price_change_set_item_lists_append_only_truncate BEFORE TRUNCATE ON price_change_set_item_lists
  FOR EACH STATEMENT EXECUTE FUNCTION price_change_set_content_append_only();

CREATE TABLE price_change_set_items (
  tenant_id           UUID         NOT NULL,
  change_set_id       UUID         NOT NULL,
  change_set_version  INTEGER      NOT NULL,
  position            INTEGER      NOT NULL,
  op                  TEXT         NOT NULL,
  item                JSONB        NOT NULL,
  created_by_user_id  UUID         NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  correlation_id      UUID         NOT NULL,
  CONSTRAINT price_change_set_items_pk PRIMARY KEY (tenant_id, change_set_id, change_set_version, position),
  CONSTRAINT price_change_set_items_list_fk FOREIGN KEY (tenant_id, change_set_id, change_set_version)
    REFERENCES price_change_set_item_lists (tenant_id, change_set_id, change_set_version) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_items_position CHECK (position BETWEEN 1 AND 500),
  CONSTRAINT price_change_set_items_op CHECK (op IN (
    'set_price', 'adjust_amount', 'adjust_percent', 'end_price', 'reset_store_override', 'move_store_zone')),
  -- The authored item is an object naming its own op (a missing `op` is refused, not NULL-passed).
  CONSTRAINT price_change_set_items_item_shape CHECK (
    jsonb_typeof(item) = 'object' AND (item ->> 'op') IS NOT DISTINCT FROM op)
);

-- Items are written only by the transaction that wrote their list, at a
-- position within its count.
CREATE FUNCTION price_change_set_items_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_xact xid8;
  v_count integer;
BEGIN
  SELECT l.list_xact, l.item_count INTO v_xact, v_count
    FROM public.price_change_set_item_lists l
   WHERE l.tenant_id = NEW.tenant_id AND l.change_set_id = NEW.change_set_id
     AND l.change_set_version = NEW.change_set_version;
  IF v_xact IS NULL OR v_xact <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'price_change_set_items: the item list of change set % version % is sealed (written by another transaction) or missing',
      NEW.change_set_id, NEW.change_set_version
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.position > v_count THEN
    RAISE EXCEPTION 'price_change_set_items: position % is beyond the list''s % item(s)', NEW.position, v_count
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER price_change_set_items_before_insert BEFORE INSERT ON price_change_set_items
  FOR EACH ROW EXECUTE FUNCTION price_change_set_items_before_insert();
CREATE TRIGGER price_change_set_items_append_only_row BEFORE UPDATE OR DELETE ON price_change_set_items
  FOR EACH ROW EXECUTE FUNCTION price_change_set_content_append_only();
CREATE TRIGGER price_change_set_items_append_only_truncate BEFORE TRUNCATE ON price_change_set_items
  FOR EACH STATEMENT EXECUTE FUNCTION price_change_set_content_append_only();

-- =============================================================================
-- 2. price_change_set_validations
-- =============================================================================

CREATE TABLE price_change_set_validations (
  tenant_id                 UUID         NOT NULL,
  change_set_id             UUID         NOT NULL,
  change_set_version        INTEGER      NOT NULL,
  -- The item list it materialized: the set's current one.
  item_list_version         INTEGER      NOT NULL,
  -- The head revision the preview was computed at (fixed; change_sets'
  -- validated_at_revision may later advance past a non-intersecting head, §3).
  validated_at_revision     BIGINT       NOT NULL,
  preview_hash              TEXT         NOT NULL,
  target_store_set_hash     TEXT         NOT NULL,
  sensitive                 BOOLEAN      NOT NULL,
  sensitivity_reasons       TEXT[]       NOT NULL DEFAULT '{}',
  -- `PreviewSummary` (lines, stores, devices, products, increases, decreases,
  -- unchanged, max deltas, earliest instant, findings, blocking).
  summary                   JSONB        NOT NULL,
  -- The target Store set behind target_store_set_hash, with time zones (Q-B8):
  -- [{"storeId": uuid, "timezone": text}, ...].
  target_stores             JSONB        NOT NULL,
  line_count                INTEGER      NOT NULL,
  preview_line_count        INTEGER      NOT NULL,
  membership_change_count   INTEGER      NOT NULL,
  -- The validating transaction, forced by the insert trigger: only it writes lines and preview rows.
  validation_xact           XID8         NOT NULL DEFAULT pg_current_xact_id(),
  created_by_user_id        UUID         NOT NULL,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  correlation_id            UUID         NOT NULL,
  CONSTRAINT price_change_set_validations_pk PRIMARY KEY (tenant_id, change_set_id, change_set_version),
  -- Composite FK target: a line names its validation and that validation's item list.
  CONSTRAINT price_change_set_validations_list_uk UNIQUE (tenant_id, change_set_id, change_set_version, item_list_version),
  CONSTRAINT price_change_set_validations_set_fk FOREIGN KEY (tenant_id, change_set_id)
    REFERENCES change_sets (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_validations_list_fk FOREIGN KEY (tenant_id, change_set_id, item_list_version)
    REFERENCES price_change_set_item_lists (tenant_id, change_set_id, change_set_version) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_validations_versions CHECK (item_list_version BETWEEN 1 AND change_set_version),
  CONSTRAINT price_change_set_validations_revision CHECK (validated_at_revision >= 0),
  CONSTRAINT price_change_set_validations_preview_hash CHECK (preview_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT price_change_set_validations_target_hash CHECK (target_store_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT price_change_set_validations_sensitivity_reasons CHECK (sensitivity_reasons <@ ARRAY[
    'approval_mode_always', 'delta_threshold', 'store_threshold', 'zone_move', 'past_dated', 'rollback', 'emergency']::text[]),
  -- Every `PreviewSummary` key, and every finding count.
  CONSTRAINT price_change_set_validations_summary CHECK (
    jsonb_typeof(summary) = 'object'
    AND summary ?& ARRAY['lines', 'stores', 'devices', 'products', 'increases', 'decreases', 'unchanged',
                         'maxIncreasePct', 'maxDecreasePct', 'earliestEffectiveAt', 'findings', 'blocking']
    AND jsonb_typeof(summary -> 'blocking') = 'boolean'
    AND jsonb_typeof(summary -> 'findings') = 'object'
    AND (summary -> 'findings') ?& ARRAY['replaces', 'shadowed', 'invalidates_dependent', 'conflicts_pending',
                                         'past_dated', 'invalid']),
  -- [{"storeId": uuid, "timezone": text}, ...]
  CONSTRAINT price_change_set_validations_target_stores CHECK (
    jsonb_typeof(target_stores) = 'array'
    AND NOT jsonb_path_exists(target_stores, '$[*] ? (!(exists(@.storeId)) || !(exists(@.timezone)))')),
  -- Q-B6: at most 50 000 materialized lines per set.
  CONSTRAINT price_change_set_validations_counts CHECK (
    line_count BETWEEN 0 AND 50000 AND preview_line_count >= 0 AND membership_change_count >= 0)
);

-- A validation is written only while its set is a draft at exactly that
-- version, from the set's current item list, which is never empty (an empty
-- set fails validation, 422 change_set_empty, and stores nothing).
CREATE FUNCTION price_change_set_validations_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state text;
  v_version integer;
  v_list_version integer;
  v_list_count integer;
BEGIN
  SELECT cs.state, cs.version INTO v_state, v_version
    FROM public.change_sets cs
   WHERE cs.tenant_id = NEW.tenant_id AND cs.id = NEW.change_set_id
     FOR NO KEY UPDATE;
  IF v_state IS DISTINCT FROM 'draft' OR v_version IS DISTINCT FROM NEW.change_set_version THEN
    RAISE EXCEPTION 'price_change_set_validations: change set % is % at version %, not a draft at version %',
      NEW.change_set_id, v_state, v_version, NEW.change_set_version
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l.change_set_version, l.item_count INTO v_list_version, v_list_count
    FROM public.price_change_set_item_lists l
   WHERE l.tenant_id = NEW.tenant_id AND l.change_set_id = NEW.change_set_id
     AND l.change_set_version <= NEW.change_set_version
   ORDER BY l.change_set_version DESC
   LIMIT 1;
  IF v_list_version IS DISTINCT FROM NEW.item_list_version THEN
    RAISE EXCEPTION 'price_change_set_validations: change set %''s current item list is version %, not %',
      NEW.change_set_id, v_list_version, NEW.item_list_version
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_list_count = 0 THEN
    RAISE EXCEPTION 'price_change_set_validations: change set %''s item list is empty', NEW.change_set_id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.validation_xact := pg_current_xact_id();
  NEW.created_at := now();
  RETURN NEW;
END
$$;

-- At COMMIT a validation holds exactly its counted lines and preview rows,
-- and one membership change per Zone move line. A transaction that forces
-- this check early (SET CONSTRAINTS ... IMMEDIATE) still cannot add rows
-- after it: line_no and preview row_no are capped by the counts and unique.
CREATE FUNCTION price_change_set_validations_complete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  n_lines integer;
  n_preview integer;
  n_moves integer;
BEGIN
  SELECT count(*) INTO n_lines FROM public.price_change_set_lines l
   WHERE l.tenant_id = NEW.tenant_id AND l.change_set_id = NEW.change_set_id
     AND l.change_set_version = NEW.change_set_version;
  SELECT count(*) INTO n_preview FROM public.price_change_set_preview_lines p
   WHERE p.tenant_id = NEW.tenant_id AND p.change_set_id = NEW.change_set_id
     AND p.change_set_version = NEW.change_set_version;
  SELECT count(*) INTO n_moves FROM public.price_change_set_preview_memberships m
   WHERE m.tenant_id = NEW.tenant_id AND m.change_set_id = NEW.change_set_id
     AND m.change_set_version = NEW.change_set_version;
  IF n_lines <> NEW.line_count OR n_preview <> NEW.preview_line_count OR n_moves <> NEW.membership_change_count
     OR n_moves <> (SELECT count(*) FROM public.price_change_set_lines l
                     WHERE l.tenant_id = NEW.tenant_id AND l.change_set_id = NEW.change_set_id
                       AND l.change_set_version = NEW.change_set_version AND l.op = 'move_store_zone') THEN
    RAISE EXCEPTION 'price_change_set_validations: change set % version % has %/%/% lines/preview rows/membership changes, its validation says %/%/%',
      NEW.change_set_id, NEW.change_set_version, n_lines, n_preview, n_moves,
      NEW.line_count, NEW.preview_line_count, NEW.membership_change_count
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER price_change_set_validations_before_insert BEFORE INSERT ON price_change_set_validations
  FOR EACH ROW EXECUTE FUNCTION price_change_set_validations_before_insert();
CREATE CONSTRAINT TRIGGER price_change_set_validations_complete AFTER INSERT ON price_change_set_validations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION price_change_set_validations_complete();
CREATE TRIGGER price_change_set_validations_append_only_row BEFORE UPDATE OR DELETE ON price_change_set_validations
  FOR EACH ROW EXECUTE FUNCTION price_change_set_content_append_only();
CREATE TRIGGER price_change_set_validations_append_only_truncate BEFORE TRUNCATE ON price_change_set_validations
  FOR EACH STATEMENT EXECUTE FUNCTION price_change_set_content_append_only();

-- Lines and preview rows are written only by their validation's transaction.
CREATE FUNCTION price_change_set_validation_sealed(p_tenant uuid, p_set uuid, p_version integer) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.price_change_set_validations v
                  WHERE v.tenant_id = p_tenant AND v.change_set_id = p_set
                    AND v.change_set_version = p_version AND v.validation_xact = pg_current_xact_id())
$$;

-- =============================================================================
-- 3. price_change_set_lines
-- =============================================================================

CREATE TABLE price_change_set_lines (
  tenant_id             UUID            NOT NULL,
  change_set_id         UUID            NOT NULL,
  -- The validation (draft version) that materialized the line.
  change_set_version    INTEGER         NOT NULL,
  line_no               INTEGER         NOT NULL,
  -- The authored item it came from, in that validation's item list.
  item_list_version     INTEGER         NOT NULL,
  item_position         INTEGER         NOT NULL,
  op                    TEXT            NOT NULL,
  scope                 TEXT            NOT NULL,
  price_book_id         UUID            NOT NULL,
  price_zone_id         UUID            NULL,
  store_id              UUID            NULL,
  -- NULL only on a Zone move (it moves a Store, not a product price).
  product_id            UUID            NULL,
  sell_unit             TEXT            NULL,
  time_basis            TEXT            NOT NULL,
  effective_from        TIMESTAMPTZ     NULL,
  effective_to          TIMESTAMPTZ     NULL,
  effective_from_local  TIMESTAMP       NULL,
  effective_to_local    TIMESTAMP       NULL,
  -- The concrete price after publish; NULL for end_price, reset_store_override,
  -- a Zone move, and an `invalid` helper line whose result is not a price.
  new_price             NUMERIC(19, 4)  NULL,
  -- A helper's exact, unrounded result when it was not representable (spec 041 §6).
  rounded_from          NUMERIC(23, 8)  NULL,
  class                 TEXT            NOT NULL,
  messages              TEXT[]          NOT NULL DEFAULT '{}',
  -- The active events (or memberships, for a move) this line supersedes at publish.
  replaced_ids          UUID[]          NOT NULL DEFAULT '{}',
  -- Set ONCE at publish (§10, Q-B5): the event this line became (priced ops),
  -- and every other event or membership row its publish wrote (remainders of
  -- a split or ended event, the moved Store's new membership rows).
  new_event_id          UUID            NULL,
  result_ids            UUID[]          NOT NULL DEFAULT '{}',
  created_by_user_id    UUID            NOT NULL,
  created_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),
  correlation_id        UUID            NOT NULL,
  CONSTRAINT price_change_set_lines_pk PRIMARY KEY (tenant_id, change_set_id, change_set_version, line_no),
  CONSTRAINT price_change_set_lines_validation_fk FOREIGN KEY (tenant_id, change_set_id, change_set_version, item_list_version)
    REFERENCES price_change_set_validations (tenant_id, change_set_id, change_set_version, item_list_version) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_lines_item_fk FOREIGN KEY (tenant_id, change_set_id, item_list_version, item_position)
    REFERENCES price_change_set_items (tenant_id, change_set_id, change_set_version, position) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_lines_book_fk FOREIGN KEY (tenant_id, price_book_id)
    REFERENCES price_books (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_lines_zone_fk FOREIGN KEY (tenant_id, price_book_id, price_zone_id)
    REFERENCES price_zones (tenant_id, price_book_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_lines_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_lines_product_fk FOREIGN KEY (product_id, tenant_id)
    REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_lines_new_event_fk FOREIGN KEY (tenant_id, new_event_id)
    REFERENCES price_events (tenant_id, id) ON DELETE RESTRICT,
  -- Q-B6: at most 50 000 materialized lines per set.
  CONSTRAINT price_change_set_lines_line_no CHECK (line_no BETWEEN 1 AND 50000),
  CONSTRAINT price_change_set_lines_op CHECK (op IN (
    'set_price', 'adjust_amount', 'adjust_percent', 'end_price', 'reset_store_override', 'move_store_zone')),
  CONSTRAINT price_change_set_lines_scope CHECK (scope IN ('book', 'zone', 'store')),
  CONSTRAINT price_change_set_lines_scope_target CHECK (
    (scope = 'book' AND price_zone_id IS NULL AND store_id IS NULL)
    OR (scope = 'zone' AND price_zone_id IS NOT NULL AND store_id IS NULL)
    OR (scope = 'store' AND store_id IS NOT NULL AND (price_zone_id IS NULL OR op = 'move_store_zone'))),
  -- A Zone move names its Store and target Zone, no product, absolute bounds;
  -- every other line names a product and its v1 Sell Unit (NULL never passes).
  CONSTRAINT price_change_set_lines_move CHECK (
    (op = 'move_store_zone' AND scope = 'store' AND price_zone_id IS NOT NULL AND product_id IS NULL
       AND sell_unit IS NULL AND time_basis = 'absolute' AND new_price IS NULL)
    OR (op <> 'move_store_zone' AND product_id IS NOT NULL AND sell_unit IS NOT NULL AND sell_unit = 'each')),
  CONSTRAINT price_change_set_lines_reset_scope CHECK (op <> 'reset_store_override' OR scope = 'store'),
  CONSTRAINT price_change_set_lines_time_basis CHECK (time_basis IN ('store_local', 'absolute')),
  CONSTRAINT price_change_set_lines_bounds CHECK (
    (time_basis = 'absolute' AND effective_from IS NOT NULL
       AND effective_from_local IS NULL AND effective_to_local IS NULL
       AND (effective_to IS NULL OR effective_to > effective_from))
    OR (time_basis = 'store_local' AND effective_from_local IS NOT NULL
       AND effective_from IS NULL AND effective_to IS NULL
       AND (effective_to_local IS NULL OR effective_to_local > effective_from_local))),
  -- A priced line has a concrete, positive price (0 is no v1 price, Q-4),
  -- except an `invalid` one (a helper result <= 0 or not representable, spec
  -- 042 §5), which may carry none so validation can still record the finding;
  -- an end, reset or move has none.
  CONSTRAINT price_change_set_lines_price CHECK (
    (op IN ('set_price', 'adjust_amount', 'adjust_percent') AND new_price IS NOT NULL AND new_price > 0)
    OR (op IN ('set_price', 'adjust_amount', 'adjust_percent') AND class = 'invalid' AND new_price IS NULL)
    OR (op IN ('end_price', 'reset_store_override', 'move_store_zone') AND new_price IS NULL)),
  CONSTRAINT price_change_set_lines_rounded_from CHECK (
    rounded_from IS NULL OR op IN ('adjust_amount', 'adjust_percent')),
  CONSTRAINT price_change_set_lines_class CHECK (class IN (
    'new', 'replaces', 'conflicts_pending', 'shadowed', 'invalidates_dependent', 'past_dated', 'invalid')),
  CONSTRAINT price_change_set_lines_new_event CHECK (
    new_event_id IS NULL OR (op IN ('set_price', 'adjust_amount', 'adjust_percent') AND new_price IS NOT NULL))
);

CREATE INDEX ix_price_change_set_lines_product
  ON price_change_set_lines (tenant_id, product_id) WHERE product_id IS NOT NULL;
CREATE INDEX ix_price_change_set_lines_zone
  ON price_change_set_lines (tenant_id, price_zone_id) WHERE price_zone_id IS NOT NULL;
-- The §3 intersection check reads a set's lines by Store.
CREATE INDEX ix_price_change_set_lines_store
  ON price_change_set_lines (tenant_id, store_id) WHERE store_id IS NOT NULL;
-- An event is the result of exactly one line.
CREATE UNIQUE INDEX uq_price_change_set_lines_new_event
  ON price_change_set_lines (tenant_id, new_event_id) WHERE new_event_id IS NOT NULL;

-- Lines are written only by their validation's transaction, with no publish
-- record yet, and replace only events or memberships of their own tenant.
CREATE FUNCTION price_change_set_lines_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.price_change_set_validation_sealed(NEW.tenant_id, NEW.change_set_id, NEW.change_set_version) THEN
    RAISE EXCEPTION 'price_change_set_lines: the validation of change set % version % is sealed (written by another transaction) or missing',
      NEW.change_set_id, NEW.change_set_version
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.line_no > (SELECT v.line_count FROM public.price_change_set_validations v
                     WHERE v.tenant_id = NEW.tenant_id AND v.change_set_id = NEW.change_set_id
                       AND v.change_set_version = NEW.change_set_version) THEN
    RAISE EXCEPTION 'price_change_set_lines: line_no % is beyond the validation''s line count', NEW.line_no
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.new_event_id IS NOT NULL OR cardinality(NEW.result_ids) > 0 THEN
    RAISE EXCEPTION 'price_change_set_lines: new_event_id and result_ids are set at publish, not at validation'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.replaced_ids) AS r(id)
              WHERE NOT EXISTS (SELECT 1 FROM public.price_events e WHERE e.tenant_id = NEW.tenant_id AND e.id = r.id)
                AND NOT EXISTS (SELECT 1 FROM public.price_zone_memberships m WHERE m.tenant_id = NEW.tenant_id AND m.id = r.id)) THEN
    RAISE EXCEPTION 'price_change_set_lines: replaced_ids names an id that is no price event or membership of the tenant'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;

-- The only change: new_event_id and result_ids, from unset to set, once, by
-- the transaction that published the set (its revision was issued here), only
-- on a line of the validation the set was approved for (the set's latest
-- validation, whose preview hash the set carries), never on a blocking line
-- (`invalid`; `past_dated` unless the set is an emergency or a rollback, owner
-- decision 2026-11-19), new_event_id only
-- to the event this set published in that revision for this line's own
-- target, product, sell unit, price, time basis and interval, and result_ids
-- only to events or memberships published in that revision.
CREATE FUNCTION price_change_set_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_revision bigint;
  v_kind text;
  v_preview_hash text;
  v_latest integer;
  v_latest_hash text;
BEGIN
  IF OLD.new_event_id IS NOT NULL OR cardinality(OLD.result_ids) > 0
     OR (NEW.new_event_id IS NULL AND cardinality(NEW.result_ids) = 0)
     OR (to_jsonb(NEW) - 'new_event_id' - 'result_ids') IS DISTINCT FROM (to_jsonb(OLD) - 'new_event_id' - 'result_ids') THEN
    RAISE EXCEPTION 'price_change_set_lines: a line is immutable; only its publish record (new_event_id, result_ids) is set, once'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT cs.revision_no, cs.kind, cs.preview_hash INTO v_revision, v_kind, v_preview_hash
    FROM public.change_sets cs
   WHERE cs.tenant_id = NEW.tenant_id AND cs.id = NEW.change_set_id;
  IF v_revision IS NULL OR NOT public.pricing_revision_issued_here(NEW.tenant_id, v_revision) THEN
    RAISE EXCEPTION 'price_change_set_lines: change set % was not published by this transaction', NEW.change_set_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT v.change_set_version, v.preview_hash INTO v_latest, v_latest_hash
    FROM public.price_change_set_validations v
   WHERE v.tenant_id = NEW.tenant_id AND v.change_set_id = NEW.change_set_id
   ORDER BY v.change_set_version DESC
   LIMIT 1;
  IF NEW.change_set_version IS DISTINCT FROM v_latest OR v_latest_hash IS DISTINCT FROM v_preview_hash THEN
    RAISE EXCEPTION 'price_change_set_lines: only the lines of the approved validation (version %) are published, not version %',
      v_latest, NEW.change_set_version
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.class = 'invalid' OR (NEW.class = 'past_dated' AND v_kind NOT IN ('emergency', 'rollback')) THEN
    RAISE EXCEPTION 'price_change_set_lines: a % line of a % set is never published', NEW.class, v_kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.new_event_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.price_events e
        WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.new_event_id
          AND e.change_set_id = NEW.change_set_id AND e.published_in_revision = v_revision
          AND e.price_book_id = NEW.price_book_id AND e.scope = NEW.scope
          AND e.price_zone_id IS NOT DISTINCT FROM NEW.price_zone_id
          AND e.store_id IS NOT DISTINCT FROM NEW.store_id
          AND e.product_id = NEW.product_id AND e.sell_unit = NEW.sell_unit
          AND e.price = NEW.new_price AND e.time_basis = NEW.time_basis
          AND e.effective_from IS NOT DISTINCT FROM NEW.effective_from
          AND e.effective_to IS NOT DISTINCT FROM NEW.effective_to
          AND e.effective_from_local IS NOT DISTINCT FROM NEW.effective_from_local
          AND e.effective_to_local IS NOT DISTINCT FROM NEW.effective_to_local) THEN
    RAISE EXCEPTION 'price_change_set_lines: event % is not the event this set published for this line', NEW.new_event_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.result_ids) AS r(id)
              WHERE NOT EXISTS (SELECT 1 FROM public.price_events e
                                 WHERE e.tenant_id = NEW.tenant_id AND e.id = r.id
                                   AND e.change_set_id = NEW.change_set_id AND e.published_in_revision = v_revision)
                AND NOT EXISTS (SELECT 1 FROM public.price_zone_memberships m
                                 WHERE m.tenant_id = NEW.tenant_id AND m.id = r.id AND m.published_in_revision = v_revision)) THEN
    RAISE EXCEPTION 'price_change_set_lines: result_ids names an id this set''s publish did not write'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER price_change_set_lines_before_insert BEFORE INSERT ON price_change_set_lines
  FOR EACH ROW EXECUTE FUNCTION price_change_set_lines_before_insert();
CREATE TRIGGER price_change_set_lines_guard BEFORE UPDATE ON price_change_set_lines
  FOR EACH ROW EXECUTE FUNCTION price_change_set_lines_guard();
CREATE TRIGGER price_change_set_lines_no_delete_row BEFORE DELETE ON price_change_set_lines
  FOR EACH ROW EXECUTE FUNCTION price_change_set_content_append_only();
CREATE TRIGGER price_change_set_lines_no_delete_truncate BEFORE TRUNCATE ON price_change_set_lines
  FOR EACH STATEMENT EXECUTE FUNCTION price_change_set_content_append_only();

-- =============================================================================
-- 4. The stored Impact Preview (spec 042 §6)
-- =============================================================================

-- One `PreviewLine` per (priced, ended or reset line, Store): the old and new
-- resolved price and source scope at that Store at the line's exact
-- activation instant there. A Zone move has no product rows, only its
-- membership change (owner decision 2026-11-19).
CREATE TABLE price_change_set_preview_lines (
  tenant_id           UUID            NOT NULL,
  change_set_id       UUID            NOT NULL,
  change_set_version  INTEGER         NOT NULL,
  line_no             INTEGER         NOT NULL,
  -- The row's place in the contract's page order (storeId, productId,
  -- sellUnit, effectiveFrom), 1..preview_line_count: the keyset cursor.
  row_no              INTEGER         NOT NULL,
  store_id            UUID            NOT NULL,
  product_id          UUID            NOT NULL,
  sell_unit           TEXT            NOT NULL,
  old_price           NUMERIC(19, 4)  NULL,
  old_source_scope    TEXT            NULL,
  new_price           NUMERIC(19, 4)  NULL,
  new_source_scope    TEXT            NULL,
  -- `DeltaPercent`: up to 22 integer digits.
  delta_pct           NUMERIC(24, 2)  NULL,
  rounded_from        NUMERIC(23, 8)  NULL,
  effective_from      TIMESTAMPTZ     NOT NULL,
  class               TEXT            NOT NULL,
  devices             INTEGER         NOT NULL,
  messages            TEXT[]          NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT price_change_set_preview_lines_pk PRIMARY KEY (tenant_id, change_set_id, change_set_version, line_no, store_id),
  CONSTRAINT price_change_set_preview_lines_line_fk FOREIGN KEY (tenant_id, change_set_id, change_set_version, line_no)
    REFERENCES price_change_set_lines (tenant_id, change_set_id, change_set_version, line_no) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_preview_lines_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_preview_lines_product_fk FOREIGN KEY (product_id, tenant_id)
    REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_preview_lines_sell_unit CHECK (sell_unit = 'each'),
  CONSTRAINT price_change_set_preview_lines_scopes CHECK (
    (old_source_scope IS NULL OR old_source_scope IN ('book', 'zone', 'store'))
    AND (new_source_scope IS NULL OR new_source_scope IN ('book', 'zone', 'store'))),
  CONSTRAINT price_change_set_preview_lines_prices CHECK (
    (old_price IS NULL OR old_price >= 0) AND (new_price IS NULL OR new_price > 0)),
  CONSTRAINT price_change_set_preview_lines_row_no CHECK (row_no >= 1),
  CONSTRAINT price_change_set_preview_lines_row_uk UNIQUE (tenant_id, change_set_id, change_set_version, row_no),
  CONSTRAINT price_change_set_preview_lines_class CHECK (class IN (
    'new', 'replaces', 'conflicts_pending', 'shadowed', 'invalidates_dependent', 'past_dated', 'invalid')),
  CONSTRAINT price_change_set_preview_lines_devices CHECK (devices >= 0)
);


-- One `PreviewMembershipChange` per Zone move line.
CREATE TABLE price_change_set_preview_memberships (
  tenant_id                  UUID         NOT NULL,
  change_set_id              UUID         NOT NULL,
  change_set_version         INTEGER      NOT NULL,
  line_no                    INTEGER      NOT NULL,
  store_id                   UUID         NOT NULL,
  -- NULL: the Store fell back to the Book's default Zone.
  from_zone_id               UUID         NULL,
  to_zone_id                 UUID         NOT NULL,
  effective_from             TIMESTAMPTZ  NOT NULL,
  effective_to               TIMESTAMPTZ  NULL,
  superseded_membership_ids  UUID[]       NOT NULL DEFAULT '{}',
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT price_change_set_preview_memberships_pk PRIMARY KEY (tenant_id, change_set_id, change_set_version, line_no),
  CONSTRAINT price_change_set_preview_memberships_line_fk FOREIGN KEY (tenant_id, change_set_id, change_set_version, line_no)
    REFERENCES price_change_set_lines (tenant_id, change_set_id, change_set_version, line_no) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_preview_memberships_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_preview_memberships_from_fk FOREIGN KEY (tenant_id, from_zone_id)
    REFERENCES price_zones (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_preview_memberships_to_fk FOREIGN KEY (tenant_id, to_zone_id)
    REFERENCES price_zones (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_preview_memberships_bounds CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- Preview rows are written only by their validation's transaction, within its
-- counts, and only as its line says: a preview line for that line's product,
-- sell unit, class (and Store, for a Store line); a membership change only for
-- a Zone move of that Store to that Zone over that interval, superseding only
-- memberships of that Store.
CREATE FUNCTION price_change_set_preview_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  l public.price_change_set_lines%ROWTYPE;
  v_count integer;
BEGIN
  IF NOT public.price_change_set_validation_sealed(NEW.tenant_id, NEW.change_set_id, NEW.change_set_version) THEN
    RAISE EXCEPTION '%: the validation of change set % version % is sealed (written by another transaction) or missing',
      TG_TABLE_NAME, NEW.change_set_id, NEW.change_set_version
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO l FROM public.price_change_set_lines pl
   WHERE pl.tenant_id = NEW.tenant_id AND pl.change_set_id = NEW.change_set_id
     AND pl.change_set_version = NEW.change_set_version AND pl.line_no = NEW.line_no;
  -- Nested, not AND-ed: the two tables have different columns, and PL/pgSQL resolves NEW fields eagerly.
  IF TG_TABLE_NAME = 'price_change_set_preview_memberships' THEN
    IF l.op IS DISTINCT FROM 'move_store_zone' OR l.store_id IS DISTINCT FROM NEW.store_id
       OR l.price_zone_id IS DISTINCT FROM NEW.to_zone_id
       OR l.effective_from IS DISTINCT FROM NEW.effective_from OR l.effective_to IS DISTINCT FROM NEW.effective_to THEN
      RAISE EXCEPTION 'price_change_set_preview_memberships: line % is not a Zone move of that Store to that Zone over that interval',
        NEW.line_no
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(NEW.superseded_membership_ids) AS r(id)
                WHERE NOT EXISTS (SELECT 1 FROM public.price_zone_memberships m
                                   WHERE m.tenant_id = NEW.tenant_id AND m.id = r.id AND m.store_id = NEW.store_id)) THEN
      RAISE EXCEPTION 'price_change_set_preview_memberships: superseded_membership_ids names no membership of Store %', NEW.store_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF l.op IS NULL OR l.op = 'move_store_zone' OR l.product_id IS DISTINCT FROM NEW.product_id
       OR l.sell_unit IS DISTINCT FROM NEW.sell_unit OR l.class IS DISTINCT FROM NEW.class
       OR (l.scope = 'store' AND l.store_id IS DISTINCT FROM NEW.store_id) THEN
      RAISE EXCEPTION 'price_change_set_preview_lines: the row does not match line % (product, sell unit, class, Store)', NEW.line_no
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT v.preview_line_count INTO v_count FROM public.price_change_set_validations v
     WHERE v.tenant_id = NEW.tenant_id AND v.change_set_id = NEW.change_set_id
       AND v.change_set_version = NEW.change_set_version;
    IF NEW.row_no > v_count THEN
      RAISE EXCEPTION 'price_change_set_preview_lines: row_no % is beyond the validation''s preview count', NEW.row_no
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER price_change_set_preview_lines_before_insert BEFORE INSERT ON price_change_set_preview_lines
  FOR EACH ROW EXECUTE FUNCTION price_change_set_preview_before_insert();
CREATE TRIGGER price_change_set_preview_lines_append_only_row BEFORE UPDATE OR DELETE ON price_change_set_preview_lines
  FOR EACH ROW EXECUTE FUNCTION price_change_set_content_append_only();
CREATE TRIGGER price_change_set_preview_lines_append_only_truncate BEFORE TRUNCATE ON price_change_set_preview_lines
  FOR EACH STATEMENT EXECUTE FUNCTION price_change_set_content_append_only();
CREATE TRIGGER price_change_set_preview_memberships_before_insert BEFORE INSERT ON price_change_set_preview_memberships
  FOR EACH ROW EXECUTE FUNCTION price_change_set_preview_before_insert();
CREATE TRIGGER price_change_set_preview_memberships_append_only_row BEFORE UPDATE OR DELETE ON price_change_set_preview_memberships
  FOR EACH ROW EXECUTE FUNCTION price_change_set_content_append_only();
CREATE TRIGGER price_change_set_preview_memberships_append_only_truncate BEFORE TRUNCATE ON price_change_set_preview_memberships
  FOR EACH STATEMENT EXECUTE FUNCTION price_change_set_content_append_only();

-- =============================================================================
-- 5. change_sets: a set leaves draft only with its validation; publish is complete
-- =============================================================================

-- Item lists, validations and lines are keyed by the set's version and written
-- only while it is a draft at that version, keeping every earlier one. So:
--   - any move back into `draft` (an edit, a stale validation, a reject)
--     starts a new version, or the next validation would collide with the
--     kept one;
--   - a set leaves `draft` (except to `cancelled`, and except the system
--     `legacy_import` set, which has no preview) only when a validation exists
--     at its version whose preview hash, target-Store-set hash, sensitivity
--     and revision it carries;
--   - the validation is of the set's current item list (no list is written at
--     or below a validated version);
--   - outside `draft` (to `cancelled` too), that binding (preview hash, target
--     hash, sensitivity) never changes; validated_at_revision may still
--     advance past a non-intersecting head (§3), never back;
--   - blocking lines (`invalid`; `past_dated` unless emergency or rollback)
--     block submit, approve and publish;
--   - a publish's per-line record is complete at COMMIT
--     (change_sets_publish_complete).
-- Owner decisions 2026-11-19: every return to draft (edit, stale, reject) is
-- a new version; a rollback may publish past-dated lines; a priced line's
-- price is > 0; a Zone move has no per-product preview rows.
CREATE FUNCTION change_sets_content_rules() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.price_change_set_validations%ROWTYPE;
  v_latest_list integer;
BEGIN
  IF NEW.state = 'draft' AND OLD.state <> 'draft' AND NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'change set %: a return to draft from % increments the version', OLD.id, OLD.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'draft' OR NEW.kind = 'legacy_import' THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'draft' THEN
    IF NEW.state = 'cancelled' THEN
      RETURN NEW;
    END IF;
    SELECT * INTO v FROM public.price_change_set_validations pv
     WHERE pv.tenant_id = NEW.tenant_id AND pv.change_set_id = NEW.id AND pv.change_set_version = NEW.version;
    SELECT max(l.change_set_version) INTO v_latest_list FROM public.price_change_set_item_lists l
     WHERE l.tenant_id = NEW.tenant_id AND l.change_set_id = NEW.id AND l.change_set_version <= NEW.version;
    IF NOT FOUND OR v.change_set_version IS NULL
       OR v.item_list_version IS DISTINCT FROM v_latest_list
       OR v.preview_hash IS DISTINCT FROM NEW.preview_hash
       OR v.target_store_set_hash IS DISTINCT FROM NEW.target_store_set_hash
       OR v.sensitive IS DISTINCT FROM NEW.sensitive
       OR v.sensitivity_reasons IS DISTINCT FROM NEW.sensitivity_reasons
       OR v.validated_at_revision IS DISTINCT FROM NEW.validated_at_revision THEN
      RAISE EXCEPTION 'change set %: it leaves draft only with the validation at version % of its current item list (preview, target Stores, sensitivity, revision)',
        OLD.id, NEW.version
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.preview_hash IS DISTINCT FROM OLD.preview_hash
     OR NEW.target_store_set_hash IS DISTINCT FROM OLD.target_store_set_hash
     OR NEW.sensitive IS DISTINCT FROM OLD.sensitive
     OR NEW.sensitivity_reasons IS DISTINCT FROM OLD.sensitivity_reasons
     OR NEW.validated_at_revision < OLD.validated_at_revision THEN
    -- Also on the way to `cancelled`: the record of what was validated is kept as it was.
    RAISE EXCEPTION 'change set %: outside draft its validation binding never changes', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Blocking lines block submit, approve and publish (contract `422 blocking_findings`):
  -- `invalid`, and `past_dated` unless the set is an emergency or a rollback.
  IF NEW.state IN ('pending_approval', 'approved', 'published') AND NEW.state IS DISTINCT FROM OLD.state
     AND EXISTS (SELECT 1 FROM public.price_change_set_lines l
                  WHERE l.tenant_id = NEW.tenant_id AND l.change_set_id = NEW.id AND l.change_set_version = NEW.version
                    AND (l.class = 'invalid' OR (l.class = 'past_dated' AND NEW.kind NOT IN ('emergency', 'rollback')))) THEN
    RAISE EXCEPTION 'change set %: its validation has blocking lines; it cannot become %', OLD.id, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- At COMMIT of a publish (not legacy_import): every priced line of the
-- approved validation recorded the event it became, and every event and
-- membership row the revision wrote is recorded on exactly one line
-- (new_event_id or result_ids): the §10 before/after record is complete.
-- Like every deferred check, it runs at COMMIT; a transaction that forces it
-- early with SET CONSTRAINTS ... IMMEDIATE and writes more afterwards is the
-- runtime's to prevent (RT-1484 sets constraints only as its last statement).
CREATE FUNCTION change_sets_publish_complete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  n integer;
BEGIN
  IF NEW.state <> 'published' OR OLD.state = 'published' OR NEW.kind = 'legacy_import' THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO n FROM public.price_change_set_lines l
   WHERE l.tenant_id = NEW.tenant_id AND l.change_set_id = NEW.id AND l.change_set_version = NEW.version
     AND l.op IN ('set_price', 'adjust_amount', 'adjust_percent') AND l.new_event_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'change set %: % priced line(s) of the published validation recorded no event', NEW.id, n
      USING ERRCODE = 'check_violation';
  END IF;
  WITH recorded AS (
    SELECT l.new_event_id AS id FROM public.price_change_set_lines l
     WHERE l.tenant_id = NEW.tenant_id AND l.change_set_id = NEW.id AND l.new_event_id IS NOT NULL
    UNION ALL
    SELECT r.id FROM public.price_change_set_lines l, unnest(l.result_ids) AS r(id)
     WHERE l.tenant_id = NEW.tenant_id AND l.change_set_id = NEW.id
  ), written AS (
    SELECT e.id FROM public.price_events e
     WHERE e.tenant_id = NEW.tenant_id AND e.published_in_revision = NEW.revision_no
    UNION ALL
    SELECT m.id FROM public.price_zone_memberships m
     WHERE m.tenant_id = NEW.tenant_id AND m.published_in_revision = NEW.revision_no
  )
  SELECT count(*) INTO n FROM (
    SELECT w.id FROM written w
     WHERE (SELECT count(*) FROM recorded r WHERE r.id = w.id) <> 1
    UNION ALL
    SELECT r.id FROM recorded r GROUP BY r.id HAVING count(*) > 1
  ) bad;
  IF n > 0 THEN
    RAISE EXCEPTION 'change set %: % row(s) of revision % are not recorded on exactly one line', NEW.id, n, NEW.revision_no
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER change_sets_content_rules BEFORE UPDATE ON change_sets
  FOR EACH ROW EXECUTE FUNCTION change_sets_content_rules();
CREATE CONSTRAINT TRIGGER change_sets_publish_complete AFTER UPDATE ON change_sets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION change_sets_publish_complete();

-- =============================================================================
-- 6. Row-level security
-- =============================================================================

DO $$
DECLARE
  -- The empty-GUC CASE guard: '' reads as NULL, never a cast error.
  tenant_match CONSTANT text := 'tenant_id = CASE'
    || ' WHEN current_setting(''app.current_tenant'', true) = '''' THEN NULL'
    || ' ELSE current_setting(''app.current_tenant'', true)::uuid END';
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['price_change_set_item_lists', 'price_change_set_items', 'price_change_set_validations',
                           'price_change_set_lines', 'price_change_set_preview_lines',
                           'price_change_set_preview_memberships'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', t || '_tenant_select', t, tenant_match);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', t || '_tenant_insert', t, tenant_match);
  END LOOP;
  EXECUTE format('CREATE POLICY price_change_set_lines_tenant_update ON price_change_set_lines FOR UPDATE USING (%s) WITH CHECK (%s)',
    tenant_match, tenant_match);
END
$$;

COMMIT;
