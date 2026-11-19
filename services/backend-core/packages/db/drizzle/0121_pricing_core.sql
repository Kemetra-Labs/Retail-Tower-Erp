-- 0121_pricing_core.sql
--
-- Retail Pricing core schema (Jira RT-1151, RT-282 PR-05). [GATED: migration],
-- authorized by the owner on RT-1151 (D1, comment 17783).
--
-- Source-of-truth artifacts:
--   - services/backend-core/specs/041-pricing-domain/spec.md and data-model.md
--     §2.1-§2.6 (OD-1..OD-6, Q-1..Q-8, ratified for planning on RT-483)
--   - services/backend-core/specs/042-price-change-set-lifecycle/plan.md §3,
--     §4.1, §8, §9 (the shared Change Set header; Q-B1..Q-B8)
--   - services/backend-core/specs/044-pricing-legacy-cutover/plan.md R3 (the
--     down migration refuses while the tables hold rows) and §4.2 (the system
--     legacy-import Change Set)
--   - services/backend-core/specs/041-pricing-domain/rt-1151-implementation-plan.md
--   - contracts pricing/price-structure.yaml, pricing/price-change-sets.yaml
--     and pricing/price-inquiry.yaml (1.0.0-draft, RT-1151 PR-04)
--   - packages/db/__tests__/migration/0121-pricing-core.spec.ts
--
-- Seven new tables. No runtime reads or writes them until RT-1484. Legacy price
-- columns (tenant_products.default_price, store_product_overrides.price) and
-- price_history are NOT touched: they stay the only writable price authority
-- until each tenant's cutover (RT-1485, decision 712).
--
--   change_sets                The domain-neutral Change Set header (spec 042
--                              §9, OD-4): domain `pricing` today, `catalog`
--                              later (RT-281). State machine of spec 042 §3,
--                              optimistic `version`, the validation binding
--                              (`validated_at_revision`, `preview_hash`,
--                              `target_store_set_hash`), the actors of each
--                              transition and the revision it published. A
--                              guard trigger keeps identity and creation facts
--                              fixed, the version moving forward, the revision
--                              set once, a published set closed except for its
--                              derived superseded / rolled_back state, and a
--                              terminal set frozen. Items and lines are 0122.
--   price_books                The tenant's Price Books (decisions 471-474). v1
--                              (OD-1): at most one non-retired Book per pricing
--                              context, and it cannot be retired; currency,
--                              tax-price basis and context never change (472,
--                              Q-5). A deferred check makes every Book commit
--                              with exactly one default Zone.
--   price_zones                Zones of a Book (483-486, 492). Exactly one
--                              default Zone per Book, immutable and never
--                              retired (Q-8). A Zone in use (an active
--                              membership or price event) cannot be retired.
--   pricing_revisions          The immutable, tenant-wide, gapless Pricing
--                              Revision (OD-3): 1, 2, 3 ... per tenant (a
--                              trigger), append-only. Each one records the
--                              transaction that issued it (`issue_xact`):
--                              events and memberships can be published or
--                              ended only by that transaction, so a revision's
--                              content is fixed when it commits (528, 530).
--   pricing_revision_stores    The fan-out (data-model §2.6): which Stores a
--                              revision can change. Store applied revision =
--                              max(revision_no) per Store. A row is written by
--                              the issuing transaction, or names the tenant's
--                              head revision (the Store bootstrap row).
--                              Append-only.
--   price_zone_memberships     Effective-dated Store -> Zone membership in a
--                              Book (485, 487, 494), absolute instants only.
--                              No two ACTIVE rows of one Store in one Book
--                              overlap (EXCLUDE, btree_gist from 0016). A row
--                              is only ever superseded (state + ended_in_revision),
--                              never edited.
--   (Every table carries created_by_user_id / correlation_id: the actor and the
--   request or job that wrote the row, data-model "common columns".)
--   price_events               The immutable price timeline (507-514, 521): one
--                              fact per row, scope book / zone / store, time
--                              basis store_local or absolute (Q-1, Q-6). No two
--                              ACTIVE events of one key overlap, per time basis
--                              (two EXCLUDE constraints). A row is only ever
--                              superseded or cancelled, never edited (534).
--
-- What this migration does NOT enforce (Change Set validation in RT-1484 does;
-- spec 041 §5, spec 042 §5):
--   - price > 0 and exactness at the currency minor unit (the DB keeps >= 0,
--     like price_history; Q-4 rejects 0 at validation);
--   - a key not mixing time bases while active (Q-6);
--   - past-dated events outside the emergency path (520);
--   - four eyes, sensitivity and staleness (spec 042 §3, §7);
--   - the completeness of a revision's Store fan-out.
--
-- RLS: ENABLE + FORCE on all seven, with tenant policies (the empty-GUC CASE
-- of 0010 / 0091 / 0097 / 0101): SELECT and INSERT everywhere; UPDATE only on
-- change_sets, price_books, price_zones, price_zone_memberships and
-- price_events, whose guard triggers bound the change. pricing_revisions and
-- pricing_revision_stores are append-only for every role. NO DELETE policy.
--
-- Grants: none here. Production grants the domain role SELECT and INSERT and
-- column-level UPDATE outside migrations:
-- docs/operations/sql/pricing-domain-grants.sql (deploy/README.md step 2). The
-- API refuses to boot without them (DOMAIN_REQUIRED_GRANTS,
-- apps/api/src/auth/grants/pricing.grants.ts).
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS. Codes, names,
-- titles and reasons (short free text, documented "no PII" in the contracts),
-- opaque UUIDs (user ids are operational actors), money (numeric(19,4)),
-- currency codes, instants and local date-times. No customer reference.
-- Pricing facts are kept: nothing is deleted.
--
-- Deploy window: none. Every table is new and empty, and no existing table
-- changes. Apply 0121 and the grants script before the API that uses them
-- (migrate is step 1, grants step 2).
--
-- Lock impact: ONE transaction, lock_timeout 2s. The new FKs take SHARE ROW
-- EXCLUSIVE on tenants, stores and tenant_products until COMMIT (writes to them
-- wait for the rest of this transaction, well under a second; the new tables
-- are empty, so there is no validation scan). Reads continue.
--
-- Reversal: 0121_pricing_core.down.sql REFUSES while any Change Set or Price
-- Book exists (spec 044 R3; every other table needs one of the two); otherwise
-- it drops the seven tables and their functions.

