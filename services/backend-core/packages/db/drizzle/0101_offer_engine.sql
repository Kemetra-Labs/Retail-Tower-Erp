-- 0101_offer_engine.sql
--
-- Offer Engine V1 data model (Jira RT-1336, RT-286 spec 048 slice S3).
-- [GATED: migration]. Depends on 0097 (`tenant_product_brands`) and 0100 (the
-- `sale_lines` composite key, built CONCURRENTLY). 0099 is held by an open PR
-- (RT-1114, #519).
--
-- Source-of-truth artifacts:
--   - services/backend-core/specs/048-offer-engine-v1/spec.md §4-§9 and its
--     decision-record.md (OD-1..OD-12, the OD-7 clarifications)
--   - packages/contracts/openapi/offers.openapi.yaml (1.0.0-draft, RT-1335):
--     `OfferDefinition`, `Offer`, `OfferVersion`, `OfferPause`,
--     `OfferStorePause`, `OfferPack`, `PackOffer`
--   - packages/contracts/openapi/pos-sales/sales.yaml (1.22.0-draft, RT-1335):
--     `CaptureSaleLinePromotion`, `SaleLinePromotion`, `PromotionClawback`
--   - packages/db/__tests__/migration/0101-offer-engine.spec.ts
--
-- Ten tables. No runtime reads or writes them until RT-1337 (S4).
--
--   offers                        One row per offer: tenant identity and the
--                                 stored lifecycle facts. `state` is DERIVED
--                                 when read (contract): no published version
--                                 = draft; ended_at / archived_at / the
--                                 whole-offer pause and the schedule give the
--                                 rest. The draft of the next version is a
--                                 mutable JSONB working copy
--                                 (`OfferDefinition`, validated by the
--                                 runtime; a draft may hold references that
--                                 preview reports as `offer_reference_invalid`,
--                                 so it has no FKs). `draft_revision` is the
--                                 optimistic-concurrency token: the last
--                                 revision ever issued, never reused across
--                                 drafts (a guard trigger: it never moves
--                                 back). An archived offer never changes, and
--                                 ended_at / archived_at are set once.
--   offer_versions                One row per published version, numbered
--                                 1, 2, 3 ... per offer (a trigger), with the
--                                 frozen `OfferDefinition` scalars: names,
--                                 type, the buy_x_get_y_percent parameters,
--                                 the schedule (store_local local date-times,
--                                 or absolute instants), the offline policy
--                                 and the eligible-set count at publish.
--                                 `published_at` is the server time (forced to
--                                 now()). APPEND-ONLY: UPDATE, DELETE and
--                                 TRUNCATE are refused by a trigger for every
--                                 role (§16: a version used by a sale is never
--                                 changed). An archived offer gets no version.
--   offer_version_stores          The explicit store scope of a version
--                                 (`storeScope.storeIds`); none when
--                                 `all_stores`. Append-only.
--   offer_version_rules           The eligibility rules (§5.2, OD-1): one row
--                                 per include or exclude entry, naming exactly
--                                 one product, category or brand of the same
--                                 tenant (composite FKs). Append-only.
--                                 The children of a version are written in
--                                 the version's own transaction only (a
--                                 trigger compares the version's
--                                 `published_at`, forced to now(), with the
--                                 inserting transaction's now()), and at
--                                 COMMIT a deferred constraint trigger checks
--                                 the version is whole: at least one include
--                                 rule (§5.2 rule 1) and, unless all_stores,
--                                 at least one store. So a published version,
--                                 children included, never changes.
--   offer_pauses                  Whole-offer (store_id NULL) and store-level
--                                 pauses (`pause`, `pausedStores`), with their
--                                 required reason. A resume sets resumed_at
--                                 and resumed_by_user_id once; the row is
--                                 never deleted (§21: pausing never deletes
--                                 history). At most one open pause per offer,
--                                 and per (offer, store).
--   offer_pack_revisions          The tenant-wide, monotonic Offer Pack
--                                 revision (§19, `OfferPack.packRevision`):
--                                 1, 2, 3 ... per tenant with no gap (a
--                                 trigger). Append-only. A tenant with no row
--                                 is at revision 0 (contract).
--   offer_pack_store_revisions    The per-store applied revision: the latest
--                                 revision that changed the store's Pack (the
--                                 ETag basis), one row per store, only moving
--                                 forward (the 0072 tenant_inventory_safety_
--                                 revisions pattern).
--   offer_pack_eligible_products  The MATERIALISED eligible sets (OD-6), per
--                                 store, as validity ranges of Pack revisions:
--                                 a row says product P is in offer O version V
--                                 for store S from revision `from_revision`
--                                 until `to_revision` (exclusive; NULL =
--                                 still current). The rows covering revision R
--                                 for store S are exactly the eligible sets of
--                                 S's Pack at R, so the server can judge a
--                                 sale against the revision it cites (§19,
--                                 OD-9) without copying every set into every
--                                 revision. A pause, a resume, an end, a new
--                                 version or a catalog change closes and opens
--                                 rows at the new revision. History is frozen
--                                 by a guard trigger: a row is inserted only
--                                 at the tenant's latest revision, and the
--                                 only change ever allowed is closing it
--                                 (to_revision NULL -> the latest revision);
--                                 so once revision R+1 exists, the content of
--                                 R can never change. No DELETE.
--                                 PACK INVARIANT (OD-7 clarification,
--                                 `PackOffer.eligibleProductIds`): a product
--                                 is in at most ONE offer per store in any
--                                 Pack revision. Enforced by an EXCLUDE
--                                 constraint over (tenant, store, product,
--                                 [from_revision, to_revision)), btree_gist
--                                 (installed by 0016).
--   sale_line_promotions          The frozen per-line offer fact (§8, §20,
--                                 `SaleLinePromotion`): offer, version, Pack
--                                 revision and discountAmount. At most one per
--                                 sale line (PK). Composite FK onto the 0100
--                                 key pins it to a line of the same sale,
--                                 store and tenant. A guard trigger reads the
--                                 line and refuses arithmetic that cannot hold
--                                 (OD-4, §8): a non-whole quantity (F-9), a
--                                 discount above the gross, `line_amount <>
--                                 unit_price x quantity - discount_amount`, or
--                                 a reward (discount > 0) on a quantity other
--                                 than 1. APPEND-ONLY for every role.
--   sale_return_promotion_        The per-offer clawback of a return (§9,
--   clawbacks                     OD-3, `SaleReturn.promotionClawbacks`): one
--                                 row per (return, offer), amount > 0, with
--                                 the frozen offer version. Composite FK onto
--                                 sale_returns (id, tenant_id, store_id).
--                                 APPEND-ONLY for every role.
--
-- tenant_product_categories gains a unique (id, tenant_id) key, the composite
-- FK target of the category rules (the uq_tenant_products_id_tenant pattern of
-- 0045). `id` is the primary key, so it refuses no row.
--
-- What SQL does NOT enforce (owned by the runtime, RT-1337):
--   - OD-7 publish/resume conflicts: overlapping windows in a shared store need
--     each store's IANA timezone to resolve `store_local` schedules, and the
--     eligible sets come from the live catalog. The PACK invariant above is
--     the SQL backstop: whatever the runtime decides, no Pack revision can hold
--     a product in two offers for one store.
--   - That a materialised row's store is in the version's scope, not paused,
--     and its product active and matching the rules; that store pauses name a
--     store of the scope; the 200-offer and 20 000-product Pack limits.
--   - The promotion percent check (`discountAmount` = percentOff% of unitPrice,
--     half up at the currency minor unit) and OD-5 (the manual discount is not
--     stored, F-3), and the OD-9 rule-level review flag.
--   - The clawback arithmetic of §9.
--
-- RLS: ENABLE + FORCE on all ten, with tenant policies (the empty-GUC CASE of
-- 0010 / 0091 / 0097): SELECT and INSERT on every table; UPDATE only on
-- offers, offer_pauses, offer_pack_store_revisions and
-- offer_pack_eligible_products, whose guard triggers allow only the changes
-- above. NO DELETE policy anywhere.
--
-- Grants: none here. Production grants the domain role SELECT and INSERT on
-- the ten tables and column-level UPDATE only on the columns the runtime may
-- change, outside migrations: docs/operations/sql/offer-engine-domain-grants.sql
-- (deploy/README.md step 2). The API refuses to boot without them
-- (DOMAIN_REQUIRED_GRANTS, apps/api/src/auth/grants/offer-engine.grants.ts).
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS. Offer names
-- and a pause reason (short free text, documented "no PII" in the contract),
-- opaque UUIDs (the user ids are operational actors), whole numbers, a percent,
-- money amounts (numeric(19,4), the sale_lines scale), dates and timestamps,
-- and the draft definition, which holds only the same fields. No customer
-- reference of any kind. Retention inherits the sales posture: the promotion
-- facts and clawbacks are sale facts and are never deleted.
--
-- Deploy window: none. Every table is new and empty; the only change to an
-- existing table is the categories key. Apply 0100, 0101 and the grants script
-- before the API that uses them (migrate is step 1, grants step 2).
--
-- Lock impact: ONE transaction, lock_timeout 2s (a lock that cannot be taken
-- rolls the migration back, to be re-run).
--   - tenant_product_categories: CREATE UNIQUE INDEX (not CONCURRENTLY) takes
--     SHARE, which blocks only category writes, for the build of a key over a
--     small taxonomy table (milliseconds), until COMMIT. Reads continue.
--   - The new FKs take SHARE ROW EXCLUSIVE on tenants, stores, tenant_products,
--     tenant_product_categories, tenant_product_brands, sale_lines and
--     sale_returns until COMMIT: writes to them wait for the rest of this
--     transaction (well under a second; every new table is empty, so no FK
--     validation scan). Reads continue.
--
-- Reversal: 0101_offer_engine.down.sql REFUSES while any offer or Pack
-- revision exists; otherwise it drops the ten tables, their functions and the
-- categories key.

