/**
 * RT-1530 (RT-1484 follow-up of #749 review finding m4) — the `publicationStatus` of a published
 * Price Change Set, computed at read time from the Stores' CURRENT time zones (spec 042 §3: "the
 * earliest exact per-Store activation instant of its events and memberships, computed at read time
 * from each targeted Store's zone").
 *
 * The status is `scheduled` until the earliest activation instant over the set's targeted Stores,
 * `active` from then on. It is display only: the resolver reads the published events, never this.
 *
 * Inputs, all read on the caller's client inside its tenant transaction (RLS) with an explicit
 * `tenant_id` predicate:
 *   - the set's published lines and their stored per-Store preview rows. A published set's events
 *     are exactly its lines, and the preview rows name each (Store, line) the publish reached, so
 *     they are the per-Store enumeration of the events (a Book or Zone event has no Store of its
 *     own). A `store_local` line keeps its wall-clock start (`effective_from_local`); an `absolute`
 *     line keeps its instant;
 *   - the set's Zone-membership changes (a Zone move is `absolute`: its instant has no zone);
 *   - the live `stores.timezone` (`liveAndNamedStores`, the Stores module's port).
 *
 * Rules:
 *   - `absolute` row: the stored instant. `store_local` row: the line's wall clock read in the
 *     Store's live zone (`localWallClockToInstant`, the resolver's Q-2 DST rule).
 *   - A `zone` line also waits for the Store's membership to start. Validation stored the later of
 *     the line's start and the membership's start; when that exceeded the line's start in the zone
 *     the Store had at validation (`price_change_set_validations.target_stores`), the membership
 *     start was binding and stays a floor under the live-zone instant. Otherwise the membership
 *     had started already and does not bind.
 *   - A Store that is not live (deleted, or deactivated once `liveAndNamedStores` says so, RT-1531)
 *     is dropped: a revision fans out to live Stores only, so the set can no longer reach it, and
 *     it has no live zone to read. If no row is left there is nothing left to wait for, so the set
 *     reads `active` (the same as a set with no stored instants).
 *   - A zone the runtime cannot read keeps the stored instant instead of failing the read.
 *
 * Staleness rule 3 (`price-change-set-staleness.ts`) keeps using the stored instants: it judges a
 * VALIDATED set whose zones are pinned by `targetStoreSetHash`.
 */
import type { PoolClient } from "pg";

import { liveAndNamedStores } from "../../stores";
import { LOCAL_TEXT, wallClock } from "../inquiry/price-inquiry.repository";
import { localWallClockToInstant } from "../resolution/store-local-time";

type Queryable = Pick<PoolClient, "query">;

export type PublicationStatus = "scheduled" | "active";

/** A published set to compute the status of: its id and the version its lines were validated at. */
export interface PublishedSetRef {
  readonly id: string;
  readonly version: number;
}

/** One distinct (set, Store, line start) of a published set's stored preview. */
export interface ActivationRow {
  readonly setId: string;
  readonly storeId: string;
  readonly timeBasis: "absolute" | "store_local";
  /** The line's scope; null for a Zone-membership change. */
  readonly scope: "book" | "zone" | "store" | null;
  /** The line's wall-clock start (`store_local` only), UTC fields = the local date-time. */
  readonly wall: Date | null;
  /** The instant validation stored for this Store. */
  readonly storedMs: number;
}

/** The activation instant (ms) of one row, in `liveZone` (the Store's zone now). */
export function activationMs(row: ActivationRow, liveZone: string, validatedZone: string | undefined): number {
  if (row.timeBasis === "absolute" || row.wall === null) return row.storedMs;
  try {
    const live = localWallClockToInstant(row.wall, liveZone).getTime();
    if (row.scope !== "zone" || validatedZone === undefined) return live;
    // A membership start that was binding at validation stays a floor.
    const validated = localWallClockToInstant(row.wall, validatedZone).getTime();
    return row.storedMs > validated ? Math.max(live, row.storedMs) : live;
  } catch (err) {
    if (err instanceof RangeError) return row.storedMs;
    throw err;
  }
}

/** `scheduled` until `earliestMs`, then `active`; with no instant left there is nothing to wait for. */
export function statusAt(earliestMs: number | null, nowMs: number): PublicationStatus {
  return earliestMs === null || earliestMs <= nowMs ? "active" : "scheduled";
}

