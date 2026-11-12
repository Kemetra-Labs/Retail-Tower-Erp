/**
 * Offer Engine V1 — the frozen sale facts (0101, Jira RT-1336, RT-286 spec
 * 048 §8, §9, §20; contract `pos-sales/sales.yaml` 1.22.0-draft
 * `SaleLinePromotion`, `PromotionClawback`).
 *
 *   sale_line_promotions             One offer fact per sale line (PK): offer,
 *                                    version, Pack revision and
 *                                    discountAmount (0 on an eligible line
 *                                    that is not a reward). The composite FK
 *                                    (sale_line_id, sale_id, tenant_id,
 *                                    store_id) -> sale_lines (the 0100 key)
 *                                    pins it to a line of the same sale, store
 *                                    and tenant. A guard trigger refuses line
 *                                    arithmetic that cannot hold (a non-whole
 *                                    quantity, the net invariant, a reward on
 *                                    a quantity other than 1).
 *   sale_return_promotion_clawbacks  The per-offer clawback of a return
 *                                    (amount > 0), with the frozen version;
 *                                    one per (return, offer). A guard trigger
 *                                    refuses an offer version that is not on
 *                                    the returned sale's promotion facts.
 *
 * Both are APPEND-ONLY for every role (a trigger refuses UPDATE, DELETE and
 * TRUNCATE). RLS: ENABLE + FORCE; SELECT + INSERT tenant policies only. §XIV:
 * BUSINESS-CLASS (money amounts at the sale_lines scale, opaque ids).
 */
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, numeric, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";

import { saleLines } from "../sales/sale-lines";
import { saleReturns } from "../sales/sale-returns";
import { offerPackRevisions } from "./offer-pack";
import { offerVersions } from "./offer-versions";

export const saleLinePromotions = pgTable(
  "sale_line_promotions",
  {
    saleLineId: uuid("sale_line_id").primaryKey().notNull(),
    saleId: uuid("sale_id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    storeId: uuid("store_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    offerVersion: integer("offer_version").notNull(),
    packRevision: bigint("pack_revision", { mode: "number" }).notNull(),
    discountAmount: numeric("discount_amount", { precision: 19, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "fk_sale_line_promotions_line",
      columns: [t.saleLineId, t.saleId, t.tenantId, t.storeId],
      foreignColumns: [saleLines.id, saleLines.saleId, saleLines.tenantId, saleLines.storeId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_sale_line_promotions_version",
      columns: [t.tenantId, t.offerId, t.offerVersion],
      foreignColumns: [offerVersions.tenantId, offerVersions.offerId, offerVersions.version],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_sale_line_promotions_pack_revision",
      columns: [t.tenantId, t.packRevision],
      foreignColumns: [offerPackRevisions.tenantId, offerPackRevisions.revision],
    }).onDelete("restrict"),
    check(
      "sale_line_promotions_discount_non_negative",
      sql`${t.discountAmount} >= 0 AND ${t.discountAmount} <> 'NaN'::numeric`,
    ),
    index("idx_sale_line_promotions_tenant_sale").on(t.tenantId, t.saleId),
  ],
);

export const saleReturnPromotionClawbacks = pgTable(
  "sale_return_promotion_clawbacks",
  {
    returnId: uuid("return_id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    storeId: uuid("store_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    offerVersion: integer("offer_version").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: "sale_return_promotion_clawbacks_pk", columns: [t.returnId, t.offerId] }),
    foreignKey({
      name: "fk_sale_return_promotion_clawbacks_return",
      columns: [t.returnId, t.tenantId, t.storeId],
      foreignColumns: [saleReturns.id, saleReturns.tenantId, saleReturns.storeId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_sale_return_promotion_clawbacks_version",
      columns: [t.tenantId, t.offerId, t.offerVersion],
      foreignColumns: [offerVersions.tenantId, offerVersions.offerId, offerVersions.version],
    }).onDelete("restrict"),
    check(
      "sale_return_promotion_clawbacks_amount_positive",
      sql`${t.amount} > 0 AND ${t.amount} <> 'NaN'::numeric`,
    ),
  ],
);

export type SaleLinePromotionRow = typeof saleLinePromotions.$inferSelect;
export type NewSaleLinePromotionRow = typeof saleLinePromotions.$inferInsert;
export type SaleReturnPromotionClawbackRow = typeof saleReturnPromotionClawbacks.$inferSelect;
export type NewSaleReturnPromotionClawbackRow = typeof saleReturnPromotionClawbacks.$inferInsert;
