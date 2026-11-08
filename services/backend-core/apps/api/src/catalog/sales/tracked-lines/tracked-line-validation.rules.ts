/**
 * Jira RT-451 slice S2 — the pure decision of the Tracked Line Validation
 * (`posValidateTrackedLine`, `pos-sales/tracked-lines.yaml`; RT-50 G7-5, G7-8,
 * Q11, Q12).
 *
 * The checks run in the contract's order and the FIRST that fails is the single
 * refusal reason:
 *
 *   1. not_sellable      the product is retired, inactive at the store (the
 *                        store override's `is_active`, else the product's), or a
 *                        `serial` product (Q11: serial selling stays fail-closed)
 *   2. profile_mismatch  the Tracking Profile does not allow lot selling (`none`);
 *                        a product-level check, before the identity is looked up
 *   3. unknown_identity  no identity with this id or code exists in the tenant
 *   4. wrong_product     the identity belongs to another product of the tenant
 *   5. recalled          an active `recall_hold`
 *   6. held              an active `quality_hold`
 *   7. expired           its `expiryDate` is before the store's business date
 *                        (G7-5: sellable through the expiry date, inclusive)
 *
 * Nothing else is checked: quantity never refuses and nothing is reserved
 * (Q12). A scanned `expiryDate` never changes the identity or the result.
 */
import type { TrackedLineRefusalReason } from "@data-pulse-2/db/schema";

/** The product as the store resolves it. */
export interface TrackedLineProductFacts {
  readonly trackingMode: string;
  /** Not retired and active at the store (override `is_active`, else the product's). */
  readonly sellableAtStore: boolean;
}

/** The identity the request named, as Inventory knows it; null when none exists in the tenant. */
export interface TrackedLineIdentityFacts {
  readonly productId: string;
  readonly expiryDate: string | null;
  readonly recallHold: boolean;
  readonly qualityHold: boolean;
}

/** The product-level checks (1 and 2); null when the product may be sold as a lot. */
export function productRefusal(product: TrackedLineProductFacts): TrackedLineRefusalReason | null {
  if (!product.sellableAtStore || product.trackingMode === "serial") return "not_sellable";
  if (product.trackingMode !== "batch") return "profile_mismatch";
  return null;
}

/** The identity-level checks (3 to 7) at the store's business date; null when accepted. */
export function identityRefusal(input: {
  readonly productId: string;
  readonly identity: TrackedLineIdentityFacts | null;
  readonly businessDate: string;
}): TrackedLineRefusalReason | null {
  const { identity } = input;
  if (identity === null) return "unknown_identity";
  if (identity.productId !== input.productId) return "wrong_product";
  if (identity.recallHold) return "recalled";
  if (identity.qualityHold) return "held";
  // ISO `YYYY-MM-DD` strings compare in calendar order.
  if (identity.expiryDate !== null && identity.expiryDate < input.businessDate) return "expired";
  return null;
}
