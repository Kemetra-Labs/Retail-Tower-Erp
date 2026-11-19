/**
 * Price Change Set content (0123, Jira RT-1151, RT-282 PR-05; spec 042 §3,
 * §4.2, §4.3, §5, §6, §10; contract pricing/price-change-sets.yaml 1.0.0-draft).
 *
 *   price_change_set_item_lists   One row per item-list write (an empty
 *                                 replacement too), sealed to its transaction.
 *   price_change_set_items        The authored items of a list.
 *   price_change_set_validations  One row per `validate`: the item list used,
 *                                 the revision, hashes, sensitivity, the
 *                                 preview summary and target Stores, and the
 *                                 counts of its rows; sealed to its transaction.
 *   price_change_set_lines        The materialized lines; immutable except the
 *                                 publish record (new_event_id, result_ids,
 *                                 set once; Q-B5).
 *   price_change_set_preview_lines        The stored per-Store preview rows.
 *   price_change_set_preview_memberships  The stored Zone-membership changes.
 *
 * Drizzle cannot declare the triggers, the deferred count checks or the
 * multi-column CHECKs; 0123's SQL is authoritative for them, for the
 * change_sets content-rules trigger and for the policies. RLS: ENABLE + FORCE
 * on all six; SELECT + INSERT, UPDATE on lines only; no DELETE. §XIV:
 * BUSINESS-CLASS.
 *
 * No runtime reads or writes these tables until RT-1484.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { tenantProducts } from "../catalog/tenant-products";
import { xid8 } from "../offers/offer-versions";
import { stores } from "../stores";
import { effectiveBoundsColumns, pricingAuthorshipColumns } from "./columns";
import { changeSets, priceBooks, priceEvents, priceZones } from "./pricing";

const CHANGE_OPS = sql`('set_price', 'adjust_amount', 'adjust_percent', 'end_price', 'reset_store_override', 'move_store_zone')`;
const LINE_CLASSES = sql`('new', 'replaces', 'conflicts_pending', 'shadowed', 'invalidates_dependent', 'past_dated', 'invalid')`;

/** The key every content row starts with: the set and the draft version it belongs to. */
const setVersionColumns = () => ({
  tenantId: uuid("tenant_id").notNull(),
  changeSetId: uuid("change_set_id").notNull(),
  changeSetVersion: integer("change_set_version").notNull(),
});

export const priceChangeSetItemLists = pgTable(
  "price_change_set_item_lists",
  {
    ...setVersionColumns(),
    itemCount: integer("item_count").notNull(),
    /** The writing transaction (forced by the insert trigger): only it adds items. */
    listXact: xid8("list_xact")
      .default(sql`pg_current_xact_id()`)
      .notNull(),
    ...pricingAuthorshipColumns(),
  },
  (t) => [
    primaryKey({ name: "price_change_set_item_lists_pk", columns: [t.tenantId, t.changeSetId, t.changeSetVersion] }),
    foreignKey({
      name: "price_change_set_item_lists_set_fk",
      columns: [t.tenantId, t.changeSetId],
      foreignColumns: [changeSets.tenantId, changeSets.id],
    }).onDelete("restrict"),
    check("price_change_set_item_lists_version_positive", sql`${t.changeSetVersion} >= 1`),
    check("price_change_set_item_lists_item_count", sql`${t.itemCount} BETWEEN 0 AND 500`),
  ],
);

export const priceChangeSetItems = pgTable(
  "price_change_set_items",
  {
    ...setVersionColumns(),
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
      name: "price_change_set_items_list_fk",
      columns: [t.tenantId, t.changeSetId, t.changeSetVersion],
      foreignColumns: [
        priceChangeSetItemLists.tenantId,
        priceChangeSetItemLists.changeSetId,
        priceChangeSetItemLists.changeSetVersion,
      ],
    }).onDelete("restrict"),
    check("price_change_set_items_position", sql`${t.position} BETWEEN 1 AND 500`),
    check("price_change_set_items_op", sql`${t.op} IN ${CHANGE_OPS}`),
  ],
);

