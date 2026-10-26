/**
 * RT-769 mutation hooks for the two identifier writes (CAT-C2b): add and
 * retire, each by the identifier's full key. Neither takes an Idempotency-Key
 * in the contract and neither needs one: a repeated add that already succeeded
 * is 409 `alias_conflict`, a repeated retire is 404, so nothing is written
 * twice. The query client sets `mutations.retry: false`; the operator decides.
 *
 * A result carries the mapped failure (`mapIdentifierWriteError`), so the
 * drawers branch on data, not on thrown errors. A request that never completed
 * throws and the drawer shows its generic banner.
 *
 * On success the returned detail replaces the cached product, and the item
 * lists and the picker are marked stale (they show the primary SKU and
 * barcode, and search by exact code). On `product_retired` / a retire 404 the
 * product is marked stale without a read now: the drawer keeps its banner, and
 * the page reads the item again when the drawer closes.
 */
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import {
  type CatalogIdentifierKey,
  type CatalogProductDetail,
  consoleAddProductIdentifier,
  consoleRetireProductIdentifier,
} from "@/lib/catalog-queries";
import { type ScopeMembership, scopeMenuStores } from "@/shell/scope-stores";
import { requestIdOf } from "@/shift-closes/shiftCloseLogic";
import { useStoreList } from "@/stores/useStoreQueries";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type IdentifierWriteOp,
  type IdentifierWriteRender,
  mapIdentifierWriteError,
} from "./identifierFormLogic";
import { catalogProductKey, normalizeProduct } from "./useCatalogProduct";
import { markListsStale } from "./useProductWrites";

export type IdentifierWriteResult =
  | { ok: true; detail: CatalogProductDetail }
  | { ok: false; render: IdentifierWriteRender };

interface WriteResponse {
  status: number;
  data?: CatalogProductDetail;
  error?: unknown;
}

function codeOf(error: unknown): string | undefined {
  return (error as { error?: { code?: string } } | undefined)?.error?.code;
}

function resultOf(op: IdentifierWriteOp, res: WriteResponse): IdentifierWriteResult {
  if (res.status < 400 && res.data) return { ok: true, detail: normalizeProduct(res.data) };
  return {
    ok: false,
    render: mapIdentifierWriteError({
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
  result: IdentifierWriteResult,
): void {
  if (result.ok) {
    qc.setQueryData(catalogProductKey(tenantId, productId), result.detail);
    markListsStale(qc, tenantId);
  } else if (result.render.kind === "retired" || result.render.kind === "gone") {
    void qc.invalidateQueries({
      queryKey: catalogProductKey(tenantId, productId),
      refetchType: "none",
    });
    markListsStale(qc, tenantId);
  }
}

export function useAddIdentifier(tenantId: string | null, productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (key: CatalogIdentifierKey): Promise<IdentifierWriteResult> =>
      resultOf("add", await consoleAddProductIdentifier(productId, key)),
    onSuccess: (result) => settle(qc, tenantId, productId, result),
  });
}

export function useRetireIdentifier(tenantId: string | null, productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (key: CatalogIdentifierKey): Promise<IdentifierWriteResult> =>
      resultOf("retire", await consoleRetireProductIdentifier(productId, key)),
    onSuccess: (result) => settle(qc, tenantId, productId, result),
  });
}

export interface ScopeStoreOption {
  id: string;
  name: string | null;
}

/**
 * The stores an identifier can be scoped to: the caller's own roster, narrowed
 * by their membership grant (the scope menu's rule, RT-354). Read only while
 * the add drawer is open. A roster that fails to load reads as empty, so only
 * the tenant-wide scope is offered: nothing is invented, and the server still
 * refuses a store outside the caller's scope (non-disclosing 404).
 */
export function useIdentifierStores(tenantId: string | null, enabled: boolean): ScopeStoreOption[] {
  const { context } = useActiveContextValue();
  const { result } = useStoreList(enabled ? tenantId : null);
  const rows = result?.kind === "rows" && Array.isArray(result.rows) ? result.rows : [];
  const membership = context?.memberships?.find((m) => m.tenant_id === tenantId) as
    | ScopeMembership
    | undefined;
  return scopeMenuStores(rows, membership, context?.active_store ?? null).map((s) => ({
    id: s.id,
    name: s.name ?? null,
  }));
}
