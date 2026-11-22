/**
 * RT-1515 (PR 2) the SOURCE store's on-hand of each product on a Transfer being
 * drafted (`getOnHand`): its stocking unit (which the create command needs) and
 * the Physical and Sellable figures the operator sees beside the quantity.
 * Reads only. The keys are the inventory on-hand keys, so a recorded write that
 * invalidates `inventory` re-reads them, and a source-store change reads again.
 */
import { type OnHand, getOnHand } from "@/lib/inventory-queries";
import { useQueries } from "@tanstack/react-query";
import { type InventoryScope, inventoryQueryKeys } from "../useInventory";

export interface LineStock {
  state: "loading" | "ready" | "failed";
  onHand?: OnHand;
  retry: () => void;
}

/** One entry per product id; nothing is read until a source store is chosen. */
export function useLineStocks(
  scope: InventoryScope,
  sourceStoreId: string,
  productIds: readonly string[],
): ReadonlyMap<string, LineStock> {
  const unique = [...new Set(productIds)];
  const results = useQueries({
    queries: unique.map((productId) => ({
      queryKey: inventoryQueryKeys.onHand({ scope, storeId: sourceStoreId, productId }),
      enabled: Boolean(scope.tenantId && sourceStoreId),
      retry: false,
      queryFn: async (): Promise<OnHand> => {
        const res = await getOnHand(sourceStoreId, productId);
        if (res.status >= 400 || !res.data) throw new Error("on-hand");
        return res.data;
      },
    })),
  });
  return new Map(
    unique.map((id, index) => {
      const result = results[index];
      const state: LineStock["state"] = result?.data
        ? "ready"
        : result?.isError
          ? "failed"
          : "loading";
      return [id, { state, onHand: result?.data, retry: () => void result?.refetch() }];
    }),
  );
}
