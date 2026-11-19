-- 0123_price_change_set_items_lines.sql
--
-- Price Change Set content: authored items and materialized lines (Jira
-- RT-1151, RT-282 PR-05, owner decision D5(a): RT-1151 creates the Change Set
-- items and lines tables in their own migration; comment 17783). [GATED:
-- migration]. Depends on 0121 (change_sets, price_zones, price_events).
--
-- Source-of-truth artifacts:
--   - services/backend-core/specs/042-price-change-set-lifecycle/plan.md §3
--     (versioned drafts), §4.2 (items), §4.3 (materialization into lines),
--     §5 (classes), §6 (preview), §10 (per-line before/after record, Q-B5)
--   - packages/contracts/openapi/pricing/price-change-sets.yaml 1.0.0-draft:
--     `PriceChangeItem`, `LineClass`, `PreviewLine`
--   - packages/db/__tests__/migration/0123-price-change-set-items-lines.spec.ts
--
-- Two new tables, plus one trigger on 0121's change_sets (section 3: every
-- return to draft increments the version). No runtime reads or writes them
-- until RT-1484 (PR-10).
--
-- Concurrency: the item and line insert triggers lock the set's change_sets
-- row FOR NO KEY UPDATE, so two writers of one set's content (two validates,
-- or an edit and a validate) serialize on that row instead of deadlocking;
-- the second then sees the version the first moved and is refused.
--
--   price_change_set_items   The items a Change Set's author wrote (spec 042
--                            §4.2), one row per item per DRAFT VERSION: an edit
--                            (PATCH) writes the full item list again at the
--                            new version, so every edit is kept. The current
--                            items are the rows at the set's highest written
--                            version. `item` is the authored `PriceChangeItem`
--                            object (selectors, price or helper, time basis,
--                            bounds); the runtime validates it. INSERT only,
--                            and only while the set is `draft` at exactly that
--                            version; never updated or deleted.
--   price_change_set_lines   The materialized lines (§4.3): one concrete
--                            (scope target, product, sell unit) row, or one
--                            Zone move, with its concrete new price, its
--                            validation class (§5) and the events it replaces.
--                            Written by `validate` while the set is still
--                            `draft` at that version (validation then moves
--                            the set to `validated`), from the set's latest
--                            items. A re-validation always runs at a new
--                            version (an edit or a stale validation
--                            increments it), so earlier lines are kept. Immutable, except that
--                            `new_event_id` is set ONCE, by the transaction
--                            that publishes the set, to the event the line
--                            became: with `replaced_event_ids` this is the
--                            per-line before/after record of §10 (Q-B5).
--                            The per-Store preview rows of the contract are
--                            derived from the lines and the timeline at
--                            `validated_at_revision`, which is deterministic
--                            (spec 041 §4.1), so they are not stored.
--
-- RLS: ENABLE + FORCE with tenant SELECT and INSERT policies on both, UPDATE
-- on lines only (bounded by the guard). No DELETE policy.
--
-- Grants: none here. Production grants the domain role SELECT and INSERT on
-- both and column-level UPDATE (new_event_id) on lines, outside migrations:
-- docs/operations/sql/price-change-set-content-domain-grants.sql (deploy step
-- 2). The API refuses to boot without them (DOMAIN_REQUIRED_GRANTS,
-- apps/api/src/auth/grants/price-change-set-content.grants.ts).
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS. Authored
-- items (selectors of product / category / zone / store ids, prices, dates),
-- materialized prices and finding codes. No customer reference. Kept: the
-- lines of a published set are its audit record.
--
-- Deploy window: none. Both tables are new and empty; no existing table
-- changes. Apply 0123 and the grants script before the API that uses them.
--
-- Lock impact: ONE transaction, lock_timeout 2s. The new FKs take SHARE ROW
-- EXCLUSIVE on change_sets, price_books, price_zones, stores,
-- tenant_products and price_events until COMMIT (all but stores and
-- tenant_products are new and unused before RT-1484). Reads continue.
--
-- Reversal: 0123_price_change_set_items_lines.down.sql REFUSES while either
-- table holds a row; otherwise it drops both and their functions.

BEGIN;

SET LOCAL lock_timeout = '2s';

