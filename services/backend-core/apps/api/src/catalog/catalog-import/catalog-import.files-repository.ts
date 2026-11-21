/**
 * RT-1537 (spec 049 S5c): the SQL of the file replace and the error report, on the caller's client under its tenant
 * context (`runWithTenantContext`: FORCE RLS on the `catalog_import_*` tables) with an explicit `tenant_id` predicate on
 * every statement. Raw parameterized SQL; nothing here opens a transaction.
 */
import type { PoolClient } from "pg";

import { BATCH_TTL_DAYS } from "./catalog-import.limits";
import { BATCH_COLUMNS, type BatchRow, type BatchWarningBody, type ColumnMappingBody } from "./catalog-import.projections";
import type { FileFacts } from "./import-file-facts";
import type { RowIssue } from "./import-issues";
import type { ReportRow } from "./import-error-report";
import type { StagedCell } from "./staged-cell";

/** What the file of a batch becomes on a replace. */
export interface ReplacedFile extends FileFacts {
  readonly tenantId: string;
  readonly batchId: string;
  readonly warnings: readonly BatchWarningBody[];
  readonly suggestedMapping: readonly ColumnMappingBody[];
  readonly mappingProfileId: string | null;
}

/** Deletes every staged row of the batch (a re-upload replaces them; the retention purge is the worker's). */
export async function deleteBatchRows(client: PoolClient, tenantId: string, batchId: string): Promise<void> {
  await client.query(`DELETE FROM catalog_import_rows WHERE tenant_id = $1 AND batch_id = $2`, [tenantId, batchId]);
}

/**
 * The batch with its new file: back to `draft` at the next version, the mapping cleared (the carried entries are in
 * `suggested_mapping`), no counts or preview hash, the expiry moved. The mode is kept; `validation_generation` is not
 * touched (the next validate bumps it).
 */
export async function replaceBatchFile(client: PoolClient, file: ReplacedFile): Promise<BatchRow> {
  const r = await client.query<BatchRow>(
    `UPDATE catalog_import_batches
        SET file_name = $3, file_size = $4, file_sha256 = $5, file_kind = $6, sheet_name = $7, csv_delimiter = $8,
            data_row_count = $9, column_count = $10, parser_version = $11, columns = $12::jsonb,
            suggested_mapping = $13::jsonb, mapping_profile_id = $14, warnings = $15::jsonb,
            mapping = NULL, state = 'draft', version = version + 1, counts = NULL, preview_hash = NULL,
            expires_at = now() + make_interval(days => $16)
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${BATCH_COLUMNS}`,
    [
      file.tenantId,
      file.batchId,
      file.fileName,
      file.fileSize,
      file.fileSha256,
      file.fileKind,
      file.sheetName,
      file.csvDelimiter,
      file.dataRowCount,
      file.columns.length,
      file.parserVersion,
      JSON.stringify(file.columns),
      JSON.stringify(file.suggestedMapping),
      file.mappingProfileId,
      JSON.stringify(file.warnings),
      BATCH_TTL_DAYS,
    ],
  );
  return r.rows[0] as BatchRow;
}

/** The rows of the report: every `error` and `needs_review` row of the batch, in row-number order (a batch has at most 5,000 rows, the CHECK of `data_row_count`; a review decision moves a row out of these statuses). */
export async function listReportRows(client: PoolClient, tenantId: string, batchId: string): Promise<ReportRow[]> {
  const r = await client.query<{ row_number: number; status: string; issues: RowIssue[]; cells: StagedCell[] }>(
    `SELECT row_number, status, issues, cells FROM catalog_import_rows
      WHERE tenant_id = $1 AND batch_id = $2 AND status IN ('error', 'needs_review')
      ORDER BY row_number`,
    [tenantId, batchId],
  );
  return r.rows.map((row) => ({ rowNumber: row.row_number, status: row.status, issues: row.issues, cells: row.cells }));
}