BEGIN;

SET LOCAL lock_timeout = '2s';

-- Refuses UPDATE, DELETE and TRUNCATE on an append-only pricing table, for
-- every role (the 0050 / 0101 pattern).
CREATE FUNCTION pricing_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Pricing revisions are immutable; a correction is a new revision (RT-1151, decisions 530, 534).';
END
$$;

-- Refuses DELETE and TRUNCATE on a pricing table whose rows are only ever
-- superseded, never removed.
CREATE FUNCTION pricing_no_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '%: % is not permitted; pricing facts are kept', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Supersede or cancel instead (RT-1151, decision 534).';
END
$$;

-- =============================================================================
-- 1. change_sets (the shared header, spec 042 §4.1 / §9)
-- =============================================================================

CREATE TABLE change_sets (
  id                        UUID         PRIMARY KEY,
  tenant_id                 UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  domain                    TEXT         NOT NULL,
  kind                      TEXT         NOT NULL,
  title                     TEXT         NOT NULL,
  reason                    TEXT         NULL,
  state                     TEXT         NOT NULL DEFAULT 'draft',
  version                   INTEGER      NOT NULL DEFAULT 1,
  -- The validation binding (spec 042 §3, §6, Q-B8). 0 = the tenant had no revision.
  validated_at_revision     BIGINT       NULL,
  preview_hash              TEXT         NULL,
  target_store_set_hash     TEXT         NULL,
  sensitive                 BOOLEAN      NULL,
  sensitivity_reasons       TEXT[]       NOT NULL DEFAULT '{}',
  -- The Pricing Revision it published (set once, by the publish).
  revision_no               BIGINT       NULL,
  -- For kind = rollback: the published set it rolls back.
  rolls_back_change_set_id  UUID         NULL,
  created_by_user_id        UUID         NOT NULL,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  correlation_id            UUID         NOT NULL,
  submitted_by_user_id      UUID         NULL,
  submitted_at              TIMESTAMPTZ  NULL,
  approved_by_user_id       UUID         NULL,
  approved_at               TIMESTAMPTZ  NULL,
  published_by_user_id      UUID         NULL,
  published_at              TIMESTAMPTZ  NULL,
  cancelled_by_user_id      UUID         NULL,
  cancelled_at              TIMESTAMPTZ  NULL,
  -- The last rejection (spec 042 §3: reject returns the set to draft).
  rejected_by_user_id       UUID         NULL,
  rejected_at               TIMESTAMPTZ  NULL,
  rejection_reason          TEXT         NULL,
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT change_sets_domain CHECK (domain IN ('pricing')),
  CONSTRAINT change_sets_kind CHECK (kind IN ('standard', 'emergency', 'rollback', 'legacy_import')),
  CONSTRAINT change_sets_state CHECK (state IN (
    'draft', 'validated', 'pending_approval', 'approved', 'published', 'superseded', 'rolled_back', 'cancelled')),
  CONSTRAINT change_sets_version_positive CHECK (version >= 1),
  CONSTRAINT change_sets_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT change_sets_reason_length CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 1000),
  CONSTRAINT change_sets_rejection_length CHECK (rejection_reason IS NULL OR char_length(rejection_reason) BETWEEN 1 AND 1000),
  -- Emergency and rollback always carry a reason (spec 042 §4.1, Q-B3).
  CONSTRAINT change_sets_reason_required CHECK (kind NOT IN ('emergency', 'rollback') OR reason IS NOT NULL),
  CONSTRAINT change_sets_rollback_target CHECK ((kind = 'rollback') = (rolls_back_change_set_id IS NOT NULL)),
  CONSTRAINT change_sets_rollback_not_self CHECK (rolls_back_change_set_id IS NULL OR rolls_back_change_set_id <> id),
  CONSTRAINT change_sets_validated_at_revision_non_negative CHECK (validated_at_revision IS NULL OR validated_at_revision >= 0),
  CONSTRAINT change_sets_preview_hash_format CHECK (preview_hash IS NULL OR preview_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT change_sets_target_store_set_hash_format
    CHECK (target_store_set_hash IS NULL OR target_store_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- A preview is whole: validated at a revision, with both hashes and the sensitivity.
  CONSTRAINT change_sets_preview_whole CHECK (
    (preview_hash IS NULL) = (validated_at_revision IS NULL)
    AND (preview_hash IS NULL) = (target_store_set_hash IS NULL)
    AND (preview_hash IS NULL) = (sensitive IS NULL)),
  CONSTRAINT change_sets_sensitivity_reasons CHECK (sensitivity_reasons <@ ARRAY[
    'approval_mode_always', 'delta_threshold', 'store_threshold', 'zone_move', 'past_dated', 'rollback', 'emergency']::text[]),
  -- A state past draft holds its preview; approved and later hold the approval.
  CONSTRAINT change_sets_state_needs_preview
    CHECK (state IN ('draft', 'cancelled') OR preview_hash IS NOT NULL OR kind = 'legacy_import'),
  CONSTRAINT change_sets_submitted_whole CHECK ((submitted_at IS NULL) = (submitted_by_user_id IS NULL)),
  CONSTRAINT change_sets_approved_whole CHECK ((approved_at IS NULL) = (approved_by_user_id IS NULL)),
  CONSTRAINT change_sets_published_whole CHECK ((published_at IS NULL) = (published_by_user_id IS NULL)),
  CONSTRAINT change_sets_cancelled_whole CHECK ((cancelled_at IS NULL) = (cancelled_by_user_id IS NULL)),
  CONSTRAINT change_sets_rejected_whole CHECK (
    (rejected_at IS NULL) = (rejected_by_user_id IS NULL) AND (rejected_at IS NULL) = (rejection_reason IS NULL)),
  CONSTRAINT change_sets_approval_needed CHECK (
    state NOT IN ('approved', 'published', 'superseded', 'rolled_back')
    OR approved_at IS NOT NULL OR kind = 'legacy_import'),
  -- Published (and its derived states) = has a revision and a publisher.
  CONSTRAINT change_sets_published_has_revision CHECK (
    (state IN ('published', 'superseded', 'rolled_back')) = (revision_no IS NOT NULL)
    AND (revision_no IS NULL) = (published_at IS NULL)),
  CONSTRAINT change_sets_cancelled_state CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)),
  -- Composite FK targets: every child row is pinned to its set's tenant.
  CONSTRAINT change_sets_tenant_id_uk UNIQUE (tenant_id, id),
  CONSTRAINT change_sets_rolls_back_fk FOREIGN KEY (tenant_id, rolls_back_change_set_id)
    REFERENCES change_sets (tenant_id, id) ON DELETE RESTRICT
);

