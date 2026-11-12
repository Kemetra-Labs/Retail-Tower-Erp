/**
 * Offer Engine V1 — published versions and their children (0101, Jira
 * RT-1336, RT-286 spec 048 §4-§5; contract `offers.openapi.yaml`
 * `OfferVersion`, `OfferDefinition`).
 *
 *   offer_versions        One row per published version, numbered 1, 2, 3 ...
 *                         per offer (a trigger), with the frozen definition
 *                         scalars. `published_at` is forced to the server's
 *                         now(). APPEND-ONLY for every role (§16).
 *   offer_version_stores  The explicit store scope (none when all_stores).
 *   offer_version_rules   The include / exclude rules (§5.2, OD-1): exactly
 *                         one product, category or brand of the same tenant.
 *
 * The children are written in the version's own transaction only, and at
 * COMMIT a deferred constraint trigger checks the version is whole (an include
 * rule; a store unless all_stores). Both children are append-only too, so a
 * published version never changes. The guards, the composite FKs onto the
 * catalog (products (id, tenant_id), categories (id, tenant_id), brands
 * (tenant_id, id)) and the policies are in 0101's SQL.
 *
 * RLS: ENABLE + FORCE; SELECT + INSERT tenant policies only. §XIV:
 * BUSINESS-CLASS.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { tenantProductBrands } from "../catalog/tenant-product-brands";
import { tenantProductCategories } from "../catalog/tenant-product-categories";
import { tenantProducts } from "../catalog/tenant-products";
import { stores } from "../stores";
import { offers } from "./offers";

export const OFFER_TYPES = ["buy_x_get_y_percent"] as const;
export type OfferType = (typeof OFFER_TYPES)[number];
export const OFFER_TIME_BASES = ["store_local", "absolute"] as const;
export type OfferTimeBasis = (typeof OFFER_TIME_BASES)[number];
export const OFFER_OFFLINE_POLICIES = ["allow_cached", "online_only"] as const;
export type OfferOfflinePolicy = (typeof OFFER_OFFLINE_POLICIES)[number];
export const OFFER_RULE_EFFECTS = ["include", "exclude"] as const;
export type OfferRuleEffect = (typeof OFFER_RULE_EFFECTS)[number];

export const offerVersions = pgTable(
  "offer_versions",
  {
    tenantId: uuid("tenant_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    version: integer("version").notNull(),
    nameAr: text("name_ar").notNull(),
    nameEn: text("name_en"),
    offerType: text("offer_type").$type<OfferType>().notNull(),
    buyQuantity: integer("buy_quantity").notNull(),
    getQuantity: integer("get_quantity").notNull(),
    /** A whole percent 1..100. */
    percentOff: smallint("percent_off").notNull(),
    rewardSelection: text("reward_selection").$type<"cheapest">().notNull(),
    /** Null = unlimited. */
    maxApplicationsPerSale: integer("max_applications_per_sale"),
    priceBasis: text("price_basis").$type<"resolved_store_price">().notNull(),
    allStores: boolean("all_stores").notNull(),
    timeBasis: text("time_basis").$type<OfferTimeBasis>().notNull(),
    /** store_local: local date-times, resolved in each store's IANA timezone. */
    startsLocal: timestamp("starts_local", { withTimezone: false, mode: "string" }),
    endsLocal: timestamp("ends_local", { withTimezone: false, mode: "string" }),
    /** absolute: instants, the same for every store. */
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    offlinePolicy: text("offline_policy").$type<OfferOfflinePolicy>().notNull().default("allow_cached"),
    eligibleSetCount: integer("eligible_set_count").notNull(),
    publishedByUserId: uuid("published_by_user_id").notNull(),
    /** Forced to the server's now() by the insert trigger. */
    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: "offer_versions_pk", columns: [t.tenantId, t.offerId, t.version] }),
    foreignKey({
      name: "fk_offer_versions_offer_tenant",
      columns: [t.tenantId, t.offerId],
      foreignColumns: [offers.tenantId, offers.id],
    }).onDelete("restrict"),
    check("offer_versions_version_positive", sql`${t.version} >= 1`),
    check("offer_versions_type_allowed", sql`${t.offerType} = 'buy_x_get_y_percent'`),
    check("offer_versions_percent_off_range", sql`${t.percentOff} BETWEEN 1 AND 100`),
    check("offer_versions_offline_policy_allowed", sql`${t.offlinePolicy} IN ('allow_cached', 'online_only')`),
  ],
);