-- =============================================================================
-- 1. price_change_set_items (versioned, insert-only)
-- =============================================================================

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
  CONSTRAINT price_change_set_items_set_fk FOREIGN KEY (tenant_id, change_set_id)
    REFERENCES change_sets (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_change_set_items_version_positive CHECK (change_set_version >= 1),
  -- The contract caps a set at 500 items (CreatePriceChangeSetRequest.items).
  CONSTRAINT price_change_set_items_position CHECK (position BETWEEN 1 AND 500),
  CONSTRAINT price_change_set_items_op CHECK (op IN (
    'set_price', 'adjust_amount', 'adjust_percent', 'end_price', 'reset_store_override', 'move_store_zone')),
  -- The authored item is an object whose `op` is the row's op.
  CONSTRAINT price_change_set_items_item_shape CHECK (
    jsonb_typeof(item) = 'object' AND (item ->> 'op') IS NOT DISTINCT FROM op)
);

-- Items are written only while their set is a draft at exactly that version,
-- and never below a version already written.
CREATE FUNCTION price_change_set_items_before_insert() RETURNS trigger
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
    RAISE EXCEPTION 'price_change_set_items: change set % is % at version %, not a draft at version %',
      NEW.change_set_id, v_state, v_version, NEW.change_set_version
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.price_change_set_items i
              WHERE i.tenant_id = NEW.tenant_id AND i.change_set_id = NEW.change_set_id
                AND i.change_set_version > NEW.change_set_version) THEN
    RAISE EXCEPTION 'price_change_set_items: change set % already has items at a later version', NEW.change_set_id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;

-- Refuses UPDATE, DELETE and TRUNCATE for every role.
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

CREATE TRIGGER price_change_set_items_before_insert BEFORE INSERT ON price_change_set_items
  FOR EACH ROW EXECUTE FUNCTION price_change_set_items_before_insert();
CREATE TRIGGER price_change_set_items_append_only_row BEFORE UPDATE OR DELETE ON price_change_set_items
  FOR EACH ROW EXECUTE FUNCTION price_change_set_content_append_only();
CREATE TRIGGER price_change_set_items_append_only_truncate BEFORE TRUNCATE ON price_change_set_items
  FOR EACH STATEMENT EXECUTE FUNCTION price_change_set_content_append_only();

-- =============================================================================
-- 2. price_change_set_lines (materialized at validation)
-- =============================================================================

