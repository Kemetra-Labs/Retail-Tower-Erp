/**
 * RT-1485 PR-16a-2a — the pure planner of the legacy price import (spec 044 §4.1, §4.2, §4.4;
 * decisions MC-1, MC-2, MC-10). No I/O: it turns the tenant's live legacy prices, the declared
 * MC-10 inputs and the tenant's Store zones into the events of the `legacy_import` revision, or a
 * refusal.
 *
 *   - A priced live `tenant_products` row becomes a `book` event; a priced live
 *     `store_product_overrides` row a `store` event (§4.2). Override rows with no price, and
 *     retired rows, never reach this planner (the catalog port reads priced live rows only).
 *   - Exceptions (§4.4, MC-2) are not imported and are reported per row: `zero_price` (Q-4,
 *     price > 0) and `not_representable` (minor-unit exactness, spec 041 §6). Each one blocks the
 *     tenant's cutover; it is fixed on the legacy side, never accepted into Pricing.
 *   - More than one legacy currency refuses the whole tenant (`multi_currency_tenant`). A single
 *     legacy currency must equal the declared Book currency (`currency_mismatch`, MC-10), so the
 *     §4.4 `foreign_currency` row class cannot occur once the planner accepts a tenant.
 *   - Bounds (MC-1): `store_local`, open-ended. A store event starts at the import instant `at`
 *     in its Store's zone; a book event at `at` in the westernmost zone (smallest UTC offset at
 *     `at`) of ALL the tenant's Stores, active or not, or the declared reference zone when the
 *     tenant has no Store. Read back under Q-2, every start is at or before `at`.
 */
import { representablePrice } from "../resolution/representable-price";
import { instantToWallClock } from "../resolution/store-local-time";

export interface LegacyBookPrice {
  readonly productId: string;
  /** `numeric(19,4)` as text. */
  readonly price: string;
  readonly currencyCode: string;
}

export interface LegacyStorePrice extends LegacyBookPrice {
  readonly storeId: string;
}

/** The tenant's live, priced legacy rows. */
export interface LegacyPrices {
  readonly book: readonly LegacyBookPrice[];
  readonly store: readonly LegacyStorePrice[];
}

/** The MC-10 inputs: declared per tenant, never defaulted. */
export interface ImportInputs {
  readonly currencyCode: string;
  readonly taxPriceBasis: "inclusive" | "exclusive";
  /** Required only when the tenant has no Store (the Book-scope bound). */
  readonly referenceZone: string | null;
}

export interface StoreZone {
  readonly id: string;
  readonly timezone: string;
}

export interface PlannedEvent {
  readonly scope: "book" | "store";
  readonly storeId: string | null;
  readonly productId: string;
  /** At `numeric(19,4)` scale. */
  readonly price: string;
  /** `effective_from_local` (wall clock, UTC fields); `effective_to_local` is null. */
  readonly fromLocal: Date;
}

export type ExceptionClass = "zero_price" | "not_representable";

export interface ImportException {
  readonly cls: ExceptionClass;
  readonly scope: "book" | "store";
  readonly storeId: string | null;
  readonly productId: string;
}

export type RefusalReason = "multi_currency_tenant" | "currency_mismatch" | "reference_zone_required";

export type ImportPlan =
  | { readonly kind: "ok"; readonly events: PlannedEvent[]; readonly exceptions: ImportException[]; readonly currencyCode: string }
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly currencies: string[] };

const ZERO = /^0*(?:\.0*)?$/;

/** The zone with the smallest UTC offset at `at` (ties: the first in `zones`). */
function westernmost(zones: readonly string[], at: Date): string | null {
  let best: string | null = null;
  let bestOffset = Number.POSITIVE_INFINITY;
  for (const zone of zones) {
    const offset = instantToWallClock(at, zone).getTime() - at.getTime();
    if (offset < bestOffset) {
      best = zone;
      bestOffset = offset;
    }
  }
  return best;
}

function classify(price: string, currencyCode: string): { price: string } | { cls: ExceptionClass } {
  if (ZERO.test(price)) return { cls: "zero_price" };
  const exact = representablePrice(price, currencyCode);
  return exact === null ? { cls: "not_representable" } : { price: exact };
}

/** The import plan, or a refusal. `stores` is every Store of the tenant, active or not. */
export function planLegacyImport(legacy: LegacyPrices, inputs: ImportInputs, stores: readonly StoreZone[], at: Date): ImportPlan {
  const currencies = [...new Set([...legacy.book, ...legacy.store].map((r) => r.currencyCode))].sort();
  if (currencies.length > 1) return { kind: "refused", reason: "multi_currency_tenant", currencies };
  if (currencies.length === 1 && currencies[0] !== inputs.currencyCode) return { kind: "refused", reason: "currency_mismatch", currencies };
  const bookZone = stores.length > 0 ? westernmost(stores.map((s) => s.timezone), at) : inputs.referenceZone;
  if (bookZone === null) return { kind: "refused", reason: "reference_zone_required", currencies };
  const zoneOf = new Map(stores.map((s) => [s.id, s.timezone]));

  const events: PlannedEvent[] = [];
  const exceptions: ImportException[] = [];
  const rows: ReadonlyArray<{ scope: "book" | "store"; storeId: string | null; row: LegacyBookPrice }> = [
    ...legacy.book.map((row) => ({ scope: "book" as const, storeId: null, row })),
    ...legacy.store.map((row) => ({ scope: "store" as const, storeId: row.storeId, row })),
  ];
  for (const { scope, storeId, row } of rows) {
    const c = classify(row.price, row.currencyCode);
    if ("cls" in c) {
      exceptions.push({ cls: c.cls, scope, storeId, productId: row.productId });
      continue;
    }
    const zone = storeId === null ? bookZone : zoneOf.get(storeId);
    // The catalog port only returns overrides of the tenant's own Stores (FK); a gap is a defect.
    if (zone === undefined) throw new Error(`legacy import: no zone for store ${storeId}`);
    events.push({ scope, storeId, productId: row.productId, price: c.price, fromLocal: instantToWallClock(at, zone) });
  }
  return { kind: "ok", events, exceptions, currencyCode: inputs.currencyCode };
}
