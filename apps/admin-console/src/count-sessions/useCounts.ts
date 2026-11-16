import {
  type InventoryScope,
  type PagedState,
  type ReadState,
  useInventoryPages,
  useInventoryRead,
} from "@/inventory/useInventory";
/**
 * RT-1425 query and mutation hooks for the Count Session screens. Reads reuse the
 * inventory read-state plumbing (typed errors, keyset paging, no self-retry, a
 * 429 carrying the server's wait). Keys carry the active tenant and store, so a
 * scope change never shows another scope's rows.
 *
 * Writes go through one `run` that returns a classified outcome and never
 * throws: a missing response is `failed` (the result is unknown, so the caller
 * keeps its Idempotency-Key). A recorded write invalidates every count read, so
 * what is on screen is the server's state, never an optimistic guess.
 */
import { consoleGetCatalogProduct } from "@/lib/catalog-queries";
import {
  type CountLateEventFinding,
  type CountLateEventFindingList,
  type CountSession,
  type CountSessionList,
  type CountSessionState,
  type CountVarianceLine,
  type CountVarianceLineList,
  getCountSession,
  listCountLateEventFindings,
  listCountSessions,
  listCountVarianceLines,
} from "@/lib/count-session-queries";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { type CountOutcome, classifyCountResult } from "./countLogic";

interface Target {
  scope: InventoryScope;
  storeId: string;
}

interface SessionTarget extends Target {
  sessionId: string;
}

const base = ({ scope }: Target) => ["counts", scope.tenantId, scope.activeStoreId] as const;

const countQueryKeys = {
  sessions: (t: Target, state: string) => [...base(t), "sessions", t.storeId, state] as const,
  session: (t: SessionTarget) => [...base(t), "session", t.storeId, t.sessionId] as const,
  lines: (t: SessionTarget) => [...base(t), "lines", t.storeId, t.sessionId] as const,
  late: (t: SessionTarget) => [...base(t), "late", t.storeId, t.sessionId] as const,
};

export function useCountSessions(
  target: Target,
  state: CountSessionState | "",
): PagedState<CountSession> {
  return useInventoryPages<CountSession, CountSessionList>({
    queryKey: countQueryKeys.sessions(target, state),
    scope: target.scope,
    fetchPage: (query) => listCountSessions(target.storeId, state ? { ...query, state } : query),
  });
}

export function useCountSession(target: SessionTarget): ReadState<CountSession> {
  return useInventoryRead({
    queryKey: countQueryKeys.session(target),
    scope: target.scope,
    load: () => getCountSession(target.storeId, target.sessionId),
  });
}

export interface AllLines extends PagedState<CountVarianceLine> {
  /** Every page is loaded: approval is only possible then. */
  complete: boolean;
}

/**
 * The review lines, every page. Approval must acknowledge every flagged line, so
 * the pages are walked to the end on their own; a failed page stops the walk and
 * keeps the loaded lines, and `complete` stays false.
 */
export function useAllVarianceLines(target: SessionTarget): AllLines {
  const lines = useInventoryPages<CountVarianceLine, CountVarianceLineList>({
    queryKey: countQueryKeys.lines(target),
    scope: target.scope,
    fetchPage: (query) => listCountVarianceLines(target.storeId, target.sessionId, query),
  });
  const { hasMore, isFetching, loadMore, error, inlineError } = lines;
  useEffect(() => {
    if (hasMore && !isFetching && !error && !inlineError) loadMore();
  }, [hasMore, isFetching, error, inlineError, loadMore]);
  const complete = !lines.isLoading && !error && !inlineError && !hasMore;
  return { ...lines, complete };
}

export function useLateFindings(target: SessionTarget): PagedState<CountLateEventFinding> {
  return useInventoryPages<CountLateEventFinding, CountLateEventFindingList>({
    queryKey: countQueryKeys.late(target),
    scope: target.scope,
    fetchPage: (query) => listCountLateEventFindings(target.storeId, target.sessionId, query),
  });
}

/** Product id -> catalog name for the ids given (an unresolved id falls back to the id). */
export function useProductNames(
  scope: InventoryScope,
  ids: readonly string[],
): ReadonlyMap<string, string> {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["count-products", scope.tenantId, "name", id],
      enabled: Boolean(scope.tenantId),
      retry: false,
      staleTime: 5 * 60_000,
      queryFn: async () => {
        const res = await consoleGetCatalogProduct(id);
        if (res.status !== 200 || !res.data) throw new Error("product name");
        return res.data.summary.name;
      },
    })),
  });
  const names = new Map<string, string>();
  results.forEach((r, i) => {
    if (r.data) names.set(ids[i], r.data);
  });
  return names;
}

type Sent<D> = { status: number; data?: D; error?: unknown; retryAfter?: number };

/** One write at a time per screen: `run` sends it and returns the classified outcome. */
export function useCountCommand() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (send: () => Promise<Sent<unknown>>): Promise<CountOutcome> =>
      classifyCountResult(await send()),
    onSuccess: (outcome) => {
      if (outcome.kind === "ok") void qc.invalidateQueries({ queryKey: ["counts"] });
    },
  });
  const run = async <D>(send: () => Promise<Sent<D>>): Promise<CountOutcome<D>> => {
    try {
      return (await mutation.mutateAsync(send)) as CountOutcome<D>;
    } catch {
      return { kind: "failed" };
    }
  };
  return { run, isPending: mutation.isPending };
}
