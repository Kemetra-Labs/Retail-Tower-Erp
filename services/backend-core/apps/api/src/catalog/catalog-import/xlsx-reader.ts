/**
 * RT-1505 (spec 049 §5, §8.5, OD-9 A): reads an XLSX upload with
 * `read-excel-file` 9.3.17, behind the guards the library does not have.
 *
 *   1. `inspectZip` (zip-guard.ts): entry count, declared and real sizes, macro
 *      parts, lying and hidden local entries. An entry is inflated once, when
 *      the import reads it, bounded by its verified size.
 *   2. The package parts (xlsx-package.ts), read with the library's own rules:
 *      plain XLSX by content type, the sheet to read (the `sheet` query, else
 *      the first).
 *   3. The sheet-XML pre-scan (xlsx-sheet-scan.ts): the formula cells, the
 *      extent and the number of valued rows, so a sheet that would make the
 *      library pad millions of cells, or that has too many rows, is refused
 *      before the library runs.
 *   4. The library never sees the uploaded bytes (security review of PR #761:
 *      it re-parses a ZIP by its local headers, reads fixed part paths and finds
 *      sheets with a SAX parser, so what the guard checked and what it read could
 *      differ). It reads a stored-only archive rebuilt from the verified parts at
 *      the library's own paths (`stored-zip.ts`): a synthesized workbook that
 *      lists exactly the one chosen sheet, its relationships, the chosen sheet,
 *      and the shared strings and styles. `readSheet(rebuilt, 1, { trim: false,
 *      parseNumber })`: `trim: false` because the spec's own whitespace set
 *      applies at validate (NBSP and the bidi marks, OD-10); `parseNumber`
 *      returns the exact digits stored in the file, so a numeric cell stays
 *      detectable (`identifier_numeric_cell`) and keeps its digits. A text cell
 *      stays a string byte for byte (leading zeros kept). A formula cell is
 *      wrapped with its cached value (or none).
 *
 * The library parses on the calling thread: a read of a file at the limits
 * blocks the event loop for its duration (measured and stated in the PR for
 * RT-1505), which the concurrency bound of the upload keeps from stacking.
 * Worker-thread isolation is a follow-up.
 */
import { readSheet } from "read-excel-file/node";

import { MAX_COLUMNS } from "./catalog-import.limits";
import { GridBuilder, type ParsedGrid } from "./grid-builder";
import { ImportFileRejectedError } from "./import-file-rejected";
import { charCount } from "./import-text";
import type { StagedCell } from "./staged-cell";
import { buildStoredZip, type StoredPart } from "./stored-zip";
import { readWorkbookInfo, type WorkbookInfo } from "./xlsx-package";
import { scanSheet, type SheetScan } from "./xlsx-sheet-scan";
import { inspectZip, type InspectedZip } from "./zip-guard";

/**
 * The most cells (valued extent: rows times columns) the library may be asked
 * to build: it pads every row to the widest valued cell. 10,000,000 is far
 * above any file that passes the 5,000-row and 50-column limits with the rows
 * where a merchant keeps them.
 */
const MAX_SHEET_AREA = 10_000_000;

const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

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

/** The sheet to read: the named one, else the first, and the part that holds it. */
function chooseSheet(info: WorkbookInfo, wanted: string | null): { name: string; path: string } {
  const sheet = wanted === null ? info.sheets[0] : info.sheets.find((s) => s.name === wanted);
  if (sheet === undefined) throw new ImportFileRejectedError("sheet_not_found");
  // 0124 `sheet_name`: 1 to 31 characters, the Excel limit.
  if (charCount(sheet.name) > 31) throw unreadable();
  const path = sheet.relationId === undefined ? undefined : info.sheetPaths.get(sheet.relationId);
  if (path === undefined) throw unreadable();
  return { name: sheet.name, path };
}

/** The workbook part of the rebuilt archive: exactly one sheet. */
function workbookXml(date1904: boolean): string {
  const pr = date1904 ? '<workbookPr date1904="1"/>' : "";
  return `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN_NS}" xmlns:r="${OFFICE_REL}">${pr}<sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

function relsXml(withStrings: boolean, withStyles: boolean): string {
  const rel = (id: string, kind: string, target: string): string => `<Relationship Id="${id}" Type="${OFFICE_REL}/${kind}" Target="${target}"/>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE_REL_NS}">` +
    rel("rId1", "worksheet", "worksheets/sheet1.xml") +
    (withStrings ? rel("rId2", "sharedStrings", "sharedStrings.xml") : "") +
    (withStyles ? rel("rId3", "styles", "styles.xml") : "") +
    "</Relationships>"
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';

/** An optional part (shared strings, styles) as the library would read it: only a `.xml` part that exists. */
async function optionalPart(zip: InspectedZip, path: string | null): Promise<Buffer | null> {
  if (path === null || !path.endsWith(".xml")) return null;
  return zip.read(path);
}

/** The stored archive the library reads: only parts the guard verified, at the library's own paths. */
async function rebuild(zip: InspectedZip, info: WorkbookInfo, sheetXml: Buffer): Promise<Buffer> {
  const strings = await optionalPart(zip, info.sharedStringsPath);
  const styles = await optionalPart(zip, info.stylesPath);
  const parts: StoredPart[] = [
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES) },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml(info.date1904)) },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(relsXml(strings !== null, styles !== null)) },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml },
  ];
  if (strings !== null) parts.push({ name: "xl/sharedStrings.xml", data: strings });
  if (styles !== null) parts.push({ name: "xl/styles.xml", data: styles });
  return buildStoredZip(parts);
}

/** Refuses a sheet whose extent the library would have to pad past the import's bound. */
function checkExtent(scan: SheetScan): void {
  if (scan.maxValuedColumn > MAX_COLUMNS) throw new ImportFileRejectedError("too_many_columns");
  if (scan.maxValuedRow * Math.max(1, scan.maxValuedColumn) > MAX_SHEET_AREA) {
    throw new ImportFileRejectedError("xlsx_limits_exceeded");
  }
}

/** The library read more than the pre-scan found: the two disagree about the sheet, so neither is trusted. */
function checkAgainstScan(data: readonly (readonly unknown[])[], scan: SheetScan): void {
  const widest = data.reduce((w, row) => Math.max(w, row.length), 0);
  if (data.length > scan.maxValuedRow || widest > scan.maxValuedColumn) throw unreadable();
}

export interface ParsedXlsx {
  readonly sheetName: string;
  readonly grid: ParsedGrid;
}

/** Reads `bytes` (an upload that starts with a ZIP signature) as XLSX. `sheet` is the query value, or `null` for the first. */
export async function readXlsx(bytes: Buffer, sheet: string | null): Promise<ParsedXlsx> {
  const zip = inspectZip(bytes);
  const info = await readWorkbookInfo(zip);
  const chosen = chooseSheet(info, sheet);
  const sheetXml = await zip.read(chosen.path);
  if (sheetXml === null) throw unreadable();
  const scan = scanSheet(sheetXml.toString("utf8"));
  checkExtent(scan);
  let data: readonly (readonly unknown[])[];
  try {
    data = await readSheet(await rebuild(zip, info, sheetXml), 1, {
      trim: false,
      parseNumber: (text: string): RawNumber => ({ __num: text }),
    });
  } catch (err) {
    if (err instanceof ImportFileRejectedError) throw err;
    throw unreadable();
  }
  checkAgainstScan(data, scan);
  const builder = new GridBuilder();
  data.forEach((row, i) => builder.add(i + 1, stageRow(row, i + 1, scan.formulaCells)));
  return { sheetName: chosen.name, grid: builder.finish() };
}
