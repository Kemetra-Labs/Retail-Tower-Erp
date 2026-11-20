/**
 * RT-1505 part B (spec 049 section 7): the second half of validate, pure. Given the parsed rows, the batch mode and
 * the catalogue facts, it matches every row (SKU, then barcode / PLU, byte for byte, tenant-wide, never a name),
 * applies the mode, and gives the row exactly one status (decision 419: no silent skip).
 *
 * Rules settled here (spec 049 section 12.3):
 *   - The found identifiers' products are united: none is `no_match`, one is `match`, two or more `ambiguous`, in
 *     every mode (an ambiguous row is always a review).
 *   - A row with any error is `error`; its review issues are dropped and it writes nothing (no field change, no
 *     identifier add, no brand to create). Otherwise a review reason makes it `needs_review`, the reason being the
 *     first that applies of: ambiguous, sku_mismatch, store_scoped_conflict, no_identifier, possible_duplicate.
 *   - A matched product that is retired is `product_retired` in every mode (no un-retire through an import).
 *   - Store-scoped identifiers are checked only for a value the row would ADD (free tenant-wide).
 *   - One pass over the rows with set lookups: linear in the rows and the identifiers.
 */
import { makeIssue, type ProductRef, type ReviewReason, type RowIssue } from "./import-issues";
import { MAX_NAME_MATCHES, type CatalogLookups, type ProductFacts } from "./import-lookups";
import type { ColumnMapping, ImportMode } from "./import-mapping";
import { identifierKey, type ParsedRow, type RowIdentifier } from "./import-row-parse";

export type RowStatus = "ready_create" | "ready_update" | "unchanged" | "needs_review" | "error" | "excluded";

export interface FieldChange {
  readonly field: "name" | "description" | "category" | "brand" | "tax_category" | "is_active";
  readonly before: string | null;
  readonly after: string | null;
}

export interface IdentifierRef {
  readonly type: "sku" | "barcode" | "plu";
  readonly value: string;
}

/** The contract's `RowOutcome`. */
export interface RowOutcome {
  readonly match: "no_match" | "match" | "ambiguous";
  readonly matchedProduct: ProductRef | null;
  readonly candidates: ProductRef[];
  readonly fieldChanges: FieldChange[];
  readonly identifierAdds: IdentifierRef[];
  readonly identifiersNotAdded: IdentifierRef[];
  readonly brandToCreate: string | null;
}

export interface RowResult {
  readonly rowNumber: number;
  readonly status: RowStatus;
  readonly reviewReason: ReviewReason | null;
  readonly outcome: RowOutcome;
  readonly issues: RowIssue[];
  /** The matched product's `updated_at` text at validation (the publish stale re-check), or null. */
  readonly matchedUpdatedAt: string | null;
}

const REVIEW_PRECEDENCE: readonly ReviewReason[] = ["ambiguous", "sku_mismatch", "store_scoped_conflict", "no_identifier", "possible_duplicate"];

/** A review reason a rule raised, with the issue that names it. */
interface Review {
  readonly reason: ReviewReason;
  readonly issue: RowIssue;
}

/** What the rules decided for a row before the status is set. */
interface Draft {
  match: RowOutcome["match"];
  matched: ProductFacts | null;
  candidates: ProductRef[];
  fieldChanges: FieldChange[];
  identifierAdds: IdentifierRef[];
  brandToCreate: string | null;
  /** Whether the row creates a product (else it updates the matched one). */
  creates: boolean;
}

class Evaluator {
  private readonly refs = new Map<string, ProductRef>();
  private readonly fieldColumn = new Map<string, number>();
  private readonly groups = new Map<string, number[]>();

