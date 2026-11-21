/**
 * RT-1507 (spec 049 section 6, 8.2, 8.3): what a validated batch does to the catalogue, computed once and used by BOTH the
 * preview and the publish, so the counts the merchant is shown are the effect that is written. Pure.
 *
 * From the stored rows (status and outcome) only: a `ready_create` row creates a product with its identifiers; a
 * `ready_update` row changes the product it names (its field changes) and adds identifiers to it; `unchanged` and
 * `excluded` rows write nothing (an `unchanged` row's stated values still count when two rows share a product); a `ready_update` row with nothing to change or add writes nothing (a decided row that
 * turned out to change nothing). A brand a row names that does not exist is created once, however many rows name it
 * (OD-3 B). Two rows that update one product are one update of that product; if they disagree on a field (a row's explicit
 * value counts even when it equals the product's current one and so records no field change), or together would give the
 * product two SKUs, or were validated against different states of the product, the plan flags it and the publish is refused
 * (`import_not_publishable` / `stale_validation`), because no merge could be right (OD-1: a product keeps one SKU).
 */
import type { ProductRef } from "./import-issues";
import type { FieldChange, IdentifierRef, RowOutcome, RowStatus } from "./import-row-evaluate";

/** A stored row as the plan reads it. */
export interface PlanRow {
  readonly rowNumber: number;
  readonly status: RowStatus;
  readonly outcome: RowOutcome;
  /** The matched product's `updated_at` at validation: a UTC ISO instant with microseconds. */
  readonly matchedText: string | null;
  /** The same instant in epoch milliseconds, as the console writes' precondition. */
  readonly matchedMs: string | null;
  /** The row carried a price value that is never imported. */
  readonly priceNotImported: boolean;
}

interface PlannedIdentifier extends IdentifierRef {
  readonly rowNumber: number;
}

export interface PlannedUpdate {
  readonly productId: string;
  readonly product: ProductRef;
  readonly rowNumbers: number[];
  readonly matchedText: string;
  readonly matchedMs: string;
  readonly changes: FieldChange[];
  readonly adds: PlannedIdentifier[];
}

/** Why two or more rows cannot be merged into one update of a product (RT-1536; the reasons of the contract's `ImportConflict`). */
export type ConflictReason = "field_disagreement" | "second_sku";

/** One product the publish refuses (`import_not_publishable`), with the rows the merchant has to fix. */
export interface PlanConflict {
  readonly productId: string;
  readonly product: ProductRef;
  /** Ascending, without duplicates: every row that states a value for the product (a disagreement), or adds one of its SKUs. */
  readonly rowNumbers: number[];
  readonly reason: ConflictReason;
  /** The field the rows disagree on (`field_disagreement` only). */
  readonly field?: string;
}

export interface PublishPlan {
  /** Brands to create, each once, with the first row that names it. */
  readonly brands: Array<{ readonly name: string; readonly rowNumber: number }>;
  readonly creates: Array<{ readonly rowNumber: number; readonly adds: IdentifierRef[] }>;
  readonly updates: PlannedUpdate[];
  /** Products an update takes off every till (`is_active` -> false, OD-17), with the first row that does. */
  readonly deactivations: Array<{ readonly rowNumber: number; readonly product: ProductRef }>;
  readonly identifiersToAdd: number;
  /** Products two rows change differently: no merge is right. */
  readonly conflictingProducts: string[];
  /** The same products with the rows and the reason (one entry per product and reason, per field for a disagreement). */
  readonly conflicts: PlanConflict[];
  /** Products two rows validated against different states of the product: the validation is stale. */
  readonly staleProducts: string[];
  readonly rowsWithPriceNotImported: number;
  readonly rowsUnchanged: number;
  readonly rowsExcluded: number;
}

interface MutableUpdate {
  productId: string;
  product: ProductRef;
  rowNumbers: number[];
  matchedTexts: Set<string>;
  matchedMs: string;
  changes: Map<string, FieldChange>;
  adds: PlannedIdentifier[];
}

function startUpdate(row: PlanRow): MutableUpdate {
  const product = row.outcome.matchedProduct;
  if (product === null || row.matchedText === null || row.matchedMs === null) {
    throw new Error(`import row ${row.rowNumber} is ready_update without a matched product`);
  }
  return { productId: product.productId, product, rowNumbers: [], matchedTexts: new Set(), matchedMs: row.matchedMs, changes: new Map(), adds: [] };
}

