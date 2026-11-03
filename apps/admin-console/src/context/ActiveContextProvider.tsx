/**
 * SF-3 provider. Exposes the read-only active-context projection to every
 * downstream surface (SF-1 auto-select branching, SF-2 indicator/chooser).
 * The actual query + mutators live in useActiveContext; this just shares one
 * instance through React context so the whole shell reads one source of truth.
 */
import { queryKeys } from "@/lib/query";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useLayoutEffect, useState } from "react";
import { type ActiveContextValue, useActiveContext } from "./useActiveContext";

const ActiveContext = createContext<ActiveContextValue | null>(null);

/**
 * RT-1077: the session was replaced without a sign-out (A's session expired,
 * then B signed in on the same tab). The authenticated principal is the user id
 * of the server-resolved context; a different one than the cache was filled
 * under means every cached read belongs to someone else. An explicit sign-out
 * already clears the client (useSignOut); this covers the path that has none.
 *
 * The remembered principal survives a signed-out (`session-lost`) context, so A
 * returning keeps the cache (no flash, no refetch) while B drops it. The
 * context query itself stays: it just resolved to B and is the source of truth.
 * Tenant switches are not a replacement (same user), nor is a role change.
 */
function useSessionReplacement(principal: string | null): boolean {
  const qc = useQueryClient();
  const [filledUnder, setFilledUnder] = useState<string | null>(null);
  const replaced = principal !== null && filledUnder !== null && principal !== filledUnder;

  // Before paint, so no data screen of the old principal is ever shown to the new one.
  useLayoutEffect(() => {
    if (principal === null || principal === filledUnder) return;
    if (filledUnder !== null) {
      void qc.cancelQueries({ predicate: (q) => !isActiveContextKey(q.queryKey) });
      qc.removeQueries({ predicate: (q) => !isActiveContextKey(q.queryKey) });
    }
    setFilledUnder(principal);
  }, [principal, filledUnder, qc]);

  return replaced;
}

function isActiveContextKey(key: readonly unknown[]): boolean {
  return key.length === queryKeys.activeContext.length && key[0] === queryKeys.activeContext[0];
}

export function ActiveContextProvider({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const value = useActiveContext();
  const replaced = useSessionReplacement(value.context?.user?.id ?? null);
  // While the old principal's cache is being dropped, mount no data screen.
  return (
    <ActiveContext.Provider value={value}>{replaced ? null : children}</ActiveContext.Provider>
  );
}

export function useActiveContextValue(): ActiveContextValue {
  const value = useContext(ActiveContext);
  if (!value) {
    throw new Error("useActiveContextValue must be used within <ActiveContextProvider>");
  }
  return value;
}
