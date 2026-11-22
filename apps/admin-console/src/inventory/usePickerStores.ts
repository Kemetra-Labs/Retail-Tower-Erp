/**
 * The stores this caller may open in the inventory views (RT-728), shared by the
 * Inventory page and the shipment-Transfer list's store filter (RT-1515). Its own
 * module so the two lazy-loaded pages do not import each other.
 */
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { type ScopeMembership, scopeMenuStores } from "@/shell/scope-stores";
import { useStoreList } from "@/stores/useStoreQueries";
import type { InventoryScope } from "./useInventory";

export interface PickerStore {
  id: string;
  name?: string;
}

export interface PickerState {
  stores: PickerStore[];
  isLoading: boolean;
  failed: boolean;
  retry: () => void;
}

type ActiveStore = { id?: string; name?: string } | null | undefined;

/** With an active store the API reads only that store: it is the one choice. */
function activeStoreChoice(active: ActiveStore, rows: readonly PickerStore[]): PickerStore[] {
  if (!active?.id) return [];
  const listed = rows.find((s) => s.id === active.id);
  return [{ id: active.id, name: listed?.name ?? active.name }];
}

/**
 * The stores this caller may open, from the store list and the active context.
 * RT-1515: also the shipment-Transfer list's store filter options.
 */
export function usePickerStores(scope: InventoryScope): PickerState {
  const { context } = useActiveContextValue();
  const { result, isLoading, refetch } = useStoreList(scope.tenantId);
  const rows = result?.kind === "rows" ? result.rows : [];
  const pinned = activeStoreChoice(context?.active_store, rows);
  if (pinned.length > 0) return { stores: pinned, isLoading: false, failed: false, retry: refetch };
  const membership = context?.memberships?.find((m) => m.tenant_id === scope.tenantId) as
    | ScopeMembership
    | undefined;
  return {
    stores: scopeMenuStores(rows, membership, null).map((s) => ({ id: s.id, name: s.name })),
    isLoading,
    failed: result?.kind === "error",
    retry: refetch,
  };
}
