/**
 * The one read behind the posting-health report: `consoleGetSalesSummary`
 * for the scope header's store, or for the whole scope — the daily report's
 * read (`useSalesSummaryRead`), under its own cache key. A scope or range
 * change is a new read and never mixes with the previous one.
 *
 * Errors are typed by the RT-818 mapper, never raw.
 */
import type { SalesSummaryQuery } from "@/lib/sales-summary-queries";
import { type SalesDailyState, useSalesSummaryRead } from "@/sales-daily/useSalesDaily";
import type { SaleScope } from "@/sales/useSales";

/** The report read for a valid range; `null` reads nothing. */
export function usePostingHealth(
  scope: SaleScope,
  query: SalesSummaryQuery | null,
): SalesDailyState {
  return useSalesSummaryRead("posting-health", scope, query);
}
