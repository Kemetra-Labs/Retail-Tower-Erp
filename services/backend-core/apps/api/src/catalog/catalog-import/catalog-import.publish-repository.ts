/**
 * RT-1507 (spec 049 section 8.2, 8.3): the SQL of the publish, on the caller's client under its tenant context (FORCE RLS)
 * with an explicit `tenant_id` predicate on every statement. Raw parameterized SQL; nothing here opens a transaction. The
 * catalogue tables are READ here (the stale re-check, the name lookups); every catalogue WRITE goes through the console
 * catalog domain functions. Only the import's own tables are written.
 */
import type { PoolClient } from "pg";

import { BATCH_TTL_DAYS } from "./catalog-import.limits";
import { BATCH_COLUMNS, type BatchRow } from "./catalog-import.projections";
import { isoOf } from "./import-sql";
import type { PlanRow } from "./import-publish-plan";
import type { IdentifierRef, RowOutcome, RowStatus } from "./import-row-evaluate";
import type { StagedCell } from "./staged-cell";

/** Serialises every publish of the tenant until COMMIT (the single-product console writes do not take it, spec 049 8.2). */
export function tenantImportPublishLockKey(tenantId: string): string {
  return `catalog_import_publish:${tenantId.toLowerCase()}`;
}

export async function lockTenantPublish(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [tenantImportPublishLockKey(tenantId)]);
}

interface PlanRecord {
  readonly row_number: number;
  readonly status: RowStatus;
  readonly outcome: RowOutcome;
  readonly matched_text: string | null;
  readonly matched_ms: string | null;
  readonly price_not_imported: boolean;
  readonly cells: StagedCell[] | null;
}

/** A row for the plan, and (for a row that creates a product, when asked) its staged cells. */
export interface LoadedPlanRow extends PlanRow {
  readonly cells: StagedCell[] | null;
}

/**
 * Every row of the batch for the preview (no cells) or the publish (the cells of the rows that create a product only: the
 * other rows' text is never needed and a batch's staged text can be several MB).
 */
export async function loadPlanRows(client: PoolClient, tenantId: string, batchId: string, withCreateCells: boolean): Promise<LoadedPlanRow[]> {
  const r = await client.query<PlanRecord>(
    `SELECT row_number, status, outcome - '_validated' AS outcome,
            ${isoOf("matched_updated_at")} AS matched_text,
            floor(extract(epoch FROM date_trunc('milliseconds', matched_updated_at)) * 1000)::bigint::text AS matched_ms,
            EXISTS (SELECT 1 FROM jsonb_array_elements(issues) i WHERE i->>'code' = 'price_not_imported') AS price_not_imported,
            CASE WHEN $3::boolean AND status = 'ready_create' THEN cells END AS cells
       FROM catalog_import_rows WHERE tenant_id = $1 AND batch_id = $2 AND status IS NOT NULL ORDER BY row_number`,
    [tenantId, batchId, withCreateCells],
  );
  return r.rows.map((row) => ({
    rowNumber: row.row_number,
    status: row.status,
    outcome: row.outcome,
    matchedText: row.matched_text,
    matchedMs: row.matched_ms,
    priceNotImported: row.price_not_imported,
    cells: row.cells,
  }));
}

/** What the stale re-check compares with the catalogue (spec 049 section 8.2). */
export interface CatalogueExpectations {
  /** Every matched product and its `updated_at` as validation saw it (UTC ISO, microseconds). */
  readonly products: ReadonlyArray<{ readonly productId: string; readonly matchedText: string }>;
  /** Every identifier to add: still free tenant-wide. */
  readonly identifiers: readonly IdentifierRef[];
  /** Referenced categories and existing brands: still active. */
  readonly categories: readonly string[];
  readonly existingBrands: readonly string[];
  /** Brands to create: still absent. */
  readonly newBrands: readonly string[];
  /** Products that receive a SKU: still without an active tenant-wide SKU (OD-1; a console identifier add does not move `updated_at`). */
  readonly skuReceivers: readonly string[];
}

async function count(client: PoolClient, sql: string, params: unknown[]): Promise<number> {
  return Number(((await client.query<{ n: string }>(sql, params)).rows[0] as { n: string }).n);
}

async function productsUnchanged(client: PoolClient, tenantId: string, products: CatalogueExpectations["products"]): Promise<boolean> {
  if (products.length === 0) return true;
  const n = await count(
    client,
    `SELECT count(*)::text AS n
       FROM unnest($2::uuid[], $3::text[]) AS x(id, ts)
       JOIN tenant_products p ON p.tenant_id = $1::uuid AND p.id = x.id AND p.retired_at IS NULL AND p.updated_at = x.ts::timestamptz`,
    [tenantId, products.map((p) => p.productId), products.map((p) => p.matchedText)],
  );
  return n === products.length;
}

async function identifiersFree(client: PoolClient, tenantId: string, identifiers: readonly IdentifierRef[]): Promise<boolean> {
  if (identifiers.length === 0) return true;
  const n = await count(
    client,
    `SELECT count(*)::text AS n
       FROM unnest($2::text[], $3::text[]) AS x(t, v)
       JOIN product_aliases a ON a.identifier_type = x.t AND a.value = x.v
      WHERE a.tenant_id = $1::uuid AND a.store_id IS NULL AND a.retired_at IS NULL`,
    [tenantId, identifiers.map((i) => i.type), identifiers.map((i) => i.value)],
  );
  return n === 0;
}

