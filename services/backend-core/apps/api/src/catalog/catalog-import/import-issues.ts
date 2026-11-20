/**
 * RT-1505 part B (spec 049 section 5 to 7, contract `RowIssue`): the issue codes of validate, their severity and
 * their fixed English text. The text never repeats a cell value (it names the field and the fix); the console
 * localises by `code`.
 */
import type { CanonicalField } from "./import-mapping";

type IssueSeverity = "error" | "review" | "warning" | "notice";

export type ReviewReason = "ambiguous" | "no_identifier" | "sku_mismatch" | "store_scoped_conflict" | "possible_duplicate";

const SEVERITY = {
  // errors
  required_field_missing: "error",
  value_invalid: "error",
  identifier_numeric_cell: "error",
  identifier_formula_cell: "error",
  identifier_non_ascii_digits: "error",
  identifier_invisible_char: "error",
  formula_without_value: "error",
  duplicate_in_file: "error",
  category_not_found: "error",
  product_retired: "error",
  already_exists: "error",
  not_found: "error",
  // review reasons
  ambiguous: "review",
  no_identifier: "review",
  sku_mismatch: "review",
  store_scoped_conflict: "review",
  possible_duplicate: "review",
  // warnings
  gtin_check_digit: "warning",
  tax_category_unused: "warning",
  store_scoped_same_product: "warning",
  deactivates_product: "warning",
  // notices
  price_not_imported: "notice",
  whitespace_trimmed: "notice",
  formula_cached_value: "notice",
  brand_created: "notice",
} as const satisfies Record<string, IssueSeverity>;

export type IssueCode = keyof typeof SEVERITY;

const MESSAGES: Readonly<Record<IssueCode, string>> = {
  required_field_missing: "This field is required to create a product. Fill it in the file.",
  value_invalid: "The value breaks the rule of its field. Fix it in the file.",
  identifier_numeric_cell: "The identifier is stored as a number, so leading zeros are lost. Format the column as Text and enter it again.",
  identifier_formula_cell: "The identifier comes from a formula. Replace the formula with its value, as Text.",
  identifier_non_ascii_digits: "The identifier has Arabic-Indic digits, which no scanner produces. Use the digits 0 to 9.",
  identifier_invisible_char: "The identifier has a hidden character (a non-breaking space or a direction mark) inside it. Remove it.",
  formula_without_value: "The cell is a formula with no saved result. Recalculate the file, save it and upload it again.",
  duplicate_in_file: "Another row has the same identifier. An identifier may appear on one row only.",
  category_not_found: "No active category has exactly this name. Create the category first, or remove the value.",
  product_retired: "The matching product is retired. An import never brings a product back.",
  already_exists: "A product with this identifier already exists. Use Update or Upsert to change it.",
  not_found: "No product has this identifier. Use Create or Upsert to add it.",
  ambiguous: "The identifiers on this row belong to more than one product. Choose the product.",
  no_identifier: "The row has no SKU, barcode or PLU, so a later import can never match it again. Confirm it is a new product.",
  sku_mismatch: "The barcode or PLU belongs to a product that has a different SKU. Confirm which product to update.",
  store_scoped_conflict: "An identifier on this row is already used by another product at a store. Adding it for the whole tenant would make a scan ambiguous.",
  possible_duplicate: "A product with exactly this name already exists. Confirm that this is a new product.",
  gtin_check_digit: "The barcode looks like a GTIN but its check digit is wrong. Check it for a typing mistake.",
  tax_category_unused: "No product of the tenant uses this tax category yet. Check it for a typing mistake.",
  store_scoped_same_product: "The identifier is already used by this product at a store.",
  deactivates_product: "The product will be taken off every till.",
  price_not_imported: "Prices are not imported yet. A new product is created without a price.",
  whitespace_trimmed: "Leading or trailing whitespace was removed.",
  formula_cached_value: "The cell is a formula; its saved result is used.",
  brand_created: "The brand does not exist yet and will be created.",
};

/** The contract's `ProductRef`: a product of the session's tenant and its ACTIVE tenant-wide identifiers (OD-11 A). */
export interface ProductRef {
  readonly productId: string;
  readonly name: string;
  readonly identifiers: ReadonlyArray<{ readonly type: "sku" | "barcode" | "plu"; readonly value: string }>;
}

/** The contract's `RowIssue`. */
export interface RowIssue {
  readonly code: IssueCode;
  readonly severity: IssueSeverity;
  readonly field: CanonicalField | null;
  readonly columnNumber: number | null;
  readonly message: string;
  readonly relatedProduct?: ProductRef;
  readonly relatedRowNumber?: number;
}

export function makeIssue(
  code: IssueCode,
  field: CanonicalField | null,
  columnNumber: number | null,
  extra: { readonly relatedProduct?: ProductRef; readonly relatedRowNumber?: number } = {},
): RowIssue {
  return { code, severity: SEVERITY[code], field, columnNumber, message: MESSAGES[code], ...extra };
}