-- One revision per published set.
CREATE UNIQUE INDEX uq_change_sets_tenant_revision
  ON change_sets (tenant_id, domain, revision_no) WHERE revision_no IS NOT NULL;
-- A published set is rolled back at most once.
CREATE UNIQUE INDEX uq_change_sets_rolls_back
  ON change_sets (tenant_id, rolls_back_change_set_id)
  WHERE rolls_back_change_set_id IS NOT NULL AND state <> 'cancelled';
-- The Console list (spec 042 §12): newest first, filtered by state.
CREATE INDEX ix_change_sets_tenant_created ON change_sets (tenant_id, domain, created_at DESC, id DESC);
CREATE INDEX ix_change_sets_tenant_state ON change_sets (tenant_id, domain, state);

CREATE TRIGGER change_sets_set_updated_at BEFORE UPDATE ON change_sets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION change_sets_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.domain <> OLD.domain OR NEW.kind <> OLD.kind
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at
     OR NEW.rolls_back_change_set_id IS DISTINCT FROM OLD.rolls_back_change_set_id THEN
    RAISE EXCEPTION 'change set %: identity, kind and creation facts never change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('cancelled', 'superseded', 'rolled_back') THEN
    RAISE EXCEPTION 'change set % is % and never changes', OLD.id, OLD.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'change set %: the version only moves forward', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revision_no IS NOT NULL AND NEW.revision_no IS DISTINCT FROM OLD.revision_no THEN
    RAISE EXCEPTION 'change set %: the published revision is set once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- A published set changes only to its derived superseded / rolled_back state.
  IF OLD.state = 'published' THEN
    IF NEW.state NOT IN ('published', 'superseded', 'rolled_back')
       OR (to_jsonb(NEW) - 'state' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'updated_at') THEN
      RAISE EXCEPTION 'change set % is published: only its superseded / rolled_back state may change', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER change_sets_guard BEFORE UPDATE ON change_sets
  FOR EACH ROW EXECUTE FUNCTION change_sets_guard();
CREATE TRIGGER change_sets_no_delete_row BEFORE DELETE ON change_sets
  FOR EACH ROW EXECUTE FUNCTION pricing_no_delete();
CREATE TRIGGER change_sets_no_delete_truncate BEFORE TRUNCATE ON change_sets
  FOR EACH STATEMENT EXECUTE FUNCTION pricing_no_delete();

-- =============================================================================
-- 2. price_books
-- =============================================================================

