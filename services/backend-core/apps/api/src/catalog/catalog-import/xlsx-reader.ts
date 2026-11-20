/**
 * RT-1505 (spec 049 §5, §8.5, OD-9 A): reads an XLSX upload with
 * `read-excel-file` 9.3.17, behind the guards the library does not have.
 *
 *   1. `inspectZip` (zip-guard.ts): entry count, declared and real sizes,
 *      macro parts, a lying header, all BEFORE the library sees the bytes.
 *   2. The package parts (xlsx-package.ts): plain XLSX by content type, the
 *      sheet to read (the `sheet` query, else the first).
 *   3. The sheet-XML pre-scan (xlsx-sheet-scan.ts): the formula cells, and the
 *      extent of the valued cells, so a sheet that would make the library pad
 *      millions of cells is refused first.
 *   4. `readSheet(bytes, position, { trim: false, parseNumber })`. `trim: false`
 *      because the spec's own whitespace set applies at validate (NBSP and the
 *      bidi marks, OD-10); `parseNumber` returns the exact digits stored in the
 *      file, so a numeric cell stays detectable (`identifier_numeric_cell`) and
 *      keeps its digits. A text cell stays a string byte for byte (leading
 *      zeros kept). A formula cell is wrapped with its cached value (or none).
 *
 * The library runs in its own worker thread, so parsing never blocks the
 * event loop.
 */
import { readSheet } from "read-excel-file/node";

import { MAX_COLUMNS } from "./catalog-import.limits";
import { GridBuilder, type ParsedGrid } from "./grid-builder";
import { ImportFileRejectedError } from "./import-file-rejected";
import { charCount } from "./import-text";
import { type StagedCell } from "./staged-cell";
import { readWorkbookSheets } from "./xlsx-package";
import { scanSheet } from "./xlsx-sheet-scan";
import { inspectZip } from "./zip-guard";

/**
 * The most cells (valued extent: rows times columns) the library may be asked
 * to build: it pads every row to the widest valued cell. 10,000,000 is far
 * above any file that passes the 5,000-row and 50-column limits with the rows
 * where a merchant keeps them.
 */
const MAX_SHEET_AREA = 10_000_000;

/** A number cell as `parseNumber` returns it: the text exactly as the file stores it. */
interface RawNumber {
  readonly __num: string;
}

const unreadable = (): ImportFileRejectedError => new ImportFileRejectedError("file_unreadable");

function isRawNumber(value: unknown): value is RawNumber {
  return typeof value === "object" && value !== null && typeof (value as RawNumber).__num === "string";
}

/** One value the library returned, as a staged cell (a formula is wrapped by the caller). */
function toCell(value: unknown): StagedCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "boolean") return { t: "b", v: String(value) };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw unreadable();
    return { t: "d", v: value.toISOString() };
  }
  if (isRawNumber(value)) return { t: "n", v: value.__num };
  throw unreadable();
}

function stageRow(row: readonly unknown[], rowNumber: number, formulas: ReadonlySet<string>): StagedCell[] {
  return row.map((value, i): StagedCell => {
    const cell = toCell(value);
    if (!formulas.has(`${rowNumber}:${i + 1}`)) return cell;
    return { t: "f", v: cell as string | { t: "n" | "b" | "d"; v: string } | null };
  });
}

/** The sheet's position (1-based) and name: the named sheet, else the first. */
function chooseSheet(names: readonly string[], wanted: string | null): { position: number; name: string } {
  const index = wanted === null ? 0 : names.indexOf(wanted);
  if (index === -1) throw new ImportFileRejectedError("sheet_not_found");
  const name = names[index] as string;
  // 0124 `sheet_name`: 1 to 31 characters, the Excel limit.
  if (name === "" || charCount(name) > 31) throw unreadable();
  return { position: index + 1, name };
}

export interface ParsedXlsx {
  readonly sheetName: string;
  readonly grid: ParsedGrid;
}

/** Reads `bytes` (an upload that starts with a ZIP signature) as XLSX. `sheet` is the query value, or `null` for the first. */
export async function readXlsx(bytes: Buffer, sheet: string | null): Promise<ParsedXlsx> {
  const zip = await inspectZip(bytes);
  const sheets = await readWorkbookSheets(zip);
  const chosen = chooseSheet(
    sheets.map((s) => s.name),
    sheet,
  );
  const sheetXml = await zip.read((sheets[chosen.position - 1] as { path: string }).path);
  if (sheetXml === null) throw unreadable();
  const scan = scanSheet(sheetXml.toString("utf8"));
  if (scan.maxValuedColumn > MAX_COLUMNS) throw new ImportFileRejectedError("too_many_columns");
  if (scan.maxValuedRow * Math.max(1, scan.maxValuedColumn) > MAX_SHEET_AREA) {
    throw new ImportFileRejectedError("xlsx_limits_exceeded");
  }
  let data: readonly (readonly unknown[])[];
  try {
    data = await readSheet(bytes, chosen.position, {
      trim: false,
      parseNumber: (text: string): RawNumber => ({ __num: text }),
    });
  } catch {
    throw unreadable();
  }
  const builder = new GridBuilder();
  data.forEach((row, i) => builder.add(i + 1, stageRow(row, i + 1, scan.formulaCells)));
  return { sheetName: chosen.name, grid: builder.finish() };
}
