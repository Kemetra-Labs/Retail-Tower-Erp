/**
 * RT-1505 part B (spec 049 section 5): the first half of validate, pure. It reads the staged cells of every row
 * through the confirmed mapping and applies the rules that need no catalogue: the trim and its notice (OD-10), the
 * identifier rules (numeric and formula cells, hidden characters, Arabic-Indic digits, the GTIN check digit), the
 * field text rules, `is_active`, the formula rules and the price notice.
 *
 * Cells are staged untrimmed and immutable, so the trim happens here (and again when a row is read back). Staged
 * cells are always read through `stagedCellText` (a formula's cached value) and `kind` (the type of the cell).
 * One pass over each row; no regular expression runs over a cell.
 */
import { trimImportText } from "./import-text";
import { hasBadGtinCheckDigit, identifierProblems, parseIsActive, textFieldInvalid } from "./import-cell-rules";
import { makeIssue, type RowIssue } from "./import-issues";
import type { CanonicalField, ColumnMapping } from "./import-mapping";
import { stagedCellText, type StagedCell } from "./staged-cell";

type IdentifierType = "sku" | "barcode" | "plu";

/** An identifier value that passed every rule, and the column it came from. */
export interface RowIdentifier {
  readonly type: IdentifierType;
  readonly value: string;
  readonly columnNumber: number;
}

interface FieldValue {
  readonly value: string;
  readonly columnNumber: number;
}

/** One staged row after the catalogue-free rules. */
export interface ParsedRow {
  readonly rowNumber: number;
  /** Errors, warnings and notices found so far (the catalogue rules add theirs). */
  readonly issues: RowIssue[];
  /** Valid identifiers, one per (type, value). */
  readonly identifiers: RowIdentifier[];
  readonly name: FieldValue | null;
  readonly description: FieldValue | null;
  readonly category: FieldValue | null;
  readonly brand: FieldValue | null;
  readonly taxCategory: FieldValue | null;
  readonly isActive: { readonly value: boolean; readonly columnNumber: number } | null;
}

/** The staged row validate reads. */
export interface StagedRow {
  readonly rowNumber: number;
  readonly cells: readonly StagedCell[];
}

/** The lookup key of an identifier: its type and exact value. */
export const identifierKey = (type: string, value: string): string => `${type}\u{0}${value}`;

type CellKind = "text" | "n" | "b" | "d" | "f";

/** A cell after the trim: its text (null when blank), its type, whether the trim changed it. */
interface CellView {
  readonly kind: CellKind;
  readonly text: string | null;
  readonly trimmed: boolean;
  /** A formula the file holds no cached value for. */
  readonly uncachedFormula: boolean;
}

/** The text of a staged cell as the merchant sees it: trimmed, `null` when blank. */
export function trimmedCellText(cell: StagedCell | undefined): string | null {
  return viewCell(cell).text;
}

function viewCell(raw: StagedCell | undefined): CellView {
  const cell = raw ?? null;
  const kind: CellKind = cell === null || typeof cell === "string" ? "text" : cell.t;
  const rawText = stagedCellText(cell);
  if (rawText === null) return { kind, text: null, trimmed: false, uncachedFormula: kind === "f" };
  const trimmedText = trimImportText(rawText);
  return { kind, text: trimmedText === "" ? null : trimmedText, trimmed: trimmedText !== rawText, uncachedFormula: false };
}

const IDENTIFIER_FIELDS: ReadonlySet<CanonicalField> = new Set<CanonicalField>(["sku", "barcode", "plu"]);

const TEXT_FIELD_MAX: Readonly<Partial<Record<CanonicalField, number>>> = {
  name: 500,
  description: 2000,
  category: 200,
  brand: 200,
  tax_category: 50,
};

/** The mutable state of one row while its cells are read. */
class RowReader {
  readonly issues: RowIssue[] = [];
  readonly identifiers: RowIdentifier[] = [];
  private readonly seen = new Set<string>();
  private readonly values: Partial<Record<CanonicalField, FieldValue>> = {};
  isActive: { value: boolean; columnNumber: number } | null = null;

