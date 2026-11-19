/**
 * RT-1312 query hooks for the sale quarantine queue: the keyset-paged list, one item, and the one
 * guarded write (write-off). Every read takes an `enabled` gate: a role the API refuses requests
 * nothing. Keys carry the active tenant and store, so a scope change never shows another scope's
 * rows. Errors are typed, never raw. No read retries on its own and the write-off is sent once per
 * confirmation: never auto-retried, no bulk close.
 */
import {
  type QuarantineListQuery,
  type QuarantinedSale,
  type QuarantinedSalePage,
  consoleGetQuarantinedSale,
  consoleListQuarantinedSales,
  consoleWriteOffQuarantinedSale,
} from "@/lib/sale-quarantine-queries";
import { KeyedAttempt } from "@/lib/write-outcome";
import {
  FIRST_PAGE,
  type PagedState,
  type ReadState,
  dataOrThrow,
  pagedState,
  readState,
} from "@/sale-sync/useSaleSync";
import type { SaleScope } from "@/sales/useSales";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  type WriteOffOutcome,
  classifyWriteOff,
  keepsKey,
  nextQuarantineCursor,
} from "./quarantineLogic";

type ScopeKey = Pick<SaleScope, "tenantId" | "activeStoreId">;

export interface QuarantineQueue {
  scope: SaleScope;
  /** The store filter ("" = all stores). */
  storeId: string;
  /** The state filter ("" = the open queue). */
  state: string;
  /** False for a malformed filter: nothing is requested. */
  enabled: boolean;
}

export interface QuarantineTarget {
  scope: SaleScope;
  quarantineRef: string;
  /** False for a malformed reference: nothing is requested. */
  enabled: boolean;
}

const quarantineQueryKeys = {
  all: (scope: ScopeKey) => ["sale-quarantine", scope.tenantId, scope.activeStoreId] as const,
  list: ({ scope, storeId, state }: Pick<QuarantineQueue, "scope" | "storeId" | "state">) =>
    [...quarantineQueryKeys.all(scope), "list", storeId, state] as const,
  item: ({ scope, quarantineRef }: Pick<QuarantineTarget, "scope" | "quarantineRef">) =>
    [...quarantineQueryKeys.all(scope), "item", quarantineRef] as const,
};

/** The list query: the filters when set, and the cursor after page 1. */
function pageQuery(
  { storeId, state }: QuarantineQueue,
  cursor: string | undefined,
): QuarantineListQuery {
  return {
    ...(storeId ? { store_id: storeId } : {}),
    ...(state ? { state: state as NonNullable<QuarantineListQuery["state"]> } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export function useQuarantineList(queue: QuarantineQueue): PagedState<QuarantinedSale> {
  return pagedState(
    useInfiniteQuery({
      queryKey: quarantineQueryKeys.list(queue),
      enabled: queue.enabled && Boolean(queue.scope.tenantId),
      initialPageParam: FIRST_PAGE,
      queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
        consoleListQuarantinedSales(pageQuery(queue, pageParam)).then(
          dataOrThrow<QuarantinedSalePage>,
        ),
      getNextPageParam: nextQuarantineCursor,
      retry: false,
    }),
  );
}

export function useQuarantinedSale(target: QuarantineTarget): ReadState<QuarantinedSale> {
  return readState(
    useQuery({
      queryKey: quarantineQueryKeys.item(target),
      enabled: target.enabled && Boolean(target.scope.tenantId),
      queryFn: () => consoleGetQuarantinedSale(target.quarantineRef).then(dataOrThrow),
      retry: false,
    }),
  );
}

// --- Write-off (the one write) ------------------------------------------------------------

export interface WriteOffState {
  note: string;
  setNote: (note: string) => void;
  pending: boolean;
  outcome?: WriteOffOutcome;
  /** Sends one write-off with the note as entered. Called only from the operator's confirmation. */
  commit: () => Promise<void>;
}

/** An outcome after which nothing more can be sent from the dialog. */
export function isFinishedOutcome(outcome: WriteOffOutcome | undefined): boolean {
  return (
    outcome?.kind === "written-off" || outcome?.kind === "conflict" || outcome?.kind === "not-found"
  );
}

export function useWriteOff(target: Omit<QuarantineTarget, "enabled">): WriteOffState {
  const queryClient = useQueryClient();
  const attempt = useRef(new KeyedAttempt());
  const busy = useRef(false);
  const [note, setNoteState] = useState("");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<WriteOffOutcome | undefined>(undefined);

  const setNote = (next: string) => {
    setNoteState(next);
    // An answer about the previous note no longer describes this form.
    setOutcome((o) => (isFinishedOutcome(o) ? o : undefined));
  };

  const commit = async () => {
    // A ref, not state: a second click before the re-render must not send twice.
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setOutcome(undefined);
    const sent = note.trim();
    // The key follows the note: the same key with a different note is a 409, so an edited note
    // starts a new attempt. A retry of the same note replays the stored answer.
    const key = attempt.current.keyFor(`${target.quarantineRef}|${sent}`);
    let next: WriteOffOutcome;
    try {
      next = classifyWriteOff(
        await consoleWriteOffQuarantinedSale(target.quarantineRef, sent, key),
      );
    } catch {
      // No response at all: the server may or may not have acted.
      next = classifyWriteOff({ status: 0 });
    }
    if (!keepsKey(next)) attempt.current.settle();
    if (next.kind === "written-off") {
      queryClient.setQueryData<QuarantinedSale>(quarantineQueryKeys.item(target), next.item);
    } else if (
      next.kind === "conflict" ||
      next.kind === "unconfirmed" ||
      next.kind === "not-found"
    ) {
      // The item may no longer be open or reachable: read it again so the page shows the server's state.
      void queryClient.invalidateQueries({ queryKey: quarantineQueryKeys.item(target) });
    }
    if (next.kind === "written-off" || next.kind === "conflict") {
      void queryClient.invalidateQueries({
        queryKey: [...quarantineQueryKeys.all(target.scope), "list"],
      });
    }
    setOutcome(next);
    setPending(false);
    busy.current = false;
  };

  return { note, setNote, pending, outcome, commit };
}
