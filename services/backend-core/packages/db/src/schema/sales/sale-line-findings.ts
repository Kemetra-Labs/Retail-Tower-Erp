/**
 * Sale-line findings — Drizzle schema (0089, Jira RT-451 slice S3, migration
 * M2; captain decision RT-451 comment 16262; contract `inventory/inventory.yaml`
 * `listSaleLineFindings` / `SaleLineFinding`).
 *
 * `sale_line_findings`: the append-only critical findings recorded on a
 * tracked sale line at capture (RT-50 G7-9 rows 2 and 3; RT-455 OD-2), one per
 * (line, kind, cause). They are never removed or rewritten, including after
 * the cause is repaired.
 *
 *   unvalidated_tracked_line  validation_missing | validation_mismatch
 *   sold_under_hold           quality_hold | recall_hold (with the hold)
 *   erp_intent_held           expired | edge_map_missing
 *
 * RLS: ENABLE + FORCE; SELECT + INSERT tenant policies only. The same-tenant
 * composite FKs (the sale of the same store, the identity of the line's own
 * product, the hold) and the policies are defined in 0089's SQL. §XIV:
 * BUSINESS-CLASS — opaque ids, enumerated codes, a date and timestamps.
 */
import { sql } from "drizzle-orm";
import { check, date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { tenants } from "../tenants";
import { saleLines } from "./sale-lines";

export const SALE_LINE_FINDING_KINDS = ["unvalidated_tracked_line", "sold_under_hold", "erp_intent_held"] as const;
export type SaleLineFindingKind = (typeof SALE_LINE_FINDING_KINDS)[number];

export const SALE_LINE_FINDING_CAUSES = [
  "validation_missing",
  "validation_mismatch",
  "quality_hold",
  "recall_hold",
  "expired",
  "edge_map_missing",
] as const;
export type SaleLineFindingCause = (typeof SALE_LINE_FINDING_CAUSES)[number];

export const saleLineFindings = pgTable(
  "sale_line_findings",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Composite FKs (sale_id, tenant_id, store_id) -> sales,
    // (tracking_identity_id, tenant_product_ref, tenant_id) ->
    // tracking_identities and (hold_id, tenant_id) -> tracking_holds are
    // SQL-only in 0089.
    storeId: uuid("store_id").notNull(),
    saleId: uuid("sale_id").notNull(),
    saleLineId: uuid("sale_line_id")
      .notNull()
      .references(() => saleLines.id, { onDelete: "restrict" }),
    tenantProductRef: uuid("tenant_product_ref").notNull(),
    trackingIdentityId: uuid("tracking_identity_id").notNull(),
    kind: text("kind").notNull(),
    cause: text("cause").notNull(),
    holdId: uuid("hold_id"),
    businessDate: date("business_date").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "sale_line_findings_kind_allowed",
      sql`${t.kind} IN ('unvalidated_tracked_line', 'sold_under_hold', 'erp_intent_held')`,
    ),
    check(
      "sale_line_findings_kind_cause",
      sql`(${t.kind} = 'unvalidated_tracked_line' AND ${t.cause} IN ('validation_missing', 'validation_mismatch')) OR (${t.kind} = 'sold_under_hold' AND ${t.cause} IN ('quality_hold', 'recall_hold')) OR (${t.kind} = 'erp_intent_held' AND ${t.cause} IN ('expired', 'edge_map_missing'))`,
    ),
    check("sale_line_findings_hold_iff_sold_under_hold", sql`(${t.kind} = 'sold_under_hold') = (${t.holdId} IS NOT NULL)`),
    uniqueIndex("uq_sale_line_findings_line_kind_cause").on(t.saleLineId, t.kind, t.cause),
    index("idx_sale_line_findings_tenant_recorded").on(t.tenantId, t.recordedAt.desc(), t.id.desc()),
    index("idx_sale_line_findings_tenant_store_recorded").on(t.tenantId, t.storeId, t.recordedAt.desc(), t.id.desc()),
  ],
);

export type SaleLineFindingRow = typeof saleLineFindings.$inferSelect;
