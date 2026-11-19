/**
 * Price Change Set content (0123, Jira RT-1151, RT-282 PR-05; spec 042 §3,
 * §4.2, §4.3, §5, §10; contract pricing/price-change-sets.yaml 1.0.0-draft).
 *
 *   price_change_set_items  The authored items, one row per item per draft
 *                           version (every edit is kept). Insert-only, and only
 *                           while the set is a draft at exactly that version.
 *   price_change_set_lines  The lines `validate` materializes from the set's
 *                           latest items: concrete target, price, class and the
 *                           ids it replaces. Immutable, except `new_event_id`,
 *                           set once by the publishing transaction (Q-B5).
 *
 * Drizzle cannot declare the triggers or the multi-column CHECKs; 0123's SQL is
 * authoritative for them and for the policies. RLS: ENABLE + FORCE on both;
 * SELECT + INSERT on both, UPDATE on lines only; no DELETE. §XIV:
 * BUSINESS-CLASS.
 *
 * No runtime reads or writes these tables until RT-1484.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { tenantProducts } from "../catalog/tenant-products";
import { stores } from "../stores";
import { effectiveBoundsColumns, pricingAuthorshipColumns } from "./columns";
import { changeSets, priceBooks, priceEvents, priceZones } from "./pricing";

const CHANGE_OPS = sql`('set_price', 'adjust_amount', 'adjust_percent', 'end_price', 'reset_store_override', 'move_store_zone')`;

export const priceChangeSetItems = pgTable(
  "price_change_set_items",
  {
    tenantId: uuid("tenant_id").notNull(),
    changeSetId: uuid("change_set_id").notNull(),
    changeSetVersion: integer("change_set_version").notNull(),
    position: integer("position").notNull(),
    op: text("op").notNull(),
    /** The authored `PriceChangeItem` (selectors, price or helper, time basis, bounds). */
    item: jsonb("item").notNull(),
    ...pricingAuthorshipColumns(),
  },
  (t) => [
    primaryKey({
      name: "price_change_set_items_pk",
      columns: [t.tenantId, t.changeSetId, t.changeSetVersion, t.position],
    }),
    foreignKey({
      name: "price_change_set_items_set_fk",
      columns: [t.tenantId, t.changeSetId],
      foreignColumns: [changeSets.tenantId, changeSets.id],
    }).onDelete("restrict"),
    check("price_change_set_items_version_positive", sql`${t.changeSetVersion} >= 1`),
    check("price_change_set_items_position", sql`${t.position} BETWEEN 1 AND 500`),
    check("price_change_set_items_op", sql`${t.op} IN ${CHANGE_OPS}`),
  ],
);

export const priceChangeSetLines = pgTable(
  "price_change_set_lines",
  {
    tenantId: uuid("tenant_id").notNull(),
    changeSetId: uuid("change_set_id").notNull(),
    changeSetVersion: integer("change_set_version").notNull(),
    lineNo: integer("line_no").notNull(),
    itemVersion: integer("item_version").notNull(),
    itemPosition: integer("item_position").notNull(),
    op: text("op").notNull(),
    scope: text("scope").notNull(),
    priceBookId: uuid("price_book_id").notNull(),
    priceZoneId: uuid("price_zone_id"),
    storeId: uuid("store_id"),
    productId: uuid("product_id"),
    sellUnit: text("sell_unit"),
    ...effectiveBoundsColumns(),
    newPrice: numeric("new_price", { precision: 19, scale: 4 }),
    roundedFrom: numeric("rounded_from", { precision: 30, scale: 8 }),
    class: text("class").notNull(),
    messages: text("messages")
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** The active events (or memberships, for a Zone move) this line supersedes at publish. */
    replacedIds: uuid("replaced_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** Set once, by the publishing transaction. */
    newEventId: uuid("new_event_id"),
    ...pricingAuthorshipColumns(),
  },
  (t) => [
    primaryKey({
      name: "price_change_set_lines_pk",
      columns: [t.tenantId, t.changeSetId, t.changeSetVersion, t.lineNo],
    }),
    foreignKey({
      name: "price_change_set_lines_item_fk",
      columns: [t.tenantId, t.changeSetId, t.itemVersion, t.itemPosition],
      foreignColumns: [
        priceChangeSetItems.tenantId,
        priceChangeSetItems.changeSetId,
        priceChangeSetItems.changeSetVersion,
        priceChangeSetItems.position,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_change_set_lines_book_fk",
      columns: [t.tenantId, t.priceBookId],
      foreignColumns: [priceBooks.tenantId, priceBooks.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_change_set_lines_zone_fk",
      columns: [t.tenantId, t.priceBookId, t.priceZoneId],
      foreignColumns: [priceZones.tenantId, priceZones.priceBookId, priceZones.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_change_set_lines_store_fk",
      columns: [t.tenantId, t.storeId],
      foreignColumns: [stores.tenantId, stores.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_change_set_lines_product_fk",
      columns: [t.productId, t.tenantId],
      foreignColumns: [tenantProducts.id, tenantProducts.tenantId],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_change_set_lines_new_event_fk",
      columns: [t.tenantId, t.newEventId],
      foreignColumns: [priceEvents.tenantId, priceEvents.id],
    }).onDelete("restrict"),
    check("price_change_set_lines_line_no", sql`${t.lineNo} BETWEEN 1 AND 50000`),
    check("price_change_set_lines_op", sql`${t.op} IN ${CHANGE_OPS}`),
    check("price_change_set_lines_scope", sql`${t.scope} IN ('book', 'zone', 'store')`),
    check("price_change_set_lines_time_basis", sql`${t.timeBasis} IN ('store_local', 'absolute')`),
    check(
      "price_change_set_lines_class",
      sql`${t.class} IN ('new', 'replaces', 'conflicts_pending', 'shadowed', 'invalidates_dependent', 'past_dated', 'invalid')`,
    ),
    index("ix_price_change_set_lines_product")
      .on(t.tenantId, t.productId)
      .where(sql`${t.productId} IS NOT NULL`),
    index("ix_price_change_set_lines_zone")
      .on(t.tenantId, t.priceZoneId)
      .where(sql`${t.priceZoneId} IS NOT NULL`),
    index("ix_price_change_set_lines_store")
      .on(t.tenantId, t.storeId)
      .where(sql`${t.storeId} IS NOT NULL`),
    uniqueIndex("uq_price_change_set_lines_new_event")
      .on(t.tenantId, t.newEventId)
      .where(sql`${t.newEventId} IS NOT NULL`),
  ],
);
