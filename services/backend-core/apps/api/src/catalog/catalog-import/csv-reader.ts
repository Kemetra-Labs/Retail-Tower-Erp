/**
 * RT-1505 (spec 049 §5, §8.5, OD-8 A): reads a CSV upload.
 *
 *   - UTF-8 only, with or without a BOM. `csv-parse` does not reject invalid
 *     UTF-8 (it yields U+FFFD), so the bytes go through
 *     `new TextDecoder("utf-8", { fatal: true })` first (RT-1504 comment 17944).
 *     A NUL byte is refused too (a UTF-16 file is full of them). Both are
 *     `encoding_not_utf8`: "save as CSV UTF-8, or upload XLSX".
 *   - Delimiter `,`, `;` or tab: the `delimiter` query when given, else the one
 *     most used in the header record outside quotes (comma on a tie); the
 *     batch stores it so the merchant can confirm it.
 *   - Cells are raw text, never type-inferred (`cast: false`: leading zeros
 *     stay); RFC 4180 quoting, quoted line breaks and `""` escapes; a record
 *     counts once however many lines it spans. An empty field is `null`.
 *   - Records of different widths are accepted (the grid pads them); a quoting
 *     error is `file_unreadable`.
 */
import { parse } from "csv-parse/sync";

import { MAX_CELL_CHARS, MAX_COLUMNS } from "./catalog-import.limits";
import { GridBuilder, type ParsedGrid } from "./grid-builder";
import { ImportFileRejectedError } from "./import-file-rejected";
import type { StagedCell } from "./staged-cell";

export type CsvDelimiterName = "comma" | "semicolon" | "tab";

const DELIMITERS: Readonly<Record<CsvDelimiterName, string>> = { comma: ",", semicolon: ";", tab: "\t" };

/** One record can hold at most this many bytes: 50 cells of 2,000 characters of up to 4 bytes, with its quotes and separators. */
const MAX_RECORD_BYTES = MAX_COLUMNS * (MAX_CELL_CHARS * 4 + 4);

/** The text of a CSV upload, or `encoding_not_utf8`. The BOM, if any, is removed. */
function decodeUtf8(bytes: Buffer): string {
  if (bytes.includes(0)) throw new ImportFileRejectedError("encoding_not_utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ImportFileRejectedError("encoding_not_utf8");
  }
}

/** The delimiter most used in the first record outside quotes; comma when none or on a tie. */
export function detectDelimiter(text: string): CsvDelimiterName {
  const counts: Record<CsvDelimiterName, number> = { comma: 0, semicolon: 0, tab: 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch === ",") counts.comma += 1;
    else if (!quoted && ch === ";") counts.semicolon += 1;
    else if (!quoted && ch === "\t") counts.tab += 1;
  }
  const order: CsvDelimiterName[] = ["comma", "semicolon", "tab"];
  return order.reduce((best, d) => (counts[d] > counts[best] ? d : best), "comma" as CsvDelimiterName);
}

/** The error to throw for a failure inside `csv-parse`: our own refusal passes through, anything else is a quoting / shape error. */
function toRefusal(err: unknown): ImportFileRejectedError {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof ImportFileRejectedError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  const code = (err as { code?: unknown } | null)?.code;
  return new ImportFileRejectedError(code === "CSV_MAX_RECORD_SIZE" ? "cell_too_long" : "file_unreadable");
}

export interface ParsedCsv {
  readonly delimiter: CsvDelimiterName;
  readonly grid: ParsedGrid;
}

/** Reads `bytes` as CSV. `delimiter` is the query value, or `null` to detect. */
export function readCsv(bytes: Buffer, delimiter: CsvDelimiterName | null): ParsedCsv {
  const text = decodeUtf8(bytes);
  const chosen = delimiter ?? detectDelimiter(text);
  const builder = new GridBuilder();
  let rowNumber = 0;
  try {
    parse(text, {
      delimiter: DELIMITERS[chosen],
      relax_column_count: true,
      skip_empty_lines: false,
      cast: false,
      max_record_size: MAX_RECORD_BYTES,
      // Each record goes straight into the grid builder and is dropped, so a hostile file stops at its first
      // violation and no second copy of the records is held.
      on_record: (record: string[]): null => {
        rowNumber += 1;
        builder.add(rowNumber, record.map<StagedCell>((cell) => (cell === "" ? null : cell)));
        return null;
      },
    });
  } catch (err) {
    throw toRefusal(err);
  }
  return { delimiter: chosen, grid: builder.finish() };
}
