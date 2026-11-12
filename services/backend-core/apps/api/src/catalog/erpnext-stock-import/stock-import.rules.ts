/**
 * Pure DC-4 rules of the ERP-origin stock import (RT-1288; planning record
 * "Inventory Gate 8" §3 row (b); `stock-import.yaml` 1.0.0-draft). No I/O.
 *
 * Which ERP vouchers Retail Tower imports (DC-4, 898-904):
 *   - only a voucher WITHOUT Retail provenance (899: Retail's own vouchers are
 *     already known) whose family is ERP-owned:
 *       Purchase Receipt (an ERP-native return included, imported negative, Q4)
 *         → erp_procurement_receipt;
 *       Stock Entry with purpose Manufacture or Repack → erp_manufacturing;
 *       Stock Reconciliation with purpose "Opening Stock" → erp_opening_stock;
 *       a Stock Reconciliation or Stock Entry carrying the governed correction
 *         reference (Q3) → erp_correction.
 *   - anything else without provenance is an unattributed ERP movement (901),
 *     a visible finding, never a silent merge.
 *
 * The effect key (DC-4 with captain decision D1): source `erpnext`, external id
 * built from the voucher type, voucher no, voucher detail no, the request's
 * warehouse and, when present, the Batch; a cancellation's compensating effect
 * adds `cancel` (DC-6). Each component is percent-encoded and the components
 * are joined with `:`, so a `:` inside an ERPNext name can never make two
 * different rows share a key.
 */
import type { ERP_INVENTORY_EVENT_TYPES } from "@data-pulse-2/db";

export type ErpInventoryEventType = (typeof ERP_INVENTORY_EVENT_TYPES)[number];

/** `stock_movements.source_system` of every imported effect. */
export const ERP_IMPORT_SOURCE_SYSTEM = "erpnext";

export interface FamilyFacts {
  readonly voucherType: string;
  readonly purpose: string | null;
  readonly correctionRef: string | null;
}

/** The ERP event type of an ERP-owned voucher family, or null (not ERP-owned). */
export function erpOwnedEventType(row: FamilyFacts): ErpInventoryEventType | null {
  const purpose = row.purpose?.trim().toLowerCase() ?? null;
  switch (row.voucherType) {
    case "Purchase Receipt":
      return "erp_procurement_receipt";
    case "Stock Entry":
      if (purpose === "manufacture" || purpose === "repack") return "erp_manufacturing";
      return row.correctionRef !== null ? "erp_correction" : null;
    case "Stock Reconciliation":
      if (purpose === "opening stock") return "erp_opening_stock";
      return row.correctionRef !== null ? "erp_correction" : null;
    default:
      return null;
  }
}

export interface KeyFacts {
  readonly voucherType: string;
  readonly voucherNo: string;
  readonly voucherDetailNo: string;
  readonly erpnextWarehouseRef: string;
  readonly batch: string | null;
}

/** The DC-4 base key of a row (without the DC-6 `cancel` component). */
export function effectKeyBase(k: KeyFacts): string {
  const parts = [k.voucherType, k.voucherNo, k.voucherDetailNo, k.erpnextWarehouseRef];
  if (k.batch !== null) parts.push(k.batch);
  return parts.map(encodeURIComponent).join(":");
}

/** The DC-6 key of a cancellation's compensating effect. */
export function cancelKey(base: string): string {
  return `${base}:cancel`;
}

/** The effect journal's precision (`stock_movements.quantity` numeric(19,4)). */
const JOURNAL_SCALE = 4;

/**
 * The signed quantity as the effect journal stores it, or null when the value
 * has more fractional digits than the journal keeps (a finding, never a
 * silent rounding). Exact string arithmetic only (§III).
 */
export function journalQuantity(actualQty: string): string | null {
  const [whole, frac = ""] = actualQty.split(".");
  const trimmed = frac.replace(/0+$/, "");
  if (trimmed.length > JOURNAL_SCALE) return null;
  const integerDigits = (whole ?? "").replace(/^-/, "");
  // numeric(19,4): at most 15 integer digits, which the contract pattern already caps.
  if (integerDigits.length > 15) return null;
  return trimmed.length === 0 ? whole! : `${whole}.${trimmed}`;
}

/** True when an exact-decimal string is zero. */
export function isZeroQuantity(qty: string): boolean {
  return /^-?0+(\.0+)?$/.test(qty);
}

/** True when an exact-decimal string is negative (and not zero). */
export function isNegativeQuantity(qty: string): boolean {
  return qty.startsWith("-") && !isZeroQuantity(qty);
}
