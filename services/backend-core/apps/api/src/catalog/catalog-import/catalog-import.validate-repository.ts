/**
 * RT-1505 part B (spec 049 sections 7, 8, 10): the SQL of map, validate and the row list, on the caller's client under
 * its tenant context (`runWithTenantContext`: FORCE RLS on every table) with an explicit `tenant_id` predicate on every
 * statement. Raw parameterized SQL; nothing here opens a transaction. Only the import's own tables are written; the
 * catalogue tables are read.
 */
import type { PoolClient } from "pg";

import { BATCH_TTL_DAYS } from "./catalog-import.limits";
import { BATCH_COLUMNS, type BatchRow, type ColumnMappingBody } from "./catalog-import.projections";
import { MAX_NAME_MATCHES, type CatalogLookups, type LookupKeys, type ProductFacts } from "./import-lookups";
import type { MappingTarget } from "./import-mapping";
import type { RowResult } from "./import-row-evaluate";
import type { StagedRow } from "./import-row-parse";
import type { SuggestionProfile } from "./import-synonyms";
import type { RowIssue } from "./import-issues";
import type { StagedCell } from "./staged-cell";

/** The batch, locked for the rest of the transaction (map and validate serialize on it), or null. */
export async function lockBatch(client: PoolClient, tenantId: string, batchId: string): Promise<BatchRow | null> {
  const r = await client.query<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM catalog_import_batches WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
    tenantId,
    batchId,
  ]);
  return r.rows[0] ?? null;
}

/** Sets the mapping: back to `draft`, the next version, no counts or preview hash, the expiry moved (spec 049 section 8.1). */
export async function updateBatchMapping(client: PoolClient, tenantId: string, batchId: string, mapping: readonly ColumnMappingBody[]): Promise<BatchRow> {
  const r = await client.query<BatchRow>(
    `UPDATE catalog_import_batches
        SET mapping = $3::jsonb, state = 'draft', version = version + 1, counts = NULL, preview_hash = NULL,
            expires_at = now() + make_interval(days => $4)
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${BATCH_COLUMNS}`,
    [tenantId, batchId, JSON.stringify(mapping), BATCH_TTL_DAYS],
  );
  return r.rows[0] as BatchRow;
}