function mergeInto(update: MutableUpdate, row: PlanRow): void {
  update.rowNumbers.push(row.rowNumber);
  update.matchedTexts.add(row.matchedText as string);
  for (const change of row.outcome.fieldChanges) {
    if (!update.changes.has(change.field)) update.changes.set(change.field, change);
  }
  for (const id of row.outcome.identifierAdds) {
    if (!update.adds.some((a) => a.type === id.type && a.value === id.value)) update.adds.push({ ...id, rowNumber: row.rowNumber });
  }
}

/** The values a row sets on its product: its field changes, and the values it states explicitly (when the cells were read). */
function valuesOf(row: PlanRow, explicit: ReadonlyMap<number, Readonly<Record<string, string>>>): Array<[string, string]> {
  const values = new Map<string, string>();
  for (const change of row.outcome.fieldChanges) if (change.after !== null) values.set(change.field, change.after);
  for (const [field, value] of Object.entries(explicit.get(row.rowNumber) ?? {})) values.set(field, value);
  return [...values];
}

/** What a product's rows have stated, field by field: the first value, and every row that stated the field. */
interface ProductValues {
  readonly seen: Map<string, string>;
  readonly statedBy: Map<string, number[]>;
  readonly disagreeing: Set<string>;
  readonly rows: Set<number>;
}

/** Records what the row states for its product; the fields it disagrees on, against the product's earlier rows, are remembered. Returns the product id. */
function trackValues(
  tracked: Map<string, ProductValues>,
  row: PlanRow,
  explicit: ReadonlyMap<number, Readonly<Record<string, string>>>,
): string {
  const productId = row.outcome.matchedProduct?.productId ?? "";
  const product = tracked.get(productId) ?? { seen: new Map(), statedBy: new Map(), disagreeing: new Set(), rows: new Set() };
  tracked.set(productId, product);
  product.rows.add(row.rowNumber);
  for (const [field, value] of valuesOf(row, explicit)) {
    const had = product.seen.get(field);
    if (had !== undefined && had !== value) product.disagreeing.add(field);
    else product.seen.set(field, value);
    product.statedBy.set(field, [...(product.statedBy.get(field) ?? []), row.rowNumber]);
  }
  return productId;
}

/** A merged update that would give the product a second SKU (or a SKU to one that has one): OD-1 sends such a row to review. */
function addsSecondSku(update: MutableUpdate): boolean {
  const skus = update.adds.filter((a) => a.type === "sku").length;
  return skus > 1 || (skus === 1 && update.product.identifiers.some((i) => i.type === "sku"));
}

/** The rows and reasons of every conflicting product, ordered by their first row (a stable list for the preview). */
function conflictsOf(conflicting: readonly MutableUpdate[], tracked: ReadonlyMap<string, ProductValues>): PlanConflict[] {
  const sorted = (rows: Iterable<number>): number[] => [...new Set(rows)].sort((a, b) => a - b);
  const out: PlanConflict[] = [];
  for (const u of conflicting) {
    const values = tracked.get(u.productId);
    for (const field of [...(values?.disagreeing ?? [])].sort()) {
      out.push({ productId: u.productId, product: u.product, rowNumbers: sorted(values?.statedBy.get(field) ?? []), reason: "field_disagreement", field });
    }
    if (addsSecondSku(u)) {
      out.push({ productId: u.productId, product: u.product, rowNumbers: sorted(u.adds.filter((a) => a.type === "sku").map((a) => a.rowNumber)), reason: "second_sku" });
    }
  }
  return out.sort((a, b) => (a.rowNumbers[0] as number) - (b.rowNumbers[0] as number) || a.productId.localeCompare(b.productId) || a.reason.localeCompare(b.reason) || (a.field ?? "").localeCompare(b.field ?? ""));
}

const hasEffect = (row: PlanRow): boolean => row.outcome.fieldChanges.length > 0 || row.outcome.identifierAdds.length > 0;

/**
 * The effect of the batch's rows (in row order). `explicit` is, per row number, the values the row states for its product
 * (field -> text, as the field changes name them); it is read only for the rows that share a product (the publish loads those
 * cells), and lets the plan see a row that restates the product's current value against another row's change.
 */