CREATE TABLE price_books (
  id                  UUID         PRIMARY KEY,
  tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code                TEXT         NOT NULL,
  name                TEXT         NOT NULL,
  currency_code       CHAR(3)      NOT NULL,
  tax_price_basis     TEXT         NOT NULL,
  pricing_context     TEXT         NOT NULL DEFAULT 'retail',
  is_default          BOOLEAN      NOT NULL DEFAULT true,
  retired_at          TIMESTAMPTZ  NULL,
  created_by_user_id  UUID         NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  correlation_id      UUID         NOT NULL,
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT price_books_code_format CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  CONSTRAINT price_books_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT price_books_currency_format CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT price_books_tax_price_basis CHECK (tax_price_basis IN ('inclusive', 'exclusive')),
  CONSTRAINT price_books_pricing_context CHECK (pricing_context IN ('retail')),
  CONSTRAINT price_books_retired_after_created CHECK (retired_at IS NULL OR retired_at >= created_at),
  CONSTRAINT price_books_tenant_code_uk UNIQUE (tenant_id, code),
  CONSTRAINT price_books_tenant_id_uk UNIQUE (tenant_id, id),
  -- Composite FK target: an event's currency is its Book's currency (472, 486).
  CONSTRAINT price_books_tenant_id_currency_uk UNIQUE (tenant_id, id, currency_code)
);

-- v1 (OD-1): at most one non-retired Book per pricing context.
CREATE UNIQUE INDEX uq_price_books_one_active_per_context
  ON price_books (tenant_id, pricing_context) WHERE retired_at IS NULL;

CREATE TRIGGER price_books_set_updated_at BEFORE UPDATE ON price_books
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION price_books_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.code <> OLD.code
     OR NEW.currency_code <> OLD.currency_code OR NEW.tax_price_basis <> OLD.tax_price_basis
     OR NEW.pricing_context <> OLD.pricing_context OR NEW.is_default <> OLD.is_default
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'price book %: identity, code, currency, tax-price basis and context never change (472, Q-5)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- v1: the tenant's Book cannot be retired or replaced (data-model §2.1).
  IF NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'price book %: a Book cannot be retired in v1 (data-model §2.1)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER price_books_guard BEFORE UPDATE ON price_books
  FOR EACH ROW EXECUTE FUNCTION price_books_guard();
CREATE TRIGGER price_books_no_delete_row BEFORE DELETE ON price_books
  FOR EACH ROW EXECUTE FUNCTION pricing_no_delete();
CREATE TRIGGER price_books_no_delete_truncate BEFORE TRUNCATE ON price_books
  FOR EACH STATEMENT EXECUTE FUNCTION pricing_no_delete();

-- =============================================================================
-- 3. price_zones
-- =============================================================================

CREATE TABLE price_zones (
  id                  UUID         PRIMARY KEY,
  tenant_id           UUID         NOT NULL,
  price_book_id       UUID         NOT NULL,
  code                TEXT         NOT NULL,
  name                TEXT         NOT NULL,
  is_default          BOOLEAN      NOT NULL DEFAULT false,
  retired_at          TIMESTAMPTZ  NULL,
  retired_by_user_id  UUID         NULL,
  retire_reason       TEXT         NULL,
  created_by_user_id  UUID         NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  correlation_id      UUID         NOT NULL,
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT price_zones_code_format CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  CONSTRAINT price_zones_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT price_zones_retired_whole CHECK (
    (retired_at IS NULL) = (retired_by_user_id IS NULL) AND (retired_at IS NULL) = (retire_reason IS NULL)),
  CONSTRAINT price_zones_retire_reason_length CHECK (retire_reason IS NULL OR char_length(retire_reason) BETWEEN 1 AND 500),
  CONSTRAINT price_zones_default_not_retired CHECK (NOT (is_default AND retired_at IS NOT NULL)),
  CONSTRAINT price_zones_book_fk FOREIGN KEY (tenant_id, price_book_id)
    REFERENCES price_books (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_zones_book_code_uk UNIQUE (tenant_id, price_book_id, code),
  CONSTRAINT price_zones_tenant_id_uk UNIQUE (tenant_id, id),
  -- Composite FK target: a membership's or event's Zone belongs to its Book.
  CONSTRAINT price_zones_tenant_book_id_uk UNIQUE (tenant_id, price_book_id, id)
);

-- Exactly one default Zone per Book: at most one here, at least one by the
-- deferred check on price_books below.
CREATE UNIQUE INDEX uq_price_zones_one_default_per_book
  ON price_zones (tenant_id, price_book_id) WHERE is_default;

CREATE TRIGGER price_zones_set_updated_at BEFORE UPDATE ON price_zones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION price_zones_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.price_book_id <> OLD.price_book_id
     OR NEW.code <> OLD.code OR NEW.is_default <> OLD.is_default
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'price zone %: identity, Book, code and default flag never change (Q-8)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'price zone % is retired and never changes', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Retiring: never while an active membership or price event uses the Zone.
  IF NEW.retired_at IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.price_zone_memberships m
                WHERE m.tenant_id = OLD.tenant_id AND m.price_zone_id = OLD.id AND m.state = 'active')
       OR EXISTS (SELECT 1 FROM public.price_events e
                   WHERE e.tenant_id = OLD.tenant_id AND e.price_zone_id = OLD.id AND e.state = 'active') THEN
      RAISE EXCEPTION 'price zone % is in use by an active membership or price event', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER price_zones_guard BEFORE UPDATE ON price_zones
  FOR EACH ROW EXECUTE FUNCTION price_zones_guard();
