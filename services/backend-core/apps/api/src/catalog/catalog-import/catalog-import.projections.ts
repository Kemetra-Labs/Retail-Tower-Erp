/**
 * RT-1505 (spec 049 §10, contract `catalog/catalog-import.yaml` 1.0.3-draft):
 * a `catalog_import_batches` row and the `CatalogImportBatch` body the
 * operations answer with. Pure: no I/O.
 */

/** The contract's `ColumnMapping`. */
export interface ColumnMappingBody {
  readonly columnNumber: number;
  readonly target: string;
}

/** The contract's `ImportColumn`. */
export interface ImportColumnBody {
  readonly columnNumber: number;
  readonly header: string;
  readonly samples: readonly string[];
}

/** The contract's `BatchWarning`. */
export interface BatchWarningBody {
  readonly code: "file_previously_published";
  readonly publishedBatchId: string;
  readonly publishedAt: string;
}

/** The contract's `StatusCounts`. */
interface StatusCountsBody {
  readonly ready_create: number;
  readonly ready_update: number;
  readonly unchanged: number;
  readonly needs_review: number;
  readonly error: number;
  readonly excluded: number;
}

/** A `catalog_import_batches` row as the pool returns it (columns as the SQL selects them). */
export interface BatchRow {
  readonly id: string;
  readonly state: string;
  readonly version: number;
  readonly mode: string;
  readonly file_name: string | null;
  readonly file_size: number;
  readonly file_sha256: string;
  readonly file_kind: string;
  readonly sheet_name: string | null;
  readonly csv_delimiter: string | null;
  readonly data_row_count: number;
  readonly column_count: number;
  readonly parser_version: string;
  readonly columns: ImportColumnBody[];
  readonly mapping: ColumnMappingBody[] | null;
  readonly suggested_mapping: ColumnMappingBody[];
  readonly mapping_profile_id: string | null;
  readonly warnings: BatchWarningBody[];
  readonly preview_hash: string | null;
  readonly counts: StatusCountsBody | null;
  readonly validation_generation: number;
  readonly rows_purged_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly expires_at: Date | null;
  readonly published_at: Date | null;
}

/** The contract's `CatalogImportBatch`. */
export interface CatalogImportBatchBody {
  readonly batchId: string;
  readonly state: string;
  readonly version: number;
  readonly mode: string;
  readonly file: {
    readonly name: string | null;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly kind: string;
    readonly sheetName: string | null;
    readonly csvDelimiter: string | null;
    readonly dataRowCount: number;
    readonly columnCount: number;
    readonly parserVersion: string;
  };
  readonly columns: readonly ImportColumnBody[];
  readonly mapping: readonly ColumnMappingBody[] | null;
  readonly suggestedMapping: readonly ColumnMappingBody[];
  readonly mappingProfileId: string | null;
  readonly counts: StatusCountsBody | null;
  readonly previewHash: string | null;
  readonly publishable: boolean;
  readonly warnings: readonly BatchWarningBody[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly publishedAt: string | null;
}

/** The columns every batch read selects, in the order `BatchRow` names them. */
export const BATCH_COLUMNS = `id, state, version, mode, file_name, file_size, file_sha256, file_kind, sheet_name, csv_delimiter,
  data_row_count, column_count, parser_version, columns, mapping, suggested_mapping, mapping_profile_id, warnings,
  preview_hash, counts, validation_generation, rows_purged_at, created_at, updated_at, expires_at, published_at`;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** `validated` and no row is `needs_review` or `error` (contract `publishable`). */
function isPublishable(row: BatchRow): boolean {
  return row.state === "validated" && row.counts !== null && row.counts.needs_review === 0 && row.counts.error === 0;
}

export function toBatchBody(row: BatchRow): CatalogImportBatchBody {
  return {
    batchId: row.id,
    state: row.state,
    version: row.version,
    mode: row.mode,
    file: {
      name: row.file_name,
      sizeBytes: row.file_size,
      sha256: row.file_sha256,
      kind: row.file_kind,
      sheetName: row.sheet_name,
      csvDelimiter: row.csv_delimiter,
      dataRowCount: row.data_row_count,
      columnCount: row.column_count,
      parserVersion: row.parser_version,
    },
    columns: row.columns,
    mapping: row.mapping,
    suggestedMapping: row.suggested_mapping,
    mappingProfileId: row.mapping_profile_id,
    counts: row.counts,
    previewHash: row.preview_hash,
    publishable: isPublishable(row),
    warnings: row.warnings,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    expiresAt: iso(row.expires_at),
    publishedAt: iso(row.published_at),
  };
}
