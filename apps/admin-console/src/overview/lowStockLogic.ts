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

/** The server body when it has the expected shape, else undefined (a malformed answer is an error). */
export function asLowStock(data: unknown): LowStockList | undefined {
  const d = data as Partial<LowStockList> | undefined;
  if (!d || !Array.isArray(d.items)) return undefined;
  for (const k of ["belowReorderCount", "criticalCount", "evaluatedCount"] as const) {
    if (typeof d[k] !== "number") return undefined;
  }
  return d as LowStockList;
}

export type LowStockView =
  /** No pair has a resolved level: say so, never "nothing is low". */
  | { kind: "unconfigured" }
  /** Levels exist and nothing is below them. */
  | { kind: "none" }
  | { kind: "list" };

export function viewOf(list: LowStockList): LowStockView {
  if (list.items.length > 0) return { kind: "list" };
  return list.evaluatedCount === 0 ? { kind: "unconfigured" } : { kind: "none" };
}