CREATE TABLE price_change_set_lines (
  tenant_id             UUID            NOT NULL,
  change_set_id         UUID            NOT NULL,
  change_set_version    INTEGER         NOT NULL,
  line_no               INTEGER         NOT NULL,
  -- The authored item the line was materialized from: the set's latest
  -- written items, which may be an earlier version than the one validated (a
  -- stale validation or a header-only edit increments the version without
  -- rewriting the items).
  item_version          INTEGER         NOT NULL,
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
  -- The concrete price after publish; NULL for end_price, reset_store_override and a Zone move.
  new_price             NUMERIC(19, 4)  NULL,
  -- A helper's exact, unrounded result when it was not representable (spec 041 §6).
  rounded_from          NUMERIC(30, 8)  NULL,
  class                 TEXT            NOT NULL,
  messages              TEXT[]          NOT NULL DEFAULT '{}',
  -- The active events (or memberships, for a move) this line supersedes at publish.
  replaced_ids          UUID[]          NOT NULL DEFAULT '{}',
  -- Set ONCE at publish: the event this line became (NULL for a move or an end/reset).
  new_event_id          UUID            NULL,
  created_by_user_id    UUID            NOT NULL,
  created_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),
  correlation_id        UUID            NOT NULL,
  CONSTRAINT price_change_set_lines_pk PRIMARY KEY (tenant_id, change_set_id, change_set_version, line_no),
  CONSTRAINT price_change_set_lines_item_fk FOREIGN KEY (tenant_id, change_set_id, item_version, item_position)
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
  CONSTRAINT price_change_set_lines_item_version CHECK (item_version BETWEEN 1 AND change_set_version),
  CONSTRAINT price_change_set_lines_op CHECK (op IN (
    'set_price', 'adjust_amount', 'adjust_percent', 'end_price', 'reset_store_override', 'move_store_zone')),
  CONSTRAINT price_change_set_lines_scope CHECK (scope IN ('book', 'zone', 'store')),
  CONSTRAINT price_change_set_lines_scope_target CHECK (
    (scope = 'book' AND price_zone_id IS NULL AND store_id IS NULL)
    OR (scope = 'zone' AND price_zone_id IS NOT NULL AND store_id IS NULL)
    OR (scope = 'store' AND store_id IS NOT NULL AND (price_zone_id IS NULL OR op = 'move_store_zone'))),
  -- A Zone move names its Store and target Zone, no product, absolute bounds;
  -- every other line names a product and its v1 Sell Unit.
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
  -- A priced line has a concrete, non-negative price, except an `invalid` one
  -- (a helper result <= 0 or not representable, spec 042 §5), which may carry
  -- none so validation can still record the finding; an end, reset or move
  -- has none.
  CONSTRAINT price_change_set_lines_price CHECK (
    (op IN ('set_price', 'adjust_amount', 'adjust_percent') AND new_price IS NOT NULL AND new_price >= 0)
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

-- Lines are written only while their set is a draft at exactly that version
-- (validation writes them, then moves the set to `validated`).
CREATE FUNCTION price_change_set_lines_before_insert() RETURNS trigger
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
    RAISE EXCEPTION 'price_change_set_lines: change set % is % at version %, not a draft at version %',
      NEW.change_set_id, v_state, v_version, NEW.change_set_version
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.item_version IS DISTINCT FROM (
       SELECT max(i.change_set_version) FROM public.price_change_set_items i
        WHERE i.tenant_id = NEW.tenant_id AND i.change_set_id = NEW.change_set_id) THEN
    RAISE EXCEPTION 'price_change_set_lines: a line is materialized from the set''s latest items, not version %', NEW.item_version
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.new_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'price_change_set_lines: new_event_id is set at publish, not at validation'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;

-- The only change: new_event_id, NULL -> the event, once, by the transaction
-- that published the set (its revision was issued here), only on a line of the
-- set's latest validation, and only to an event of this set published in that
-- revision (the unique index makes each event one line's result).
CREATE FUNCTION price_change_set_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_revision bigint;
BEGIN
  IF OLD.new_event_id IS NOT NULL OR NEW.new_event_id IS NULL
     OR (to_jsonb(NEW) - 'new_event_id') IS DISTINCT FROM (to_jsonb(OLD) - 'new_event_id') THEN
    RAISE EXCEPTION 'price_change_set_lines: a line is immutable; only new_event_id is set, once, at publish'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.change_set_version IS DISTINCT FROM (
       SELECT max(l.change_set_version) FROM public.price_change_set_lines l
        WHERE l.tenant_id = NEW.tenant_id AND l.change_set_id = NEW.change_set_id) THEN
    RAISE EXCEPTION 'price_change_set_lines: only the lines of the set''s latest validation are published, not version %',
      NEW.change_set_version
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT cs.revision_no INTO v_revision
    FROM public.change_sets cs
   WHERE cs.tenant_id = NEW.tenant_id AND cs.id = NEW.change_set_id;
  IF v_revision IS NULL OR NOT public.pricing_revision_issued_here(NEW.tenant_id, v_revision) THEN
    RAISE EXCEPTION 'price_change_set_lines: change set % was not published by this transaction', NEW.change_set_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.price_events e
                  WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.new_event_id
                    AND e.change_set_id = NEW.change_set_id AND e.published_in_revision = v_revision) THEN
    RAISE EXCEPTION 'price_change_set_lines: event % is not an event this set published', NEW.new_event_id
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
-- 3. change_sets: every return to draft increments the version
-- =============================================================================

-- Items and lines are keyed by the set's version and written only while it is
-- a draft at that version, keeping every earlier validation. So any move back
-- into `draft` (an edit, a stale validation, a reject) must start a new
-- version, or the next validation would collide with the kept lines.
CREATE FUNCTION change_sets_redraft_bumps_version() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.state = 'draft' AND OLD.state <> 'draft' AND NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'change set %: a return to draft from % increments the version', OLD.id, OLD.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER change_sets_redraft_bumps_version BEFORE UPDATE OF state ON change_sets
  FOR EACH ROW EXECUTE FUNCTION change_sets_redraft_bumps_version();

-- =============================================================================
-- 4. Row-level security
-- =============================================================================

DO $$
DECLARE
  -- The empty-GUC CASE guard: '' reads as NULL, never a cast error.
  tenant_match CONSTANT text := 'tenant_id = CASE'
    || ' WHEN current_setting(''app.current_tenant'', true) = '''' THEN NULL'
    || ' ELSE current_setting(''app.current_tenant'', true)::uuid END';
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['price_change_set_items', 'price_change_set_lines'] LOOP
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