/** Saves (or replaces) the tenant's mapping profile of this name and returns its id: an upsert that keeps the id. */
export async function upsertMappingProfile(
  client: PoolClient,
  profile: { readonly id: string; readonly tenantId: string; readonly actorUserId: string; readonly name: string; readonly entries: Readonly<Record<string, MappingTarget>> },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO catalog_import_mapping_profiles (id, tenant_id, name, entries, created_by, updated_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5)
     ON CONFLICT (tenant_id, name) DO UPDATE SET entries = EXCLUDED.entries, updated_by = EXCLUDED.updated_by
     RETURNING id`,
    [profile.id, profile.tenantId, profile.name, JSON.stringify(profile.entries), profile.actorUserId],
  );
  return (r.rows[0] as { id: string }).id;
}

/** The profiles a suggestion draws on: the tenant's 200 most recently updated (a bound, not a rule the merchant sees). */
const MAX_SUGGESTION_PROFILES = 200;

export async function listSuggestionProfiles(client: PoolClient, tenantId: string): Promise<SuggestionProfile[]> {
  const r = await client.query<{ id: string; name: string; entries: Record<string, string>; updated_at: Date }>(
    `SELECT id, name, entries, updated_at FROM catalog_import_mapping_profiles
      WHERE tenant_id = $1 ORDER BY updated_at DESC, id LIMIT $2`,
    [tenantId, MAX_SUGGESTION_PROFILES],
  );
  return r.rows.map((p) => ({ id: p.id, name: p.name, entries: p.entries, updatedAt: p.updated_at }));
}

/** Every staged row of the batch, in source order. */
export async function loadStagedRows(client: PoolClient, tenantId: string, batchId: string): Promise<StagedRow[]> {
  const r = await client.query<{ row_number: number; cells: StagedCell[] }>(
    `SELECT row_number, cells FROM catalog_import_rows WHERE tenant_id = $1 AND batch_id = $2 ORDER BY row_number`,
    [tenantId, batchId],
  );
  return r.rows.map((row) => ({ rowNumber: row.row_number, cells: row.cells }));
}

interface FactsRow {
  id: string;
  name: string;
  description: string | null;
  tax_category: string;
  is_active: boolean;
  retired: boolean;
  updated_at_text: string;
  category_name: string | null;
  brand_name: string | null;
}

/** The product facts of `ids`, with their active tenant-wide identifiers. */
async function loadProducts(client: PoolClient, tenantId: string, ids: readonly string[]): Promise<Map<string, ProductFacts>> {
  const products = new Map<string, ProductFacts>();
  if (ids.length === 0) return products;
  const facts = await client.query<FactsRow>(
    `SELECT p.id, p.name, p.description, p.tax_category, p.is_active, (p.retired_at IS NOT NULL) AS retired,
            p.updated_at::text AS updated_at_text, c.name AS category_name, b.name AS brand_name
       FROM tenant_products p
       LEFT JOIN tenant_product_categories c ON c.tenant_id = p.tenant_id AND c.id = p.category_id
       LEFT JOIN tenant_product_brands b ON b.tenant_id = p.tenant_id AND b.id = p.brand_id
      WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[])`,
    [tenantId, ids],
  );
  const identifiers = await client.query<{ product_id: string; identifier_type: "sku" | "barcode" | "plu"; value: string }>(
    `SELECT product_id, identifier_type, value FROM product_aliases
      WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) AND store_id IS NULL AND retired_at IS NULL
        AND identifier_type IN ('sku', 'barcode', 'plu')
      ORDER BY CASE identifier_type WHEN 'sku' THEN 0 WHEN 'barcode' THEN 1 ELSE 2 END, value`,
    [tenantId, ids],
  );
  const byProduct = new Map<string, Array<{ type: "sku" | "barcode" | "plu"; value: string }>>();
  for (const row of identifiers.rows) {
    const list = byProduct.get(row.product_id) ?? [];
    list.push({ type: row.identifier_type, value: row.value });
    byProduct.set(row.product_id, list);
  }
  for (const f of facts.rows) {
    products.set(f.id, {
      id: f.id,
      name: f.name,
      description: f.description,
      taxCategory: f.tax_category,
      isActive: f.is_active,
      retired: f.retired,
      updatedAtText: f.updated_at_text,
      categoryName: f.category_name,
      brandName: f.brand_name,
      identifiers: byProduct.get(f.id) ?? [],
    });
  }
  return products;
}

/** Names (of the given list) that an active taxonomy row of the tenant carries. */
async function existingNames(client: PoolClient, table: "tenant_product_categories" | "tenant_product_brands", tenantId: string, names: readonly string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const r = await client.query<{ name: string }>(`SELECT name FROM ${table} WHERE tenant_id = $1 AND retired_at IS NULL AND name = ANY($2::text[])`, [tenantId, names]);
  return new Set(r.rows.map((row) => row.name));
}

/** Everything validate matches the file against, read in a handful of set-based queries (never one per row). */
export async function loadCatalogLookups(client: PoolClient, tenantId: string, keys: LookupKeys, needNames: boolean): Promise<CatalogLookups> {
  const tenantWide = new Map<string, string>();
  const storeScoped = new Map<string, string[]>();
  if (keys.identifierTypes.length > 0) {
    const hits = await client.query<{ identifier_type: string; value: string; product_id: string; scoped: boolean }>(
      `SELECT a.identifier_type, a.value, a.product_id, (a.store_id IS NOT NULL) AS scoped
         FROM product_aliases a
        WHERE a.tenant_id = $1 AND a.retired_at IS NULL AND a.identifier_type IN ('sku', 'barcode', 'plu')
          AND (a.identifier_type, a.value) IN (SELECT t, v FROM unnest($2::text[], $3::text[]) AS x(t, v))`,
      [tenantId, keys.identifierTypes, keys.identifierValues],
    );
    // A store-scoped identifier counts whatever the state of its store (a deleted store's too): the stores module
    // cannot be asked from here without an import cycle, and a review is the safe answer to a leftover.
    for (const h of hits.rows) {
      const key = `${h.identifier_type}\u{0}${h.value}`;
      if (!h.scoped) tenantWide.set(key, h.product_id);
      else storeScoped.set(key, [...(storeScoped.get(key) ?? []), h.product_id]);
    }
  }
  const productsByName = new Map<string, string[]>();
  if (needNames && keys.names.length > 0) {
    const same = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM (
         SELECT id, name, row_number() OVER (PARTITION BY name ORDER BY id) AS n
           FROM tenant_products WHERE tenant_id = $1 AND retired_at IS NULL AND name = ANY($2::text[])
       ) s WHERE n <= $3 ORDER BY name, id`,
      [tenantId, keys.names, MAX_NAME_MATCHES],
    );
    for (const row of same.rows) productsByName.set(row.name, [...(productsByName.get(row.name) ?? []), row.id]);
  }
  const productIds = new Set<string>([...tenantWide.values(), ...[...storeScoped.values()].flat(), ...[...productsByName.values()].flat()]);
  const usedTax = keys.taxCategories.length === 0 ? { rows: [] as Array<{ tax_category: string }> } : await client.query<{ tax_category: string }>(
    `SELECT DISTINCT tax_category FROM tenant_products WHERE tenant_id = $1 AND tax_category = ANY($2::text[])`,
    [tenantId, keys.taxCategories],
  );
  return {
    tenantWide,
    storeScoped,
    products: await loadProducts(client, tenantId, [...productIds]),
    categories: await existingNames(client, "tenant_product_categories", tenantId, keys.categories),
    brands: await existingNames(client, "tenant_product_brands", tenantId, keys.brands),
    usedTaxCategories: new Set(usedTax.rows.map((row) => row.tax_category)),
    productsByName,
  };
}

