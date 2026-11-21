/**
 * RT-1537: the facts of an uploaded file that a batch stores, as the upload (`createBatch`) and the file replace both
 * write them. One place, so the two cannot drift. Pure.
 */
import type { ImportColumnBody } from "./catalog-import.projections";
import type { ParsedImportFile } from "./import-file-parser";

export interface FileFacts {
  readonly fileName: string | null;
  readonly fileSize: number;
  readonly fileSha256: string;
  readonly fileKind: string;
  readonly sheetName: string | null;
  readonly csvDelimiter: string | null;
  readonly dataRowCount: number;
  readonly columns: readonly ImportColumnBody[];
  readonly parserVersion: string;
}

/** The uploaded bytes, their SHA-256 and the query's `file_name`, with what the parse found. */
export function fileFacts(file: { readonly bytes: Buffer; readonly sha256: string; readonly query: { readonly file_name?: string | undefined } }, parsed: ParsedImportFile): FileFacts {
  return {
    fileName: file.query.file_name ?? null,
    fileSize: file.bytes.length,
    fileSha256: file.sha256,
    fileKind: parsed.kind,
    sheetName: parsed.sheetName,
    csvDelimiter: parsed.csvDelimiter,
    dataRowCount: parsed.grid.rows.length,
    columns: parsed.grid.columns,
    parserVersion: parsed.parserVersion,
  };
}
