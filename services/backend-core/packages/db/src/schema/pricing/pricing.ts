/**
 * Retail Pricing core (0121, Jira RT-1151, RT-282 PR-05; spec 041 data-model
 * §2.1-§2.6, spec 042 §4.1 / §9; contracts pricing/price-structure.yaml,
 * pricing/price-change-sets.yaml, pricing/price-inquiry.yaml 1.0.0-draft).
 *
 *   change_sets              The domain-neutral Change Set header (OD-4):
 *                            state machine, optimistic version, validation
 *                            binding, transition actors, published revision.
 *   price_books              v1: at most one non-retired Book per pricing
 *                            context, never retired; currency, tax basis and
 *                            context never change (472, Q-5).
 *   price_zones              Exactly one immutable default Zone per Book (Q-8).
 *   pricing_revisions        Immutable, gapless per tenant (OD-3); `issue_xact`
 *                            is the only transaction that may publish or end
 *                            events and memberships at that revision.
 *   pricing_revision_stores  The Store fan-out; applied revision = max per Store.
 *   price_zone_memberships   Effective-dated Store -> Zone, absolute instants.
 *   price_events             The immutable price timeline (book / zone / store
 *                            scope, store_local or absolute time basis).
 *
 * Drizzle cannot declare EXCLUDE constraints, triggers, deferred constraint
 * triggers or partial unique indexes with expressions; those live in 0121's
 * SQL only: the overlap EXCLUDEs on memberships and events (btree_gist), the
 * guard / append-only / no-delete triggers, the "a Book has a default Zone"
 * deferred check, the gapless revision trigger and the policies.
 *
 * RLS: ENABLE + FORCE on all seven; SELECT + INSERT everywhere, UPDATE on
 * change_sets, price_books, price_zones, price_zone_memberships and
 * price_events only; no DELETE. §XIV: BUSINESS-CLASS.
 *
 * No runtime reads or writes these tables until RT-1484.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { tenantProducts } from "../catalog/tenant-products";
import { xid8 } from "../offers/offer-versions";
import { stores } from "../stores";
import { effectiveBoundsColumns, pricingAuthorshipColumns, tenantIdColumn, timelineColumns } from "./columns";

export const changeSets = pgTable(
  "change_sets",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(),
    domain: text("domain").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    reason: text("reason"),
    state: text("state").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    validatedAtRevision: bigint("validated_at_revision", { mode: "number" }),
    previewHash: text("preview_hash"),
    targetStoreSetHash: text("target_store_set_hash"),
    sensitive: boolean("sensitive"),
    sensitivityReasons: text("sensitivity_reasons")
      .array()
      .notNull()
      .default(sql`'{}'`),
    revisionNo: bigint("revision_no", { mode: "number" }),
    rollsBackChangeSetId: uuid("rolls_back_change_set_id"),
    ...pricingAuthorshipColumns(),
    submittedByUserId: uuid("submitted_by_user_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedByUserId: uuid("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    publishedByUserId: uuid("published_by_user_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    cancelledByUserId: uuid("cancelled_by_user_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    rejectedByUserId: uuid("rejected_by_user_id"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    /** 0123: the version holding the current item list, and the latest validation; NULL never written. */
    itemsVersion: integer("items_version"),
    linesVersion: integer("lines_version"),
  },
  (t) => [
    unique("change_sets_tenant_id_uk").on(t.tenantId, t.id),
    check("change_sets_domain", sql`${t.domain} IN ('pricing')`),
    check("change_sets_kind", sql`${t.kind} IN ('standard', 'emergency', 'rollback', 'legacy_import')`),
    check("change_sets_version_positive", sql`${t.version} >= 1`),
    check("change_sets_items_version", sql`${t.itemsVersion} IS NULL OR ${t.itemsVersion} BETWEEN 1 AND ${t.version}`),
    check("change_sets_lines_version", sql`${t.linesVersion} IS NULL OR ${t.linesVersion} BETWEEN 1 AND ${t.version}`),
    index("ix_change_sets_tenant_state").on(t.tenantId, t.domain, t.state),
  ],
);

export const priceBooks = pgTable(
  "price_books",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    taxPriceBasis: text("tax_price_basis").notNull(),
    pricingContext: text("pricing_context").notNull().default("retail"),
    isDefault: boolean("is_default").notNull().default(true),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    ...pricingAuthorshipColumns(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("price_books_tenant_code_uk").on(t.tenantId, t.code),
    unique("price_books_tenant_id_uk").on(t.tenantId, t.id),
    unique("price_books_tenant_id_currency_uk").on(t.tenantId, t.id, t.currencyCode),
    check("price_books_tax_price_basis", sql`${t.taxPriceBasis} IN ('inclusive', 'exclusive')`),
    check("price_books_pricing_context", sql`${t.pricingContext} IN ('retail')`),
  ],
);

export const priceZones = pgTable(
  "price_zones",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    priceBookId: uuid("price_book_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredByUserId: uuid("retired_by_user_id"),
    retireReason: text("retire_reason"),
    ...pricingAuthorshipColumns(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "price_zones_book_fk",
      columns: [t.tenantId, t.priceBookId],
      foreignColumns: [priceBooks.tenantId, priceBooks.id],
    }).onDelete("restrict"),
    unique("price_zones_book_code_uk").on(t.tenantId, t.priceBookId, t.code),
    unique("price_zones_tenant_id_uk").on(t.tenantId, t.id),
    unique("price_zones_tenant_book_id_uk").on(t.tenantId, t.priceBookId, t.id),
  ],
);