/** Rows per statement when the outcomes are written back. */
const ROWS_PER_UPDATE = 500;

/**
 * Writes every row's outcome (status, outcome, issues, review reason, the matched product's `updated_at`) and clears any
 * review decision: validation starts the rows afresh (the review slice refines this to keep a decision whose candidate
 * set and reason are unchanged, spec 049 section 8.1).
 */
export async function writeRowResults(client: PoolClient, tenantId: string, batchId: string, results: readonly RowResult[]): Promise<void> {
  for (let from = 0; from < results.length; from += ROWS_PER_UPDATE) {
    const chunk = results.slice(from, from + ROWS_PER_UPDATE).map((r) => ({
      n: r.rowNumber,
      status: r.status,
      outcome: r.outcome,
      issues: r.issues,
      reason: r.reviewReason,
      matched: r.matchedUpdatedAt,
    }));
    await client.query(
      `UPDATE catalog_import_rows r
          SET status = v.status, outcome = v.outcome, issues = v.issues, review_reason = v.reason,
              matched_updated_at = v.matched::timestamptz,
              resolution = NULL, resolution_product_id = NULL, resolved_by = NULL, resolved_at = NULL
         FROM jsonb_to_recordset($3::jsonb) AS v(n int, status text, outcome jsonb, issues jsonb, reason text, matched text)
        WHERE r.tenant_id = $1 AND r.batch_id = $2 AND r.row_number = v.n`,
      [tenantId, batchId, JSON.stringify(chunk)],
    );
  }
}

/** Moves the batch to `validated`: the next version and generation, the counts and the preview hash; the expiry moves. */
export async function markBatchValidated(
  client: PoolClient,
  tenantId: string,
  batchId: string,
  counts: Readonly<Record<string, number>>,
  previewHash: string,
): Promise<BatchRow> {
  const r = await client.query<BatchRow>(
    `UPDATE catalog_import_batches
        SET state = 'validated', version = version + 1, validation_generation = validation_generation + 1,
            counts = $3::jsonb, preview_hash = $4, expires_at = now() + make_interval(days => $5)
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${BATCH_COLUMNS}`,
    [tenantId, batchId, JSON.stringify(counts), previewHash, BATCH_TTL_DAYS],
  );
  return r.rows[0] as BatchRow;
}

/** A stored row as the list reads it. */
export interface StoredRow {
  readonly row_number: number;
  readonly cells: StagedCell[];
  readonly status: string | null;
  readonly outcome: unknown;
  readonly issues: RowIssue[];
  readonly review_reason: string | null;
  readonly resolution: string | null;
  readonly resolution_product_id: string | null;
  readonly resolved_at: Date | null;
  readonly product_id: string | null;
}

/** One page of rows after `afterRow`, optionally of one status, in row order; `limit + 1` rows are read to know if more follow. */
export async function listStoredRows(
  client: PoolClient,
  tenantId: string,
  batchId: string,
  status: string | null,
  afterRow: number,
  limit: number,
): Promise<StoredRow[]> {
  const r = await client.query<StoredRow>(
    `SELECT row_number, cells, status, outcome, issues, review_reason, resolution, resolution_product_id, resolved_at, product_id
       FROM catalog_import_rows
      WHERE tenant_id = $1 AND batch_id = $2 AND row_number > $3 AND ($4::text IS NULL OR status = $4)
      ORDER BY row_number LIMIT $5`,
    [tenantId, batchId, afterRow, status, limit + 1],
  );
  return r.rows;
}
