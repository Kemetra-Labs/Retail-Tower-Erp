/**
 * Sale / void / return Inventory Effect lines — pure rules (Jira RT-427).
 *
 * No I/O. Decides, for one Retail business line, whether it gets an effect
 * and under which provenance key (RT-289 DC-1). The writer
 * (`sale-effects.ts`) reads the facts and applies the decision.
 *
 * Owner decision 2 (RT-427, 2026-10-21): an effect write never stalls the
 * sale or its ERP posting (731). A line that is not stock (no product, zero
 * quantity) writes no effect and no signal. A line whose effect cannot be
 * written exactly writes no effect and is reported as SKIPPED, with a bounded
 * reason, so the gap is observable (signal + structured log) and reconcilable:
 *   - unit_mismatch: the line's unit is not the product's established stocking
 *     unit at the store (the 0016 one-unit-per-product guard would refuse it);
 *   - quantity_precision: the quantity needs more than the 4 decimals of
 *     `stock_movements.quantity` (sale lines keep 6), so it cannot be stored
 *     without rounding (756);
 *   - tracked_product: a batch / serial product needs a tracking identity,
 *     which only tracked selling writes (RT-451, RT-50 G7-4).
 *
 * Tracked effects (RT-451 S4; RT-50 G7-9 rows 1 to 3, G7-10). A `batch`
 * product's line that carries the identity it was sold from (the writer
 * passes it only for a line capture classified `valid` or `flagged`, or from
 * the original effect for a void or return) is written AT that identity. A
 * batch line without one (captured while tracked selling was off, comment
 * 16269) stays skipped as `tracked_product`, as does every `serial` line
 * (serial selling stays gated, RT-50 Q11; RT-451 comment 16275 (a)). An
 * untracked product's line never carries an identity.
 */

export const SKIPPED_EFFECT_REASONS = ["unit_mismatch", "quantity_precision", "tracked_product"] as const;
export type SkippedEffectReason = (typeof SKIPPED_EFFECT_REASONS)[number];

/** The Retail business events whose lines carry effects in RT-427. */
export type SaleEffectEvent = "sale" | "sale_void" | "sale_return";

/** What the writer knows about one line before writing its effect. */
export interface EffectLineFacts {
  readonly tenantProductRef: string | null;
  /** Exact decimal text as Postgres returns it (e.g. `"2.500000"`). */
  readonly quantity: string;
  readonly unit: string;
  /** `tenant_products.tracking_mode`; null for a line with no product. */
  readonly trackingMode: string | null;
  /** The unit the product's movements at this store already use, if any. */
  readonly establishedUnit: string | null;
  /**
   * The tracking identity the line moves, or null: a classified line's
   * identity (sale), or the original effect's (void, return).
   */
  readonly trackingIdentityId: string | null;
}

export type EffectLineDecision =
  /** Write the effect; at `trackingIdentityId` when it is not null. */
  | { readonly kind: "write"; readonly trackingIdentityId: string | null }
  | { readonly kind: "ignore" }
  | { readonly kind: "skip"; readonly reason: SkippedEffectReason };

/** The identity a line's effect is written at, or a `tracked_product` skip. */
function trackedIdentity(facts: EffectLineFacts): { identity: string | null } | null {
  if (facts.trackingMode === null || facts.trackingMode === "none") return { identity: null };
  if (facts.trackingMode === "batch" && facts.trackingIdentityId !== null) return { identity: facts.trackingIdentityId };
  return null;
}

const ZERO_QUANTITY = /^-?0+(\.0+)?$/;
/** At most 4 significant decimals (trailing zeros beyond them are fine). */
const FITS_FOUR_DECIMALS = /^-?\d+(\.\d{0,4}0*)?$/;

/** Whether, and why not, one line gets an Inventory Effect. */
export function decideEffectLine(facts: EffectLineFacts): EffectLineDecision {
  if (facts.tenantProductRef === null || ZERO_QUANTITY.test(facts.quantity)) {
    return { kind: "ignore" };
  }
  const tracked = trackedIdentity(facts);
  if (tracked === null) {
    return { kind: "skip", reason: "tracked_product" };
  }
  if (!FITS_FOUR_DECIMALS.test(facts.quantity)) {
    return { kind: "skip", reason: "quantity_precision" };
  }
  if (facts.establishedUnit !== null && facts.establishedUnit !== facts.unit) {
    return { kind: "skip", reason: "unit_mismatch" };
  }
  return { kind: "write", trackingIdentityId: tracked.identity };
}

/** DC-1 provenance key of a sale line's effect. */
export function saleLineEffectKey(saleLineId: string): string {
  return `sale_line:${saleLineId}`;
}

/** DC-1 provenance key of a void's compensating effect for one sale line. */
export function voidEffectKey(voidId: string, saleLineId: string): string {
  return `void:${voidId}:${saleLineId}`;
}

/** DC-1 provenance key of a return line's effect. */
export function returnLineEffectKey(returnLineId: string): string {
  return `return_line:${returnLineId}`;
}
