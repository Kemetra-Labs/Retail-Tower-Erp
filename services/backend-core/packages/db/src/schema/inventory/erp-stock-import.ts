/**
 * ERP-origin stock import — Drizzle schema (0096, Jira RT-1288, Inventory Gate 8
 * P4; contract `erpnext-connector/stock-import.yaml` 1.0.0-draft).
 *
 * - `erp_stock_import_runs`: one import run per mapped bucket warehouse.
 * - `erp_stock_import_pages`: a wanted page of a run (the contract's
 *   `requestRef` is its id) and the report recorded for it.
 * - `erp_stock_import_rows`: each reported row, recorded once per (warehouse,
 *   ledgerEntryRef, entryIndex), with its DC-4 classification and the effect it
 *   wrote.
 * - `erp_stock_import_findings`: the visible findings.
 *
 * RLS: ENABLE + FORCE on all four; runs and pages have SELECT, INSERT and
 * UPDATE tenant policies, rows and findings SELECT and INSERT only. The
 * same-tenant composite FKs, CHECKs and partial indexes are SQL-only in 0096.
 * §XIV: no personal data; ERPNext names, quantities and timestamps only, no
 * valuation.
 */
import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { tenants } from "../tenants";

export const ERP_STOCK_IMPORT_RUN_STATUSES = ["running", "completed", "refused", "failed"] as const;
export type ErpStockImportRunStatus = (typeof ERP_STOCK_IMPORT_RUN_STATUSES)[number];

export const ERP_STOCK_IMPORT_ROW_OUTCOMES = [
  "imported",
  "covered",
  "retail_provenance",
  "zero_quantity",
  "awaiting_identity",
  "finding",
] as const;
export type ErpStockImportRowOutcome = (typeof ERP_STOCK_IMPORT_ROW_OUTCOMES)[number];

export const ERP_STOCK_IMPORT_FINDING_KINDS = [
  "unattributed_erp_movement",
  "unknown_item",
  "uom_mismatch",
  "unmapped_warehouse",
  "unkeyable_row",
  "quantity_precision",
  "duplicate_effect_key",
  "tracking_mismatch",
] as const;
export type ErpStockImportFindingKind = (typeof ERP_STOCK_IMPORT_FINDING_KINDS)[number];

/** The `id` primary key and the tenant FK every import table starts with. */
const idAndTenant = () => ({
  id: uuid("id").primaryKey().notNull(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
});

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const erpStockImportRuns = pgTable("erp_stock_import_runs", {
  ...idAndTenant(),
  storeId: uuid("store_id").notNull(),
  warehouseMapId: uuid("warehouse_map_id").notNull(),
  erpnextWarehouseRef: text("erpnext_warehouse_ref").notNull(),
  status: text("status").$type<ErpStockImportRunStatus>().notNull().default("running"),
  statusReason: text("status_reason"),
  settleSeconds: integer("settle_seconds").notNull(),
  overlapSeconds: integer("overlap_seconds").notNull(),
  startedAt: tz("started_at").notNull().defaultNow(),
  endedAt: tz("ended_at"),
});

export const erpStockImportPages = pgTable("erp_stock_import_pages", {
  // The contract's `requestRef` is the id.
  ...idAndTenant(),
  runId: uuid("run_id").notNull(),
  pageSeq: integer("page_seq").notNull(),
  afterKey: jsonb("after_key"),
  maxRows: integer("max_rows").notNull(),
  issuedAt: tz("issued_at").notNull().defaultNow(),
  recordedAt: tz("recorded_at"),
  idempotencyKey: text("idempotency_key"),
  bodyHash: text("body_hash"),
  readAt: text("read_at"),
  rowCount: integer("row_count"),
  exhausted: boolean("exhausted"),
  refused: boolean("refused"),
  readThrough: jsonb("read_through"),
  readThroughCreation: tz("read_through_creation"),
});

export const erpStockImportRows = pgTable("erp_stock_import_rows", {
  ...idAndTenant(),
  storeId: uuid("store_id").notNull(),
  pageId: uuid("page_id").notNull(),
  erpnextWarehouseRef: text("erpnext_warehouse_ref").notNull(),
  ledgerEntryRef: text("ledger_entry_ref").notNull(),
  entryIndex: integer("entry_index").notNull(),
  voucherType: text("voucher_type").notNull(),
  voucherNo: text("voucher_no").notNull(),
  voucherDetailNo: text("voucher_detail_no"),
  erpnextItemRef: text("erpnext_item_ref").notNull(),
  erpnextBatchRef: text("erpnext_batch_ref"),
  creation: tz("creation").notNull(),
  isCancelled: boolean("is_cancelled").notNull(),
  actualQty: numeric("actual_qty", { precision: 21, scale: 6 }).notNull(),
  stockUom: text("stock_uom").notNull(),
  outcome: text("outcome").$type<ErpStockImportRowOutcome>().notNull(),
  effectKey: text("effect_key"),
  tenantProductRef: uuid("tenant_product_ref"),
  trackingIdentityId: uuid("tracking_identity_id"),
  effectId: uuid("effect_id"),
  recordedAt: tz("recorded_at").notNull().defaultNow(),
});

export const erpStockImportFindings = pgTable("erp_stock_import_findings", {
  ...idAndTenant(),
  storeId: uuid("store_id").notNull(),
  pageId: uuid("page_id").notNull(),
  rowId: uuid("row_id"),
  erpnextWarehouseRef: text("erpnext_warehouse_ref").notNull(),
  kind: text("kind").$type<ErpStockImportFindingKind>().notNull(),
  detail: jsonb("detail").notNull().default({}),
  recordedAt: tz("recorded_at").notNull().defaultNow(),
});