  constructor(
    private readonly mode: ImportMode,
    mapping: readonly ColumnMapping[],
    private readonly rows: readonly ParsedRow[],
    private readonly lookups: CatalogLookups,
  ) {
    for (const m of mapping) if (m.target !== "ignore" && !this.fieldColumn.has(m.target)) this.fieldColumn.set(m.target, m.columnNumber);
    for (const row of rows) {
      for (const id of row.identifiers) {
        const key = identifierKey(id.type, id.value);
        const group = this.groups.get(key);
        if (group === undefined) this.groups.set(key, [row.rowNumber]);
        else group.push(row.rowNumber);
      }
    }
  }

  evaluateAll(): RowResult[] {
    return this.rows.map((row) => this.evaluate(row));
  }

  private ref(id: string): ProductRef {
    let ref = this.refs.get(id);
    if (ref === undefined) {
      const facts = this.lookups.products.get(id) as ProductFacts;
      ref = { productId: id, name: facts.name, identifiers: facts.identifiers };
      this.refs.set(id, ref);
    }
    return ref;
  }

  private evaluate(row: ParsedRow): RowResult {
    const issues = [...row.issues];
    const reviews: Review[] = [];
    this.duplicates(row, issues);
    const draft: Draft = { match: "no_match", matched: null, candidates: [], fieldChanges: [], identifierAdds: [], brandToCreate: null, creates: false };
    this.fieldChecks(row, draft, issues);
    const found = this.foundProducts(row);
    if (found.length > 1) this.ambiguous(found, draft, reviews);
    else if (found.length === 1) this.single(row, this.lookups.products.get(found[0] as string) as ProductFacts, draft, issues, reviews);
    else this.unmatched(row, draft, issues, reviews);
    return this.finish(row, draft, issues, reviews);
  }

  /** Two rows with the same identifier are both errors (no first-wins). The first other row is named. */
  private duplicates(row: ParsedRow, issues: RowIssue[]): void {
    for (const id of row.identifiers) {
      const group = this.groups.get(identifierKey(id.type, id.value)) as number[];
      if (group.length < 2) continue;
      const other = group[0] === row.rowNumber ? (group[1] as number) : (group[0] as number);
      issues.push(makeIssue("duplicate_in_file", id.type, id.columnNumber, { relatedRowNumber: other }));
    }
  }

  /** The category must exist (OD-3 A), a missing brand is created (OD-3 B), an unused tax category is a warning. */
  private fieldChecks(row: ParsedRow, draft: Draft, issues: RowIssue[]): void {
    if (row.category !== null && !this.lookups.categories.has(row.category.value)) {
      issues.push(makeIssue("category_not_found", "category", row.category.columnNumber));
    }
    if (row.brand !== null && !this.lookups.brands.has(row.brand.value)) draft.brandToCreate = row.brand.value;
    if (row.taxCategory !== null && !this.lookups.usedTaxCategories.has(row.taxCategory.value)) {
      issues.push(makeIssue("tax_category_unused", "tax_category", row.taxCategory.columnNumber));
    }
  }

  /** The distinct products the row's identifiers are active on, tenant-wide, in the order found. */
  private foundProducts(row: ParsedRow): string[] {
    const found: string[] = [];
    for (const id of row.identifiers) {
      const product = this.lookups.tenantWide.get(identifierKey(id.type, id.value));
      if (product !== undefined && !found.includes(product)) found.push(product);
    }
    return found;
  }

  private free(id: RowIdentifier): boolean {
    return !this.lookups.tenantWide.has(identifierKey(id.type, id.value));
  }

  private ambiguous(found: readonly string[], draft: Draft, reviews: Review[]): void {
    draft.match = "ambiguous";
    draft.candidates = found.map((id) => this.ref(id));
    reviews.push({ reason: "ambiguous", issue: makeIssue("ambiguous", null, null) });
  }

  private single(
    row: ParsedRow,
    product: ProductFacts,
    draft: Draft,
    issues: RowIssue[],
    reviews: Review[],
  ): void {
    draft.match = "match";
    draft.matched = product;
    const related = { relatedProduct: this.ref(product.id) };
    if (product.retired) {
      issues.push(makeIssue("product_retired", null, null, related));
      return;
    }
    if (this.mode === "create") {
      issues.push(makeIssue("already_exists", null, null, related));
      return;
    }
    this.updatePath(row, product, draft, issues, reviews);
  }