async function skuReceiversFree(client: PoolClient, tenantId: string, productIds: readonly string[]): Promise<boolean> {
  if (productIds.length === 0) return true;
  const n = await count(
    client,
    `SELECT count(*)::text AS n FROM product_aliases
      WHERE tenant_id = $1::uuid AND product_id = ANY($2::uuid[]) AND identifier_type = 'sku' AND store_id IS NULL AND retired_at IS NULL`,
    [tenantId, productIds],
  );
  return n === 0;
}

async function activeCount(client: PoolClient, table: "tenant_product_categories" | "tenant_product_brands", tenantId: string, names: readonly string[]): Promise<number> {
  if (names.length === 0) return 0;
  return count(client, `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1::uuid AND retired_at IS NULL AND name = ANY($2::text[])`, [tenantId, names]);
}

/**
 * Whether the catalogue still is what validation saw: every matched product unchanged and not retired, every identifier to
 * add still free, every product that receives a SKU still without one, every referenced category and brand still active, every
 * brand to create still absent. Run after the matched products are locked, so a concurrent console write is either seen here or
 * waits for this transaction.
 */
export async function catalogueChanged(client: PoolClient, tenantId: string, expected: CatalogueExpectations): Promise<boolean> {
  if (!(await productsUnchanged(client, tenantId, expected.products))) return true;
  if (!(await identifiersFree(client, tenantId, expected.identifiers))) return true;
  if (!(await skuReceiversFree(client, tenantId, expected.skuReceivers))) return true;
  if ((await activeCount(client, "tenant_product_categories", tenantId, expected.categories)) !== expected.categories.length) return true;
  if ((await activeCount(client, "tenant_product_brands", tenantId, expected.existingBrands)) !== expected.existingBrands.length) return true;
  return (await activeCount(client, "tenant_product_brands", tenantId, expected.newBrands)) !== 0;
}

/** Active categories and brands of the tenant by exact name: name -> id. */
export async function activeIdsByName(client: PoolClient, table: "tenant_product_categories" | "tenant_product_brands", tenantId: string, names: readonly string[]): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const r = await client.query<{ id: string; name: string }>(
    `SELECT id::text AS id, name FROM ${table} WHERE tenant_id = $1::uuid AND retired_at IS NULL AND name = ANY($2::text[])`,
    [tenantId, names],
  );
  return new Map(r.rows.map((row) => [row.name, row.id]));
}

/** Records the product each published row created or changed (provenance, decision 423). */
export async function setRowProducts(client: PoolClient, tenantId: string, batchId: string, pairs: ReadonlyArray<{ readonly rowNumber: number; readonly productId: string }>): Promise<void> {
  for (let from = 0; from < pairs.length; from += 1000) {
    const chunk = pairs.slice(from, from + 1000);
    await client.query(
      `UPDATE catalog_import_rows r SET product_id = x.product_id
         FROM unnest($3::int[], $4::uuid[]) AS x(row_number, product_id)
        WHERE r.tenant_id = $1 AND r.batch_id = $2 AND r.row_number = x.row_number`,
      [tenantId, batchId, chunk.map((p) => p.rowNumber), chunk.map((p) => p.productId)],
    );
  }
}

/** The `published` transition: closed now, no expiry, the next version; its summary is stored (a replay outlives the idempotency TTL). */
export async function markBatchPublished(client: PoolClient, tenantId: string, batchId: string, summary: Readonly<Record<string, number>>): Promise<BatchRow> {
  const r = await client.query<BatchRow>(
    `UPDATE catalog_import_batches
        SET state = 'published', version = version + 1, published_at = now(), closed_at = now(), expires_at = NULL, publish_summary = $3::jsonb
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${BATCH_COLUMNS}`,
    [tenantId, batchId, JSON.stringify(summary)],
  );
  return r.rows[0] as BatchRow;
}

/**
 * A stale publish: the batch back in `draft` at the next version with no counts or hash (the mapping's own transition), only
 * if it is still the `validated` batch at `expectedVersion`. Returns whether it moved.
 */
export async function markBatchStale(client: PoolClient, tenantId: string, batchId: string, expectedVersion: number): Promise<boolean> {
  const r = await client.query(
    `UPDATE catalog_import_batches
        SET state = 'draft', version = version + 1, counts = NULL, preview_hash = NULL, expires_at = now() + make_interval(days => $4)
      WHERE tenant_id = $1 AND id = $2 AND state = 'validated' AND version = $3`,
    [tenantId, batchId, expectedVersion, BATCH_TTL_DAYS],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The stored summary of a published batch. */
export async function readPublishSummary(client: PoolClient, tenantId: string, batchId: string): Promise<Record<string, number> | null> {
  const r = await client.query<{ publish_summary: Record<string, number> | null }>(
    `SELECT publish_summary FROM catalog_import_batches WHERE tenant_id = $1 AND id = $2`,
    [tenantId, batchId],
  );
  return r.rows[0]?.publish_summary ?? null;
}

/** The staged cells of some rows of the batch, by row number. */
export async function loadRowCells(client: PoolClient, tenantId: string, batchId: string, rowNumbers: readonly number[]): Promise<Array<{ rowNumber: number; cells: StagedCell[] }>> {
  if (rowNumbers.length === 0) return [];
  const r = await client.query<{ row_number: number; cells: StagedCell[] }>(
    `SELECT row_number, cells FROM catalog_import_rows WHERE tenant_id = $1 AND batch_id = $2 AND row_number = ANY($3::int[]) ORDER BY row_number`,
    [tenantId, batchId, rowNumbers],
  );
  return r.rows.map((row) => ({ rowNumber: row.row_number, cells: row.cells }));
}
