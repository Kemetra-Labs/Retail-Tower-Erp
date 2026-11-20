/**
 * RT-1505 (spec 049 §8, §10): the SQL of the import's upload and read, on the
 * caller's client under its tenant context (`runWithTenantContext`: FORCE RLS
 * on every `catalog_import_*` table), plus an explicit `tenant_id` predicate on
 * every statement. Raw parameterized SQL, as the other console catalog
 * services; nothing here opens a transaction.
 */
import type { PoolClient } from "pg";

import { BATCH_TTL_DAYS, PREVIOUSLY_PUBLISHED_DAYS } from "./catalog-import.limits";
import { BATCH_COLUMNS, type BatchRow, type BatchWarningBody, type ColumnMappingBody, type ImportColumnBody } from "./catalog-import.projections";
import type { StagedCell } from "./staged-cell";

/** The partial unique index that allows one open batch per tenant (0124). */
export const ONE_OPEN_BATCH_INDEX = "ux_catalog_import_batches_one_open";

/** The id of the tenant's open batch (`draft`, `validated`, or the reserved approval states), or null. */
export async function findOpenBatchId(client: PoolClient, tenantId: string): Promise<string | null> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM catalog_import_batches
      WHERE tenant_id = $1 AND state IN ('draft', 'validated', 'pending_approval', 'approved') LIMIT 1`,
    [tenantId],
  );
  return r.rows[0]?.id ?? null;
}

/** The newest batch of the tenant published in the last 30 days with this file hash, as the batch warning (spec 049 §8.4), or null. */
export async function findPreviouslyPublished(client: PoolClient, tenantId: string, sha256: string): Promise<BatchWarningBody | null> {
  const r = await client.query<{ id: string; published_at: Date }>(
    `SELECT id, published_at FROM catalog_import_batches
      WHERE tenant_id = $1 AND file_sha256 = $2 AND state = 'published'
        AND published_at >= now() - make_interval(days => $3)
      ORDER BY published_at DESC LIMIT 1`,
    [tenantId, sha256, PREVIOUSLY_PUBLISHED_DAYS],
  );
  const row = r.rows[0];
  return row === undefined ? null : { code: "file_previously_published", publishedBatchId: row.id, publishedAt: row.published_at.toISOString() };
}

/** What a new batch is created from. */
export interface NewBatch {
  readonly id: string;
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly mode: string;
  readonly fileName: string | null;
  readonly fileSize: number;
  readonly fileSha256: string;
  readonly fileKind: string;
  readonly sheetName: string | null;
  readonly csvDelimiter: string | null;
  readonly dataRowCount: number;
  readonly columns: readonly ImportColumnBody[];
  readonly parserVersion: string;
  readonly warnings: readonly BatchWarningBody[];
  /** The mapping suggestion shown to the merchant (stored, never recomputed on read) and the profile it drew on. */
  readonly suggestedMapping: readonly ColumnMappingBody[];
  readonly mappingProfileId: string | null;
}

/** Inserts the `draft` batch at version 1, expiring {@link BATCH_TTL_DAYS} days after now. A second open batch of the tenant is the 23505 of {@link ONE_OPEN_BATCH_INDEX}. */
export async function insertBatch(client: PoolClient, batch: NewBatch): Promise<BatchRow> {
  const r = await client.query<BatchRow>(
    `INSERT INTO catalog_import_batches
       (id, tenant_id, mode, file_name, file_size, file_sha256, file_kind, sheet_name, csv_delimiter,
        data_row_count, column_count, parser_version, columns, suggested_mapping, mapping_profile_id, warnings,
        created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16::jsonb,
             $17, now() + make_interval(days => $18))
     RETURNING ${BATCH_COLUMNS}`,
    [
      batch.id,
      batch.tenantId,
      batch.mode,
      batch.fileName,
      batch.fileSize,
      batch.fileSha256,
      batch.fileKind,
      batch.sheetName,
      batch.csvDelimiter,
      batch.dataRowCount,
      batch.columns.length,
      batch.parserVersion,
      JSON.stringify(batch.columns),
      JSON.stringify(batch.suggestedMapping),
      batch.mappingProfileId,
      JSON.stringify(batch.warnings),
      batch.actorUserId,
      BATCH_TTL_DAYS,
    ],
  );
  return r.rows[0] as BatchRow;
}

/** One staged row to insert: the source row number and its cells. */
export interface NewRow {
  readonly rowNumber: number;
  readonly cells: readonly StagedCell[];
}

/** Rows per insert statement: the staged text of a batch is capped (8,000,000 characters), and one statement never carries all of it. */
const ROWS_PER_STATEMENT = 500;

/** Inserts the staged rows of the batch, {@link ROWS_PER_STATEMENT} to a statement, on the caller's transaction. */
export async function insertRows(client: PoolClient, tenantId: string, batchId: string, rows: readonly NewRow[]): Promise<void> {
  for (let from = 0; from < rows.length; from += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(from, from + ROWS_PER_STATEMENT);
    await client.query(
      `INSERT INTO catalog_import_rows (tenant_id, batch_id, row_number, cells)
       SELECT $1::uuid, $2::uuid, (r->>'n')::int, r->'c' FROM jsonb_array_elements($3::jsonb) AS r`,
      [tenantId, batchId, JSON.stringify(chunk.map((row) => ({ n: row.rowNumber, c: row.cells })))],
    );
  }
}

/** One batch of the tenant, or null (absent or another tenant's: RLS and the predicate give the same answer). */
export async function findBatch(client: PoolClient, tenantId: string, batchId: string): Promise<BatchRow | null> {
  const r = await client.query<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM catalog_import_batches WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    batchId,
  ]);
  return r.rows[0] ?? null;
}
