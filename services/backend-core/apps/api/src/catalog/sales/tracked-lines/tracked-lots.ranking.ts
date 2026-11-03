/**
 * Jira RT-451 slice S1 — the pure parts of the lot lookup
 * (`posListTrackedLots`, `pos-sales/tracked-lines.yaml`; RT-50 G7-13, Q10).
 *
 * The SQL in `tracked-lots.service.ts` filters (non-expired at the store's
 * business date, no active hold) and orders the lots by the contract's key;
 * this module derives the effective FEFO policy and turns the ordered rows
 * into the contract's `TrackedLotRow`s (1-based `fefoRank` under `suggest`,
 * null under `off`; the advisory position as an exact decimal string).
 */
import { formatQuantity, parseQuantity } from "../../../inventory/decimal-quantity";

export type FefoPolicy = "off" | "suggest";

/** The contract's hard bound on `TrackedLotList.lots`. */
export const MAX_TRACKED_LOTS = 500;

/**
 * The effective FEFO policy (G7-13). No tenant FEFO setting exists yet, so the
 * contract's default applies: `suggest` for a product that requires an expiry,
 * `off` for one that does not (FEFO orders by expiry).
 */
export function effectiveFefoPolicy(product: { readonly expiryRequired: boolean }): FefoPolicy {
  return product.expiryRequired ? "suggest" : "off";
}

/** One lot as the SQL returns it, already in the contract's order. */
export interface OrderedLotRow {
  readonly identity_id: string;
  readonly code: string;
  readonly expiry_date: string | null;
  /** The summed sellable quantity at the store; null while positions are not live. */
  readonly sellable_position: string | null;
}

/** Contract `TrackedLotRow`. */
export interface TrackedLotRow {
  readonly identityId: string;
  readonly code: string;
  readonly expiryDate: string | null;
  readonly fefoRank: number | null;
  readonly sellablePosition: string | null;
}

/** Map the ordered rows to the contract rows; ranks follow the given order. */
export function toTrackedLotRows(rows: readonly OrderedLotRow[], policy: FefoPolicy): TrackedLotRow[] {
  return rows.slice(0, MAX_TRACKED_LOTS).map((row, index) => ({
    identityId: row.identity_id,
    code: row.code,
    expiryDate: row.expiry_date,
    fefoRank: policy === "suggest" ? index + 1 : null,
    sellablePosition:
      row.sellable_position === null
        ? null
        : formatQuantity(parseQuantity(row.sellable_position, "sellablePosition"), "sellablePosition"),
  }));
}