BEGIN;

SET LOCAL lock_timeout = '2s';

-- =============================================================================
-- 0. The categories key (composite FK target of the category rules)
-- =============================================================================

CREATE UNIQUE INDEX uq_tenant_product_categories_id_tenant
  ON tenant_product_categories (id, tenant_id);

-- Refuses UPDATE, DELETE and TRUNCATE on an append-only table, for every role
-- (the 0050 cash_variance_policy_revisions pattern).
CREATE FUNCTION offer_engine_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Offer Engine facts are never edited or deleted (RT-1336, spec 048 §16, §20).';
END
$$;

-- =============================================================================
-- 1. offers
-- =============================================================================

CREATE TABLE offers (
  id                        UUID         PRIMARY KEY,
  tenant_id                 UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- The last draft revision ever issued (0 before the first draft); never reused.
  draft_revision            INTEGER      NOT NULL DEFAULT 0,
  -- The draft of the next version (`OfferDefinition`), or NULL when none.
  draft_definition          JSONB        NULL,
  draft_updated_at          TIMESTAMPTZ  NULL,
  draft_updated_by_user_id  UUID         NULL,
  ended_at                  TIMESTAMPTZ  NULL,
  ended_by_user_id          UUID         NULL,
  archived_at               TIMESTAMPTZ  NULL,
  archived_by_user_id       UUID         NULL,
  created_by_user_id        UUID         NOT NULL,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT offers_draft_revision_non_negative CHECK (draft_revision >= 0),
  -- A draft is whole (definition, time, author) or absent, and holds a revision.
  CONSTRAINT offers_draft_whole CHECK (
    (draft_definition IS NULL) = (draft_updated_at IS NULL)
    AND (draft_definition IS NULL) = (draft_updated_by_user_id IS NULL)
    AND (draft_definition IS NULL OR draft_revision >= 1)),
  CONSTRAINT offers_draft_is_object
    CHECK (draft_definition IS NULL OR jsonb_typeof(draft_definition) = 'object'),
  CONSTRAINT offers_ended_whole CHECK ((ended_at IS NULL) = (ended_by_user_id IS NULL)),
  CONSTRAINT offers_archived_whole CHECK ((archived_at IS NULL) = (archived_by_user_id IS NULL)),
  CONSTRAINT offers_ended_after_created CHECK (ended_at IS NULL OR ended_at >= created_at),
  CONSTRAINT offers_archived_after_created CHECK (archived_at IS NULL OR archived_at >= created_at),
  -- Composite FK target: every child row is pinned to its offer's tenant.
  CONSTRAINT offers_tenant_id_uk UNIQUE (tenant_id, id)
);

