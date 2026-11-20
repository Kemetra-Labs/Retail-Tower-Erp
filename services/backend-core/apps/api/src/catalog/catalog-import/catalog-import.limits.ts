/**
 * RT-1505 (spec 049 §8.5, OD-7 A): the limits of the manual product import,
 * in one place. The contract (`catalog/catalog-import.yaml`) and the 0124
 * CHECK constraints state the same numbers; the tests pin them.
 */

/** 5 MiB: the largest file body (`413 file_too_large` past it). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Data rows per batch (the header row is not one); `catalog_import_batches.data_row_count` is at most 5000. */
export const MAX_DATA_ROWS = 5000;

/** Columns per batch (`catalog_import_batches.column_count` is at most 50). */
export const MAX_COLUMNS = 50;

/**
 * The XLSX sheet maximum. `catalog_import_rows.row_number` is the SOURCE row
 * number, CHECK 2..1048576 (0124, RT-1503 comment 17873): a source file with
 * more physical rows, CSV as well as XLSX, is refused (`file_too_many_rows`),
 * so the parser and the database bound agree even for a file of mostly blank
 * lines.
 */
export const MAX_SOURCE_ROWS = 1_048_576;

/** A cell, in characters (code points). */
export const MAX_CELL_CHARS = 2000;

/** XLSX: at most this many ZIP entries, and this many bytes once inflated (declared), both checked before inflating. */
export const MAX_ZIP_ENTRIES = 200;
export const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

/**
 * The most characters of cell text one batch may stage, in total (header and data). One shared string referenced by
 * every cell would otherwise fan a few hundred KB of upload out to gigabytes of staged JSON (security review of
 * PR #761, round 3). 5,000 rows of 50 cells of 32 characters fit; a refusal is `xlsx_limits_exceeded`.
 */
export const MAX_STAGED_CHARS = 8_000_000;

/** XLSX style and string tables (Excel's own limits, or the product of the row and column limits): more is refused. */
export const MAX_STYLE_ENTRIES = 64_000;
export const MAX_SHARED_STRINGS = 250_000;
export const MAX_SHARED_STRING_CHARS = 32_767;
export const MAX_FORMAT_CODE_CHARS = 255;

/**
 * Custom number formats: Excel keeps about 250, so 1,000 is generous; and 64 KiB of format-code text in total. The
 * library runs a quadratic date check over each code and caches it per format id, so many long codes multiply:
 * 64,000 codes of 250 `[` characters with a 5,000 x 50 sheet blocked for 7.8 s from a 1.5 MB upload (review round 4).
 */
export const MAX_NUM_FMTS = 1000;
export const MAX_FORMAT_CODE_TOTAL_CHARS = 64 * 1024;

/** Samples kept per column for the mapping step. */
export const MAX_SAMPLES = 3;

/** An open batch expires this long after its last change (spec 049 §8.1). */
export const BATCH_TTL_DAYS = 7;

/** The `file_previously_published` warning looks back this far (spec 049 §8.4). */
export const PREVIOUSLY_PUBLISHED_DAYS = 30;

/** The pinned parser versions (apps/api/package.json, RT-1504); a test keeps them equal. */
export const CSV_PARSER_VERSION = "csv-parse@7.0.3";
export const XLSX_PARSER_VERSION = "read-excel-file@9.3.17+zip-guard@1";
