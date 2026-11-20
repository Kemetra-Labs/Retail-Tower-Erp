/**
 * RT-1505 (spec 049 §5, §8.5, §12.1 "Blank rows"): turns the physical rows of
 * a CSV or an XLSX sheet into the staged batch shape, enforcing the file
 * limits as the rows arrive so a hostile file stops early.
 *
 *   - Row 1 is the header (a source row number is the row the merchant sees,
 *     header = 1, so data rows are 2 and up; a CSV record counts once however
 *     many lines a quoted cell spans).
 *   - A data row with no value in any cell is BLANK: it is skipped and leaves a
 *     gap in the row numbers, and it is not counted in `data_row_count` (0124
 *     `row_number` is the source number, gaps allowed). Every row that carries
 *     a value is kept: nothing with data is silently dropped (decision 419).
 *     The header must carry a value (`header_missing`).
 *   - A trailing empty cell does not widen the file. A column is a column when
 *     the header or any kept row has a value at or after it, so a data column
 *     with no header is kept (header text `""`) and must be mapped or ignored.
 *   - Cells are staged as read, untrimmed (validate counts the trims, OD-10);
 *     a cell of only whitespace stays text. An empty CSV field is `null`.
 *   - Limits: 5,000 data rows, 50 columns, 2,000 characters a cell, 1,048,576
 *     physical rows, and no cell `jsonb` cannot store (NUL, a lone surrogate).
 */
import {
  MAX_COLUMNS,
  MAX_DATA_ROWS,
  MAX_CELL_CHARS,
  MAX_SAMPLES,
  MAX_SOURCE_ROWS,
  MAX_STAGED_CHARS,
} from "./catalog-import.limits";
import { ImportFileRejectedError } from "./import-file-rejected";
import { charCount, isBlankText, isStorableText, trimImportText } from "./import-text";
import { stagedCellText, type StagedCell } from "./staged-cell";

/** One kept data row: its source row number and its cells, one per column. */
export interface ParsedRow {
  readonly rowNumber: number;
  readonly cells: StagedCell[];
}

/** One column of the file, as the contract's `ImportColumn`. */
interface ParsedColumn {
  readonly columnNumber: number;
  readonly header: string;
  readonly samples: string[];
}

export interface ParsedGrid {
  readonly columns: ParsedColumn[];
  readonly rows: ParsedRow[];
}

function hasValue(cell: StagedCell): boolean {
  if (cell === null) return false;
  if (typeof cell === "string") return !isBlankText(cell);
  // A number, boolean, date or formula cell is a value, even a formula with no cached one: it must reach
  // validate (an uncached formula is an error there), never read as blank.
  return true;
}

/** The number of leading cells that reach the last cell with a value. */
function extentOf(cells: readonly StagedCell[]): number {
  for (let i = cells.length - 1; i >= 0; i -= 1) if (hasValue(cells[i] as StagedCell)) return i + 1;
  return 0;
}

/** Checks one cell and returns the characters it adds to the batch's staged text. */
function checkCell(cell: StagedCell): number {
  const text = stagedCellText(cell);
  if (text === null) return 0;
  if (!isStorableText(text)) throw new ImportFileRejectedError("file_unreadable");
  // `.length` counts UTF-16 units, an upper bound of the code points: only a long cell is counted exactly.
  if (text.length > MAX_CELL_CHARS && charCount(text) > MAX_CELL_CHARS) throw new ImportFileRejectedError("cell_too_long");
  return text.length;
}

export class GridBuilder {
  private header: readonly StagedCell[] | null = null;
  private readonly rows: ParsedRow[] = [];
  private extent = 0;
  private stagedChars = 0;

  /** Adds physical row `rowNumber` (1 is the header). Rows must arrive in order. */
  add(rowNumber: number, cells: readonly StagedCell[]): void {
    if (rowNumber > MAX_SOURCE_ROWS) throw new ImportFileRejectedError("file_too_many_rows");
    const extent = extentOf(cells);
    if (extent === 0) return;
    if (extent > MAX_COLUMNS) throw new ImportFileRejectedError("too_many_columns");
    const kept = cells.slice(0, extent);
    // The total staged text is capped as rows arrive (a shared string reused by every cell would fan out).
    for (const cell of kept) this.stagedChars += checkCell(cell);
    if (this.stagedChars > MAX_STAGED_CHARS) throw new ImportFileRejectedError("xlsx_limits_exceeded");
    this.extent = Math.max(this.extent, extent);
    if (rowNumber === 1) {
      this.header = kept;
      return;
    }
    if (this.rows.length >= MAX_DATA_ROWS) throw new ImportFileRejectedError("too_many_rows");
    this.rows.push({ rowNumber, cells: [...kept] });
  }

  /** The staged grid; throws `header_missing` / `no_data_rows`. */
  finish(): ParsedGrid {
    if (this.header === null) throw new ImportFileRejectedError("header_missing");
    if (this.rows.length === 0) throw new ImportFileRejectedError("no_data_rows");
    const width = this.extent;
    const rows = this.rows.map((r) => ({ rowNumber: r.rowNumber, cells: padTo(r.cells, width) }));
    const header = padTo([...this.header], width);
    const columns = header.map<ParsedColumn>((cell, i) => ({
      columnNumber: i + 1,
      header: trimImportText(stagedCellText(cell) ?? ""),
      samples: sampleValues(rows, i),
    }));
    return { columns, rows };
  }
}

function padTo(cells: StagedCell[], width: number): StagedCell[] {
  while (cells.length < width) cells.push(null);
  return cells;
}

/** Up to three non-blank values of a column, from the first data rows, trimmed, for the mapping step. */
function sampleValues(rows: readonly ParsedRow[], column: number): string[] {
  const samples: string[] = [];
  for (const row of rows) {
    const text = stagedCellText(row.cells[column] as StagedCell);
    if (text !== null && !isBlankText(text)) samples.push(trimImportText(text));
    if (samples.length === MAX_SAMPLES) break;
  }
  return samples;
}
