/**
 * RT-1505 (RT-1504 finding F1, lead decision on RT-1505 comment 17947; security
 * review of PR #761, rounds 1 and 2): the sheet-XML pre-scan of an XLSX upload.
 *
 * `read-excel-file` returns the cached value of a formula cell, so a cached
 * formula is indistinguishable from a literal and a formula with no cached value
 * reads as blank. Spec 049 §5 needs to know which cells are formulas (an
 * identifier from a formula is an error, a formula elsewhere a counted notice, an
 * uncached formula an error), so this names them. It also bounds what the
 * library will allocate (the library pads every row to the widest valued cell, so
 * one valued cell at `XFD1` or at the last row would cost hundreds of MiB): it
 * reports the extent of the VALUED cells (a cell with `<v>`, `<is>` or `<f>`) and
 * refuses more valued rows than the import accepts, before the library runs.
 *
 * The scan does not trust that the library's SAX parser reads the sheet the way
 * this tokenizer does (two XML readers can disagree about a duplicate attribute,
 * a `<!` declaration, an attribute without whitespace before it). So the sheet is
 * RE-SERIALIZED: the scan returns a canonical `<worksheet><sheetData>` built only
 * from the tokens it understood, holding the rows (`r`), the cells (`r`, `t`, `s`)
 * and, per cell, the `<v>` text and the `<is>` inline string (`<t>`, `<r>` runs,
 * `<rPh>` dropped), every text XML-escaped here. That canonical sheet, and only
 * that, is what the library reads, so the scan and the library cannot disagree.
 * Everything the library ignores is dropped (dimension, merged cells, formulas'
 * text, views). Anything ambiguous or unexpected is refused as `file_unreadable`.
 *
 * The library handles every `<row>` and `<c>` after `<sheetData>` opens, wherever
 * it nests; so does this scan, in order.
 */
import { MAX_DATA_ROWS, MAX_SOURCE_ROWS } from "./catalog-import.limits";
import { ImportFileRejectedError } from "./import-file-rejected";
import { decodeXmlText, tagAttributes, tokenizeXml, type XmlTag, type XmlToken } from "./xml-tags";

/** What the pre-scan learned about one sheet. */
export interface SheetScan {
  /** `"<row>:<column>"` (both 1-based) of every cell that holds a formula. */
  readonly formulaCells: ReadonlySet<string>;
  /** The largest row / column holding a valued cell (0 when none). */
  readonly maxValuedRow: number;
  readonly maxValuedColumn: number;
  /** The canonical worksheet XML the library reads in place of the uploaded one. */
  readonly canonicalXml: string;
}

const CELL_REF = /^([A-Z]{1,3})(\d{1,7})$/;
const ROW_REF = /^\d{1,7}$/;
const STYLE_REF = /^\d{1,9}$/;
/** The cell types the library reads; any other `t` is an error in the library too. */
const CELL_TYPES: ReadonlySet<string> = new Set(["b", "d", "e", "inlineStr", "n", "s", "str"]);
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** Column letters to a 1-based number ("A" is 1, "XFD" is 16384). */
function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

const unreadable = (): ImportFileRejectedError => new ImportFileRejectedError("file_unreadable");

const escapeText = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Where the scan is inside one `<c>`. */
interface CellState {
  row: number;
  column: number;
  valued: boolean;
  seenV: boolean;
  seenIs: boolean;
  /** Collecting the text of `<v>` (`"v"`) or of a `<t>` (`"t"`), else null. */
  text: "v" | "t" | null;
  buffer: string;
  inIs: boolean;
  inRun: boolean;
  /** Skipping a subtree whose content the library ignores (`<f>`, `<rPr>`, `<rPh>`, `<phoneticPr>`). */
  skipName: string | null;
  skipDepth: number;
}

class SheetScanner {
  private readonly out: string[] = [];
  private readonly formulas = new Set<string>();
  private readonly valuedRows = new Set<number>();
  private maxRow = 0;
  private maxColumn = 0;
  private rowsSeen = 0;
  private sheetData = false;
  private rowOpen = false;
  private cell: CellState | null = null;