  constructor(readonly rowNumber: number) {}

  issue(code: Parameters<typeof makeIssue>[0], field: CanonicalField | null, columnNumber: number): void {
    this.issues.push(makeIssue(code, field, columnNumber));
  }

  value(field: CanonicalField): FieldValue | null {
    return this.values[field] ?? null;
  }

  /** Reads the cell of one mapped column. */
  read(columnNumber: number, target: CanonicalField, cell: CellView): void {
    if (IDENTIFIER_FIELDS.has(target)) {
      this.identifier(columnNumber, target as IdentifierType, cell);
      return;
    }
    if (cell.kind === "f") {
      // A formula in a field other than an identifier: its cached value is used and counted; none is an error.
      if (cell.uncachedFormula) return this.issue("formula_without_value", target, columnNumber);
      this.issue("formula_cached_value", target, columnNumber);
    }
    if (cell.text === null) return;
    if (target === "is_active") return this.active(columnNumber, cell.text);
    const max = TEXT_FIELD_MAX[target] as number;
    if (textFieldInvalid(cell.text, max)) return this.issue("value_invalid", target, columnNumber);
    this.values[target] = { value: cell.text, columnNumber };
  }

  private active(columnNumber: number, text: string): void {
    const parsed = parseIsActive(text);
    if (parsed === null) return this.issue("value_invalid", "is_active", columnNumber);
    this.isActive = { value: parsed, columnNumber };
  }

  private identifier(columnNumber: number, type: IdentifierType, cell: CellView): void {
    // An identifier is text, never a number or a formula (spec 049 section 5, 310): the cell type decides first.
    if (cell.kind === "f") return this.issue("identifier_formula_cell", type, columnNumber);
    if (cell.kind === "n") return this.issue("identifier_numeric_cell", type, columnNumber);
    if (cell.kind === "b" || cell.kind === "d") return this.issue("value_invalid", type, columnNumber);
    if (cell.text === null) return;
    const problems = identifierProblems(cell.text, type);
    for (const code of problems) this.issue(code, type, columnNumber);
    if (problems.length > 0) return;
    if (type === "barcode" && hasBadGtinCheckDigit(cell.text)) this.issue("gtin_check_digit", type, columnNumber);
    const key = identifierKey(type, cell.text);
    // The same (type, value) twice on one row is one identifier, not a duplicate of another row.
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.identifiers.push({ type, value: cell.text, columnNumber });
  }

  done(): ParsedRow {
    return {
      rowNumber: this.rowNumber,
      issues: this.issues,
      identifiers: this.identifiers,
      name: this.value("name"),
      description: this.value("description"),
      category: this.value("category"),
      brand: this.value("brand"),
      taxCategory: this.value("tax_category"),
      isActive: this.isActive,
    };
  }
}

function parseRow(mapping: readonly ColumnMapping[], row: StagedRow): ParsedRow {
  const reader = new RowReader(row.rowNumber);
  for (const entry of mapping) {
    const cell = viewCell(row.cells[entry.columnNumber - 1]);
    const field = entry.target === "ignore" ? null : entry.target;
    // Every cell is trimmed, mapped or not (OD-10): one notice per cell the trim changed.
    if (cell.trimmed) reader.issue("whitespace_trimmed", field, entry.columnNumber);
    if (field === null) continue;
    if (field === "price" || field === "currency") {
      // Recognised, never interpreted, never written (OD-2 A): a price value is a notice, nothing else.
      if (field === "price" && (cell.text !== null || cell.kind === "f")) reader.issue("price_not_imported", "price", entry.columnNumber);
      continue;
    }
    reader.read(entry.columnNumber, field, cell);
  }
  return reader.done();
}

/** Every staged row through the mapping, in order. */
export function parseRows(mapping: readonly ColumnMapping[], rows: readonly StagedRow[]): ParsedRow[] {
  return rows.map((row) => parseRow(mapping, row));
}