export const pricingRevisions = pgTable(
  "pricing_revisions",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(),
    revisionNo: bigint("revision_no", { mode: "number" }).notNull(),
    changeSetId: uuid("change_set_id").notNull(),
    kind: text("kind").notNull(),
    rollsBackRevisionNo: bigint("rolls_back_revision_no", { mode: "number" }),
    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
    publishedByUserId: uuid("published_by_user_id").notNull(),
    earliestEffectiveAt: timestamp("earliest_effective_at", { withTimezone: true }),
    correlationId: uuid("correlation_id").notNull(),

    /** The issuing transaction, forced by the insert trigger. */
    issueXact: xid8("issue_xact")
      .default(sql`pg_current_xact_id()`)
      .notNull(),
  },
  (t) => [
    unique("pricing_revisions_tenant_revision_uk").on(t.tenantId, t.revisionNo),
    unique("pricing_revisions_tenant_change_set_uk").on(t.tenantId, t.changeSetId),
    unique("pricing_revisions_tenant_revision_set_uk").on(t.tenantId, t.revisionNo, t.changeSetId),
    foreignKey({
      name: "pricing_revisions_change_set_fk",
      columns: [t.tenantId, t.changeSetId],
      foreignColumns: [changeSets.tenantId, changeSets.id],
    }).onDelete("restrict"),
    check("pricing_revisions_positive", sql`${t.revisionNo} >= 1`),
    check("pricing_revisions_kind", sql`${t.kind} IN ('publish', 'emergency', 'rollback', 'legacy_import')`),
  ],
);

export const pricingRevisionStores = pgTable(
  "pricing_revision_stores",
  {
    tenantId: uuid("tenant_id").notNull(),
    storeId: uuid("store_id").notNull(),
    revisionNo: bigint("revision_no", { mode: "number" }).notNull(),
    ...pricingAuthorshipColumns(),
  },
  (t) => [
    primaryKey({ name: "pricing_revision_stores_pk", columns: [t.tenantId, t.storeId, t.revisionNo] }),
    foreignKey({
      name: "pricing_revision_stores_revision_fk",
      columns: [t.tenantId, t.revisionNo],
      foreignColumns: [pricingRevisions.tenantId, pricingRevisions.revisionNo],
    }).onDelete("restrict"),
    foreignKey({
      name: "pricing_revision_stores_store_fk",
      columns: [t.tenantId, t.storeId],
      foreignColumns: [stores.tenantId, stores.id],
    }).onDelete("restrict"),
    index("ix_pricing_revision_stores_revision").on(t.tenantId, t.revisionNo),
  ],
);

export const priceZoneMemberships = pgTable(
  "price_zone_memberships",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    priceBookId: uuid("price_book_id").notNull(),
    priceZoneId: uuid("price_zone_id").notNull(),
    storeId: uuid("store_id").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    ...timelineColumns(),
    ...pricingAuthorshipColumns(),
  },
  (t) => [
    foreignKey({
      name: "price_zone_memberships_zone_fk",
      columns: [t.tenantId, t.priceBookId, t.priceZoneId],
      foreignColumns: [priceZones.tenantId, priceZones.priceBookId, priceZones.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_zone_memberships_store_fk",
      columns: [t.tenantId, t.storeId],
      foreignColumns: [stores.tenantId, stores.id],
    }).onDelete("restrict"),
    check("price_zone_memberships_state", sql`${t.state} IN ('active', 'superseded')`),
  ],
);

export const priceEvents = pgTable(
  "price_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    priceBookId: uuid("price_book_id").notNull(),
    scope: text("scope").notNull(),
    priceZoneId: uuid("price_zone_id"),
    storeId: uuid("store_id"),
    productId: uuid("product_id").notNull(),
    sellUnit: text("sell_unit").notNull().default("each"),
    priceKind: text("price_kind").notNull().default("regular"),
    price: numeric("price", { precision: 19, scale: 4 }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    ...effectiveBoundsColumns(),
    ...timelineColumns(),
    supersedesEventId: uuid("supersedes_event_id"),
    changeSetId: uuid("change_set_id").notNull(),
    source: text("source").notNull(),
    ...pricingAuthorshipColumns(),
  },
  (t) => [
    unique("price_events_tenant_id_uk").on(t.tenantId, t.id),
    foreignKey({
      name: "price_events_book_currency_fk",
      columns: [t.tenantId, t.priceBookId, t.currencyCode],
      foreignColumns: [priceBooks.tenantId, priceBooks.id, priceBooks.currencyCode],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_events_product_fk",
      columns: [t.productId, t.tenantId],
      foreignColumns: [tenantProducts.id, tenantProducts.tenantId],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_events_change_set_fk",
      columns: [t.tenantId, t.changeSetId],
      foreignColumns: [changeSets.tenantId, changeSets.id],
    }).onDelete("restrict"),
    check("price_events_scope", sql`${t.scope} IN ('book', 'zone', 'store')`),
    check("price_events_price_non_negative", sql`${t.price} >= 0`),
    check("price_events_time_basis", sql`${t.timeBasis} IN ('store_local', 'absolute')`),
    check("price_events_state", sql`${t.state} IN ('active', 'superseded', 'cancelled')`),
    index("ix_price_events_revision").on(t.tenantId, t.publishedInRevision),
  ],
);