export function planPublish(rows: readonly PlanRow[], explicit: ReadonlyMap<number, Readonly<Record<string, string>>> = new Map()): PublishPlan {
  const brands = new Map<string, number>();
  const creates: PublishPlan["creates"] = [];
  const updates = new Map<string, MutableUpdate>();
  const tracked = new Map<string, ProductValues>();
  let priceNotImported = 0;
  let unchanged = 0;
  let excluded = 0;
  for (const row of rows) {
    if (row.priceNotImported) priceNotImported += 1;
    if (row.status === "unchanged") {
      unchanged += 1;
      // It writes nothing, but what it states for its product still counts against another row's change of it.
      trackValues(tracked, row, explicit);
    } else if (row.status === "excluded") excluded += 1;
    else if (row.status === "ready_create") {
      creates.push({ rowNumber: row.rowNumber, adds: row.outcome.identifierAdds });
      if (row.outcome.brandToCreate !== null && !brands.has(row.outcome.brandToCreate)) brands.set(row.outcome.brandToCreate, row.rowNumber);
    } else if (row.status === "ready_update") {
      const productId = trackValues(tracked, row, explicit);
      if (!hasEffect(row)) continue;
      const update = updates.get(productId) ?? startUpdate(row);
      updates.set(update.productId, update);
      mergeInto(update, row);
      if (row.outcome.brandToCreate !== null && !brands.has(row.outcome.brandToCreate)) brands.set(row.outcome.brandToCreate, row.rowNumber);
    }
  }
  const planned: PlannedUpdate[] = [...updates.values()].map((u) => ({
    productId: u.productId,
    product: u.product,
    rowNumbers: u.rowNumbers,
    matchedText: [...u.matchedTexts][0] as string,
    matchedMs: u.matchedMs,
    changes: [...u.changes.values()],
    adds: u.adds,
  }));
  const conflicting = [...updates.values()].filter((u) => (tracked.get(u.productId)?.disagreeing.size ?? 0) > 0 || addsSecondSku(u));
  const conflicts = conflictsOf(conflicting, tracked);
  return {
    brands: [...brands].map(([name, rowNumber]) => ({ name, rowNumber })),
    creates,
    updates: planned,
    deactivations: planned.flatMap((u) => (u.changes.some((c) => c.field === "is_active" && c.after === "false") ? [{ rowNumber: u.rowNumbers[0] as number, product: u.product }] : [])),
    identifiersToAdd: creates.reduce((n, c) => n + c.adds.length, 0) + planned.reduce((n, u) => n + u.adds.length, 0),
    conflictingProducts: conflicting.map((u) => u.productId),
    conflicts,
    staleProducts: [...updates.values()].filter((u) => u.matchedTexts.size > 1).map((u) => u.productId),
    rowsWithPriceNotImported: priceNotImported,
    rowsUnchanged: unchanged,
    rowsExcluded: excluded,
  };
}

/** The contract's `PublishSummary` for a plan. */
export function summaryOf(plan: PublishPlan): Record<string, number> {
  return {
    brandsCreated: plan.brands.length,
    productsCreated: plan.creates.length,
    productsUpdated: plan.updates.length,
    identifiersAdded: plan.identifiersToAdd,
    productsDeactivated: plan.deactivations.length,
    rowsUnchanged: plan.rowsUnchanged,
    rowsExcluded: plan.rowsExcluded,
  };
}

/** The bounds of the contract's `conflicts` list and of each entry's `rowNumbers` (`conflictCount` is the unbounded total). */
export const MAX_PREVIEW_CONFLICTS = 100;
export const MAX_CONFLICT_ROWS = 50;

/** The contract's `CatalogImportPreview` body (without the batch's own fields). */
export function previewOf(plan: PublishPlan): {
  brandsToCreate: string[];
  productsToCreate: number;
  productsToUpdate: number;
  identifiersToAdd: number;
  deactivations: Array<{ rowNumber: number; product: ProductRef }>;
  newProductsWithoutPrice: number;
  rowsWithPriceNotImported: number;
  conflictCount: number;
  conflicts: Array<{ product: ProductRef; rowNumbers: number[]; reason: ConflictReason; field?: string }>;
} {
  return {
    brandsToCreate: plan.brands.map((b) => b.name),
    productsToCreate: plan.creates.length,
    productsToUpdate: plan.updates.length,
    identifiersToAdd: plan.identifiersToAdd,
    deactivations: plan.deactivations.map((d) => ({ rowNumber: d.rowNumber, product: d.product })),
    // Every created product: none has a price, so none reaches a till until priced in Pricing (spec 049 section 6, F-4).
    newProductsWithoutPrice: plan.creates.length,
    rowsWithPriceNotImported: plan.rowsWithPriceNotImported,
    conflictCount: plan.conflicts.length,
    conflicts: plan.conflicts.slice(0, MAX_PREVIEW_CONFLICTS).map((c) => ({
      product: c.product,
      rowNumbers: c.rowNumbers.slice(0, MAX_CONFLICT_ROWS),
      reason: c.reason,
      ...(c.field === undefined ? {} : { field: c.field }),
    })),
  };
}
