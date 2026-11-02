/**
 * RT-1070 people directory, data part. One query per batch of at most 200 ids,
 * keyed by tenant (a tenant switch drops every cached name). A failed lookup
 * (any status, a thrown fetch) leaves the query in its error state, so it is
 * retried on the next mount, but it is never surfaced to the operator: no names
 * resolve and the caller falls back to the id (no banner, no retry storm).
 */
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { consoleListPeopleNames } from "@/lib/people-queries";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { chunkPeopleIds, normalizePeopleIds, usableName } from "./peopleDirectory";

export const peopleQueryKeys = {
  batch: (tenantId: string | null, ids: readonly string[]) =>
    ["people-names", tenantId, ids] as const,
};

class PeopleLookupFailed extends Error {}

/** A failed lookup throws: it stays in the query error state (never cached as fresh data). */
async function fetchBatch(ids: string[]): Promise<Record<string, string | null>> {
  const { status, data } = await consoleListPeopleNames(ids);
  if (status !== 200 || !data) throw new PeopleLookupFailed(`people lookup ${status}`);
  const names: Record<string, string | null> = {};
  for (const item of data.items) names[item.user_id.toLowerCase()] = usableName(item.display_name);
  return names;
}

/** Lower-cased user id → display name, only for ids that resolved to a name. */
export function usePeopleNames(
  ids: readonly (string | null | undefined)[],
): ReadonlyMap<string, string> {
  const { context } = useActiveContextValue();
  const tenantId = context?.active_tenant?.id ?? null;
  const key = normalizePeopleIds(ids).join(",");
  const batches = useMemo(() => chunkPeopleIds(key ? key.split(",") : []), [key]);
  const results = useQueries({
    queries: batches.map((batch) => ({
      queryKey: peopleQueryKeys.batch(tenantId, batch),
      queryFn: () => fetchBatch(batch),
      enabled: tenantId !== null,
      retry: false,
      staleTime: 5 * 60_000,
    })),
  });
  const map = new Map<string, string>();
  for (const r of results) {
    for (const [id, name] of Object.entries(r.data ?? {})) if (name) map.set(id, name);
  }
  return map;
}
