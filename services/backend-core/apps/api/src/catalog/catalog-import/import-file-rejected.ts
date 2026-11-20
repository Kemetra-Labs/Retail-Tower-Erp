/**
 * RT-1505: a file the import refuses. Every code is one of the 422 codes of
 * `catalog/catalog-import.yaml` `FileRejected` (the `file_too_large` 413 is the
 * body reader's). Nothing is written when one is thrown.
 *
 *   file_type_unsupported  .xls / .xlsm / .xlsb, OLE2, a macro-enabled or binary
 *                          workbook, a `vbaProject.bin` entry, a non-XLSX ZIP, an
 *                          encrypted or exotic ZIP (zip64, multi-disk, a method
 *                          other than stored / deflate)
 *   encoding_not_utf8      a CSV that is not UTF-8, or has a NUL byte
 *   file_unreadable        a corrupt workbook (a lying ZIP header, a cell that
 *                          cannot be stored) or a CSV quoting error
 *   xlsx_limits_exceeded   over 200 ZIP entries or 50 MiB uncompressed
 *   sheet_not_found        `sheet` names no sheet of the workbook
 *   header_missing         the first row is empty
 *   no_data_rows           no row below the header carries a value
 *   too_many_rows          over 5,000 data rows
 *   file_too_many_rows     over 1,048,576 physical rows (RT-1503 comment 17873)
 *   too_many_columns       over 50 columns
 *   cell_too_long          a cell over 2,000 characters
 */
export type ImportFileRejectionCode =
  | "file_type_unsupported"
  | "encoding_not_utf8"
  | "file_unreadable"
  | "xlsx_limits_exceeded"
  | "sheet_not_found"
  | "header_missing"
  | "no_data_rows"
  | "too_many_rows"
  | "file_too_many_rows"
  | "too_many_columns"
  | "cell_too_long";

/** The 400 `validation_error` of a query value that only the file's type can refuse (`sheet` on a CSV, `delimiter` on an XLSX). */
export type ImportFileRefusalCode = ImportFileRejectionCode | "validation_error";

/** The message of each refusal: states the fix, names no cell content (§XIV). */
export const IMPORT_FILE_MESSAGES: Readonly<Record<ImportFileRefusalCode, string>> = {
  file_type_unsupported: "Upload an .xlsx workbook without macros, or a CSV file. Older .xls and macro-enabled workbooks are not accepted.",
  encoding_not_utf8: 'The file is not UTF-8 text. Save it as "CSV UTF-8", or upload an .xlsx workbook.',
  file_unreadable: "The file could not be read. Check that it is not corrupt and re-save it.",
  xlsx_limits_exceeded: "The workbook is larger than the import accepts (at most 200 parts and 50 MiB unpacked).",
  sheet_not_found: "The workbook has no sheet with that name.",
  header_missing: "The first row of the file must hold the column headers.",
  no_data_rows: "The file has no rows below the header.",
  too_many_rows: "The file has more than 5,000 data rows. Split it and upload the parts one at a time.",
  file_too_many_rows: "The file has more than 1,048,576 rows.",
  too_many_columns: "The file has more than 50 columns.",
  cell_too_long: "A cell is longer than 2,000 characters.",
  validation_error: "A query parameter does not apply to this kind of file.",
};

/** Thrown by the file readers; the service answers it with the contract's 422 (or the 400 for `validation_error`). */
export class ImportFileRejectedError extends Error {
  constructor(readonly code: ImportFileRefusalCode) {
    super(code);
    this.name = "ImportFileRejectedError";
  }
}
