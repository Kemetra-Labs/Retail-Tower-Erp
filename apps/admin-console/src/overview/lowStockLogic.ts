/**
 * RT-1073 low-stock widget logic (DESIGN.md §12.4, RT-1055 LS-1..LS-5).
 *
 * The server's order is kept (no client re-sort). Red is for `critical` only.
 * Quantities are the server's exact-decimal strings: they are only trimmed of
 * trailing fractional zeros for display, never computed on.
 */
import type { LowStockItem, LowStockList } from "@/lib/low-stock-queries";

/** Roles the contract serves; any other role gets the non-disclosing 404. */
const LOW_STOCK_ROLES = ["owner", "tenant_admin", "store_manager"] as const;

export function canReadLowStock(role: string | null | undefined): boolean {
  return (LOW_STOCK_ROLES as readonly string[]).includes(role ?? "");
}

export type LowStockTone = "critical" | "low";

/** The only colour rule: red (critical) below the critical level, otherwise neutral. */
export function toneOf(item: Pick<LowStockItem, "band">): LowStockTone {
  return item.band === "critical" ? "critical" : "low";
}

/** "12.5000" -> "12.5", "3.0000" -> "3"; a string that is not a decimal is returned as is. */
export function trimQuantity(value: string): string {
  return /^-?\d+\.\d+$/.test(value) ? value.replace(/\.?0+$/, "") : value;
}

/** The bar's fill as a CSS percentage, straight from the contract ratio ("0.0000".."0.9999"). */
export function fillPercent(levelRatio: string): number {
  const n = Number(levelRatio);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n * 100));
}

const TEXT_FIELDS = [
  "storeId",
  "storeName",
  "productId",
  "productName",
  "sellableOnHand",
  "reorderLevel",
  "levelRatio",
] as const;

/** Every field `Item` renders or keys on has the type the contract gives it. */
function isRenderableItem(item: unknown): boolean {
  if (item === null || typeof item !== "object") return false;
  const i = item as Record<string, unknown>;
  if (!TEXT_FIELDS.every((k) => typeof i[k] === "string")) return false;
  if (i.band !== "critical" && i.band !== "low") return false;
  if (i.storeStatus !== "active" && i.storeStatus !== "inactive") return false;
  return i.stockingUnit === null || typeof i.stockingUnit === "string";
}

/** The server body when it has the expected shape, else undefined (a malformed answer is an error). */
export function asLowStock(data: unknown): LowStockList | undefined {
  const d = data as Partial<LowStockList> | undefined;
  if (!d || !Array.isArray(d.items)) return undefined;
  // A malformed item would throw in `Item` (a React child that is an object, a missing band);
  // a malformed answer is the panel's error state instead.
  if (!d.items.every(isRenderableItem)) return undefined;
  for (const k of [
    "belowReorderCount",
    "criticalCount",
    "evaluatedCount",
    "unknownOnHandCount",
    "negativeOnHandCount",
  ] as const) {
    if (typeof d[k] !== "number") return undefined;
  }
  return d as LowStockList;
}

export type LowStockView =
  /** At least one low item to list. */
  | { kind: "list" }
  /** No pair has a resolved level: say so, never "nothing is low". */
  | { kind: "unconfigured" }
  /** Pairs with recorded stock exist and none is below its level, and no pair is unchecked. */
  | { kind: "none" }
  /** Same, but some pairs could not be checked: the claim covers only the pairs with recorded stock. */
  | { kind: "noneChecked" }
  /** Every evaluated pair is unchecked (no recorded stock, or negative): no claim about low stock at all. */
  | { kind: "unchecked" };

/** Pairs that were evaluated but could not be assessed (never listed by the server). */
export function uncheckedCount(list: LowStockList): number {
  return (list.unknownOnHandCount ?? 0) + (list.negativeOnHandCount ?? 0);
}

export function viewOf(list: LowStockList): LowStockView {
  if (list.items.length > 0) return { kind: "list" };
  if (list.evaluatedCount === 0) return { kind: "unconfigured" };
  const unchecked = uncheckedCount(list);
  if (unchecked === 0) return { kind: "none" };
  // Known pairs = evaluated minus unchecked; with none, nothing can be said about low stock.
  return list.evaluatedCount - unchecked > 0 ? { kind: "noneChecked" } : { kind: "unchecked" };
}
