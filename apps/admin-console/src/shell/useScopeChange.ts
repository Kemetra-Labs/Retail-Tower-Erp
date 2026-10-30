import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useCallback } from "react";
import { useDirtyGuard } from "./dirty-guard";

/**
 * RT-268 / RT-354: a scope change is a context transition, never a filter
 * click. Unsaved work is confirmed first (Stay / Discard), then the server
 * switch runs and the context re-fetches (no optimistic update). The scope
 * switcher and the Ctrl K navigator (RT-969) share this one path, so neither
 * can change scope silently.
 *
 * `storeId` null means All stores. Choosing the current scope changes nothing.
 */
export function useScopeChange(): (storeId: string | null) => Promise<void> {
  const { context, switchStore, clearStore } = useActiveContextValue();
  const guard = useDirtyGuard();
  const currentStoreId = context?.active_store?.id ?? null;
  return useCallback(
    async (storeId: string | null) => {
      if (storeId === currentStoreId) return;
      if (!(await guard.confirmLeave())) return;
      await (storeId === null ? clearStore() : switchStore(storeId));
    },
    [currentStoreId, guard, switchStore, clearStore],
  );
}
