/**
 * RT-1329: the reads and writes behind the "POS pilot" page.
 *
 * The two platform reads (RT-1328) are never retried on a 429: the page says it
 * once, claims that 429 (RT-931) and offers one gated retry, as the tenant
 * directory does. Tenant names come from that same directory read
 * (`useTenantDirectory`); there is no second `listTenants` call.
 *
 * A write is sent once (the query client never retries a mutation). After any
 * answer that may have changed something, both lists are read again, so the
 * tables show the server's state, never an optimistic guess. A 429 or 403 wrote
 * nothing, and re-reading into a running Retry-After would only spend more of
 * the same budget, so those leave the lists as they are.
 */
import {
  platformActivatePilotRelease,
  platformAddPilotTenant,
  platformListPilotReleases,
  platformListPilotTenants,
  platformRemovePilotTenant,
} from "@/lib/pilot-platform-queries";
import type { PilotRelease, PilotTenant } from "@/lib/pilot-platform-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tenantDirectoryKey } from "../tenants/useTenantDirectory";
import {
  type ActivateKind,
  type AddKind,
  type Outcome,
  type RemoveKind,
  activateOutcome,
  addOutcome,
  removeOutcome,
} from "./pilotLogic";

const pilotReleasesKey = ["platform", "pos-pilot", "releases"] as const;
const pilotTenantsKey = ["platform", "pos-pilot", "tenants"] as const;

/** `seq`: this 429's count on the shared clock, so the shell can skip that one (RT-931, RT-940). */
export type PilotReadError =
  | { kind: "rate-limited"; seq: number | undefined }
  | { kind: "not-permitted" }
  | { kind: "failed"; requestId?: string };

class PilotReadFailure extends Error {
  constructor(readonly detail: PilotReadError) {
    super("pos-pilot-read");
  }
}

function requestIdOf(error: unknown): string | undefined {
  return (error as { error?: { request_id?: string } } | undefined)?.error?.request_id;
}

async function readItems<T>(
  call: () => Promise<{
    status: number;
    data?: { items?: unknown };
    error?: unknown;
    rateLimitSeq?: number;
  }>,
): Promise<T[]> {
  const res = await call();
  if (res.status === 429) {
    throw new PilotReadFailure({ kind: "rate-limited", seq: res.rateLimitSeq });
  }
  if (res.status === 403) throw new PilotReadFailure({ kind: "not-permitted" });
  if (res.status >= 400) {
    throw new PilotReadFailure({ kind: "failed", requestId: requestIdOf(res.error) });
  }
  // A 200 without an `items` array is unknown, never an authoritative empty list.
  const items = res.data?.items;
  if (!Array.isArray(items)) throw new PilotReadFailure({ kind: "failed" });
  return items as T[];
}

function readErrorOf(error: Error | null): PilotReadError | undefined {
  if (!error) return undefined;
  return error instanceof PilotReadFailure ? error.detail : { kind: "failed" };
}

function usePilotList<T>(key: readonly string[], read: () => Promise<T[]>) {
  const query = useQuery<T[]>({ queryKey: key, queryFn: read, retry: false });
  return {
    items: query.data,
    isLoading: query.isLoading,
    error: readErrorOf(query.error),
    refetch: () => void query.refetch(),
  };
}

export function usePilotReleases() {
  return usePilotList<PilotRelease>(pilotReleasesKey, () =>
    readItems<PilotRelease>(platformListPilotReleases),
  );
}

export function usePilotTenants() {
  return usePilotList<PilotTenant>(pilotTenantsKey, () =>
    readItems<PilotTenant>(platformListPilotTenants),
  );
}

/** A write's outcome plus the seq of its own 429, for the page to claim. */
export type WriteOutcome<K extends string> = Outcome<K> & { seq?: number };

function useWrite<K extends string>(
  send: (id: string) => Promise<{ status: number; error?: unknown; rateLimitSeq?: number }>,
  classify: (res: { status: number; error?: unknown }) => Outcome<K>,
  refreshDirectoryOn?: K,
) {
  const qc = useQueryClient();
  const mutation = useMutation<WriteOutcome<K>, Error, string>({
    mutationFn: async (id) => {
      const res = await send(id);
      return { ...classify(res), seq: res.status === 429 ? res.rateLimitSeq : undefined };
    },
    onSettled: (outcome) => {
      if (outcome && (outcome.kind === "rateLimited" || outcome.kind === "notPermitted")) return;
      void qc.invalidateQueries({ queryKey: pilotReleasesKey });
      void qc.invalidateQueries({ queryKey: pilotTenantsKey });
      if (outcome && outcome.kind === refreshDirectoryOn) {
        void qc.invalidateQueries({ queryKey: tenantDirectoryKey });
      }
    },
  });
  /** Resolves to the outcome; a request that got no answer is `failed`. */
  const run = async (id: string): Promise<WriteOutcome<K>> => {
    try {
      return await mutation.mutateAsync(id);
    } catch {
      return { kind: "failed" as K };
    }
  };
  return { run, pending: mutation.isPending };
}

export function useActivateRelease() {
  return useWrite<ActivateKind>(platformActivatePilotRelease, activateOutcome);
}

export function useAddPilotTenant() {
  return useWrite<AddKind>(platformAddPilotTenant, addOutcome, "tenantNotFound");
}

export function useRemovePilotTenant() {
  return useWrite<RemoveKind>(platformRemovePilotTenant, removeOutcome);
}
