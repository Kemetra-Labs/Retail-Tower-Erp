/**
 * RT-1505: how one parsed cell is staged in `catalog_import_rows.cells` (jsonb).
 *
 * The column is documented as "parsed text per source column, NULL for a blank
 * cell", but validation (RT-1505 part B) must know three things that text
 * alone loses, and the mapping that says which cells are identifiers is only
 * known at validate time:
 *
 *   - an XLSX cell stored as a NUMBER (spec 049 §5 `identifier_numeric_cell`:
 *     leading zeros are already gone in the file);
 *   - an XLSX BOOLEAN or DATE cell (never an identifier either);
 *   - a FORMULA cell (§5: an identifier from a formula is an error, a formula
 *     elsewhere is a counted notice, a formula with no cached value is an
 *     error). The library cannot tell a cached formula value from a literal,
 *     so the sheet-XML pre-scan (xlsx-formulas.ts) names the formula cells and
 *     the reader wraps them here (RT-1504 finding F1).
 *
 * A plain text cell stays a bare JSON string and a blank one `null`, so a CSV
 * row is exactly `["a", "b", null]`. Only a typed XLSX cell is an object. No
 * schema change: the column is `jsonb`, and the text of a cell is always
 * `stagedCellText`.
 */

/** A cell the library returned as a number, boolean or date, in its raw text. */
interface TypedStagedCell {
  /** `n` number (exact digits as stored in the file), `b` boolean, `d` date (ISO 8601). */
  readonly t: "n" | "b" | "d";
  readonly v: string;
}

/** A formula cell: `v` is the cached value (`null` when the file holds none). */
interface FormulaStagedCell {
  readonly t: "f";
  readonly v: string | TypedStagedCell | null;
}

export type StagedCell = string | null | TypedStagedCell | FormulaStagedCell;

/** The text of a staged cell (a formula's cached value), or `null` when it has none. */
export function stagedCellText(cell: StagedCell): string | null {
  if (cell === null || typeof cell === "string") return cell;
  if (cell.t !== "f") return cell.v;
  return cell.v === null || typeof cell.v === "string" ? cell.v : cell.v.v;
}

/** Whether a cell the file stored as text (or a CSV cell) can be an identifier as is: no number, boolean, date or formula. */
export function isPlainTextCell(cell: StagedCell): boolean {
  return cell === null || typeof cell === "string";
}
