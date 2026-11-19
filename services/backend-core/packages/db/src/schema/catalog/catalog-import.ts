/**
 * Manual product import staging (0124, Jira RT-1503, spec 049 slice S2 §10;
 * contract catalog/catalog-import.yaml 1.0.2-draft).
 *
 *   catalog_import_mapping_profiles  A tenant's saved column mappings:
 *                              `entries` maps the exact trimmed header text to
 *                              a canonical field or `ignore`. Unique per
 *                              (tenant, name); saving under a name upserts the
 *                              entries and keeps the `id`.
 *   catalog_import_batches     One upload: spec 042 §3 state names plus
 *                              `expired`, optimistic `version`,
 *                              `validation_generation` (the review-list cursor
 *                              binding), file facts, `columns`, `mapping` /
 *                              `suggested_mapping` (ColumnMapping[]),
 *                              `warnings`, `preview_hash`, `counts`,
 *                              `publish_summary` and the lifecycle instants.
 *                              One open batch per tenant. Never deleted.
 *   catalog_import_rows        The parsed rows with outcome, issues, review
 *                              reason, decision and the published product;
 *                              PK (tenant_id, batch_id, row_number). Deleted
 *                              by a re-upload and the retention purge.
 *
 * Declared here: columns, keys, foreign keys, the simple CHECKs and the three
 * batch indexes. In 0124's SQL only (Drizzle does not declare triggers or
 * policies, and this file does not mirror the multi-column and jsonpath
 * CHECKs on the lifecycle columns and JSON shapes): the guard triggers (created as a
 * draft, identity fixed, version and validation generation forward, a closed
 * batch frozen except `rows_purged_at`, a warning never names its own batch,
 * a profile's id and name fixed, a row's identity and cells fixed), the
 * batches' no-delete trigger and the policies.
 *
 * RLS: ENABLE + FORCE on all three; SELECT, INSERT and UPDATE everywhere;
 * DELETE on catalog_import_rows only. §XIV: BUSINESS-CLASS.
 *
 * No runtime reads or writes these tables until RT-1505 / RT-1507.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { tenants } from "../tenants";
import { tenantProducts } from "./tenant-products";

const tenantIdColumn = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" });

/** The contract's ColumnMapping: a 1-based column number and its target. */
export interface CatalogImportColumnMapping {
  readonly columnNumber: number;
  readonly target: string;
}

export const catalogImportMappingProfiles = pgTable(
  "catalog_import_mapping_profiles",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(),
    name: text("name").notNull(),
    /** Exact trimmed header text -> canonical field or `ignore`. */
    entries: jsonb("entries").$type<Record<string, string>>().notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("catalog_import_mapping_profiles_tenant_name_uk").on(t.tenantId, t.name),
    unique("catalog_import_mapping_profiles_tenant_id_uk").on(t.tenantId, t.id),
    check("catalog_import_mapping_profiles_entries_object", sql`jsonb_typeof(${t.entries}) = 'object'`),
  ],
);