export const priceChangeSetValidations = pgTable(
  "price_change_set_validations",
  {
    ...setVersionColumns(),
    itemListVersion: integer("item_list_version").notNull(),
    validatedAtRevision: bigint("validated_at_revision", { mode: "number" }).notNull(),
    previewHash: text("preview_hash").notNull(),
    targetStoreSetHash: text("target_store_set_hash").notNull(),
    sensitive: boolean("sensitive").notNull(),
    sensitivityReasons: text("sensitivity_reasons")
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** `PreviewSummary`. */
    summary: jsonb("summary").notNull(),
    /** The target Store set with time zones: [{ storeId, timezone }]. */
    targetStores: jsonb("target_stores").notNull(),
    lineCount: integer("line_count").notNull(),
    previewLineCount: integer("preview_line_count").notNull(),
    membershipChangeCount: integer("membership_change_count").notNull(),
    /** The validating transaction (forced by the insert trigger): only it writes lines and preview rows. */
    validationXact: xid8("validation_xact")
      .default(sql`pg_current_xact_id()`)
      .notNull(),
    ...pricingAuthorshipColumns(),
  },
  (t) => [
    primaryKey({ name: "price_change_set_validations_pk", columns: [t.tenantId, t.changeSetId, t.changeSetVersion] }),
    unique("price_change_set_validations_list_uk").on(t.tenantId, t.changeSetId, t.changeSetVersion, t.itemListVersion),
    foreignKey({
      name: "price_change_set_validations_set_fk",
      columns: [t.tenantId, t.changeSetId],
      foreignColumns: [changeSets.tenantId, changeSets.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_change_set_validations_list_fk",
      columns: [t.tenantId, t.changeSetId, t.itemListVersion],
      foreignColumns: [
        priceChangeSetItemLists.tenantId,
        priceChangeSetItemLists.changeSetId,
        priceChangeSetItemLists.changeSetVersion,
      ],
    }).onDelete("restrict"),
    check("price_change_set_validations_versions", sql`${t.itemListVersion} BETWEEN 1 AND ${t.changeSetVersion}`),
    check("price_change_set_validations_revision", sql`${t.validatedAtRevision} >= 0`),
  ],
);

export const priceChangeSetLines = pgTable(
  "price_change_set_lines",
  {
    ...setVersionColumns(),
    lineNo: integer("line_no").notNull(),
    itemListVersion: integer("item_list_version").notNull(),
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
    /** Set once, by the publishing transaction: the event this line became. */
    newEventId: uuid("new_event_id"),
    /** Set once with it: every other event or membership row its publish wrote. */
    resultIds: uuid("result_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    ...pricingAuthorshipColumns(),
  },
  (t) => [
    primaryKey({
      name: "price_change_set_lines_pk",
      columns: [t.tenantId, t.changeSetId, t.changeSetVersion, t.lineNo],
    }),
    foreignKey({
      name: "price_change_set_lines_validation_fk",
      columns: [t.tenantId, t.changeSetId, t.changeSetVersion, t.itemListVersion],
      foreignColumns: [
        priceChangeSetValidations.tenantId,
        priceChangeSetValidations.changeSetId,
        priceChangeSetValidations.changeSetVersion,
        priceChangeSetValidations.itemListVersion,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_change_set_lines_item_fk",
      columns: [t.tenantId, t.changeSetId, t.itemListVersion, t.itemPosition],
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
    check("price_change_set_lines_class", sql`${t.class} IN ${LINE_CLASSES}`),
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

/** The FK every preview row has to the line it derives from. */
type LineKey = { tenantId: AnyPgColumn; changeSetId: AnyPgColumn; changeSetVersion: AnyPgColumn; lineNo: AnyPgColumn };
const toLine = (t: LineKey, name: string) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.changeSetId, t.changeSetVersion, t.lineNo],
    foreignColumns: [
      priceChangeSetLines.tenantId,
      priceChangeSetLines.changeSetId,
      priceChangeSetLines.changeSetVersion,
      priceChangeSetLines.lineNo,
    ],
  }).onDelete("restrict");

export const priceChangeSetPreviewLines = pgTable(
  "price_change_set_preview_lines",
  {
    ...setVersionColumns(),
    lineNo: integer("line_no").notNull(),
    storeId: uuid("store_id").notNull(),
    productId: uuid("product_id").notNull(),
    sellUnit: text("sell_unit").notNull(),
    oldPrice: numeric("old_price", { precision: 19, scale: 4 }),
    oldSourceScope: text("old_source_scope"),
    newPrice: numeric("new_price", { precision: 19, scale: 4 }),
    newSourceScope: text("new_source_scope"),
    deltaPct: numeric("delta_pct", { precision: 24, scale: 2 }),
    roundedFrom: numeric("rounded_from", { precision: 30, scale: 8 }),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    class: text("class").notNull(),
    devices: integer("devices").notNull(),
    messages: text("messages")
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({
      name: "price_change_set_preview_lines_pk",
      columns: [t.tenantId, t.changeSetId, t.changeSetVersion, t.lineNo, t.storeId],
    }),
    toLine(t, "price_change_set_preview_lines_line_fk"),
    foreignKey({
      name: "price_change_set_preview_lines_store_fk",
      columns: [t.tenantId, t.storeId],
      foreignColumns: [stores.tenantId, stores.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_change_set_preview_lines_product_fk",
      columns: [t.productId, t.tenantId],
      foreignColumns: [tenantProducts.id, tenantProducts.tenantId],
    }).onDelete("restrict"),
    check("price_change_set_preview_lines_sell_unit", sql`${t.sellUnit} = 'each'`),
    check("price_change_set_preview_lines_class", sql`${t.class} IN ${LINE_CLASSES}`),
    check("price_change_set_preview_lines_devices", sql`${t.devices} >= 0`),
    index("ix_price_change_set_preview_lines_page").on(
      t.tenantId,
      t.changeSetId,
      t.changeSetVersion,
      t.storeId,
      t.productId,
      t.sellUnit,
      t.effectiveFrom,
    ),
  ],
);

export const priceChangeSetPreviewMemberships = pgTable(
  "price_change_set_preview_memberships",
  {
    ...setVersionColumns(),
    lineNo: integer("line_no").notNull(),
    storeId: uuid("store_id").notNull(),
    /** NULL: the Store fell back to the Book's default Zone. */
    fromZoneId: uuid("from_zone_id"),
    toZoneId: uuid("to_zone_id").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    supersededMembershipIds: uuid("superseded_membership_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({
      name: "price_change_set_preview_memberships_pk",
      columns: [t.tenantId, t.changeSetId, t.changeSetVersion, t.lineNo],
    }),
    toLine(t, "price_change_set_preview_memberships_line_fk"),
    foreignKey({
      name: "price_change_set_preview_memberships_store_fk",
      columns: [t.tenantId, t.storeId],
      foreignColumns: [stores.tenantId, stores.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_change_set_preview_memberships_from_fk",
      columns: [t.tenantId, t.fromZoneId],
      foreignColumns: [priceZones.tenantId, priceZones.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_change_set_preview_memberships_to_fk",
      columns: [t.tenantId, t.toZoneId],
      foreignColumns: [priceZones.tenantId, priceZones.id],
    }).onDelete("restrict"),
  ],
);
