/**
 * RT-1505 (spec 049 §8.5, spec 039 FR-03): decides what an upload is, from its
 * CONTENT only (never the `Content-Type` header or the file name), and parses
 * it into the staged grid.
 *
 *   - `D0 CF 11 E0 A1 B1 1A E1` (OLE2: .xls, an encrypted workbook): refused,
 *     `file_type_unsupported`.
 *   - A ZIP signature (`PK\x03\x04`, or an empty / spanned archive): the zip
 *     guard and the content types decide; a plain XLSX is read, anything else
 *     (`.xlsm`, `vbaProject.bin`, a non-XLSX ZIP) is `file_type_unsupported`.
 *   - Anything else is tried as UTF-8 CSV (`encoding_not_utf8` when it is not).
 *
 * A `sheet` query with a CSV, and a `delimiter` query with an XLSX, are the
 * contract's 400 `validation_error`: only the type can say so.
 */
import { CSV_PARSER_VERSION, XLSX_PARSER_VERSION } from "./catalog-import.limits";
import { readCsv, type CsvDelimiterName } from "./csv-reader";
import type { ParsedGrid } from "./grid-builder";
import { ImportFileRejectedError } from "./import-file-rejected";
import { readXlsx } from "./xlsx-reader";

const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** `PK` then 03 04 (a local header), 05 06 (an empty archive) or 07 08 (a spanned one). */
function isZipSignature(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  const kind = (bytes[2] as number) * 256 + (bytes[3] as number);
  return kind === 0x0304 || kind === 0x0506 || kind === 0x0708;
}

/** The query values that shape the parse (`sheet`, `delimiter`); `null` is absent. */
export interface ImportParseOptions {
  readonly sheet: string | null;
  readonly delimiter: CsvDelimiterName | null;
}

export interface ParsedImportFile {
  readonly kind: "csv" | "xlsx";
  readonly sheetName: string | null;
  readonly csvDelimiter: CsvDelimiterName | null;
  readonly parserVersion: string;
  readonly grid: ParsedGrid;
}

/** What the bytes are, by signature: `zip` and `ole2` are decided further (or refused) by the readers. */
function sniff(bytes: Buffer): "ole2" | "zip" | "text" {
  if (bytes.length >= OLE2_MAGIC.length && bytes.subarray(0, OLE2_MAGIC.length).equals(OLE2_MAGIC)) return "ole2";
  return isZipSignature(bytes) ? "zip" : "text";
}

/** Parses an upload. Throws `ImportFileRejectedError`; nothing is written either way. */
export async function parseImportFile(bytes: Buffer, options: ImportParseOptions): Promise<ParsedImportFile> {
  const type = sniff(bytes);
  if (type === "ole2") throw new ImportFileRejectedError("file_type_unsupported");
  if (type === "zip") {
    if (options.delimiter !== null) throw new ImportFileRejectedError("validation_error");
    const parsed = await readXlsx(bytes, options.sheet);
    return { kind: "xlsx", sheetName: parsed.sheetName, csvDelimiter: null, parserVersion: XLSX_PARSER_VERSION, grid: parsed.grid };
  }
  if (options.sheet !== null) throw new ImportFileRejectedError("validation_error");
  const parsed = readCsv(bytes, options.delimiter);
  return { kind: "csv", sheetName: null, csvDelimiter: parsed.delimiter, parserVersion: CSV_PARSER_VERSION, grid: parsed.grid };
}
