/**
 * The global search's pure rules. No React, no fetch. The page reads three
 * existing contracts, one page each, and never stitches or sums:
 *
 * - Products: `consoleListCatalogProducts?q=` — an exact match on an active
 *   barcode, sku or plu, or a case-insensitive substring of the product name.
 *   The list's own `q` (catalogLogic), capped at 100 characters.
 * - Sales: `consoleListSales?sale_number=` — an exact match on the captured
 *   receipt number, within one store and a range of at most 31 business days.
 *   The window is the store's today and the 30 days before it.
 * - Operators: no server search exists (`listMembers` is one tenant roster),
 *   so the page filters that one read client-side, by name or email.
 */
import type { CatalogListQuery } from "@/lib/catalog-queries";
import type { SaleListQuery } from "@/lib/sale-queries";
import { addDays } from "@/sales-daily/dailyLogic";
import { todayIn } from "@/sales/saleFilters";

/** The receipt-number lookup reads at most the last 31 business days (the sales list's cap). */
const RECEIPT_WINDOW_DAYS = 30;
/** `sale_number` is an exact match of at most 96 characters. */
export const MAX_SALE_NUMBER_LENGTH = 96;
/** `q` is the catalog's search text: at most 100 characters. */
export const MAX_SEARCH_LENGTH = 100;
/** First-page cap per section on the search page. */
export const SEARCH_PAGE_SIZE = 10;

/** The receipt window in a store's zone: today and the 30 days before it. */
export function receiptWindow(
  timeZone: string,
  now: Date = new Date(),
): { from: string; to: string } {
  const to = todayIn(timeZone, now);
  return { from: addDays(to, -RECEIPT_WINDOW_DAYS), to };
}

/**
 * The products query for a search term, or null when there is nothing to
 * search. The list's own shape: active products, the active store's view when
 * a store is in scope, first page only.
 */
export function productSearchQuery(
  q: string | null,
  storeId: string | null,
): CatalogListQuery | null {
  const term = (q ?? "").trim();
  if (term === "" || term.length > MAX_SEARCH_LENGTH) return null;
  return {
    q: term,
    status: "active",
    ...(storeId ? { store_id: storeId } : {}),
    limit: SEARCH_PAGE_SIZE,
  };
}

/**
 * The receipt lookup for a search term, or null when it cannot run: no term,
 * a term longer than the receipt number allows, no active store, or no window.
 * A sale captured without a receipt snapshot has no number and never matches.
 */
export function receiptSearchQuery(
  q: string | null,
  storeId: string | null,
  window: { from: string; to: string } | null,
): SaleListQuery | null {
  const term = (q ?? "").trim();
  if (term === "" || term.length > MAX_SALE_NUMBER_LENGTH) return null;
  if (!storeId || !window) return null;
  return {
    store_id: storeId,
    from: window.from,
    to: window.to,
    sale_number: term,
    page_size: SEARCH_PAGE_SIZE,
  };
}
