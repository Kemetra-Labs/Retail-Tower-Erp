/**
 * The caller's in-scope stores for a queue's store filter (the scope menu's own rule, RT-354).
 * Shared by the sales-needing-repair queue (RT-726) and the sale quarantine queue (RT-1312).
 */
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { type ScopeMembership, scopeMenuStores } from "@/shell/scope-stores";
import { useStoreList } from "@/stores/useStoreQueries";

export interface FilterStore {
  id: string;
  name?: string;
}

export function useFilterStores(tenantId: string | null): FilterStore[] {
  const { context } = useActiveContextValue();
  const { result } = useStoreList(tenantId);
  const rows = result?.kind === "rows" ? result.rows : [];
  const membership = context?.memberships?.find((m) => m.tenant_id === tenantId) as
    | ScopeMembership
    | undefined;
  return scopeMenuStores(rows, membership, null).map((s) => ({ id: s.id, name: s.name }));
}