CREATE TRIGGER offers_set_updated_at BEFORE UPDATE ON offers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION offers_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'offer % is archived and never changes', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'offer %: id, tenant and creation facts never change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.draft_revision < OLD.draft_revision THEN
    RAISE EXCEPTION 'offer %: the draft revision only moves forward', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.ended_at IS NOT NULL
     AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.ended_by_user_id IS DISTINCT FROM OLD.ended_by_user_id) THEN
    RAISE EXCEPTION 'offer %: an end is recorded once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER offers_guard BEFORE UPDATE ON offers
  FOR EACH ROW EXECUTE FUNCTION offers_guard();

-- =============================================================================
-- 2. offer_versions (immutable)
-- =============================================================================

CREATE TABLE offer_versions (
  tenant_id                  UUID         NOT NULL,
  offer_id                   UUID         NOT NULL,
  version                    INTEGER      NOT NULL,
  name_ar                    TEXT         NOT NULL,
  name_en                    TEXT         NULL,
  offer_type                 TEXT         NOT NULL,
  buy_quantity               INTEGER      NOT NULL,
  get_quantity               INTEGER      NOT NULL,
  percent_off                SMALLINT     NOT NULL,
  reward_selection           TEXT         NOT NULL,
  -- NULL = unlimited.
  max_applications_per_sale  INTEGER      NULL,
  price_basis                TEXT         NOT NULL,
  -- TRUE: the whole chain, stores added later included; FALSE: the
  -- offer_version_stores rows.
  all_stores                 BOOLEAN      NOT NULL,
  time_basis                 TEXT         NOT NULL,
  -- store_local: local date-times, resolved in each store's IANA timezone.
  starts_local               TIMESTAMP    NULL,
  ends_local                 TIMESTAMP    NULL,
  -- absolute: instants, the same for every store.
  starts_at                  TIMESTAMPTZ  NULL,
  ends_at                    TIMESTAMPTZ  NULL,
  offline_policy             TEXT         NOT NULL DEFAULT 'allow_cached',
  -- The eligible-set size at publish (`OfferVersion.eligibleSetCount`).
  eligible_set_count         INTEGER      NOT NULL,
  published_by_user_id       UUID         NOT NULL,
  -- Server time of the publish: forced to now() by the insert trigger.
  published_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT offer_versions_pk PRIMARY KEY (tenant_id, offer_id, version),
  CONSTRAINT fk_offer_versions_offer_tenant
    FOREIGN KEY (tenant_id, offer_id) REFERENCES offers (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT offer_versions_version_positive CHECK (version >= 1),
  CONSTRAINT offer_versions_name_ar_length CHECK (char_length(name_ar) BETWEEN 1 AND 120),
  CONSTRAINT offer_versions_name_en_length CHECK (name_en IS NULL OR char_length(name_en) BETWEEN 1 AND 120),
  -- V1 (spec 048 §3.1, §5.1): one type, one reward selection, one price basis.
  CONSTRAINT offer_versions_type_allowed CHECK (offer_type = 'buy_x_get_y_percent'),
  CONSTRAINT offer_versions_reward_selection_allowed CHECK (reward_selection = 'cheapest'),
  CONSTRAINT offer_versions_price_basis_allowed CHECK (price_basis = 'resolved_store_price'),
  CONSTRAINT offer_versions_buy_quantity_range CHECK (buy_quantity BETWEEN 1 AND 1000),
  CONSTRAINT offer_versions_get_quantity_range CHECK (get_quantity BETWEEN 1 AND 1000),
  -- A whole percent 1..100, the RT-740 manual discount domain (P <= 100: a net
  -- is never negative).
  CONSTRAINT offer_versions_percent_off_range CHECK (percent_off BETWEEN 1 AND 100),
  CONSTRAINT offer_versions_max_applications_range
    CHECK (max_applications_per_sale IS NULL OR max_applications_per_sale BETWEEN 1 AND 1000),
  CONSTRAINT offer_versions_offline_policy_allowed CHECK (offline_policy IN ('allow_cached', 'online_only')),
  CONSTRAINT offer_versions_eligible_set_count_non_negative CHECK (eligible_set_count >= 0),
  -- The schedule matches its basis: local date-times (whole seconds) or instants.
  CONSTRAINT offer_versions_schedule_shape CHECK (
    (time_basis = 'store_local' AND starts_local IS NOT NULL AND starts_at IS NULL AND ends_at IS NULL
       AND date_trunc('second', starts_local) = starts_local
       AND (ends_local IS NULL OR date_trunc('second', ends_local) = ends_local))
    OR (time_basis = 'absolute' AND starts_at IS NOT NULL AND starts_local IS NULL AND ends_local IS NULL)),
  -- [startsAt, endsAt): the end is after the start.
  CONSTRAINT offer_versions_window_ordered CHECK (
    (ends_local IS NULL OR ends_local > starts_local) AND (ends_at IS NULL OR ends_at > starts_at))
);

-- Version numbering (1, 2, 3 ... per offer, no gap), server publish time, and
-- no version for an archived offer.
CREATE FUNCTION offer_versions_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_next integer;
  v_archived timestamptz;
BEGIN
  SELECT o.archived_at INTO v_archived
    FROM public.offers o
   WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.offer_id;
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'offer % is archived: no new version', NEW.offer_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(max(v.version), 0) + 1 INTO v_next
    FROM public.offer_versions v
   WHERE v.tenant_id = NEW.tenant_id AND v.offer_id = NEW.offer_id;
  IF NEW.version <> v_next THEN
    RAISE EXCEPTION 'offer %: the next version is %, not %', NEW.offer_id, v_next, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.published_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER offer_versions_before_insert BEFORE INSERT ON offer_versions
  FOR EACH ROW EXECUTE FUNCTION offer_versions_before_insert();

CREATE TRIGGER offer_versions_append_only_row BEFORE UPDATE OR DELETE ON offer_versions
  FOR EACH ROW EXECUTE FUNCTION offer_engine_append_only();
CREATE TRIGGER offer_versions_append_only_truncate BEFORE TRUNCATE ON offer_versions
  FOR EACH STATEMENT EXECUTE FUNCTION offer_engine_append_only();

-- =============================================================================
-- 3. offer_version_stores and offer_version_rules (immutable children)
-- =============================================================================

CREATE TABLE offer_version_stores (
  tenant_id  UUID     NOT NULL,
  offer_id   UUID     NOT NULL,
  version    INTEGER  NOT NULL,
  store_id   UUID     NOT NULL,
  CONSTRAINT offer_version_stores_pk PRIMARY KEY (tenant_id, offer_id, version, store_id),
  CONSTRAINT fk_offer_version_stores_version
    FOREIGN KEY (tenant_id, offer_id, version) REFERENCES offer_versions (tenant_id, offer_id, version) ON DELETE RESTRICT,
  CONSTRAINT fk_offer_version_stores_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT
);

-- The versions that cover a store (a store_manager's reads, the Pack).
CREATE INDEX idx_offer_version_stores_tenant_store
  ON offer_version_stores (tenant_id, store_id);

CREATE TABLE offer_version_rules (
  tenant_id    UUID     NOT NULL,
  offer_id     UUID     NOT NULL,
  version      INTEGER  NOT NULL,
  effect       TEXT     NOT NULL,
  product_id   UUID     NULL,
  category_id  UUID     NULL,
  brand_id     UUID     NULL,
  CONSTRAINT fk_offer_version_rules_version
    FOREIGN KEY (tenant_id, offer_id, version) REFERENCES offer_versions (tenant_id, offer_id, version) ON DELETE RESTRICT,
  CONSTRAINT fk_offer_version_rules_product_tenant
    FOREIGN KEY (product_id, tenant_id) REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_offer_version_rules_category_tenant
    FOREIGN KEY (category_id, tenant_id) REFERENCES tenant_product_categories (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_offer_version_rules_brand_tenant
    FOREIGN KEY (tenant_id, brand_id) REFERENCES tenant_product_brands (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT offer_version_rules_effect_allowed CHECK (effect IN ('include', 'exclude')),
  -- Exactly one dimension per rule.
  CONSTRAINT offer_version_rules_one_dimension CHECK (num_nonnulls(product_id, category_id, brand_id) = 1)
);

-- A rule appears once per version (the contract lists are uniqueItems).
CREATE UNIQUE INDEX uq_offer_version_rules_entry
  ON offer_version_rules (tenant_id, offer_id, version, effect, product_id, category_id, brand_id)
  NULLS NOT DISTINCT;

-- Re-materialisation on a catalog change finds the versions that name a
-- product, category or brand (also the referencing side of the RESTRICT FKs).
CREATE INDEX idx_offer_version_rules_product
  ON offer_version_rules (tenant_id, product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_offer_version_rules_category
  ON offer_version_rules (tenant_id, category_id) WHERE category_id IS NOT NULL;
CREATE INDEX idx_offer_version_rules_brand
  ON offer_version_rules (tenant_id, brand_id) WHERE brand_id IS NOT NULL;

-- The children of a version are written in the version's own transaction: its
-- published_at is that transaction's now(). A store row needs an explicit scope.
CREATE FUNCTION offer_version_children_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_published timestamptz;
  v_all_stores boolean;
BEGIN
  SELECT v.published_at, v.all_stores INTO v_published, v_all_stores
    FROM public.offer_versions v
   WHERE v.tenant_id = NEW.tenant_id AND v.offer_id = NEW.offer_id AND v.version = NEW.version;
  IF NOT FOUND THEN
    RAISE EXCEPTION '%: offer % version % does not exist', TG_TABLE_NAME, NEW.offer_id, NEW.version
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_published <> now() THEN
    RAISE EXCEPTION '%: offer % version % is published; its scope and rules never change',
      TG_TABLE_NAME, NEW.offer_id, NEW.version
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'offer_version_stores' AND v_all_stores THEN
    RAISE EXCEPTION 'offer % version % covers all stores: it lists none', NEW.offer_id, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER offer_version_stores_children_guard BEFORE INSERT ON offer_version_stores
  FOR EACH ROW EXECUTE FUNCTION offer_version_children_guard();
CREATE TRIGGER offer_version_rules_children_guard BEFORE INSERT ON offer_version_rules
  FOR EACH ROW EXECUTE FUNCTION offer_version_children_guard();

CREATE TRIGGER offer_version_stores_append_only_row BEFORE UPDATE OR DELETE ON offer_version_stores
  FOR EACH ROW EXECUTE FUNCTION offer_engine_append_only();
CREATE TRIGGER offer_version_stores_append_only_truncate BEFORE TRUNCATE ON offer_version_stores
  FOR EACH STATEMENT EXECUTE FUNCTION offer_engine_append_only();
CREATE TRIGGER offer_version_rules_append_only_row BEFORE UPDATE OR DELETE ON offer_version_rules
  FOR EACH ROW EXECUTE FUNCTION offer_engine_append_only();
CREATE TRIGGER offer_version_rules_append_only_truncate BEFORE TRUNCATE ON offer_version_rules
  FOR EACH STATEMENT EXECUTE FUNCTION offer_engine_append_only();

-- At COMMIT, a version is whole: at least one include rule (§5.2 rule 1), and
-- a store scope (all stores, or at least one listed store).
CREATE FUNCTION offer_versions_complete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.offer_version_rules r
     WHERE r.tenant_id = NEW.tenant_id AND r.offer_id = NEW.offer_id AND r.version = NEW.version
       AND r.effect = 'include') THEN
    RAISE EXCEPTION 'offer % version % has no include rule', NEW.offer_id, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT NEW.all_stores AND NOT EXISTS (
    SELECT 1 FROM public.offer_version_stores s
     WHERE s.tenant_id = NEW.tenant_id AND s.offer_id = NEW.offer_id AND s.version = NEW.version) THEN
    RAISE EXCEPTION 'offer % version % has no store', NEW.offer_id, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER offer_versions_complete AFTER INSERT ON offer_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION offer_versions_complete();

-- =============================================================================
-- 4. offer_pauses
-- =============================================================================

CREATE TABLE offer_pauses (
  id                   UUID         PRIMARY KEY,
  tenant_id            UUID         NOT NULL,
  offer_id             UUID         NOT NULL,
  -- NULL: the whole offer; otherwise one store.
  store_id             UUID         NULL,
  reason               TEXT         NOT NULL,
  paused_by_user_id    UUID         NOT NULL,
  paused_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  resumed_by_user_id   UUID         NULL,
  resumed_at           TIMESTAMPTZ  NULL,
  CONSTRAINT fk_offer_pauses_offer_tenant
    FOREIGN KEY (tenant_id, offer_id) REFERENCES offers (tenant_id, id) ON DELETE RESTRICT,
  -- Skipped while store_id is NULL (MATCH SIMPLE).
  CONSTRAINT fk_offer_pauses_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT offer_pauses_reason_length CHECK (char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT offer_pauses_resumed_whole CHECK ((resumed_at IS NULL) = (resumed_by_user_id IS NULL)),
  CONSTRAINT offer_pauses_resumed_after_paused CHECK (resumed_at IS NULL OR resumed_at >= paused_at)
);

-- At most one open whole-offer pause, and one open pause per (offer, store).
CREATE UNIQUE INDEX uq_offer_pauses_open_offer
  ON offer_pauses (tenant_id, offer_id) WHERE store_id IS NULL AND resumed_at IS NULL;
CREATE UNIQUE INDEX uq_offer_pauses_open_store
  ON offer_pauses (tenant_id, offer_id, store_id) WHERE store_id IS NOT NULL AND resumed_at IS NULL;

-- A resume is recorded once; nothing else ever changes.
CREATE FUNCTION offer_pauses_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.resumed_at IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.offer_id <> OLD.offer_id
     OR NEW.store_id IS DISTINCT FROM OLD.store_id OR NEW.reason <> OLD.reason
     OR NEW.paused_by_user_id <> OLD.paused_by_user_id OR NEW.paused_at <> OLD.paused_at THEN
    RAISE EXCEPTION 'offer pause %: only an open pause can be resumed, once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER offer_pauses_guard BEFORE UPDATE ON offer_pauses
  FOR EACH ROW EXECUTE FUNCTION offer_pauses_guard();
CREATE TRIGGER offer_pauses_append_only_row BEFORE DELETE ON offer_pauses
  FOR EACH ROW EXECUTE FUNCTION offer_engine_append_only();
CREATE TRIGGER offer_pauses_append_only_truncate BEFORE TRUNCATE ON offer_pauses
  FOR EACH STATEMENT EXECUTE FUNCTION offer_engine_append_only();

-- =============================================================================
-- 5. offer_pack_revisions and offer_pack_store_revisions
-- =============================================================================

CREATE TABLE offer_pack_revisions (
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  revision    BIGINT       NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT offer_pack_revisions_pk PRIMARY KEY (tenant_id, revision),
  CONSTRAINT offer_pack_revisions_positive CHECK (revision >= 1)
);

-- Monotonic and gapless per tenant: the next revision is the latest + 1. Two
-- concurrent writers cannot both take it (the primary key).
CREATE FUNCTION offer_pack_revisions_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_next bigint;
BEGIN
  SELECT COALESCE(max(r.revision), 0) + 1 INTO v_next
    FROM public.offer_pack_revisions r
   WHERE r.tenant_id = NEW.tenant_id;
  IF NEW.revision <> v_next THEN
    RAISE EXCEPTION 'tenant %: the next Offer Pack revision is %, not %', NEW.tenant_id, v_next, NEW.revision
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER offer_pack_revisions_before_insert BEFORE INSERT ON offer_pack_revisions
  FOR EACH ROW EXECUTE FUNCTION offer_pack_revisions_before_insert();
CREATE TRIGGER offer_pack_revisions_append_only_row BEFORE UPDATE OR DELETE ON offer_pack_revisions
  FOR EACH ROW EXECUTE FUNCTION offer_engine_append_only();
CREATE TRIGGER offer_pack_revisions_append_only_truncate BEFORE TRUNCATE ON offer_pack_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION offer_engine_append_only();

CREATE TABLE offer_pack_store_revisions (
  tenant_id         UUID         NOT NULL,
  store_id          UUID         NOT NULL,
  -- The latest revision that changed this store's Pack.
  applied_revision  BIGINT       NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT offer_pack_store_revisions_pk PRIMARY KEY (tenant_id, store_id),
  CONSTRAINT fk_offer_pack_store_revisions_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_offer_pack_store_revisions_revision
    FOREIGN KEY (tenant_id, applied_revision) REFERENCES offer_pack_revisions (tenant_id, revision) ON DELETE RESTRICT
);

CREATE TRIGGER offer_pack_store_revisions_set_updated_at BEFORE UPDATE ON offer_pack_store_revisions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The applied revision only moves forward, for every role (the 0072 guard).
CREATE FUNCTION offer_pack_store_revisions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.store_id <> OLD.store_id
     OR NEW.created_at <> OLD.created_at OR NEW.applied_revision <= OLD.applied_revision THEN
    RAISE EXCEPTION 'offer_pack_store_revisions %/%: the applied revision only moves forward',
      OLD.tenant_id, OLD.store_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER offer_pack_store_revisions_guard BEFORE UPDATE ON offer_pack_store_revisions
  FOR EACH ROW EXECUTE FUNCTION offer_pack_store_revisions_guard();
CREATE TRIGGER offer_pack_store_revisions_append_only_row BEFORE DELETE ON offer_pack_store_revisions
  FOR EACH ROW EXECUTE FUNCTION offer_engine_append_only();
CREATE TRIGGER offer_pack_store_revisions_append_only_truncate BEFORE TRUNCATE ON offer_pack_store_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION offer_engine_append_only();

-- =============================================================================
-- 6. offer_pack_eligible_products (materialised eligible sets, OD-6, OD-7)
-- =============================================================================

CREATE TABLE offer_pack_eligible_products (
  tenant_id      UUID     NOT NULL,
  store_id       UUID     NOT NULL,
  product_id     UUID     NOT NULL,
  offer_id       UUID     NOT NULL,
  offer_version  INTEGER  NOT NULL,
  -- In the store's Pack from this revision ...
  from_revision  BIGINT   NOT NULL,
  -- ... until this one (exclusive); NULL while current.
  to_revision    BIGINT   NULL,
  CONSTRAINT fk_offer_pack_eligible_products_version
    FOREIGN KEY (tenant_id, offer_id, offer_version)
    REFERENCES offer_versions (tenant_id, offer_id, version) ON DELETE RESTRICT,
  CONSTRAINT fk_offer_pack_eligible_products_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_offer_pack_eligible_products_product_tenant
    FOREIGN KEY (product_id, tenant_id) REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_offer_pack_eligible_products_from_revision
    FOREIGN KEY (tenant_id, from_revision) REFERENCES offer_pack_revisions (tenant_id, revision) ON DELETE RESTRICT,
  -- Skipped while to_revision is NULL (MATCH SIMPLE).
  CONSTRAINT fk_offer_pack_eligible_products_to_revision
    FOREIGN KEY (tenant_id, to_revision) REFERENCES offer_pack_revisions (tenant_id, revision) ON DELETE RESTRICT,
  CONSTRAINT offer_pack_eligible_products_range_ordered
    CHECK (to_revision IS NULL OR to_revision > from_revision),
  -- The Pack invariant (OD-7 clarification): in any revision, a product is in
  -- at most one offer per store.
  CONSTRAINT offer_pack_eligible_products_one_offer_per_product
    EXCLUDE USING gist (
      tenant_id WITH =,
      store_id WITH =,
      product_id WITH =,
      int8range(from_revision, to_revision) WITH &&)
);

-- The Pack read: a store's current sets.
CREATE INDEX idx_offer_pack_eligible_products_store_current
  ON offer_pack_eligible_products (tenant_id, store_id, offer_id, offer_version)
  WHERE to_revision IS NULL;
-- Re-materialisation, pause and end: an offer version's current rows.
CREATE INDEX idx_offer_pack_eligible_products_offer_current
  ON offer_pack_eligible_products (tenant_id, offer_id, offer_version, store_id)
  WHERE to_revision IS NULL;

-- History is frozen: a row is inserted at the tenant's latest revision, and
-- the only change is closing it at the latest revision. Once revision R+1
-- exists, the content of R can never change.
CREATE FUNCTION offer_pack_eligible_products_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_latest bigint;
BEGIN
  SELECT max(r.revision) INTO v_latest
    FROM public.offer_pack_revisions r
   WHERE r.tenant_id = NEW.tenant_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.to_revision IS NOT NULL OR v_latest IS NULL OR NEW.from_revision <> v_latest THEN
      RAISE EXCEPTION 'offer_pack_eligible_products: a row opens at the latest Pack revision (%), not %',
        v_latest, NEW.from_revision
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.to_revision IS NOT NULL
     OR NEW.tenant_id <> OLD.tenant_id OR NEW.store_id <> OLD.store_id OR NEW.product_id <> OLD.product_id
     OR NEW.offer_id <> OLD.offer_id OR NEW.offer_version <> OLD.offer_version
     OR NEW.from_revision <> OLD.from_revision
     OR NEW.to_revision IS NULL OR NEW.to_revision <> v_latest THEN
    RAISE EXCEPTION 'offer_pack_eligible_products: only a current row closes, at the latest Pack revision (%)', v_latest
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER offer_pack_eligible_products_guard BEFORE INSERT OR UPDATE ON offer_pack_eligible_products
  FOR EACH ROW EXECUTE FUNCTION offer_pack_eligible_products_guard();
CREATE TRIGGER offer_pack_eligible_products_append_only_row BEFORE DELETE ON offer_pack_eligible_products
  FOR EACH ROW EXECUTE FUNCTION offer_engine_append_only();
CREATE TRIGGER offer_pack_eligible_products_append_only_truncate BEFORE TRUNCATE ON offer_pack_eligible_products
  FOR EACH STATEMENT EXECUTE FUNCTION offer_engine_append_only();

-- =============================================================================
-- 7. sale_line_promotions (frozen sale facts, §8, §20)
-- =============================================================================

CREATE TABLE sale_line_promotions (
  sale_line_id     UUID           PRIMARY KEY,
  sale_id          UUID           NOT NULL,
  tenant_id        UUID           NOT NULL,
  store_id         UUID           NOT NULL,
  offer_id         UUID           NOT NULL,
  offer_version    INTEGER        NOT NULL,
  pack_revision    BIGINT         NOT NULL,
  -- 0 on an eligible line that is not a reward.
  discount_amount  NUMERIC(19,4)  NOT NULL,
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),
  -- A line of the same sale, store and tenant (the 0100 key).
  CONSTRAINT fk_sale_line_promotions_line
    FOREIGN KEY (sale_line_id, sale_id, tenant_id, store_id)
    REFERENCES sale_lines (id, sale_id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sale_line_promotions_version
    FOREIGN KEY (tenant_id, offer_id, offer_version)
    REFERENCES offer_versions (tenant_id, offer_id, version) ON DELETE RESTRICT,
  CONSTRAINT fk_sale_line_promotions_pack_revision
    FOREIGN KEY (tenant_id, pack_revision) REFERENCES offer_pack_revisions (tenant_id, revision) ON DELETE RESTRICT,
  CONSTRAINT sale_line_promotions_discount_non_negative
    CHECK (discount_amount >= 0 AND discount_amount <> 'NaN'::numeric)
);

-- readSale and returns: the promotion facts of a sale.
CREATE INDEX idx_sale_line_promotions_tenant_sale
  ON sale_line_promotions (tenant_id, sale_id);

-- The line arithmetic that must hold (OD-4, §8, F-9). The percent check needs
-- the currency minor unit and stays in the runtime (422).
CREATE FUNCTION sale_line_promotions_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_unit_price numeric;
  v_quantity numeric;
  v_line_amount numeric;
BEGIN
  SELECT l.unit_price, l.quantity, l.line_amount INTO v_unit_price, v_quantity, v_line_amount
    FROM public.sale_lines l
   WHERE l.id = NEW.sale_line_id AND l.tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sale_line_promotions: sale line % does not exist', NEW.sale_line_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_quantity < 1 OR v_quantity <> trunc(v_quantity) THEN
    RAISE EXCEPTION 'sale_line_promotions: line % has a non-whole quantity', NEW.sale_line_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.discount_amount > v_unit_price * v_quantity
     OR v_line_amount <> v_unit_price * v_quantity - NEW.discount_amount THEN
    RAISE EXCEPTION 'sale_line_promotions: line % breaks line_amount = unit_price x quantity - discount_amount',
      NEW.sale_line_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.discount_amount > 0 AND v_quantity <> 1 THEN
    RAISE EXCEPTION 'sale_line_promotions: reward line % has a quantity other than 1', NEW.sale_line_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER sale_line_promotions_line_guard BEFORE INSERT ON sale_line_promotions
  FOR EACH ROW EXECUTE FUNCTION sale_line_promotions_line_guard();
CREATE TRIGGER sale_line_promotions_append_only_row BEFORE UPDATE OR DELETE ON sale_line_promotions
  FOR EACH ROW EXECUTE FUNCTION offer_engine_append_only();
CREATE TRIGGER sale_line_promotions_append_only_truncate BEFORE TRUNCATE ON sale_line_promotions
  FOR EACH STATEMENT EXECUTE FUNCTION offer_engine_append_only();

-- =============================================================================
-- 8. sale_return_promotion_clawbacks (§9, OD-3)
-- =============================================================================

CREATE TABLE sale_return_promotion_clawbacks (
  return_id      UUID           NOT NULL,
  tenant_id      UUID           NOT NULL,
  store_id       UUID           NOT NULL,
  offer_id       UUID           NOT NULL,
  offer_version  INTEGER        NOT NULL,
  amount         NUMERIC(19,4)  NOT NULL,
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
  -- One clawback per offer per return.
  CONSTRAINT sale_return_promotion_clawbacks_pk PRIMARY KEY (return_id, offer_id),
  CONSTRAINT fk_sale_return_promotion_clawbacks_return
    FOREIGN KEY (return_id, tenant_id, store_id) REFERENCES sale_returns (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sale_return_promotion_clawbacks_version
    FOREIGN KEY (tenant_id, offer_id, offer_version)
    REFERENCES offer_versions (tenant_id, offer_id, version) ON DELETE RESTRICT,
  -- `PositiveDecimalAmount`: a clawback of 0 is not recorded.
  CONSTRAINT sale_return_promotion_clawbacks_amount_positive
    CHECK (amount > 0 AND amount <> 'NaN'::numeric)
);

CREATE TRIGGER sale_return_promotion_clawbacks_append_only_row
  BEFORE UPDATE OR DELETE ON sale_return_promotion_clawbacks
  FOR EACH ROW EXECUTE FUNCTION offer_engine_append_only();
CREATE TRIGGER sale_return_promotion_clawbacks_append_only_truncate
  BEFORE TRUNCATE ON sale_return_promotion_clawbacks
  FOR EACH STATEMENT EXECUTE FUNCTION offer_engine_append_only();

-- =============================================================================
-- 9. Row-level security: ENABLE + FORCE and tenant policies on all ten
-- =============================================================================

DO $$
DECLARE
  -- The empty-GUC CASE guard of 0010 / 0091 / 0097: '' reads as NULL, never a cast error.
  tenant_match CONSTANT text := 'tenant_id = CASE'
    || ' WHEN current_setting(''app.current_tenant'', true) = '''' THEN NULL'
    || ' ELSE current_setting(''app.current_tenant'', true)::uuid END';
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'offers', 'offer_versions', 'offer_version_stores', 'offer_version_rules', 'offer_pauses',
    'offer_pack_revisions', 'offer_pack_store_revisions', 'offer_pack_eligible_products',
    'sale_line_promotions', 'sale_return_promotion_clawbacks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', t || '_tenant_select', t, tenant_match);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', t || '_tenant_insert', t, tenant_match);
  END LOOP;
  -- UPDATE only where a guard trigger bounds the change. No DELETE policy anywhere.
  FOREACH t IN ARRAY ARRAY['offers', 'offer_pauses', 'offer_pack_store_revisions', 'offer_pack_eligible_products'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)',
      t || '_tenant_update', t, tenant_match, tenant_match);
  END LOOP;
END
$$;

COMMIT;
