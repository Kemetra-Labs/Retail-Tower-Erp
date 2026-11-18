/**
 * One server read as a `Read<T>`, shared by the owner "force with impact preview" screens
 * (RT-1440 close-without-a-count, RT-1441 store deletion). Extracted from `useForceActions.ts`
 * unchanged in behaviour; the only addition is the `forbidden` kind for a 403, which the store
 * deletion preview answers to a `tenant_admin` (`store_deletion_owner_only`).
 *
 * Reads are scope-keyed by the active tenant AND role (`useReadScope`): the role decides what the
 * server returns, so a cached answer must not cross a role change. The previews are snapshots,
 * read fresh on every open (`fresh`), never reused.
 */
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { roleCodeOf } from "@/context/effectiveRole";
import { errorRequestIdOf } from "@/lib/write-outcome";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

export type ReadError = { kind: "not-available" | "forbidden" | "failed"; requestId?: string };

function readErrorOf(status: number, error: unknown): ReadError {
  const requestId = errorRequestIdOf(error);
  if (status === 404) return { kind: "not-available", requestId };
  return status === 403 ? { kind: "forbidden", requestId } : { kind: "failed", requestId };
}

/** The scope every key carries: the active tenant and the role. */
export function useReadScope(): { tenantId: string | null; role: string | null } {
  const { context } = useActiveContextValue();
  return { tenantId: context?.active_tenant?.id ?? null, role: roleCodeOf(context) };
}

/** A request that never got an answer (offline, aborted) reads as a failed read, so it can be retried. */
export const NO_ANSWER = { status: 0, data: undefined, error: undefined } as const;

export interface Read<T> {
  data: T | undefined;
  isLoading: boolean;
  /** A read (first or again) is in flight. */
  isFetching: boolean;
  error: ReadError | undefined;
  refetch: () => void;
}

/** What a read returns: the status, and the body or the error body. */
type Answer<T> = { status: number; data?: T; error?: unknown };

interface ServerRead<T> {
  queryKey: readonly unknown[];
  enabled: boolean;
  fetcher: () => Promise<Answer<T>>;
  /** Never reused: read again on every mount (a preview is a snapshot, not a cache). */
  fresh?: boolean;
}

/** One server read as a `Read<T>`: a non-200 answer, or no answer at all, is a typed `ReadError`. */
export function useServerRead<T>({
  queryKey,
  enabled,
  fetcher,
  fresh = false,
}: ServerRead<T>): Read<T> {
  const q = useQuery<T, ReadError>({
    queryKey,
    enabled,
    retry: false,
    ...(fresh ? { gcTime: 0, staleTime: 0, refetchOnWindowFocus: false } : {}),
    queryFn: async () => {
      const res: Answer<T> = await fetcher().catch(() => NO_ANSWER);
      if (res.status === 200 && res.data) return res.data;
      throw readErrorOf(res.status, res.error);
    },
  });
  return {
    data: q.data,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error ?? undefined,
    refetch: () => void q.refetch(),
  };
}

/**
 * Read once more each time `active` turns on: a blocked answer shows the server's verdict again, so
 * the preview behind it is read again, once per answer (not on every render while it stays on).
 */
export function useRefetchOnce(active: boolean, refetch: () => void): void {
  const done = useRef(false);
  useEffect(() => {
    if (active && !done.current) refetch();
    done.current = active;
  }, [active, refetch]);
}
