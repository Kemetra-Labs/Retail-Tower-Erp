/**
 * RT-1054 the one read behind the «Sales by store» report:
 * `consoleGetSalesByStore` for the active tenant's whole store scope. The key
 * carries the tenant and the whole query, so a tenant, range, currency or
 * compare change is a new read and never mixes with the previous one. There is
 * no store parameter and no paging: the server ranks every store of the scope.
 *
 * Errors are typed by the mapper, never raw.
 */
import {
  type SalesByStore,
  type SalesByStoreErrorRender,
  type SalesByStoreQuery,
  consoleGetSalesByStore,
  mapSalesByStoreError,
} from "@/lib/sales-by-store-queries";
import { useQuery } from "@tanstack/react-query";

class ByStoreFetchError extends Error {
  constructor(readonly render: SalesByStoreErrorRender) {
    super("sales-by-store");
  }
}

const UNEXPECTED: SalesByStoreErrorRender = { kind: "generic", messageKey: "errors.generic" };

/** The typed render of a failed read; anything unexpected is the generic error. */
function renderOf(failure: unknown): SalesByStoreErrorRender | undefined {
  if (!failure) return undefined;
  return failure instanceof ByStoreFetchError ? failure.render : UNEXPECTED;
}

export const salesByStoreQueryKey = (tenantId: string | null, query: SalesByStoreQuery | null) =>
  ["sales-by-store", tenantId, query] as const;

export interface SalesByStoreState {
  report?: SalesByStore;
  isLoading: boolean;
  error?: SalesByStoreErrorRender;
  retry: () => void;
}

/** The report read for a valid query; `null` reads nothing. */
export function useSalesByStore(
  tenantId: string | null,
  query: SalesByStoreQuery | null,
): SalesByStoreState {
  const enabled = Boolean(tenantId) && query !== null;
  const result = useQuery<SalesByStore>({
    queryKey: salesByStoreQueryKey(tenantId, query),
    enabled,
    queryFn: async () => {
      const sent = query as SalesByStoreQuery;
      const res = await consoleGetSalesByStore(sent);
      if (res.status !== 200 || !res.data) {
        throw new ByStoreFetchError(
          mapSalesByStoreError({ status: res.status, error: res.error, query: sent }),
        );
      }
      return res.data;
    },
    retry: false,
  });
  return {
    report: result.data,
    isLoading: enabled && result.isLoading,
    error: renderOf(result.error),
    retry: () => void result.refetch(),
  };
}
