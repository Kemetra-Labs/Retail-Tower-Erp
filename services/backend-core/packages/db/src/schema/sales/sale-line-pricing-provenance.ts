/**
 * Sale-line pricing provenance (0122, Jira RT-1151, RT-282 PR-07; contract
 * `pos-sales/sales.yaml` 1.25.0-draft `CaptureSaleLine.pricingProvenance`,
 * `PricingProvenance`).
 *
 * At most one row per sale line: what priced the line on the till, stored
 * VERBATIM at capture (owner D3, RT-1151 comment 17783). `origin = pricing`
 * carries the source scope, price event, price kind and the Store pricing
 * revision the till had applied (spec 043 G4-11); `origin = legacy` carries the
 * legacy source scope and the read-down catalogue cursor. A CHECK keeps exactly
 * one variant. No FK to price_events / pricing_revisions on purpose: a sale is
 * never refused over provenance (decision 611, spec 043 G4-13).
 *
 * APPEND-ONLY for every role (a trigger refuses UPDATE, DELETE and TRUNCATE; it
 * lives in 0122's SQL only). RLS: ENABLE + FORCE; SELECT + INSERT tenant
 * policies. §XIV: BUSINESS-CLASS.
 */
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { saleLines } from "./sale-lines";

export const saleLinePricingProvenance = pgTable(
  "sale_line_pricing_provenance",
  {
    // Tenant-first; the SQL column order is 0122's.
    tenantId: uuid("tenant_id").notNull(),
    storeId: uuid("store_id").notNull(),
    saleId: uuid("sale_id").notNull(),
    saleLineId: uuid("sale_line_id").primaryKey().notNull(),
    origin: text("origin").notNull(),
    sourceScope: text("source_scope").notNull(),
    priceEventId: uuid("price_event_id"),
    priceKind: text("price_kind"),
    pricingRevision: bigint("pricing_revision", { mode: "number" }),
    catalogCursor: text("catalog_cursor"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "fk_sale_line_pricing_provenance_line",
      columns: [t.saleLineId, t.saleId, t.tenantId, t.storeId],
      foreignColumns: [saleLines.id, saleLines.saleId, saleLines.tenantId, saleLines.storeId],
    }).onDelete("restrict"),
    check("sale_line_pricing_provenance_origin", sql`${t.origin} IN ('pricing', 'legacy')`),
    // The per-variant column CHECK and the append-only triggers live in 0122's SQL, which is authoritative.
    index("idx_sale_line_pricing_provenance_tenant_sale").on(t.tenantId, t.saleId),
  ],
);