export const catalogImportBatches = pgTable(
  "catalog_import_batches",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(),
    state: text("state").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    validationGeneration: integer("validation_generation").notNull().default(0),
    mode: text("mode").notNull(),
    fileName: text("file_name"),
    fileSize: integer("file_size").notNull(),
    fileSha256: text("file_sha256").notNull(),
    fileKind: text("file_kind").notNull(),
    sheetName: text("sheet_name"),
    csvDelimiter: text("csv_delimiter"),
    dataRowCount: integer("data_row_count").notNull(),
    columnCount: integer("column_count").notNull(),
    parserVersion: text("parser_version").notNull(),
    columns: jsonb("columns").notNull(),
    mapping: jsonb("mapping").$type<CatalogImportColumnMapping[]>(),
    suggestedMapping: jsonb("suggested_mapping")
      .$type<CatalogImportColumnMapping[]>()
      .notNull()
      .default(sql`'[]'`),
    mappingProfileId: uuid("mapping_profile_id"),
    warnings: jsonb("warnings").notNull().default(sql`'[]'`),
    previewHash: text("preview_hash"),
    counts: jsonb("counts"),
    publishSummary: jsonb("publish_summary"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    rowsPurgedAt: timestamp("rows_purged_at", { withTimezone: true }),
  },
  (t) => [
    unique("catalog_import_batches_tenant_id_uk").on(t.tenantId, t.id),
    foreignKey({
      name: "catalog_import_batches_mapping_profile_fk",
      columns: [t.tenantId, t.mappingProfileId],
      foreignColumns: [catalogImportMappingProfiles.tenantId, catalogImportMappingProfiles.id],
    }).onDelete("restrict"),
    check(
      "catalog_import_batches_state",
      sql`${t.state} IN ('draft', 'validated', 'pending_approval', 'approved', 'published', 'cancelled', 'expired')`,
    ),
    check("catalog_import_batches_version_positive", sql`${t.version} >= 1`),
    check("catalog_import_batches_validation_generation", sql`${t.validationGeneration} >= 0`),
    check("catalog_import_batches_mode", sql`${t.mode} IN ('create', 'update', 'upsert')`),
    check("catalog_import_batches_file_kind", sql`${t.fileKind} IN ('csv', 'xlsx')`),
    // One open batch per tenant (spec 049 §8.1): the upload's 409 import_batch_open.
    uniqueIndex("ux_catalog_import_batches_one_open")
      .on(t.tenantId)
      .where(sql`${t.state} IN ('draft', 'validated', 'pending_approval', 'approved')`),
    // The 30-day file_previously_published warning (§8.4).
    index("ix_catalog_import_batches_tenant_sha_published").on(t.tenantId, t.fileSha256, t.publishedAt),
    // The expiry sweep (§8.1, §10).
    index("ix_catalog_import_batches_expiry")
      .on(t.expiresAt)
      .where(sql`${t.state} IN ('draft', 'validated')`),
  ],
);

export const catalogImportRows = pgTable(
  "catalog_import_rows",
  {
    tenantId: tenantIdColumn(),
    batchId: uuid("batch_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    cells: jsonb("cells").$type<(string | null)[]>().notNull(),
    status: text("status"),
    outcome: jsonb("outcome"),
    issues: jsonb("issues").notNull().default(sql`'[]'`),
    reviewReason: text("review_reason"),
    resolution: text("resolution"),
    resolutionProductId: uuid("resolution_product_id"),
    resolvedBy: uuid("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    matchedUpdatedAt: timestamp("matched_updated_at", { withTimezone: true }),
    productId: uuid("product_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: "catalog_import_rows_pk", columns: [t.tenantId, t.batchId, t.rowNumber] }),
    foreignKey({
      name: "catalog_import_rows_batch_fk",
      columns: [t.tenantId, t.batchId],
      foreignColumns: [catalogImportBatches.tenantId, catalogImportBatches.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "catalog_import_rows_resolution_product_fk",
      columns: [t.resolutionProductId, t.tenantId],
      foreignColumns: [tenantProducts.id, tenantProducts.tenantId],
    }).onDelete("restrict"),
    foreignKey({
      name: "catalog_import_rows_product_fk",
      columns: [t.productId, t.tenantId],
      foreignColumns: [tenantProducts.id, tenantProducts.tenantId],
    }).onDelete("restrict"),
    check("catalog_import_rows_row_number", sql`${t.rowNumber} BETWEEN 2 AND 5001`),
    check(
      "catalog_import_rows_status",
      sql`${t.status} IS NULL OR ${t.status} IN ('ready_create', 'ready_update', 'unchanged', 'needs_review', 'error', 'excluded')`,
    ),
  ],
);

export type CatalogImportMappingProfileRow = typeof catalogImportMappingProfiles.$inferSelect;
export type NewCatalogImportMappingProfileRow = typeof catalogImportMappingProfiles.$inferInsert;
export type CatalogImportBatchRow = typeof catalogImportBatches.$inferSelect;
export type NewCatalogImportBatchRow = typeof catalogImportBatches.$inferInsert;
export type CatalogImportRowRow = typeof catalogImportRows.$inferSelect;
export type NewCatalogImportRowRow = typeof catalogImportRows.$inferInsert;
