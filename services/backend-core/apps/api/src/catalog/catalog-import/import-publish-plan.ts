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

/** Whether the row's values disagree with what the product's earlier rows set; records them either way. */
function disagrees(seen: Map<string, string>, row: PlanRow, explicit: ReadonlyMap<number, Readonly<Record<string, string>>>): boolean {
  let differs = false;
  for (const [field, value] of valuesOf(row, explicit)) {
    const had = seen.get(field);
    if (had !== undefined && had !== value) differs = true;
    else seen.set(field, value);
  }
  return differs;
}

/** Records what the row states for its product; a disagreement with the product's earlier rows is remembered. Returns the product id. */
function trackValues(
  seenValues: Map<string, Map<string, string>>,
  disagreeing: Set<string>,
  row: PlanRow,
  explicit: ReadonlyMap<number, Readonly<Record<string, string>>>,
): string {
  const productId = row.outcome.matchedProduct?.productId ?? "";
  const seen = seenValues.get(productId) ?? new Map<string, string>();
  seenValues.set(productId, seen);
  if (disagrees(seen, row, explicit)) disagreeing.add(productId);
  return productId;
}

/** A merged update that would give the product a second SKU (or a SKU to one that has one): OD-1 sends such a row to review. */
function addsSecondSku(update: MutableUpdate): boolean {
  const skus = update.adds.filter((a) => a.type === "sku").length;
  return skus > 1 || (skus === 1 && update.product.identifiers.some((i) => i.type === "sku"));
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
  const seenValues = new Map<string, Map<string, string>>();
  const disagreeing = new Set<string>();
  let priceNotImported = 0;
  let unchanged = 0;
  let excluded = 0;
  for (const row of rows) {
    if (row.priceNotImported) priceNotImported += 1;
    if (row.status === "unchanged") {
      unchanged += 1;
      // It writes nothing, but what it states for its product still counts against another row's change of it.
      trackValues(seenValues, disagreeing, row, explicit);
    } else if (row.status === "excluded") excluded += 1;
    else if (row.status === "ready_create") {
      creates.push({ rowNumber: row.rowNumber, adds: row.outcome.identifierAdds });
      if (row.outcome.brandToCreate !== null && !brands.has(row.outcome.brandToCreate)) brands.set(row.outcome.brandToCreate, row.rowNumber);
    } else if (row.status === "ready_update") {
      const productId = trackValues(seenValues, disagreeing, row, explicit);
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
  return {
    brands: [...brands].map(([name, rowNumber]) => ({ name, rowNumber })),
    creates,
    updates: planned,
    deactivations: planned.flatMap((u) => (u.changes.some((c) => c.field === "is_active" && c.after === "false") ? [{ rowNumber: u.rowNumbers[0] as number, product: u.product }] : [])),
    identifiersToAdd: creates.reduce((n, c) => n + c.adds.length, 0) + planned.reduce((n, u) => n + u.adds.length, 0),
    conflictingProducts: [...updates.values()].filter((u) => disagreeing.has(u.productId) || addsSecondSku(u)).map((u) => u.productId),
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

/** The contract's `CatalogImportPreview` body (without the batch's own fields). */
export function previewOf(plan: PublishPlan): {
  brandsToCreate: string[];
  productsToCreate: number;
  productsToUpdate: number;
  identifiersToAdd: number;
  deactivations: Array<{ rowNumber: number; product: ProductRef }>;
  newProductsWithoutPrice: number;
  rowsWithPriceNotImported: number;
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
  };
}
