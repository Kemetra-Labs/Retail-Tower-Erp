/**
 * RT-1530 (RT-1484 follow-up of #749 review finding m4) — the `publicationStatus` of a published
 * Price Change Set, computed at read time from the Stores' CURRENT time zones (spec 042 §3: "the
 * earliest exact per-Store activation instant of its events and memberships, computed at read time
 * from each targeted Store's zone").
 *
 * The status is `scheduled` until the earliest activation instant over the set's targeted Stores,
 * `active` from then on. It is display only: the resolver reads the published events, never this.
 * "Now" is the service clock (`PriceChangeSetsService.clock`), not the database's `now()`.
 *
 * Inputs, all read on the caller's client inside its tenant transaction (RLS) with an explicit
 * `tenant_id` predicate, one batched statement each for the whole page of sets:
 *   - the set's published lines and their stored per-Store preview rows, grouped in SQL. A published
 *     set's events are exactly its lines, and the preview rows name each (Store, line) the publish
 *     reached, so they are the per-Store enumeration of the events (a Book or Zone event has no
 *     Store of its own). A `store_local` line keeps its wall-clock start (`effective_from_local`);
 *     an `absolute` line keeps its instant;
 *   - the set's Zone-membership changes (a Zone move is `absolute`: its instant has no zone);
 *   - the Stores' live `stores.timezone` and liveness (`liveAndNamedStores`, the Stores module's
 *     port, so RT-1531's definition of a live Store applies without a change here);
 *   - for a `zone` line only, the Store's memberships in that Zone.
 *
 * Rules:
 *   - `absolute` rows and Zone moves: the stored instant. Zone free, so Store liveness does not
 *     matter and the set's minimum is taken in SQL.
 *   - `store_local` row of a live Store: the line's wall clock read in the Store's live zone
 *     (`localWallClockToInstant`, the resolver's Q-2 DST rule). A zone the runtime cannot read keeps
 *     the stored instant instead of failing the read.
 *   - A `zone` line also waits for the Store's membership in that Zone (m1): the Store activates at
 *     the earliest `max(live line start, membership start)` over its memberships in the Zone that
 *     ended after the live line start, as they were visible when the set published (published
 *     before its revision, not ended before it). That is validation's rule (`zoneReach`) with the
 *     live zone. The Book's default Zone is the exception: a Store with no membership falls back to
 *     it, so it has no start to wait for and the line start applies (v1 approximation; validation
 *     also computes the first uncovered instant).
 *   - The Store set is fixed at validation (m3): a Store created after publish is not added to a
 *     published set (the bootstrap row of spec 041 data-model §2.6 is not a line of the set), and a
 *     Store that is not live (deleted, or deactivated once `liveAndNamedStores` says so, RT-1531)
 *     keeps its STORED instant. So a set never turns from `active` back to `scheduled` because a
 *     Store was deleted, and never reads `active` when nothing took effect. A set with no stored
 *     instant at all reads `active`.
 *
 * Staleness rule 3 (`price-change-set-staleness.ts`) keeps using the stored instants: it judges a
 * VALIDATED set whose zones `targetStoreSetHash` pins.
 */
import type { PoolClient } from "pg";

import { liveAndNamedStores } from "../../stores";
import { LOCAL_TEXT } from "../inquiry/price-inquiry.repository";
import { localWallClockToInstant } from "../resolution/store-local-time";

type Queryable = Pick<PoolClient, "query">;

export type PublicationStatus = "scheduled" | "active";

/** A published set to compute the status of: its id, the version its lines were validated at and its revision. */
export interface PublishedSetRef {
  readonly id: string;
  readonly version: number;
  readonly revisionNo: number;
}

/** The distinct `store_local` starts of one (set, Store, line target), with the earliest stored instant. */
export interface LocalGroup {
  readonly setId: string;
  readonly storeId: string;
  readonly scope: "book" | "zone" | "store";
  readonly zoneId: string | null;
  readonly zoneIsDefault: boolean;
  /** The line's wall-clock start, UTC fields = the local date-time. */
  readonly wall: Date;
  /** The earliest instant validation stored for this group. */
  readonly storedMs: number;
}

