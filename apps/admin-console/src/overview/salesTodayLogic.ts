/**
 * Overview sales-summary helpers (RT-820, kept by RT-970). No React, no fetch.
 *
 * - `asSalesSummary`: a body the Overview can render (a store list and scope
 *   totals); anything else is malformed, never zero.
 * - `salesDrillDown`: `/sales` for one store and one business date.
 *
 * RT-970 replaced the per-store "today" rows (P-6) with the KPI and pipeline
 * strips; their date rules live in `glanceLogic.ts`.
 */
import type { SalesSummary } from "@/lib/sales-summary-queries";
import { emptyFilters, filtersToSearch } from "@/sales/saleFilters";

type StoreSummary = SalesSummary["stores"][number];

/** `/sales?store=…&from=…&to=…` for one store and its business date (per store, never a total). */
export function salesDrillDown(storeRef: string, date: string): string {
  const search = filtersToSearch({
    ...emptyFilters(),
    storeId: storeRef,
    fromDate: date,
    toDate: date,
  });
  return `/sales?${search.toString()}`;
}

function isStoreSummary(store: unknown): boolean {
  const s = store as Partial<StoreSummary> | null | undefined;
  return Array.isArray(s?.days) && typeof s.currentBusinessDate === "string";
}

function hasScopeTotals(totals: Partial<SalesSummary["scopeTotals"]> | undefined): boolean {
  return Array.isArray(totals?.days) && typeof totals.storeCount === "number";
}

/** A body the panel can render: a store list and scope totals; anything else is malformed. */
export function asSalesSummary(data: unknown): SalesSummary | undefined {
  const body = data as Partial<SalesSummary> | null | undefined;
  const ok = Array.isArray(body?.stores) && body.stores.every(isStoreSummary);
  return ok && hasScopeTotals(body.scopeTotals) ? (body as SalesSummary) : undefined;
}
