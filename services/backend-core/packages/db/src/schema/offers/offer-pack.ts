/**
 * Offer Engine V1 — the Offer Pack (0101, Jira RT-1336, RT-286 spec 048 §7,
 * §19, OD-6, OD-7, OD-8; contract `offers.openapi.yaml` `OfferPack`,
 * `PackOffer`).
 *
 *   offer_pack_revisions          The tenant-wide, monotonic Pack revision:
 *                                 1, 2, 3 ... per tenant with no gap (a
 *                                 trigger). Append-only. No row = revision 0.
 *   offer_pack_store_revisions    Per store, the latest revision that changed
 *                                 its Pack (the ETag basis); only moves
 *                                 forward (the 0072 guard pattern).
 *   offer_pack_eligible_products  The materialised eligible sets (OD-6), per
 *                                 store, as validity ranges of revisions:
 *                                 product P is in offer O version V for store
 *                                 S in revisions [from_revision, to_revision)
 *                                 (to_revision null = current). The rows
 *                                 covering revision R for S are exactly S's
 *                                 Pack eligible sets at R. A row opens only at
 *                                 the tenant's latest revision and the only
 *                                 change is closing it at the latest revision
 *                                 (a guard trigger), so a past revision never
 *                                 changes. No DELETE.
 *
 * PACK INVARIANT (OD-7 clarification): in any revision a product is in at most
 * one offer per store, enforced in SQL by the EXCLUDE constraint
 * `offer_pack_eligible_products_one_offer_per_product` (gist over tenant,
 * store, product and int8range(from_revision, to_revision)). Drizzle cannot
 * declare an EXCLUDE constraint; it lives in 0101's SQL only, with the guards,
 * the composite FKs and the policies.
 *
 * RLS: ENABLE + FORCE; SELECT + INSERT everywhere, UPDATE on the store
 * revisions and the eligible products only; no DELETE. §XIV: BUSINESS-CLASS.
 */
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";

import { tenantProducts } from "../catalog/tenant-products";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { offerVersions } from "./offer-versions";

export const offerPackRevisions = pgTable(
  "offer_pack_revisions",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: "offer_pack_revisions_pk", columns: [t.tenantId, t.revision] }),
    check("offer_pack_revisions_positive", sql`${t.revision} >= 1`),
  ],
);

export const offerPackStoreRevisions = pgTable(
  "offer_pack_store_revisions",
  {
    tenantId: uuid("tenant_id").notNull(),
    storeId: uuid("store_id").notNull(),
    appliedRevision: bigint("applied_revision", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: "offer_pack_store_revisions_pk", columns: [t.tenantId, t.storeId] }),
    foreignKey({
      name: "fk_offer_pack_store_revisions_store_tenant",
      columns: [t.tenantId, t.storeId],
      foreignColumns: [stores.tenantId, stores.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_offer_pack_store_revisions_revision",
      columns: [t.tenantId, t.appliedRevision],
      foreignColumns: [offerPackRevisions.tenantId, offerPackRevisions.revision],
    }).onDelete("restrict"),
  ],
);

export const offerPackEligibleProducts = pgTable(
  "offer_pack_eligible_products",
  {
    tenantId: uuid("tenant_id").notNull(),
    storeId: uuid("store_id").notNull(),
    productId: uuid("product_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    offerVersion: integer("offer_version").notNull(),
    fromRevision: bigint("from_revision", { mode: "number" }).notNull(),
    /** Exclusive; null while current. */
    toRevision: bigint("to_revision", { mode: "number" }),
  },
  (t) => [
    foreignKey({
      name: "fk_offer_pack_eligible_products_version",
      columns: [t.tenantId, t.offerId, t.offerVersion],
      foreignColumns: [offerVersions.tenantId, offerVersions.offerId, offerVersions.version],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_offer_pack_eligible_products_store_tenant",
      columns: [t.tenantId, t.storeId],
      foreignColumns: [stores.tenantId, stores.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_offer_pack_eligible_products_product_tenant",
      columns: [t.productId, t.tenantId],
      foreignColumns: [tenantProducts.id, tenantProducts.tenantId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_offer_pack_eligible_products_from_revision",
      columns: [t.tenantId, t.fromRevision],
      foreignColumns: [offerPackRevisions.tenantId, offerPackRevisions.revision],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_offer_pack_eligible_products_to_revision",
      columns: [t.tenantId, t.toRevision],
      foreignColumns: [offerPackRevisions.tenantId, offerPackRevisions.revision],
    }).onDelete("restrict"),
    check(
      "offer_pack_eligible_products_range_ordered",
      sql`${t.toRevision} IS NULL OR ${t.toRevision} > ${t.fromRevision}`,
    ),
    index("idx_offer_pack_eligible_products_store_current")
      .on(t.tenantId, t.storeId, t.offerId, t.offerVersion)
      .where(sql`${t.toRevision} IS NULL`),
    index("idx_offer_pack_eligible_products_offer_current")
      .on(t.tenantId, t.offerId, t.offerVersion, t.storeId)
      .where(sql`${t.toRevision} IS NULL`),
  ],
);

export type OfferPackRevisionRow = typeof offerPackRevisions.$inferSelect;
export type OfferPackStoreRevisionRow = typeof offerPackStoreRevisions.$inferSelect;
export type OfferPackEligibleProductRow = typeof offerPackEligibleProducts.$inferSelect;
export type NewOfferPackEligibleProductRow = typeof offerPackEligibleProducts.$inferInsert;