/** A Store's membership in a Zone, as the set saw it. */
export interface MembershipSpan {
  readonly fromMs: number;
  readonly toMs: number | null;
}

/**
 * The activation instant (ms) of one group. `liveZone` is the Store's zone now, undefined when the
 * Store is not live (the stored instant stands); `spans` are its memberships in the line's Zone.
 */
export function activationMs(group: LocalGroup, liveZone: string | undefined, spans: readonly MembershipSpan[]): number {
  if (liveZone === undefined) return group.storedMs;
  let line: number;
  try {
    line = localWallClockToInstant(group.wall, liveZone).getTime();
  } catch (err) {
    if (err instanceof RangeError) return group.storedMs;
    throw err;
  }
  if (group.scope !== "zone" || group.zoneIsDefault) return line;
  const starts = spans.filter((s) => s.toMs === null || s.toMs > line).map((s) => Math.max(line, s.fromMs));
  return starts.length === 0 ? line : Math.min(...starts);
}

/** `scheduled` until `earliestMs`, then `active`; with no instant there is nothing to wait for. */
export function statusAt(earliestMs: number | null, nowMs: number): PublicationStatus {
  return earliestMs === null || earliestMs <= nowMs ? "active" : "scheduled";
}

/** The `store_local` groups and each set's earliest absolute instant (preview rows and Zone moves). */
async function loadActivations(
  client: Queryable,
  tenantId: string,
  sets: readonly PublishedSetRef[],
): Promise<{ groups: LocalGroup[]; absolute: Map<string, number> }> {
  const args = [tenantId, sets.map((s) => s.id), sets.map((s) => s.version)];
  const local = await client.query<{
    set_id: string;
    store_id: string;
    scope: LocalGroup["scope"];
    zone_id: string | null;
    zone_is_default: boolean;
    wall: string;
    stored_at: Date;
  }>(
    `SELECT s.id::text AS set_id, p.store_id::text AS store_id, l.scope, l.price_zone_id::text AS zone_id,
            COALESCE(z.is_default, false) AS zone_is_default,
            ${LOCAL_TEXT("l.effective_from_local")} AS wall, min(p.effective_from) AS stored_at
       FROM unnest($2::uuid[], $3::int[]) AS s(id, version)
       JOIN price_change_set_preview_lines p
         ON p.tenant_id = $1::uuid AND p.change_set_id = s.id AND p.change_set_version = s.version
       JOIN price_change_set_lines l
         ON l.tenant_id = p.tenant_id AND l.change_set_id = p.change_set_id
        AND l.change_set_version = p.change_set_version AND l.line_no = p.line_no AND l.time_basis = 'store_local'
       LEFT JOIN price_zones z ON z.tenant_id = l.tenant_id AND z.id = l.price_zone_id
      GROUP BY s.id, p.store_id, l.scope, l.price_zone_id, z.is_default, l.effective_from_local`,
    args,
  );
  const abs = await client.query<{ set_id: string; at: Date }>(
    `SELECT s.id::text AS set_id, min(p.effective_from) AS at
       FROM unnest($2::uuid[], $3::int[]) AS s(id, version)
       JOIN price_change_set_preview_lines p
         ON p.tenant_id = $1::uuid AND p.change_set_id = s.id AND p.change_set_version = s.version
       JOIN price_change_set_lines l
         ON l.tenant_id = p.tenant_id AND l.change_set_id = p.change_set_id
        AND l.change_set_version = p.change_set_version AND l.line_no = p.line_no AND l.time_basis = 'absolute'
      GROUP BY s.id
     UNION ALL
     SELECT s.id::text, min(m.effective_from)
       FROM unnest($2::uuid[], $3::int[]) AS s(id, version)
       JOIN price_change_set_preview_memberships m
         ON m.tenant_id = $1::uuid AND m.change_set_id = s.id AND m.change_set_version = s.version
      GROUP BY s.id`,
    args,
  );
  const absolute = new Map<string, number>();
  for (const a of abs.rows) {
    const at = a.at.getTime();
    const known = absolute.get(a.set_id);
    if (known === undefined || at < known) absolute.set(a.set_id, at);
  }
  return {
    groups: local.rows.map((x) => ({
      setId: x.set_id,
      storeId: x.store_id,
      scope: x.scope,
      zoneId: x.zone_id,
      zoneIsDefault: x.zone_is_default,
      wall: new Date(`${x.wall}Z`),
      storedMs: x.stored_at.getTime(),
    })),
    absolute,
  };
}

