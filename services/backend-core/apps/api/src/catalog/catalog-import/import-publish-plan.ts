/**
 * RT-1507 (spec 049 section 6, 8.2, 8.3): what a validated batch does to the catalogue, computed once and used by BOTH the
 * preview and the publish, so the counts the merchant is shown are the effect that is written. Pure.
 *
 * From the stored rows (status and outcome) only: a `ready_create` row creates a product with its identifiers; a
 * `ready_update` row changes the product it names (its field changes) and adds identifiers to it; `unchanged` and
 * `excluded` rows write nothing; a `ready_update` row with nothing to change or add writes nothing (a decided row that
 * turned out to change nothing). A brand a row names that does not exist is created once, however many rows name it
 * (OD-3 B). Two rows that update one product are one update of that product; if they disagree on a field, or were validated
 * against different states of the product, the plan flags it and the publish is refused (`import_not_publishable` /
 * `stale_validation`), because no merge could be right.
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
  conflicting: boolean;
}

function startUpdate(row: PlanRow): MutableUpdate {
  const product = row.outcome.matchedProduct;
  if (product === null || row.matchedText === null || row.matchedMs === null) {
    throw new Error(`import row ${row.rowNumber} is ready_update without a matched product`);
  }
  return { productId: product.productId, product, rowNumbers: [], matchedTexts: new Set(), matchedMs: row.matchedMs, changes: new Map(), adds: [], conflicting: false };
}

function mergeInto(update: MutableUpdate, row: PlanRow): void {
  update.rowNumbers.push(row.rowNumber);
  update.matchedTexts.add(row.matchedText as string);
  for (const change of row.outcome.fieldChanges) {
    const had = update.changes.get(change.field);
    if (had !== undefined && had.after !== change.after) update.conflicting = true;
    else if (had === undefined) update.changes.set(change.field, change);
  }
  for (const id of row.outcome.identifierAdds) {
    if (!update.adds.some((a) => a.type === id.type && a.value === id.value)) update.adds.push({ ...id, rowNumber: row.rowNumber });
  }
}

const hasEffect = (row: PlanRow): boolean => row.outcome.fieldChanges.length > 0 || row.outcome.identifierAdds.length > 0;

/** The effect of the batch's rows (in row order). */
export function planPublish(rows: readonly PlanRow[]): PublishPlan {
  const brands = new Map<string, number>();
  const creates: PublishPlan["creates"] = [];
  const updates = new Map<string, MutableUpdate>();
  let priceNotImported = 0;
  let unchanged = 0;
  let excluded = 0;
  for (const row of rows) {
    if (row.priceNotImported) priceNotImported += 1;
    if (row.status === "unchanged") unchanged += 1;
    else if (row.status === "excluded") excluded += 1;
    else if (row.status === "ready_create") {
      creates.push({ rowNumber: row.rowNumber, adds: row.outcome.identifierAdds });
      if (row.outcome.brandToCreate !== null && !brands.has(row.outcome.brandToCreate)) brands.set(row.outcome.brandToCreate, row.rowNumber);
    } else if (row.status === "ready_update" && hasEffect(row)) {
      const existing = updates.get(row.outcome.matchedProduct?.productId ?? "");
      const update = existing ?? startUpdate(row);
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
    conflictingProducts: [...updates.values()].filter((u) => u.conflicting).map((u) => u.productId),
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
