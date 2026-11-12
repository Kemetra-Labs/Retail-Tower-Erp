import { type VoucherListQuery, consoleGetVoucher, consoleListVouchers } from "@/lib/client";
/**
 * RT-1109 voucher reads (react-query). Keys are scoped by the active tenant and
 * the filters, so a tenant switch or a new filter re-queries. Neither read ever
 * carries a code (`Voucher` and `VoucherPage` are closed schemas without one),
 * so nothing secret can enter the query cache from here. The issue response is
 * deliberately NOT a query or a mutation: it lives only in the issue drawer.
 *
 * Errors: 401 → session, 403 → forbidden, 404 (detail) → not found, anything
 * else → generic. The server's words never show; the request id does.
 */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  type VoucherListPage,
  type VoucherRow,
  type VoucherStatus,
  flattenVoucherPages,
  nextVoucherCursor,
} from "./voucherLogic";
import { requestIdOf } from "./voucherOutcomes";

export interface VoucherFilters {
  status?: VoucherStatus;
  eligible_store_id?: string;
}

export type VoucherReadError = {
  kind: "session" | "forbidden" | "notFound" | "generic";
  requestId?: string;
};

export const voucherQueryKeys = {
  all: (tenantId: string | null) => ["vouchers", tenantId] as const,
  list: (tenantId: string | null, filters: VoucherFilters) =>
    ["vouchers", tenantId, "list", filters] as const,
  detail: (tenantId: string | null, voucherId: string) =>
    ["vouchers", tenantId, "detail", voucherId] as const,
};

function readError(status: number, error: unknown): VoucherReadError {
  const requestId = requestIdOf({ status, error });
  if (status === 401) return { kind: "session", requestId };
  if (status === 403) return { kind: "forbidden", requestId };
  if (status === 404) return { kind: "notFound", requestId };
  return { kind: "generic", requestId };
}

class VoucherReadFailure extends Error {
  constructor(readonly detail: VoucherReadError) {
    super("voucher-read");
  }
}

function errorOf(error: unknown): VoucherReadError | undefined {
  if (!error) return undefined;
  return error instanceof VoucherReadFailure ? error.detail : { kind: "generic" };
}

export interface VoucherListValue {
  rows: VoucherRow[];
  hasMore: boolean;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  error?: VoucherReadError;
  loadMore: () => void;
}

const FIRST_PAGE: string | undefined = undefined;

export function useVoucherList(tenantId: string | null, filters: VoucherFilters): VoucherListValue {
  const query = useInfiniteQuery({
    queryKey: voucherQueryKeys.list(tenantId, filters),
    enabled: Boolean(tenantId),
    initialPageParam: FIRST_PAGE,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const params: VoucherListQuery = { ...filters, cursor: pageParam };
      const res = await consoleListVouchers(params);
      if (res.status >= 400 || !res.data)
        throw new VoucherReadFailure(readError(res.status, res.error));
      return res.data as VoucherListPage;
    },
    getNextPageParam: (last) => nextVoucherCursor(last),
    retry: false,
  });

  return {
    rows: flattenVoucherPages(query.data?.pages ?? []),
    hasMore: Boolean(query.hasNextPage),
    isLoading: query.isLoading && Boolean(tenantId),
    isFetchingNextPage: query.isFetchingNextPage,
    error: errorOf(query.error),
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
  };
}

export function useVoucher(tenantId: string | null, voucherId: string) {
  const query = useQuery({
    queryKey: voucherQueryKeys.detail(tenantId, voucherId),
    enabled: Boolean(tenantId),
    queryFn: async () => {
      const res = await consoleGetVoucher(voucherId);
      if (res.status >= 400 || !res.data)
        throw new VoucherReadFailure(readError(res.status, res.error));
      return res.data as VoucherRow;
    },
    retry: false,
  });
  return { voucher: query.data, isLoading: query.isLoading, error: errorOf(query.error) };
}