  /** A matched product is updated: field changes, identifier adds, the SKU rule and the store-scoped rule. */
  private updatePath(
    row: ParsedRow,
    product: ProductFacts,
    draft: Draft,
    issues: RowIssue[],
    reviews: Review[],
  ): void {
    draft.fieldChanges = this.fieldChanges(row, product, draft.brandToCreate);
    if (row.isActive !== null && !row.isActive.value && product.isActive) {
      issues.push(makeIssue("deactivates_product", "is_active", row.isActive.columnNumber));
    }
    const skus = product.identifiers.filter((i) => i.type === "sku");
    for (const id of row.identifiers) {
      if (!this.free(id)) continue;
      if (id.type === "sku" && skus.length > 0) {
        // A second SKU would break the stable-key rule (OD-1): a human decides.
        reviews.push({ reason: "sku_mismatch", issue: makeIssue("sku_mismatch", "sku", id.columnNumber, { relatedProduct: this.ref(product.id) }) });
        draft.candidates = [this.ref(product.id)];
        continue;
      }
      if (this.storeScoped(id, product.id, draft, issues, reviews)) continue;
      draft.identifierAdds.push({ type: id.type, value: id.value });
    }
  }

  /** Whether the (free) identifier collides with another product's store-scoped one (review); the same product's is a warning. */
  private storeScoped(
    id: RowIdentifier,
    ownProductId: string | null,
    draft: Draft,
    issues: RowIssue[],
    reviews: Review[],
  ): boolean {
    const holders = this.lookups.storeScoped.get(identifierKey(id.type, id.value)) ?? [];
    const others = holders.filter((h) => h !== ownProductId);
    if (others.length > 0) {
      reviews.push({
        reason: "store_scoped_conflict",
        issue: makeIssue("store_scoped_conflict", id.type, id.columnNumber, { relatedProduct: this.ref(others[0] as string) }),
      });
      if (ownProductId !== null && draft.candidates.length === 0) draft.candidates = [this.ref(ownProductId)];
      return true;
    }
    if (ownProductId !== null && holders.includes(ownProductId)) issues.push(makeIssue("store_scoped_same_product", id.type, id.columnNumber));
    return false;
  }

  private fieldChanges(row: ParsedRow, product: ProductFacts, brandToCreate: string | null): FieldChange[] {
    return computeFieldChanges(row, product, this.lookups.categories, brandToCreate);
  }

  /** No identifier is active tenant-wide: a create (modes create and upsert) or the error `not_found` (update). */
  private unmatched(
    row: ParsedRow,
    draft: Draft,
    issues: RowIssue[],
    reviews: Review[],
  ): void {
    if (this.mode === "update") {
      issues.push(makeIssue("not_found", null, null));
      return;
    }
    draft.creates = true;
    for (const field of ["name", "tax_category"] as const) {
      const value = field === "name" ? row.name : row.taxCategory;
      if (value === null && !issues.some((i) => i.field === field && i.severity === "error")) {
        issues.push(makeIssue("required_field_missing", field, this.fieldColumn.get(field) ?? null));
      }
    }
    for (const id of row.identifiers) {
      if (!this.storeScoped(id, null, draft, issues, reviews)) draft.identifierAdds.push({ type: id.type, value: id.value });
    }
    if (row.identifiers.length === 0) reviews.push({ reason: "no_identifier", issue: makeIssue("no_identifier", null, null) });
    this.possibleDuplicate(row, draft, reviews);
  }