interface RawRow {
  set_id: string;
  store_id: string;
  time_basis: "absolute" | "store_local";
  scope: "book" | "zone" | "store" | null;
  wall: string | null;
  stored_at: Date;
}

/** The (set, Store, start) rows of the sets' stored preview rows and membership changes. */
async function activationRows(client: Queryable, tenantId: string, sets: readonly PublishedSetRef[]): Promise<ActivationRow[]> {
  const ids = sets.map((s) => s.id);
  const versions = sets.map((s) => s.version);
  const r = await client.query<RawRow>(
    `SELECT s.id::text AS set_id, p.store_id::text AS store_id, l.time_basis, l.scope,
            ${LOCAL_TEXT("l.effective_from_local")} AS wall, p.effective_from AS stored_at
       FROM unnest($2::uuid[], $3::int[]) AS s(id, version)
       JOIN price_change_set_preview_lines p
         ON p.tenant_id = $1::uuid AND p.change_set_id = s.id AND p.change_set_version = s.version
       JOIN price_change_set_lines l
         ON l.tenant_id = p.tenant_id AND l.change_set_id = p.change_set_id
        AND l.change_set_version = p.change_set_version AND l.line_no = p.line_no
     UNION
     SELECT s.id::text, m.store_id::text, 'absolute', NULL, NULL, m.effective_from
       FROM unnest($2::uuid[], $3::int[]) AS s(id, version)
       JOIN price_change_set_preview_memberships m
         ON m.tenant_id = $1::uuid AND m.change_set_id = s.id AND m.change_set_version = s.version`,
    [tenantId, ids, versions],
  );
  return r.rows.map((x) => ({
    setId: x.set_id,
    storeId: x.store_id,
    timeBasis: x.time_basis,
    scope: x.scope,
    wall: wallClock(x.wall),
    storedMs: x.stored_at.getTime(),
  }));
}

/** The zone each Store had when the sets were validated: `setId` then `storeId` to IANA name. */
async function validatedZones(client: Queryable, tenantId: string, sets: readonly PublishedSetRef[]): Promise<Map<string, string>> {
  const r = await client.query<{ set_id: string; store_id: string; timezone: string }>(
    `SELECT s.id::text AS set_id, t.elem ->> 'storeId' AS store_id, t.elem ->> 'timezone' AS timezone
       FROM unnest($2::uuid[], $3::int[]) AS s(id, version)
       JOIN price_change_set_validations v
         ON v.tenant_id = $1::uuid AND v.change_set_id = s.id AND v.change_set_version = s.version
      CROSS JOIN LATERAL jsonb_array_elements(v.target_stores) AS t(elem)`,
    [tenantId, sets.map((s) => s.id), sets.map((s) => s.version)],
  );
  return new Map(r.rows.map((z) => [`${z.set_id}|${z.store_id}`, z.timezone] as const));
}

/**
 * The `publicationStatus` of each published set in `sets` at `nowMs`, from the live Store zones.
 * A set absent from the result is not in `sets`.
 */
export async function publicationStatuses(
  client: Queryable,
  tenantId: string,
  nowMs: number,
  sets: readonly PublishedSetRef[],
): Promise<Map<string, PublicationStatus>> {
  const out = new Map<string, PublicationStatus>();
  if (sets.length === 0) return out;
  const rows = await activationRows(client, tenantId, sets);
  const liveZones = new Map((await liveAndNamedStores(client, tenantId, [])).filter((s) => s.live).map((s) => [s.id, s.timezone] as const));
  const needsFloor = rows.some((x) => x.timeBasis === "store_local" && x.scope === "zone" && liveZones.has(x.storeId));
  const zonesThen = needsFloor ? await validatedZones(client, tenantId, sets) : new Map<string, string>();
  const earliest = new Map<string, number>();
  for (const row of rows) {
    const liveZone = liveZones.get(row.storeId);
    if (liveZone === undefined) continue;
    const at = activationMs(row, liveZone, zonesThen.get(`${row.setId}|${row.storeId}`));
    const known = earliest.get(row.setId);
    if (known === undefined || at < known) earliest.set(row.setId, at);
  }
  for (const s of sets) out.set(s.id, statusAt(earliest.get(s.id) ?? null, nowMs));
  return out;
}
