/**
 * RT-1505 (RT-1504 finding F1, lead decision on RT-1505 comment 17947): the
 * sheet-XML pre-scan of an XLSX upload. `read-excel-file` returns the cached
 * value of a formula cell, so a cached formula is indistinguishable from a
 * literal and a formula with no cached value reads as blank. Spec 049 §5 needs
 * to know which cells are formulas (an identifier from a formula is an error,
 * a formula elsewhere a counted notice, an uncached formula an error), so this
 * names them, in the same pre-pass as the zip guard and before the library
 * runs.
 *
 * It also bounds what the library will allocate: the library pads every row to
 * the widest valued cell, so one valued cell at `XFD1` (16,384 columns) or at
 * the last row would cost hundreds of MiB. The scan reports the extent of the
 * VALUED cells (a cell with `<v>`, `<is>` or `<f>`; the library ignores a
 * styled empty cell) so the reader can refuse such a sheet first.
 *
 * A small tokenizer, not a regular expression over the text: comments, CDATA
 * and processing instructions are skipped, attribute values may hold `>`, and a
 * namespace prefix is ignored (`x:f`). Only `<f>` inside a `<c>` counts, so
 * text that merely contains the characters `<f>` (escaped, or in CDATA) is
 * never a formula.
 */
import { MAX_SOURCE_ROWS } from "./catalog-import.limits";
import { ImportFileRejectedError } from "./import-file-rejected";

/** What the pre-scan learned about one sheet. */
export interface SheetScan {
  /** `"<row>:<column>"` (both 1-based) of every cell that holds a formula. */
  readonly formulaCells: ReadonlySet<string>;
  /** The largest row / column holding a valued cell (0 when none). */
  readonly maxValuedRow: number;
  readonly maxValuedColumn: number;
}

/** A tag, up to its closing `>`; a `>` inside a quoted attribute value does not end it. */
const TAG_END = /[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/y;
const NAME = /^(\/?)(?:[\w.-]+:)?([\w.-]+)/;
const CELL_REF = /\br\s*=\s*(?:"([A-Z]{1,3})(\d{1,7})"|'([A-Z]{1,3})(\d{1,7})')/;
const ROW_REF = /\br\s*=\s*(?:"(\d{1,7})"|'(\d{1,7})')/;

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
  row: number;
  rowsSeen: number;
  inCell: boolean;
  cellRow: number;
  cellColumn: number;
  cellValued: boolean;
  maxRow: number;
  maxColumn: number;
  readonly formulas: Set<string>;
}

function openRow(state: ScanState, tag: string): void {
  state.rowsSeen += 1;
  if (state.rowsSeen > MAX_SOURCE_ROWS) throw new ImportFileRejectedError("file_too_many_rows");
  const ref = ROW_REF.exec(tag);
  state.row = ref === null ? state.row + 1 : Number(ref[1] ?? ref[2]);
  if (state.row > MAX_SOURCE_ROWS) throw new ImportFileRejectedError("file_too_many_rows");
}

function openCell(state: ScanState, tag: string): void {
  // The library cannot place a cell without its address, so such a sheet is unreadable.
  const ref = CELL_REF.exec(tag);
  if (ref === null) throw unreadable();
  state.cellColumn = columnNumber((ref[1] ?? ref[3]) as string);
  state.cellRow = Number((ref[2] ?? ref[4]) as string);
  // `tag` ends with the closing `>`; a `/` before it is a self-closing (empty) cell.
  state.inCell = !tag.slice(0, -1).trimEnd().endsWith("/");
  state.cellValued = false;
}

function markValued(state: ScanState): void {
  if (state.cellValued) return;
  state.cellValued = true;
  state.maxRow = Math.max(state.maxRow, state.cellRow);
  state.maxColumn = Math.max(state.maxColumn, state.cellColumn);
}

function onTag(state: ScanState, closing: boolean, name: string, tag: string): void {
  if (closing) {
    if (name === "c") state.inCell = false;
    return;
  }
  if (name === "row") openRow(state, tag);
  else if (name === "c") openCell(state, tag);
  else if (state.inCell && (name === "f" || name === "v" || name === "is")) {
    markValued(state);
    if (name === "f") state.formulas.add(`${state.cellRow}:${state.cellColumn}`);
  }
}

/** The index just past a construct that starts at `at` and ends with `terminator`, or -1 when it never ends. */
function skipPast(xml: string, at: number, terminator: string): number {
  const end = xml.indexOf(terminator, at);
  return end === -1 ? -1 : end + terminator.length;
}

/** The index after a non-element construct (comment, CDATA, processing instruction, declaration) at `at`, or `at` for an element. */
function skipMarkup(xml: string, at: number): number {
  if (xml.startsWith("<!--", at)) return skipPast(xml, at + 4, "-->");
  if (xml.startsWith("<![CDATA[", at)) return skipPast(xml, at + 9, "]]>");
  if (xml.startsWith("<?", at)) return skipPast(xml, at + 2, "?>");
  if (xml.startsWith("<!", at)) return skipPast(xml, at + 2, ">");
  return at;
}

/** Scans one worksheet's XML. Throws `ImportFileRejectedError` for a sheet the import cannot read. */
export function scanSheet(xml: string): SheetScan {
  const state: ScanState = {
    row: 0,
    rowsSeen: 0,
    inCell: false,
    cellRow: 0,
    cellColumn: 0,
    cellValued: false,
    maxRow: 0,
    maxColumn: 0,
    formulas: new Set<string>(),
  };
  let at = xml.indexOf("<");
  while (at !== -1) {
    const afterMarkup = skipMarkup(xml, at);
    if (afterMarkup === -1) throw unreadable();
    if (afterMarkup !== at) {
      at = xml.indexOf("<", afterMarkup);
      continue;
    }
    TAG_END.lastIndex = at + 1;
    const matched = TAG_END.exec(xml);
    if (matched === null) throw unreadable();
    const tag = matched[0];
    const named = NAME.exec(tag);
    if (named !== null) onTag(state, named[1] === "/", named[2] as string, tag);
    at = xml.indexOf("<", at + 1 + tag.length);
  }
  return { formulaCells: state.formulas, maxValuedRow: state.maxRow, maxValuedColumn: state.maxColumn };
}