  /** A create whose exact name is an active product's: a hint for a human, never a match. */
  private possibleDuplicate(row: ParsedRow, draft: Draft, reviews: Review[]): void {
    const same = row.name === null ? undefined : this.lookups.productsByName.get(row.name.value);
    if (same === undefined || same.length === 0) return;
    draft.candidates = same.slice(0, MAX_NAME_MATCHES).map((id) => this.ref(id));
    reviews.push({
      reason: "possible_duplicate",
      issue: makeIssue("possible_duplicate", "name", row.name?.columnNumber ?? null, { relatedProduct: draft.candidates[0] as ProductRef }),
    });
  }

  private finish(row: ParsedRow, draft: Draft, issues: RowIssue[], reviews: Review[]): RowResult {
    const failed = issues.some((i) => i.severity === "error");
    const reason = failed ? null : (REVIEW_PRECEDENCE.find((r) => reviews.some((x) => x.reason === r)) ?? null);
    // A refused row writes nothing: its outcome keeps the match (it names the product) and nothing it would do.
    const brandToCreate = failed ? null : draft.brandToCreate;
    const all = failed ? issues : [...issues, ...reviews.map((x) => x.issue)];
    if (brandToCreate !== null) all.push(makeIssue("brand_created", "brand", row.brand?.columnNumber ?? null));
    return {
      rowNumber: row.rowNumber,
      status: statusOf(failed, reason, draft),
      reviewReason: reason,
      issues: all,
      matchedUpdatedAt: draft.matched?.updatedAtText ?? null,
      outcome: {
        match: draft.match,
        matchedProduct: draft.matched === null ? null : this.ref(draft.matched.id),
        candidates: failed ? [] : draft.candidates,
        fieldChanges: failed ? [] : draft.fieldChanges,
        identifierAdds: failed ? [] : draft.identifierAdds,
        identifiersNotAdded: [],
        brandToCreate,
      },
    };
  }
}

/**
 * The field changes an update of `product` makes from the row's values (a blank or absent mapped value is unchanged, an
 * absent category is not a change). Exported for the review decision, which recomputes it for the product it chose.
 */
export function computeFieldChanges(row: ParsedRow, product: ProductFacts, categories: ReadonlySet<string>, brandToCreate: string | null): FieldChange[] {
  const changes: FieldChange[] = [];
  const consider = (field: FieldChange["field"], after: string | null, before: string | null): void => {
    if (after !== null && after !== before) changes.push({ field, before, after });
  };
  consider("name", row.name?.value ?? null, product.name);
  consider("description", row.description?.value ?? null, product.description);
  // An absent category (not found) is an error elsewhere and is not a change.
  consider("category", row.category !== null && categories.has(row.category.value) ? row.category.value : null, product.categoryName);
  consider("brand", brandToCreate ?? row.brand?.value ?? null, product.brandName);
  consider("tax_category", row.taxCategory?.value ?? null, product.taxCategory);
  consider("is_active", row.isActive === null ? null : String(row.isActive.value), String(product.isActive));
  return changes;
}

/** The one status of a row: an error, a review, a create, an update, or unchanged. */
function statusOf(failed: boolean, reason: ReviewReason | null, draft: Draft): RowStatus {
  if (failed) return "error";
  if (reason !== null) return "needs_review";
  if (draft.creates) return "ready_create";
  return draft.fieldChanges.length === 0 && draft.identifierAdds.length === 0 ? "unchanged" : "ready_update";
}

/** Matches and evaluates every row; one result per row, in row order. */
export function evaluateRows(mode: ImportMode, mapping: readonly ColumnMapping[], rows: readonly ParsedRow[], lookups: CatalogLookups): RowResult[] {
  return new Evaluator(mode, mapping, rows, lookups).evaluateAll();
}

/** Rows per status (every row has exactly one). */
export function countStatuses(results: readonly RowResult[]): Record<RowStatus, number> {
  const counts: Record<RowStatus, number> = { ready_create: 0, ready_update: 0, unchanged: 0, needs_review: 0, error: 0, excluded: 0 };
  for (const r of results) counts[r.status] += 1;
  return counts;
}
