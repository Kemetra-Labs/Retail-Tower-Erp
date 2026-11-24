/**
 * The one read behind the posting-health report: `consoleGetSalesSummary`
 * for the scope header's store, or for the whole scope — the same read as
 * the daily report, with its own cache key. Scope-keyed by the active tenant
 * AND store, and the key carries the whole query, so a scope or range change
 * is a new read and never mixes with the previous one.
 *
 * Errors are typed by the RT-818 mapper, never raw.
 */
import {
  type SalesSummary,
  type SalesSummaryErrorRender,
  type SalesSummaryQuery,
  consoleGetSalesSummary,
  mapSalesSummaryError,
} from "@/lib/sales-summary-queries";
import type { SaleScope } from "@/sales/useSales";
import { useQuery } from "@tanstack/react-query";

class SummaryFetchError extends Error {
  constructor(readonly render: SalesSummaryErrorRender) {
    super("sales-summary");
  }
}

const UNEXPECTED: SalesSummaryErrorRender = { kind: "generic", messageKey: "errors.generic" };

/** The typed render of a failed read; anything unexpected is the generic error. */
function renderOf(failure: unknown): SalesSummaryErrorRender | undefined {
  if (!failure) return undefined;
  return failure instanceof SummaryFetchError ? failure.render : UNEXPECTED;
}

export const postingHealthQueryKey = (scope: SaleScope, query: SalesSummaryQuery | null) =>
  ["sales-summary", "posting-health", scope.tenantId, scope.activeStoreId, query] as const;

export interface PostingHealthState {
  summary?: SalesSummary;
  isLoading: boolean;
  error?: SalesSummaryErrorRender;
  retry: () => void;
}

/** The report read for a valid range; `null` reads nothing. */
export function usePostingHealth(
  scope: SaleScope,
  query: SalesSummaryQuery | null,
): PostingHealthState {
  const enabled = Boolean(scope.tenantId) && query !== null;
  const result = useQuery<SalesSummary>({
    queryKey: postingHealthQueryKey(scope, query),
    enabled,
    queryFn: async () => {
      const sent = query as SalesSummaryQuery;
      const res = await consoleGetSalesSummary(sent);
      if (res.status !== 200 || !res.data) {
        throw new SummaryFetchError(
          mapSalesSummaryError({ status: res.status, error: res.error, query: sent }),
        );
      }
      return res.data;
    },
    retry: false,
  });
  return {
    summary: result.data,
    isLoading: enabled && result.isLoading,
    error: renderOf(result.error),
    retry: () => void result.refetch(),
  };
}
