/**
 * RT-1505 (RT-1504 finding F1, lead decision on RT-1505 comment 17947): the
 * sheet-XML pre-scan of an XLSX upload. `read-excel-file` returns the cached
 * value of a formula cell, so a cached formula is indistinguishable from a
 * literal and a formula with no cached value reads as blank. Spec 049 §5 needs
 * to know which cells are formulas (an identifier from a formula is an error,
 * a formula elsewhere a counted notice, an uncached formula an error), so this
 * names them, before the library runs.
 *
 * It also bounds what the library will allocate: the library pads every row to
 * the widest valued cell, so one valued cell at `XFD1` (16,384 columns) or at
 * the last row would cost hundreds of MiB. The scan reports the extent of the
 * VALUED cells (a cell with `<v>`, `<is>` or `<f>`; the library ignores a
 * styled empty cell), and refuses more valued rows than the import accepts
 * before the library sees the sheet (the library parses on the main thread, so
 * a sheet it would build is a sheet that blocks the event loop).
 *
 * It tokenizes like the library's SAX parser (`xml-tags.ts`): the cell address
 * is the cell's own `r` attribute (last value wins, entities decoded, never
 * text inside another attribute's value), and `<f>` counts only inside a `<c>`.
 */
import { MAX_DATA_ROWS, MAX_SOURCE_ROWS } from "./catalog-import.limits";
import { ImportFileRejectedError } from "./import-file-rejected";
import { forEachTag, tagAttributes, type XmlTag } from "./xml-tags";

/** What the pre-scan learned about one sheet. */
export interface SheetScan {
  /** `"<row>:<column>"` (both 1-based) of every cell that holds a formula. */
  readonly formulaCells: ReadonlySet<string>;
  /** The largest row / column holding a valued cell (0 when none). */
  readonly maxValuedRow: number;
  readonly maxValuedColumn: number;
}

const CELL_REF = /^([A-Z]{1,3})(\d{1,7})$/;
const ROW_REF = /^\d{1,7}$/;

/** Column letters to a 1-based number ("A" is 1, "XFD" is 16384). */
function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function unreadable(): ImportFileRejectedError {
  return new ImportFileRejectedError("file_unreadable");
}

interface ScanState {
  rowsSeen: number;
  inCell: boolean;
  cellRow: number;
  cellColumn: number;
  cellValued: boolean;
  maxRow: number;
  maxColumn: number;
  readonly valuedRows: Set<number>;
  readonly formulas: Set<string>;
}

function openRow(state: ScanState, tag: XmlTag): void {
  state.rowsSeen += 1;
  if (state.rowsSeen > MAX_SOURCE_ROWS) throw new ImportFileRejectedError("file_too_many_rows");
  const ref = tagAttributes(tag).get("r");
  if (ref === undefined) return;
  if (!ROW_REF.test(ref)) throw unreadable();
  if (Number(ref) > MAX_SOURCE_ROWS) throw new ImportFileRejectedError("file_too_many_rows");
}

function openCell(state: ScanState, tag: XmlTag): void {
  // The library cannot place a cell without a valid address, so such a sheet is unreadable.
  const ref = CELL_REF.exec(tagAttributes(tag).get("r") ?? "");
  if (ref === null) throw unreadable();
  state.cellColumn = columnNumber(ref[1] as string);
  state.cellRow = Number(ref[2]);
  if (state.cellRow > MAX_SOURCE_ROWS) throw new ImportFileRejectedError("file_too_many_rows");
  state.inCell = !tag.selfClosing;
  state.cellValued = false;
}

function markValued(state: ScanState): void {
  if (state.cellValued) return;
  state.cellValued = true;
  state.maxRow = Math.max(state.maxRow, state.cellRow);
  state.maxColumn = Math.max(state.maxColumn, state.cellColumn);
  state.valuedRows.add(state.cellRow);
  // The header is a row too: more valued rows than the header plus 5,000 data rows can never be accepted.
  if (state.valuedRows.size > MAX_DATA_ROWS + 1) throw new ImportFileRejectedError("too_many_rows");
}

function onTag(state: ScanState, tag: XmlTag): void {
  if (tag.closing) {
    if (tag.name === "c") state.inCell = false;
    return;
  }
  if (tag.name === "row") openRow(state, tag);
  else if (tag.name === "c") openCell(state, tag);
  else if (state.inCell && (tag.name === "f" || tag.name === "v" || tag.name === "is")) {
    markValued(state);
    if (tag.name === "f") state.formulas.add(`${state.cellRow}:${state.cellColumn}`);
  }
}

/** Scans one worksheet's XML. Throws `ImportFileRejectedError` for a sheet the import cannot read or would refuse anyway. */
export function scanSheet(xml: string): SheetScan {
  const state: ScanState = {
    rowsSeen: 0,
    inCell: false,
    cellRow: 0,
    cellColumn: 0,
    cellValued: false,
    maxRow: 0,
    maxColumn: 0,
    valuedRows: new Set<number>(),
    formulas: new Set<string>(),
  };
  if (!forEachTag(xml, (tag) => onTag(state, tag))) throw unreadable();
  return { formulaCells: state.formulas, maxValuedRow: state.maxRow, maxValuedColumn: state.maxColumn };
}