CREATE TRIGGER price_zones_no_delete_row BEFORE DELETE ON price_zones
  FOR EACH ROW EXECUTE FUNCTION pricing_no_delete();
CREATE TRIGGER price_zones_no_delete_truncate BEFORE TRUNCATE ON price_zones
  FOR EACH STATEMENT EXECUTE FUNCTION pricing_no_delete();

-- At COMMIT, a new Book has exactly one default Zone (OD-1: created together).
-- It reads price_zones under RLS with the tenant GUC in force at COMMIT, so a
-- transaction creates Books for ONE tenant (the runtime never does otherwise).
CREATE FUNCTION price_books_has_default_zone() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.price_zones z
                  WHERE z.tenant_id = NEW.tenant_id AND z.price_book_id = NEW.id AND z.is_default) THEN
    RAISE EXCEPTION 'price book % has no default Zone; create it in the same transaction (OD-1)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER price_books_has_default_zone
  AFTER INSERT ON price_books
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION price_books_has_default_zone();

-- =============================================================================
-- 4. pricing_revisions (immutable, gapless per tenant)
-- =============================================================================

CREATE TABLE pricing_revisions (
  id                      UUID         PRIMARY KEY,
  tenant_id               UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  revision_no             BIGINT       NOT NULL,
  change_set_id           UUID         NOT NULL,
  kind                    TEXT         NOT NULL,
  rolls_back_revision_no  BIGINT       NULL,
  published_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  published_by_user_id    UUID         NOT NULL,
  -- G4 pre-delivery lower bound (data-model §2.5); null when the revision changes no price.
  earliest_effective_at   TIMESTAMPTZ  NULL,
  correlation_id          UUID         NOT NULL,
  -- The issuing transaction, forced by the insert trigger.
  issue_xact              XID8         NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT pricing_revisions_positive CHECK (revision_no >= 1),
  CONSTRAINT pricing_revisions_kind CHECK (kind IN ('publish', 'emergency', 'rollback', 'legacy_import')),
  CONSTRAINT pricing_revisions_rollback_target CHECK (
    (kind = 'rollback') = (rolls_back_revision_no IS NOT NULL)
    AND (rolls_back_revision_no IS NULL OR rolls_back_revision_no < revision_no)),
  CONSTRAINT pricing_revisions_tenant_revision_uk UNIQUE (tenant_id, revision_no),
  CONSTRAINT pricing_revisions_tenant_change_set_uk UNIQUE (tenant_id, change_set_id),
  -- Composite FK target: a published Change Set names ITS OWN revision.
  CONSTRAINT pricing_revisions_tenant_revision_set_uk UNIQUE (tenant_id, revision_no, change_set_id),
  CONSTRAINT pricing_revisions_change_set_fk FOREIGN KEY (tenant_id, change_set_id)
    REFERENCES change_sets (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT pricing_revisions_rolls_back_fk FOREIGN KEY (tenant_id, rolls_back_revision_no)
    REFERENCES pricing_revisions (tenant_id, revision_no) ON DELETE RESTRICT
);

CREATE FUNCTION pricing_revisions_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_next bigint;
BEGIN
  SELECT COALESCE(max(r.revision_no), 0) + 1 INTO v_next
    FROM public.pricing_revisions r
   WHERE r.tenant_id = NEW.tenant_id;
  IF NEW.revision_no <> v_next THEN
    RAISE EXCEPTION 'tenant %: the next Pricing Revision is %, not %', NEW.tenant_id, v_next, NEW.revision_no
      USING ERRCODE = 'check_violation';
  END IF;
  -- Only this transaction may publish events and memberships into it.
  NEW.published_at := now();
  NEW.issue_xact := pg_current_xact_id();
  RETURN NEW;
END
$$;

CREATE TRIGGER pricing_revisions_before_insert BEFORE INSERT ON pricing_revisions
  FOR EACH ROW EXECUTE FUNCTION pricing_revisions_before_insert();
CREATE TRIGGER pricing_revisions_append_only_row BEFORE UPDATE OR DELETE ON pricing_revisions
  FOR EACH ROW EXECUTE FUNCTION pricing_append_only();
CREATE TRIGGER pricing_revisions_append_only_truncate BEFORE TRUNCATE ON pricing_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION pricing_append_only();

-- A published Change Set names the revision that published IT (the revision's
-- change_set_id is this set), never another set's.
ALTER TABLE change_sets
  ADD CONSTRAINT change_sets_revision_fk FOREIGN KEY (tenant_id, revision_no, id)
    REFERENCES pricing_revisions (tenant_id, revision_no, change_set_id) ON DELETE RESTRICT;

-- True when revision `p_revision_no` of tenant `p_tenant` was issued by the
-- current transaction (the 0101 issue_xact pattern).
CREATE FUNCTION pricing_revision_issued_here(p_tenant uuid, p_revision_no bigint) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.pricing_revisions r
                  WHERE r.tenant_id = p_tenant AND r.revision_no = p_revision_no
                    AND r.issue_xact = pg_current_xact_id())
