/**
 * RT-770 mutation hooks for the two store-override writes (CAT-C2c): upsert
 * (PUT) and retire (POST). Neither takes an Idempotency-Key in the contract:
 * the `expectedUpdatedAt` precondition makes a repeated request safe (a second
 * one is a 409 `stale_write`). The query client sets `mutations.retry: false`,
 * so nothing here retries on its own.
 *
 * A result carries the mapped failure (`mapOverrideWriteError`), so components
 * branch on data. A request that never completed throws and the drawer shows
 * its generic banner.
 *
 * On success the returned detail replaces the cached product, so the detail's
 * raw-deviation section shows what the server now holds (RT-752 D8: nothing is
 * computed here), and the item lists are marked stale: a store-scoped list
 * shows the server-resolved `storeView`, which the change may move.
 */
import {
  type CatalogProductDetail,
  type CatalogStoreOverrideUpsert,
  consoleRetireStoreOverride,
  consoleUpsertStoreOverride,
} from "@/lib/catalog-queries";
import { requestIdOf } from "@/shift-closes/shiftCloseLogic";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type OverrideWriteOp,
  type OverrideWriteRender,
  mapOverrideWriteError,
} from "./storeOverrideLogic";
import { catalogProductKey, normalizeProduct } from "./useCatalogProduct";

export type OverrideWriteResult =
  | { ok: true; detail: CatalogProductDetail }
  | { ok: false; render: OverrideWriteRender };

interface WriteResponse {
  status: number;
  data?: CatalogProductDetail;
  error?: unknown;
}

function codeOf(error: unknown): string | undefined {
  return (error as { error?: { code?: string } } | undefined)?.error?.code;
}

function resultOf(op: OverrideWriteOp, res: WriteResponse): OverrideWriteResult {
  if (res.status < 400 && res.data) return { ok: true, detail: normalizeProduct(res.data) };
  return {
    ok: false,
    render: mapOverrideWriteError({
      op,
      status: res.status,
      code: codeOf(res.error),
      requestId: requestIdOf(res.error),
    }),
  };
}

function settle(
  qc: QueryClient,
  tenantId: string | null,
  productId: string,
  result: OverrideWriteResult,
): void {
  if (result.ok) {
    qc.setQueryData(catalogProductKey(tenantId, productId), result.detail);
    void qc.invalidateQueries({ queryKey: ["catalog", "products", tenantId] });
  } else if (result.render.kind === "stale" || result.render.kind === "retired") {
    // The item moved under the person. Mark it stale without reading it now: the
    // drawer keeps what was chosen, and its Reload (or the next view) re-reads.
    void qc.invalidateQueries({
      queryKey: catalogProductKey(tenantId, productId),
      refetchType: "none",
    });
  }
}

export interface UpsertOverrideVars {
  storeId: string;
  body: CatalogStoreOverrideUpsert;
}

export function useUpsertStoreOverride(tenantId: string | null, productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ storeId, body }: UpsertOverrideVars): Promise<OverrideWriteResult> =>
      resultOf("upsert", await consoleUpsertStoreOverride(productId, storeId, body)),
    onSuccess: (result) => settle(qc, tenantId, productId, result),
  });
}

export interface RetireOverrideVars {
  storeId: string;
  expectedUpdatedAt: string;
}

export function useRetireStoreOverride(tenantId: string | null, productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      storeId,
      expectedUpdatedAt,
    }: RetireOverrideVars): Promise<OverrideWriteResult> =>
      resultOf("retire", await consoleRetireStoreOverride(productId, storeId, expectedUpdatedAt)),
    onSuccess: (result) => settle(qc, tenantId, productId, result),
  });
}
