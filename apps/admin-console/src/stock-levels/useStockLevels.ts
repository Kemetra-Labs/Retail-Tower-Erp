/**
 * RT-1074 query and mutation hooks over the five stock-levels operations.
 *
 * The read is keyed by the tenant and the product (the server limits store
 * levels to the caller's scope, so the active store is part of the key too: a
 * scope change reads again). Errors are typed, never raw.
 *
 * Writes return a result that carries the mapped failure, so the editor
 * branches on data; a request that never completed throws. The query client
 * sets `mutations.retry: false`: nothing retries on its own, the person
 * decides, and a retry of the same intent reuses its Idempotency-Key.
 *
 * On success the returned levels replace the cached read. A replayed set
 * (`Idempotent-Replayed: true`) answers with the levels as they were when the
 * set first ran, so the read is also marked stale and fetched again.
 */
import {
  type ProductStockLevels,
  type SetStockLevelRequest,
  consoleGetProductStockLevels,
  consoleRetireStoreStockLevel,
  consoleRetireTenantStockLevel,
  consoleSetStoreStockLevel,
  consoleSetTenantStockLevel,
} from "@/lib/stock-level-queries";
import { requestIdOf } from "@/shift-closes/shiftCloseLogic";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type LevelTarget,
  type LevelWriteOp,
  type LevelWriteRender,
  mapLevelWriteError,
  normalizeLevels,
} from "./stockLevelLogic";

export type StockLevelsError = {
  kind: "not-found" | "session" | "rate-limited" | "generic";
  requestId?: string;
};

export const stockLevelsKey = (
  tenantId: string | null,
  storeId: string | null,
  productId: string,
) => ["catalog", "stock-levels", tenantId, storeId, productId] as const;

class StockLevelsFetchError extends Error {
  constructor(readonly detail: StockLevelsError) {
    super("stock-levels");
  }
}

const STATUS_KINDS: Record<number, StockLevelsError["kind"]> = {
  400: "not-found",
  401: "session",
  404: "not-found",
  429: "rate-limited",
};

function errorOf(error: unknown): StockLevelsError | undefined {
  if (!error) return undefined;
  return error instanceof StockLevelsFetchError ? error.detail : { kind: "generic" };
}

export interface StockLevelsState {
  levels?: ProductStockLevels;
  isLoading: boolean;
  error?: StockLevelsError;
  retry: () => void;
  /** Read the levels again; `undefined` when the read failed (what is on screen is kept). */
  reload: () => Promise<ProductStockLevels | undefined>;
}

/** `enabled: false` (a role that may not read, no tenant) reads nothing. */
export function useStockLevels(
  tenantId: string | null,
  storeId: string | null,
  productId: string,
  enabled: boolean,
): StockLevelsState {
  const active = enabled && Boolean(tenantId);
  const result = useQuery({
    queryKey: stockLevelsKey(tenantId, storeId, productId),
    enabled: active,
    retry: false,
    queryFn: async () => {
      const res = await consoleGetProductStockLevels(productId);
      if (res.status >= 400 || !res.data) {
        throw new StockLevelsFetchError({
          kind: STATUS_KINDS[res.status] ?? "generic",
          requestId: requestIdOf(res.error),
        });
      }
      return normalizeLevels(productId, res.data);
    },
  });
  return {
    levels: result.data,
    isLoading: active && result.isLoading,
    error: errorOf(result.error),
    retry: () => void result.refetch(),
    reload: async () => {
      const again = await result.refetch();
      return again.isError ? undefined : again.data;
    },
  };
}

export type LevelWriteResult =
  | { ok: true; levels: ProductStockLevels; replayed: boolean }
  | { ok: false; status: number; render: LevelWriteRender };

interface WriteResponse {
  status: number;
  data?: unknown;
  error?: unknown;
  replayed?: boolean;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { error?: { code?: unknown } } | undefined)?.error?.code;
  return typeof code === "string" ? code : undefined;
}

function retryAfterOf(error: unknown): number | undefined {
  const value = (error as { retryAfterSec?: unknown } | undefined)?.retryAfterSec;
  return typeof value === "number" ? value : undefined;
}

function resultOf(op: LevelWriteOp, productId: string, res: WriteResponse): LevelWriteResult {
  if (res.status < 400 && res.data) {
    return {
      ok: true,
      levels: normalizeLevels(productId, res.data),
      replayed: Boolean(res.replayed),
    };
  }
  return {
    ok: false,
    status: res.status,
    render: mapLevelWriteError({
      op,
      status: res.status,
      code: codeOf(res.error),
      requestId: requestIdOf(res.error),
      retryAfterSec: retryAfterOf(res.error),
    }),
  };
}

function settle(qc: QueryClient, key: readonly unknown[], result: LevelWriteResult): void {
  if (result.ok) {
    qc.setQueryData(key, result.levels);
    if (result.replayed) void qc.invalidateQueries({ queryKey: key });
  }
}

export interface SetLevelInput {
  target: LevelTarget;
  body: SetStockLevelRequest;
  idempotencyKey: string;
}

export interface RetireLevelInput {
  target: LevelTarget;
  expectedUpdatedAt: string;
}

export function useSetStockLevel(
  tenantId: string | null,
  storeId: string | null,
  productId: string,
) {
  const qc = useQueryClient();
  const key = stockLevelsKey(tenantId, storeId, productId);
  return useMutation({
    mutationFn: async ({ target, body, idempotencyKey }: SetLevelInput) =>
      resultOf(
        "set",
        productId,
        target.kind === "tenant"
          ? await consoleSetTenantStockLevel(productId, body, idempotencyKey)
          : await consoleSetStoreStockLevel(productId, target.storeId, body, idempotencyKey),
      ),
    onSuccess: (result) => settle(qc, key, result),
  });
}

export function useRetireStockLevel(
  tenantId: string | null,
  storeId: string | null,
  productId: string,
) {
  const qc = useQueryClient();
  const key = stockLevelsKey(tenantId, storeId, productId);
  return useMutation({
    mutationFn: async ({ target, expectedUpdatedAt }: RetireLevelInput) =>
      resultOf(
        "retire",
        productId,
        target.kind === "tenant"
          ? await consoleRetireTenantStockLevel(productId, expectedUpdatedAt)
          : await consoleRetireStoreStockLevel(productId, target.storeId, expectedUpdatedAt),
      ),
    onSuccess: (result) => settle(qc, key, result),
  });
}