$$;

-- =============================================================================
-- 5. pricing_revision_stores (fan-out, append-only)
-- =============================================================================

CREATE TABLE pricing_revision_stores (
  tenant_id    UUID         NOT NULL,
  store_id     UUID         NOT NULL,
  revision_no         BIGINT       NOT NULL,
  created_by_user_id  UUID         NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  correlation_id      UUID         NOT NULL,
  CONSTRAINT pricing_revision_stores_pk PRIMARY KEY (tenant_id, store_id, revision_no),
  CONSTRAINT pricing_revision_stores_revision_fk FOREIGN KEY (tenant_id, revision_no)
    REFERENCES pricing_revisions (tenant_id, revision_no) ON DELETE RESTRICT,
  CONSTRAINT pricing_revision_stores_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES stores (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX ix_pricing_revision_stores_revision ON pricing_revision_stores (tenant_id, revision_no);

-- A fan-out row is written by the transaction that issued the revision, or
-- names the tenant's head revision (the Store bootstrap row, data-model §2.6).
CREATE FUNCTION pricing_revision_stores_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.pricing_revision_issued_here(NEW.tenant_id, NEW.revision_no)
     AND NEW.revision_no <> (SELECT max(r.revision_no) FROM public.pricing_revisions r
                              WHERE r.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'pricing_revision_stores: revision % of tenant % is neither issued here nor the head',
      NEW.revision_no, NEW.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER pricing_revision_stores_before_insert BEFORE INSERT ON pricing_revision_stores
  FOR EACH ROW EXECUTE FUNCTION pricing_revision_stores_before_insert();
CREATE TRIGGER pricing_revision_stores_append_only_row BEFORE UPDATE OR DELETE ON pricing_revision_stores
  FOR EACH ROW EXECUTE FUNCTION pricing_append_only();
CREATE TRIGGER pricing_revision_stores_append_only_truncate BEFORE TRUNCATE ON pricing_revision_stores
  FOR EACH STATEMENT EXECUTE FUNCTION pricing_append_only();

-- =============================================================================
-- 6. price_zone_memberships
-- =============================================================================

CREATE TABLE price_zone_memberships (
  id                     UUID         PRIMARY KEY,
  tenant_id              UUID         NOT NULL,
  price_book_id          UUID         NOT NULL,
  price_zone_id          UUID         NOT NULL,
  store_id               UUID         NOT NULL,
  effective_from         TIMESTAMPTZ  NOT NULL,
  effective_to           TIMESTAMPTZ  NULL,
  state                  TEXT         NOT NULL DEFAULT 'active',
  published_in_revision  BIGINT       NOT NULL,
  ended_in_revision      BIGINT       NULL,
  carried_forward        BOOLEAN      NOT NULL DEFAULT false,
  created_by_user_id     UUID         NOT NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  correlation_id         UUID         NOT NULL,
  CONSTRAINT price_zone_memberships_interval CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT price_zone_memberships_state CHECK (state IN ('active', 'superseded')),
  CONSTRAINT price_zone_memberships_ended CHECK (
    (state = 'active') = (ended_in_revision IS NULL)
    AND (ended_in_revision IS NULL OR ended_in_revision > published_in_revision)),
  CONSTRAINT price_zone_memberships_zone_fk FOREIGN KEY (tenant_id, price_book_id, price_zone_id)
    REFERENCES price_zones (tenant_id, price_book_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_zone_memberships_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_zone_memberships_published_fk FOREIGN KEY (tenant_id, published_in_revision)
    REFERENCES pricing_revisions (tenant_id, revision_no) ON DELETE RESTRICT,
  CONSTRAINT price_zone_memberships_ended_fk FOREIGN KEY (tenant_id, ended_in_revision)
    REFERENCES pricing_revisions (tenant_id, revision_no) ON DELETE RESTRICT,
  -- No two active memberships of one Store in one Book overlap (494).
  CONSTRAINT price_zone_memberships_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    price_book_id WITH =,
    store_id WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (state = 'active')
);

CREATE INDEX ix_price_zone_memberships_zone ON price_zone_memberships (tenant_id, price_zone_id) WHERE state = 'active';
CREATE INDEX ix_price_zone_memberships_revision ON price_zone_memberships (tenant_id, published_in_revision);

-- =============================================================================
-- 7. price_events
-- =============================================================================

CREATE TABLE price_events (
  id                     UUID           PRIMARY KEY,
  tenant_id              UUID           NOT NULL,
  price_book_id          UUID           NOT NULL,
  scope                  TEXT           NOT NULL,
  price_zone_id          UUID           NULL,
  store_id               UUID           NULL,
  product_id             UUID           NOT NULL,
  sell_unit              TEXT           NOT NULL DEFAULT 'each',
  price_kind             TEXT           NOT NULL DEFAULT 'regular',
  price                  NUMERIC(19, 4) NOT NULL,
  currency_code          CHAR(3)        NOT NULL,
  time_basis             TEXT           NOT NULL,
  effective_from         TIMESTAMPTZ    NULL,
  effective_to           TIMESTAMPTZ    NULL,
  effective_from_local   TIMESTAMP      NULL,
  effective_to_local     TIMESTAMP      NULL,
  state                  TEXT           NOT NULL DEFAULT 'active',
  published_in_revision  BIGINT         NOT NULL,
  ended_in_revision      BIGINT         NULL,
  supersedes_event_id    UUID           NULL,
  change_set_id          UUID           NOT NULL,
  source                 TEXT           NOT NULL,
  carried_forward        BOOLEAN        NOT NULL DEFAULT false,
  created_by_user_id     UUID           NOT NULL,
  created_at             TIMESTAMPTZ    NOT NULL DEFAULT now(),
  correlation_id         UUID           NOT NULL,
  CONSTRAINT price_events_scope CHECK (scope IN ('book', 'zone', 'store')),
  CONSTRAINT price_events_scope_target CHECK (
    (scope = 'book' AND price_zone_id IS NULL AND store_id IS NULL)
    OR (scope = 'zone' AND price_zone_id IS NOT NULL AND store_id IS NULL)
    OR (scope = 'store' AND price_zone_id IS NULL AND store_id IS NOT NULL)),
  -- v1 (OD-2, OD-1): one Sell Unit and one price kind; widening is additive.
  CONSTRAINT price_events_sell_unit CHECK (sell_unit IN ('each')),
  CONSTRAINT price_events_price_kind CHECK (price_kind IN ('regular')),
  CONSTRAINT price_events_price_non_negative CHECK (price >= 0),
  CONSTRAINT price_events_time_basis CHECK (time_basis IN ('store_local', 'absolute')),
  -- Exactly one pair of bounds, by time basis (spec 041 §4.3).
  CONSTRAINT price_events_bounds CHECK (
    (time_basis = 'absolute' AND effective_from IS NOT NULL
       AND effective_from_local IS NULL AND effective_to_local IS NULL
       AND (effective_to IS NULL OR effective_to > effective_from))
    OR (time_basis = 'store_local' AND effective_from_local IS NOT NULL
       AND effective_from IS NULL AND effective_to IS NULL
       AND (effective_to_local IS NULL OR effective_to_local > effective_from_local))),
  CONSTRAINT price_events_state CHECK (state IN ('active', 'superseded', 'cancelled')),
  CONSTRAINT price_events_ended CHECK (
    (state = 'active') = (ended_in_revision IS NULL)
    AND (ended_in_revision IS NULL OR ended_in_revision > published_in_revision)),
  CONSTRAINT price_events_source CHECK (source IN ('change_set', 'emergency', 'rollback', 'legacy_import')),
  CONSTRAINT price_events_supersedes_not_self CHECK (supersedes_event_id IS NULL OR supersedes_event_id <> id),
  CONSTRAINT price_events_tenant_id_uk UNIQUE (tenant_id, id),
  -- The event's currency is its Book's currency (472, 486).
  CONSTRAINT price_events_book_currency_fk FOREIGN KEY (tenant_id, price_book_id, currency_code)
    REFERENCES price_books (tenant_id, id, currency_code) ON DELETE RESTRICT,
  CONSTRAINT price_events_zone_fk FOREIGN KEY (tenant_id, price_book_id, price_zone_id)
    REFERENCES price_zones (tenant_id, price_book_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_events_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_events_product_fk FOREIGN KEY (product_id, tenant_id)
    REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT price_events_published_fk FOREIGN KEY (tenant_id, published_in_revision)
    REFERENCES pricing_revisions (tenant_id, revision_no) ON DELETE RESTRICT,
  CONSTRAINT price_events_ended_fk FOREIGN KEY (tenant_id, ended_in_revision)
    REFERENCES pricing_revisions (tenant_id, revision_no) ON DELETE RESTRICT,
  CONSTRAINT price_events_supersedes_fk FOREIGN KEY (tenant_id, supersedes_event_id)
    REFERENCES price_events (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT price_events_change_set_fk FOREIGN KEY (tenant_id, change_set_id)
    REFERENCES change_sets (tenant_id, id) ON DELETE RESTRICT,
  -- No two ACTIVE events of one key overlap (498, 513), one constraint per
  -- time basis. The key's target is the Zone or the Store (nil for book scope).
  CONSTRAINT price_events_no_overlap_absolute EXCLUDE USING gist (
    tenant_id WITH =,
    price_book_id WITH =,
    scope WITH =,
    (COALESCE(price_zone_id, store_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    product_id WITH =,
    sell_unit WITH =,
    price_kind WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (state = 'active' AND time_basis = 'absolute'),
  CONSTRAINT price_events_no_overlap_store_local EXCLUDE USING gist (
    tenant_id WITH =,
    price_book_id WITH =,
    scope WITH =,
    (COALESCE(price_zone_id, store_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    product_id WITH =,
    sell_unit WITH =,
    price_kind WITH =,
    tsrange(effective_from_local, effective_to_local, '[)') WITH &&
  ) WHERE (state = 'active' AND time_basis = 'store_local')
);

-- Resolution (spec 041 data-model §2.4) and revision fan-out.
CREATE INDEX ix_price_events_resolution
  ON price_events (tenant_id, product_id, sell_unit, price_book_id) WHERE state = 'active';
CREATE INDEX ix_price_events_revision ON price_events (tenant_id, published_in_revision);
CREATE INDEX ix_price_events_zone ON price_events (tenant_id, price_zone_id) WHERE price_zone_id IS NOT NULL AND state = 'active';

-- =============================================================================
-- 8. Publish-only writes for events and memberships
-- =============================================================================

-- A new event or membership row is published only by the transaction that
-- issued its revision, as `active` and not yet ended.
CREATE FUNCTION pricing_timeline_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_zone uuid;
  v_retired_at timestamptz;
BEGIN
  IF NEW.state <> 'active' OR NEW.ended_in_revision IS NOT NULL THEN
    RAISE EXCEPTION '%: a row is published active and is ended only by a later revision', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.pricing_revision_issued_here(NEW.tenant_id, NEW.published_in_revision) THEN
    RAISE EXCEPTION '%: revision % of tenant % was not issued by this transaction',
      TG_TABLE_NAME, NEW.published_in_revision, NEW.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Never into a retired Zone. FOR SHARE serializes with a concurrent retire
  -- (its UPDATE takes the row lock): whichever commits second sees the other.
  v_zone := (to_jsonb(NEW) ->> 'price_zone_id')::uuid;
  IF v_zone IS NOT NULL THEN
    SELECT z.retired_at INTO v_retired_at
      FROM public.price_zones z
     WHERE z.tenant_id = NEW.tenant_id AND z.id = v_zone
       FOR SHARE;
    IF v_retired_at IS NOT NULL THEN
      RAISE EXCEPTION '%: price zone % is retired', TG_TABLE_NAME, v_zone
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;

-- The only change: active -> superseded / cancelled with the ending revision,
-- issued by this transaction. Nothing else ever changes (521, 534).
CREATE FUNCTION pricing_timeline_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.state <> 'active' THEN
    RAISE EXCEPTION '%: row % is % and never changes', TG_TABLE_NAME, OLD.id, OLD.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'active' OR NEW.ended_in_revision IS NULL
     OR (to_jsonb(NEW) - 'state' - 'ended_in_revision') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'ended_in_revision') THEN
    RAISE EXCEPTION '%: row % may only be ended (state and ended_in_revision); it is never edited',
      TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.pricing_revision_issued_here(NEW.tenant_id, NEW.ended_in_revision) THEN
    RAISE EXCEPTION '%: ending revision % of tenant % was not issued by this transaction',
      TG_TABLE_NAME, NEW.ended_in_revision, NEW.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER price_zone_memberships_before_insert BEFORE INSERT ON price_zone_memberships
  FOR EACH ROW EXECUTE FUNCTION pricing_timeline_before_insert();
CREATE TRIGGER price_zone_memberships_guard BEFORE UPDATE ON price_zone_memberships
  FOR EACH ROW EXECUTE FUNCTION pricing_timeline_guard();
CREATE TRIGGER price_zone_memberships_no_delete_row BEFORE DELETE ON price_zone_memberships
  FOR EACH ROW EXECUTE FUNCTION pricing_no_delete();
CREATE TRIGGER price_zone_memberships_no_delete_truncate BEFORE TRUNCATE ON price_zone_memberships
  FOR EACH STATEMENT EXECUTE FUNCTION pricing_no_delete();

CREATE TRIGGER price_events_before_insert BEFORE INSERT ON price_events
  FOR EACH ROW EXECUTE FUNCTION pricing_timeline_before_insert();
CREATE TRIGGER price_events_guard BEFORE UPDATE ON price_events
  FOR EACH ROW EXECUTE FUNCTION pricing_timeline_guard();
CREATE TRIGGER price_events_no_delete_row BEFORE DELETE ON price_events
  FOR EACH ROW EXECUTE FUNCTION pricing_no_delete();
CREATE TRIGGER price_events_no_delete_truncate BEFORE TRUNCATE ON price_events
  FOR EACH STATEMENT EXECUTE FUNCTION pricing_no_delete();

-- =============================================================================
-- 9. Row-level security: ENABLE + FORCE and tenant policies on all seven
-- =============================================================================

DO $$
DECLARE
  -- The empty-GUC CASE guard of 0010 / 0091 / 0097 / 0101: '' reads as NULL, never a cast error.
  tenant_match CONSTANT text := 'tenant_id = CASE'
    || ' WHEN current_setting(''app.current_tenant'', true) = '''' THEN NULL'
    || ' ELSE current_setting(''app.current_tenant'', true)::uuid END';
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'change_sets', 'price_books', 'price_zones', 'pricing_revisions', 'pricing_revision_stores',
    'price_zone_memberships', 'price_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', t || '_tenant_select', t, tenant_match);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', t || '_tenant_insert', t, tenant_match);
  END LOOP;
  -- UPDATE only where a guard trigger bounds the change. No DELETE policy anywhere.
  FOREACH t IN ARRAY ARRAY['change_sets', 'price_books', 'price_zones', 'price_zone_memberships', 'price_events'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)',
      t || '_tenant_update', t, tenant_match, tenant_match);
  END LOOP;
END
$$;

COMMIT;