export const offerVersionStores = pgTable(
  "offer_version_stores",
  {
    tenantId: uuid("tenant_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    version: integer("version").notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "offer_version_stores_pk", columns: [t.tenantId, t.offerId, t.version, t.storeId] }),
    index("idx_offer_version_stores_tenant_store").on(t.tenantId, t.storeId),
    foreignKey({
      name: "fk_offer_version_stores_version",
      columns: [t.tenantId, t.offerId, t.version],
      foreignColumns: [offerVersions.tenantId, offerVersions.offerId, offerVersions.version],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_offer_version_stores_store_tenant",
      columns: [t.tenantId, t.storeId],
      foreignColumns: [stores.tenantId, stores.id],
    }).onDelete("restrict"),
  ],
);

export const offerVersionRules = pgTable(
  "offer_version_rules",
  {
    /** Surrogate key (the natural key has nullable dimension columns). */
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    version: integer("version").notNull(),
    effect: text("effect").$type<OfferRuleEffect>().notNull(),
    productId: uuid("product_id"),
    categoryId: uuid("category_id"),
    brandId: uuid("brand_id"),
  },
  (t) => [
    foreignKey({
      name: "fk_offer_version_rules_version",
      columns: [t.tenantId, t.offerId, t.version],
      foreignColumns: [offerVersions.tenantId, offerVersions.offerId, offerVersions.version],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_offer_version_rules_product_tenant",
      columns: [t.productId, t.tenantId],
      foreignColumns: [tenantProducts.id, tenantProducts.tenantId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_offer_version_rules_category_tenant",
      columns: [t.categoryId, t.tenantId],
      foreignColumns: [tenantProductCategories.id, tenantProductCategories.tenantId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_offer_version_rules_brand_tenant",
      columns: [t.tenantId, t.brandId],
      foreignColumns: [tenantProductBrands.tenantId, tenantProductBrands.id],
    }).onDelete("restrict"),
    check("offer_version_rules_effect_allowed", sql`${t.effect} IN ('include', 'exclude')`),
    check("offer_version_rules_one_dimension", sql`num_nonnulls(${t.productId}, ${t.categoryId}, ${t.brandId}) = 1`),
    // NULLS NOT DISTINCT in 0101's SQL (Drizzle's index builder cannot declare it).
    uniqueIndex("uq_offer_version_rules_entry").on(
      t.tenantId,
      t.offerId,
      t.version,
      t.effect,
      t.productId,
      t.categoryId,
      t.brandId,
    ),
    index("idx_offer_version_rules_product").on(t.tenantId, t.productId).where(sql`${t.productId} IS NOT NULL`),
    index("idx_offer_version_rules_category").on(t.tenantId, t.categoryId).where(sql`${t.categoryId} IS NOT NULL`),
    index("idx_offer_version_rules_brand").on(t.tenantId, t.brandId).where(sql`${t.brandId} IS NOT NULL`),
  ],
);

export type OfferVersionRow = typeof offerVersions.$inferSelect;
export type NewOfferVersionRow = typeof offerVersions.$inferInsert;
export type OfferVersionStoreRow = typeof offerVersionStores.$inferSelect;
export type OfferVersionRuleRow = typeof offerVersionRules.$inferSelect;
export type NewOfferVersionRuleRow = typeof offerVersionRules.$inferInsert;