  scan(xml: string): SheetScan {
    if (!tokenizeXml(xml, (token) => this.onToken(token))) throw unreadable();
    // An unbalanced document: a row, a cell or a text element left open.
    if (this.cell !== null || this.rowOpen) throw unreadable();
    return {
      formulaCells: this.formulas,
      maxValuedRow: this.maxRow,
      maxValuedColumn: this.maxColumn,
      canonicalXml: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN_NS}"><sheetData>${this.out.join("")}</sheetData></worksheet>`,
    };
  }

  private onToken(token: XmlToken): void {
    if (this.cell !== null) this.inCell(this.cell, token);
    else if (token.kind === "tag") this.outsideCell(token);
  }

  // ---- rows and cells -------------------------------------------------------------------------

  private outsideCell(tag: XmlTag): void {
    if (tag.name === "sheetData" && !tag.closing) {
      // A second `<sheetData>` would reset the library's state; ambiguous, so refused.
      if (this.sheetData) throw unreadable();
      this.sheetData = true;
      return;
    }
    // The library ignores a row or a cell until `<sheetData>` opens.
    if (!this.sheetData) return;
    if (tag.name === "row") this.onRow(tag);
    else if (tag.name === "c" && !tag.closing) this.openCell(tag);
  }

  private onRow(tag: XmlTag): void {
    if (tag.closing) {
      if (!this.rowOpen) throw unreadable();
      this.rowOpen = false;
      this.out.push("</row>");
      return;
    }
    if (this.rowOpen) throw unreadable();
    this.rowsSeen += 1;
    if (this.rowsSeen > MAX_SOURCE_ROWS) throw new ImportFileRejectedError("file_too_many_rows");
    const ref = tagAttributes(tag, true).get("r");
    if (ref !== undefined && !ROW_REF.test(ref)) throw unreadable();
    if (ref !== undefined && Number(ref) > MAX_SOURCE_ROWS) throw new ImportFileRejectedError("file_too_many_rows");
    this.out.push(ref === undefined ? "<row>" : `<row r="${ref}">`);
    if (tag.selfClosing) this.out.push("</row>");
    else this.rowOpen = true;
  }

  private openCell(tag: XmlTag): void {
    const a = tagAttributes(tag, true);
    // The library cannot place a cell without a valid address, so such a sheet is unreadable.
    const ref = CELL_REF.exec(a.get("r") ?? "");
    if (ref === null) throw unreadable();
    const row = Number(ref[2]);
    if (row > MAX_SOURCE_ROWS) throw new ImportFileRejectedError("file_too_many_rows");
    const type = a.get("t");
    const style = a.get("s");
    if (type !== undefined && !CELL_TYPES.has(type)) throw unreadable();
    if (style !== undefined && !STYLE_REF.test(style)) throw unreadable();
    this.out.push(`<c r="${a.get("r") as string}"${type === undefined ? "" : ` t="${type}"`}${style === undefined ? "" : ` s="${style}"`}>`);
    if (tag.selfClosing) {
      this.out.push("</c>");
      return;
    }
    this.cell = {
      row,
      column: columnNumber(ref[1] as string),
      valued: false,
      seenV: false,
      seenIs: false,
      text: null,
      buffer: "",
      inIs: false,
      inRun: false,
      skipName: null,
      skipDepth: 0,
    };
  }

  // ---- inside a cell --------------------------------------------------------------------------

  private inCell(cell: CellState, token: XmlToken): void {
    if (cell.skipName !== null) return this.inSkipped(cell, token);
    if (cell.text !== null) return this.inText(cell, token);
    if (token.kind === "markup" && token.construct !== "pi") throw unreadable();
    if (token.kind !== "tag") return;
    if (token.closing) return this.closeInCell(cell, token);
    this.openInCell(cell, token);
  }

  /** A subtree the library ignores: nothing in it is read (same-name nesting is counted). */
  private inSkipped(cell: CellState, token: XmlToken): void {
    if (token.kind !== "tag" || token.name !== cell.skipName || token.selfClosing) return;
    cell.skipDepth += token.closing ? -1 : 1;
    if (cell.skipDepth === 0) cell.skipName = null;
  }

  private skip(cell: CellState, tag: XmlTag): void {
    if (tag.selfClosing) return;
    cell.skipName = tag.name;
    cell.skipDepth = 1;
  }

  /** The text of a `<v>` or a `<t>`: text and CDATA are text; anything else inside is refused. */
  private inText(cell: CellState, token: XmlToken): void {
    if (token.kind === "text") cell.buffer += decodeXmlText(token.text);
    else if (token.kind === "markup" && token.construct === "cdata") cell.buffer += token.body;
    else if (token.kind === "tag" && token.closing && token.name === cell.text) this.endText(cell);
    else throw unreadable();
  }

  private endText(cell: CellState): void {
    const name = cell.text as string;
    this.out.push(`<${name}>${escapeText(cell.buffer)}</${name}>`);
    cell.text = null;
    cell.buffer = "";
  }

  private beginText(cell: CellState, tag: XmlTag, which: "v" | "t"): void {
    if (tag.selfClosing) {
      this.out.push(`<${which}></${which}>`);
      return;
    }
    cell.text = which;
    cell.buffer = "";
  }

  private openInCell(cell: CellState, tag: XmlTag): void {
    if (cell.inIs) return this.openInInline(cell, tag);
    switch (tag.name) {
      case "f":
        this.markValued(cell);
        this.formulas.add(`${cell.row}:${cell.column}`);
        return this.skip(cell, tag);
      case "v":
        if (cell.seenV) throw unreadable();
        cell.seenV = true;
        this.markValued(cell);
        return this.beginText(cell, tag, "v");
      case "is":
        if (cell.seenIs) throw unreadable();
        cell.seenIs = true;
        this.markValued(cell);
        this.out.push(tag.selfClosing ? "<is></is>" : "<is>");
        cell.inIs = !tag.selfClosing;
        return;
      default:
        // `<c>` or `<row>` inside a cell, or an element the library does not read there: ambiguous.
        throw unreadable();
    }
  }

  /** Inside `<is>`: `<t>` directly, `<r>` runs of `<rPr>` and `<t>`, and `<rPh>` / `<phoneticPr>`, which the library ignores. */
  private openInInline(cell: CellState, tag: XmlTag): void {
    if (tag.name === "t") return this.beginText(cell, tag, "t");
    if (tag.name === "r" && !cell.inRun) {
      this.out.push(tag.selfClosing ? "<r></r>" : "<r>");
      cell.inRun = !tag.selfClosing;
      return;
    }
    if (tag.name === "rPh" || tag.name === "phoneticPr" || (tag.name === "rPr" && cell.inRun)) return this.skip(cell, tag);
    throw unreadable();
  }

  private closeInCell(cell: CellState, tag: XmlTag): void {
    if (tag.name === "c") {
      if (cell.inIs || cell.inRun) throw unreadable();
      this.out.push("</c>");
      this.cell = null;
    } else if (tag.name === "is" && cell.inIs && !cell.inRun) {
      this.out.push("</is>");
      cell.inIs = false;
    } else if (tag.name === "r" && cell.inRun) {
      this.out.push("</r>");
      cell.inRun = false;
    } else {
      throw unreadable();
    }
  }

  // ---- extent ---------------------------------------------------------------------------------

  private markValued(cell: CellState): void {
    if (cell.valued) return;
    cell.valued = true;
    this.maxRow = Math.max(this.maxRow, cell.row);
    this.maxColumn = Math.max(this.maxColumn, cell.column);
    this.valuedRows.add(cell.row);
    // The header is a row too: more valued rows than the header plus 5,000 data rows can never be accepted.
    if (this.valuedRows.size > MAX_DATA_ROWS + 1) throw new ImportFileRejectedError("too_many_rows");
  }
}

/** Scans one worksheet's XML. Throws `ImportFileRejectedError` for a sheet the import cannot read or would refuse anyway. */
export function scanSheet(xml: string): SheetScan {
  return new SheetScanner().scan(xml);
}