/** Each Store's memberships in the given Zones as `storeId|zoneId` to spans, with the revisions that bound them. */
async function loadMemberships(
  client: Queryable,
  tenantId: string,
  storeIds: readonly string[],
  zoneIds: readonly string[],
): Promise<Map<string, { span: MembershipSpan; published: number; ended: number | null }[]>> {
  const r = await client.query<{
    store_id: string;
    price_zone_id: string;
    effective_from: Date;
    effective_to: Date | null;
    published: string;
    ended: string | null;
  }>(
    `SELECT m.store_id::text AS store_id, m.price_zone_id::text AS price_zone_id, m.effective_from, m.effective_to,
            m.published_in_revision::text AS published, m.ended_in_revision::text AS ended
       FROM price_zone_memberships m
      WHERE m.tenant_id = $1::uuid AND m.price_zone_id = ANY($3::uuid[]) AND m.store_id = ANY($2::uuid[])`,
    [tenantId, storeIds, zoneIds],
  );
  const out = new Map<string, { span: MembershipSpan; published: number; ended: number | null }[]>();
  for (const m of r.rows) {
    const key = `${m.store_id}|${m.price_zone_id}`;
    const list = out.get(key) ?? [];
    list.push({
      span: { fromMs: m.effective_from.getTime(), toMs: m.effective_to === null ? null : m.effective_to.getTime() },
      published: Number(m.published),
      ended: m.ended === null ? null : Number(m.ended),
    });
    out.set(key, list);
  }
  return out;
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
  const { groups, absolute } = await loadActivations(client, tenantId, sets);
  const revisionOf = new Map(sets.map((s) => [s.id, s.revisionNo] as const));
  const storeIds = [...new Set(groups.map((g) => g.storeId))];
  const stores = new Map(
    storeIds.length === 0 ? [] : (await liveAndNamedStores(client, tenantId, storeIds)).map((s) => [s.id, s] as const),
  );
  const zoned = groups.filter((g) => g.scope === "zone" && !g.zoneIsDefault && stores.get(g.storeId)?.live === true);
  const zoneIds = [...new Set(zoned.flatMap((g) => (g.zoneId === null ? [] : [g.zoneId])))];
  const memberships =
    zoned.length === 0
      ? new Map<string, { span: MembershipSpan; published: number; ended: number | null }[]>()
      : await loadMemberships(client, tenantId, [...new Set(zoned.map((g) => g.storeId))], zoneIds);
  const earliest = new Map(absolute);
  for (const g of groups) {
    const store = stores.get(g.storeId);
    const revision = revisionOf.get(g.setId) ?? Number.MAX_SAFE_INTEGER;
    const spans = (memberships.get(`${g.storeId}|${g.zoneId}`) ?? [])
      .filter((m) => m.published < revision && (m.ended === null || m.ended >= revision))
      .map((m) => m.span);
    const at = activationMs(g, store?.live === true ? store.timezone : undefined, spans);
    const known = earliest.get(g.setId);
    if (known === undefined || at < known) earliest.set(g.setId, at);
  }
  for (const s of sets) out.set(s.id, statusAt(earliest.get(s.id) ?? null, nowMs));
  return out;
}
