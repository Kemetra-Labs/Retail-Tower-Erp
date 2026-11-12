/**
 * `erpnext_posting_resolution` — the frozen ERP resolution of a posting intent
 * (RT-330, RT-326 phase 1a; migration 0037).
 *
 * One row per (intent, resolution_version, sale line): the ERP item ref and
 * warehouse ref the intent will post with, the ids of the maps they came from,
 * and who resolved them (`system` at creation, `operator` on a repair re-head,
 * `backfill` for intents that existed before 0037). The posting feed reads the
 * version named by `erpnext_posting_status.current_resolution_version`, so a
 * later retire or re-point of an item map never strands or retargets an
 * accepted intent (RT-316 V1).
 *
 * Append-only: SELECT + INSERT RLS policies only. A correction is a new
 * resolution_version, never an edit. Composite FK (intent_id, tenant_id) ->
 * erpnext_posting_status (id, tenant_id) is declared in the 0037 SQL migration.
 * TENANT-only RLS by `tenant_id`.
 *
 * RT-451 S6 (0095): each line also freezes its tracking (posting-feed.yaml
 * 1.10.0-draft, RT-50 G7-9 / G7-11): the product's Tracking Profile mode at
 * intent time, the identity the line was sold from, the ERPNext Batch read
 * from the edge map (`erpnext_tracking_map`) and, for G7-9 row 3, why the
 * intent is held (`expired` | `edge_map_missing`). All four are NULL on a
 * row written before 0095. The CHECKs are declared in the 0095 SQL.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { saleLines } from "../sales/sale-lines";
import { tenants } from "../tenants";

export const erpnextPostingResolution = pgTable(
  "erpnext_posting_resolution",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // The posting intent (erpnext_posting_status.id). Composite FK in 0037.
    intentId: uuid("intent_id").notNull(),
    resolutionVersion: integer("resolution_version").notNull(),
    saleLineId: uuid("sale_line_id")
      .notNull()
      .references(() => saleLines.id, { onDelete: "restrict" }),
    erpnextItemRef: text("erpnext_item_ref").notNull(),
    // Provenance: the map rows the refs were read from (no FK — maps are
    // append-only history, mirroring the 013/014 ref columns).
    itemMapId: uuid("item_map_id").notNull(),
    warehouseRef: text("warehouse_ref").notNull(),
    warehouseMapId: uuid("warehouse_map_id").notNull(),
    // RT-418 (0051): the payer's ERPNext Customer link frozen with this
    // version (one payer per sale, so the same on every line, as
    // warehouse_ref is). NULL for a sale without responsibilities.
    payerExternalRef: text("payer_external_ref"),
    // RT-451 S6 (0095): frozen tracking. `tracking_mode` none | batch |
    // serial (NULL = written before 0095); an identity only on a batch line;
    // `erpnext_batch_ref` from the edge map; `erp_hold_cause` expired |
    // edge_map_missing holds the intent off the feed (G7-9 row 3).
    trackingMode: text("tracking_mode"),
    trackingIdentityId: uuid("tracking_identity_id"),
    erpnextBatchRef: text("erpnext_batch_ref"),
    erpHoldCause: text("erp_hold_cause"),
    resolvedBy: text("resolved_by").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "pk_erpnext_posting_resolution",
      columns: [t.intentId, t.resolutionVersion, t.saleLineId],
    }),
    check(
      "erpnext_posting_resolution_version_positive",
      sql`${t.resolutionVersion} >= 1`,
    ),
    check(
      "erpnext_posting_resolution_item_ref_nonempty",
      sql`length(${t.erpnextItemRef}) > 0`,
    ),
    check(
      "erpnext_posting_resolution_warehouse_ref_nonempty",
      sql`length(${t.warehouseRef}) > 0`,
    ),
    check(
      "erpnext_posting_resolution_resolved_by_valid",
      sql`${t.resolvedBy} IN ('system', 'operator', 'backfill')`,
    ),
    check(
      "erpnext_posting_resolution_tracking_mode_valid",
      sql`${t.trackingMode} IS NULL OR ${t.trackingMode} IN ('none', 'batch', 'serial')`,
    ),
    check(
      "erpnext_posting_resolution_batch_ref_length",
      sql`${t.erpnextBatchRef} IS NULL OR char_length(${t.erpnextBatchRef}) BETWEEN 1 AND 140`,
    ),
    check(
      "erpnext_posting_resolution_hold_cause_valid",
      sql`${t.erpHoldCause} IS NULL OR ${t.erpHoldCause} IN ('expired', 'edge_map_missing')`,
    ),
    check(
      "erpnext_posting_resolution_tracking_consistent",
      sql`(${t.trackingIdentityId} IS NULL OR ${t.trackingMode} = 'batch') AND (${t.erpnextBatchRef} IS NULL OR ${t.trackingIdentityId} IS NOT NULL) AND (${t.erpHoldCause} IS NULL OR ${t.trackingIdentityId} IS NOT NULL) AND (${t.trackingIdentityId} IS NULL OR ${t.erpnextBatchRef} IS NOT NULL OR ${t.erpHoldCause} IS NOT NULL) AND (${t.erpHoldCause} IS DISTINCT FROM 'edge_map_missing' OR ${t.erpnextBatchRef} IS NULL)`,
    ),
    index("idx_erpnext_posting_resolution_tenant").on(t.tenantId),
  ],
);

export type ErpnextPostingResolution = typeof erpnextPostingResolution.$inferSelect;
export type NewErpnextPostingResolution = typeof erpnextPostingResolution.$inferInsert;
