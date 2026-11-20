/**
 * RT-1484 PR-6 (RT-282 PR-10c) — the rollback of a published Change Set (spec 042 §8; contract
 * `consoleRollbackPriceChangeSet`, info **Rollback**). A rollback is a NEW `kind: rollback` set
 * whose items are generated here from the target's Pricing Revision R; it then runs the same
 * validate → submit → approve (four eyes: always sensitive) → publish machine, and its publish
 * writes ONE new immutable revision. Nothing is edited in place (521, 531, 534).
 *
 * What the items restore. For every price key R touched (an event R published or ended: Book,
 * Zone or Store target, product, Sell Unit) and every Store whose Zone membership R touched, the
 * timeline from the rollback instant on becomes the one visible at revision R − 1 (what R
 * superseded comes back, what R introduced ends). Per key:
 *   - `s0` is the first instant at or after `from` where the head timeline and the R − 1 timeline
 *     differ (no difference: the key needs no item). History before `s0`, so before `from`, is
 *     never rewritten: publish carries the head forward up to `s0`;
 *   - every R − 1 event of the key, clipped to `[s0, …)`, becomes a `set_price` at its price, time
 *     basis and bounds;
 *   - when the head holds a price somewhere after `s0` where R − 1 held none (R priced an empty
 *     interval), an `end_price` at `s0` ends the key first (the in-set rule "end at T, then
 *     re-price from T"), so every restored row is re-written and nothing R introduced survives.
 *   A Store's memberships after `s0` become `move_store_zone` items reproducing its R − 1 Zone
 *   timeline up to the last bound either timeline has; an interval where R − 1 had no membership
 *   is a move into the Book's default Zone, which resolves identically (the fallback, spec 041
 *   §4.2 step 4).
 *   For a `store_local` key, `from` is converted to the latest wall-clock time any of the
 *   tenant's live Stores shows at that instant (the key's own Store's for a Store target), rounded up
 *   to the second (an item's local time has seconds): no Store sees the rollback before `from`.
 *
 * Blocked (`409 rollback_blocked`). Spec 042 §8 refuses a target whose rows later revisions
 * superseded; this module refuses, fail closed, whenever a revision after R published or ended
 * any event of a key R touched or any membership of a Store R touched. That covers the spec's
 * case and also a later revision that priced an interval R had ended (restoring R − 1 there
 * would silently override it). The author rolls back newest-first or authors a corrective set.
 *
 * Every statement runs on the caller's client inside its tenant transaction (RLS, FORCE) with an
 * explicit `tenant_id` predicate. Time arithmetic is exact: bounds are epoch microseconds.
 */
import type { PoolClient } from "pg";

import { liveAndNamedStores } from "../../stores";
import type { PriceChangeItem } from "./price-change-sets.dto";
import { PriceChangeSetConflictError, PriceChangeSetRollbackBlockedError, type ChangeSetState } from "./price-change-sets.projections";

type Queryable = Pick<PoolClient, "query">;

/** The contract caps a set at 500 items, and a product selector at 5 000 ids. */
export const MAX_ROLLBACK_ITEMS = 500;
const MAX_PRODUCTS_PER_ITEM = 5000;

/** A rollback the generator cannot express exactly (a key that mixes time bases, a sub-second local bound). */
export class RollbackUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RollbackUnsupportedError";
  }
}

/** The price keys (events) and the Stores (memberships) revision `$2` published or ended. */
const TOUCHED = `
  ek AS (SELECT DISTINCT price_book_id, scope, COALESCE(price_zone_id, store_id) AS target, product_id, sell_unit, price_kind
           FROM price_events WHERE tenant_id = $1::uuid AND (published_in_revision = $2 OR ended_in_revision = $2)),
  mk AS (SELECT DISTINCT price_book_id, store_id
           FROM price_zone_memberships WHERE tenant_id = $1::uuid AND (published_in_revision = $2 OR ended_in_revision = $2))`;
const ON_KEY = `e.price_book_id = ek.price_book_id AND e.scope = ek.scope
       AND COALESCE(e.price_zone_id, e.store_id) IS NOT DISTINCT FROM ek.target
       AND e.product_id = ek.product_id AND e.sell_unit = ek.sell_unit AND e.price_kind = ek.price_kind`;

/**
 * The revisions after `revision` that published or ended a row on a key, or a membership of a
 * Store, that `revision` touched, ascending (empty: the rollback is not blocked).
 */
async function blockingRevisions(client: Queryable, tenantId: string, revision: number): Promise<number[]> {
  const r = await client.query<{ r: string }>(
    `WITH ${TOUCHED}
     SELECT DISTINCT v.r::text AS r FROM (
       SELECT x.r FROM price_events e JOIN ek ON ${ON_KEY}
              CROSS JOIN LATERAL (VALUES (e.published_in_revision), (e.ended_in_revision)) AS x(r)
        WHERE e.tenant_id = $1::uuid AND x.r > $2
       UNION
       SELECT x.r FROM price_zone_memberships m JOIN mk ON m.price_book_id = mk.price_book_id AND m.store_id = mk.store_id
              CROSS JOIN LATERAL (VALUES (m.published_in_revision), (m.ended_in_revision)) AS x(r)
        WHERE m.tenant_id = $1::uuid AND x.r > $2) v`,
    [tenantId, revision],
  );
  return r.rows.map((row) => Number(row.r)).sort((x, y) => x - y);
}

/** A rollback's target at its revision, as the rollback's audit rows name it. */
export interface RollbackTarget {
  readonly id: string;
  readonly state: ChangeSetState;
  readonly revisionNo: number;
  readonly kind: string;
  readonly version: number;
  readonly previewHash: string | null;
  readonly reasonPresent: boolean;
}

/** A rollback's target in one of `states` (never the legacy import), or null. */
async function rollbackTarget(client: Queryable, tenantId: string, id: string, states: readonly ChangeSetState[]): Promise<RollbackTarget | null> {
  const r = await client.query<{ state: ChangeSetState; revision_no: string; kind: string; version: number; preview_hash: string | null; reason_present: boolean }>(
    `SELECT state, revision_no::text AS revision_no, kind, version, preview_hash, reason IS NOT NULL AS reason_present FROM change_sets
      WHERE tenant_id = $1::uuid AND id = $2::uuid AND domain = 'pricing' AND state = ANY($3::text[]) AND kind <> 'legacy_import'
        AND revision_no IS NOT NULL`,
    [tenantId, id, [...states]],
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  return {
    id,
    state: row.state,
    revisionNo: Number(row.revision_no),
    kind: row.kind,
    version: row.version,
    previewHash: row.preview_hash,
    reasonPresent: row.reason_present,
  };
}

/**
 * The rollback's target, refused unless rollbackable (create and validate): `409 rollback_blocked`
 * when a later revision touched its keys (a `superseded` target always is: later revisions ended
 * its rows, spec 042 §8), else `409 change_set_invalid_state` unless it is `published` (not a
 * draft, rolled back or the system legacy import).
 */
export async function requireRollbackable(client: Queryable, tenantId: string, id: string): Promise<RollbackTarget> {
  const target = await rollbackTarget(client, tenantId, id, ["published", "superseded"]);
  if (target === null) throw new PriceChangeSetConflictError("change_set_invalid_state");
  const blocking = await blockingRevisions(client, tenantId, target.revisionNo);
  if (blocking.length > 0) throw new PriceChangeSetRollbackBlockedError(blocking);
  if (target.state !== "published") throw new PriceChangeSetConflictError("change_set_invalid_state");
  return target;
}

/** At publish (under the publish lock): the target while it is still `published` and unblocked, else null. */
export async function publishableRollbackTarget(client: Queryable, tenantId: string, id: string): Promise<RollbackTarget | null> {
  const target = await rollbackTarget(client, tenantId, id, ["published"]);
  if (target === null || (await blockingRevisions(client, tenantId, target.revisionNo)).length > 0) return null;
  return target;
}

/** One row of a timeline: `[from, to)` in epoch microseconds (wall clock for `store_local`), and its value. */
interface Row {
  readonly from: bigint;
  readonly to: bigint | null;
  readonly value: string;
}

const covering = (rows: readonly Row[], at: bigint): Row | undefined =>
  rows.find((r) => r.from <= at && (r.to === null || at < r.to));

/** Every bound at or after `start`, with `start`, ascending. */
function pointsFrom(start: bigint, ...timelines: (readonly Row[])[]): bigint[] {
  const all = new Set<bigint>([start]);
  for (const rows of timelines) {
    for (const r of rows) {
      if (r.from >= start) all.add(r.from);
      if (r.to !== null && r.to >= start) all.add(r.to);
    }
  }
  return [...all].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

/** The first instant at or after `start` where the two timelines hold different values (null: none). */
function firstDifference(head: readonly Row[], before: readonly Row[], start: bigint, value: (r: Row | undefined) => string | null): bigint | null {
  for (const p of pointsFrom(start, head, before)) {
    if (value(covering(head, p)) !== value(covering(before, p))) return p;
  }
  return null;
}

const floorDiv = (a: bigint, b: bigint): bigint => (a % b < 0n ? a / b - 1n : a / b);
const floorMod = (a: bigint, b: bigint): bigint => ((a % b) + b) % b;

/** Epoch microseconds as an RFC 3339 instant with six fraction digits (`…T00:00:00.000001Z`). */
export function instantText(us: bigint): string {
  const seconds = floorDiv(us, 1_000_000n);
  const base = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  return `${base}.${floorMod(us, 1_000_000n).toString().padStart(6, "0")}Z`;
}

/** Wall-clock epoch microseconds as a local date-time with seconds; a sub-second bound cannot be authored. */
export function localText(us: bigint): string {
  if (floorMod(us, 1_000_000n) !== 0n) throw new RollbackUnsupportedError("a store_local bound has a sub-second part");
  return new Date(Number(floorDiv(us, 1_000_000n)) * 1000).toISOString().slice(0, 19);
}

/** A priced key's rows, as the timeline query returns them. */
interface EventRow {
  readonly scope: "book" | "zone" | "store";
  readonly zone: string | null;
  readonly store: string | null;
  readonly product: string;
  readonly basis: "absolute" | "store_local";
  readonly price: string;
  readonly head: boolean;
  readonly prior: boolean;
  readonly f: string;
  readonly t: string | null;
}

interface MembershipRow {
  readonly store: string;
  readonly zone: string;
  readonly head: boolean;
  readonly prior: boolean;
  readonly f: string;
  readonly t: string | null;
}

/** What the generator needs: the tenant, the target revision R, the rollback instant and the Book's default Zone. */
export interface RollbackInput {
  readonly tenantId: string;
  readonly revision: number;
  /** The rollback instant (RFC 3339). */
  readonly from: string;
  readonly defaultZoneId: string;
}

/** Visible at revision R − 1 (`$2` is R): published before R, not ended before R. */
const visibleBefore = (alias: string): string =>
  `(${alias}.published_in_revision < $2 AND (${alias}.ended_in_revision IS NULL OR ${alias}.ended_in_revision >= $2))`;
const MICROS = (column: string): string => `(extract(epoch FROM ${column}) * 1000000)::bigint::text`;
/** A wall-clock value rounded up to the second (an item's local time has seconds only). */
const CEIL_SECOND = (column: string): string =>
  `(date_trunc('second', ${column}) + CASE WHEN ${column} > date_trunc('second', ${column}) THEN interval '1 second' ELSE interval '0' END)`;
const TENANT_WIDE = "*";

/**
 * `from` in epoch microseconds: the instant, the wall clock each named Store shows then, and the
 * latest wall clock any live Store of the tenant shows then (`*`; UTC when it has none), each
 * rounded up to the second. The Stores and their zones come from the stores module's port.
 */
async function fromBounds(client: Queryable, tenantId: string, from: string, named: readonly string[]): Promise<{ absolute: bigint; local: Map<string, bigint> }> {
  const stores = await liveAndNamedStores(client, tenantId, named);
  const r = await client.query<{ store: string; us: string }>(
    `WITH f AS (SELECT $1::timestamptz AS at),
          w AS (SELECT z.store, f.at AT TIME ZONE z.tz AS wall FROM unnest($2::text[], $3::text[]) AS z(store, tz) CROSS JOIN f
                UNION ALL
                SELECT NULL, f.at AT TIME ZONE 'UTC' FROM f WHERE cardinality($5::text[]) = 0),
          up AS (SELECT store, ${CEIL_SECOND("wall")} AS wall FROM w)
     SELECT store, ${MICROS("wall")} AS us FROM up WHERE store = ANY($4::text[])
     UNION ALL
     SELECT '${TENANT_WIDE}', ${MICROS("max(wall)")} FROM up WHERE store IS NULL OR store = ANY($5::text[])
     UNION ALL
     SELECT 'absolute', ${MICROS("at")} FROM f`,
    [from, stores.map((s) => s.id), stores.map((s) => s.timezone), [...named], stores.filter((s) => s.live).map((s) => s.id)],
  );
  const local = new Map<string, bigint>();
  let absolute = 0n;
  for (const row of r.rows) {
    if (row.store === "absolute") absolute = BigInt(row.us);
    else local.set(row.store, BigInt(row.us));
  }
  return { absolute, local };
}

/** The items restoring one priced key from `s0` on, or none. */
function keyItems(rows: readonly EventRow[], start: bigint): PriceChangeItem[] {
  const bases = new Set(rows.map((r) => r.basis));
  if (bases.size > 1) throw new RollbackUnsupportedError("a price key mixes time bases between the target revision and the head");
  const basis = rows[0]!.basis;
  const toRow = (e: EventRow): Row => ({ from: BigInt(e.f), to: e.t === null ? null : BigInt(e.t), value: e.price });
  const head = rows.filter((e) => e.head).map(toRow);
  const before = rows.filter((e) => e.prior).map(toRow);
  const value = (r: Row | undefined): string | null => r?.value ?? null;
  const s0 = firstDifference(head, before, start, value);
  if (s0 === null) return [];
  const needsEnd = pointsFrom(s0, head, before).some((p) => covering(head, p) !== undefined && covering(before, p) === undefined);
  const text = basis === "absolute" ? instantText : localText;
  const sample = rows[0]!;
  const scope =
    sample.scope === "book"
      ? { kind: "book" as const }
      : sample.scope === "zone"
        ? { kind: "zone" as const, zoneId: sample.zone! }
        : { kind: "stores" as const, storeIds: [sample.store!] };
  const products = { kind: "items" as const, productIds: [sample.product] };
  const out: PriceChangeItem[] = [];
  if (needsEnd) out.push({ op: "end_price", scope, products, sellUnit: "each", timeBasis: basis, effectiveFrom: text(s0) });
  for (const r of [...before].sort((x, y) => (x.from < y.from ? -1 : 1))) {
    if (r.to !== null && r.to <= s0) continue;
    const from = r.from > s0 ? r.from : s0;
    out.push({
      op: "set_price",
      scope,
      products,
      sellUnit: "each",
      price: r.value,
      timeBasis: basis,
      effectiveFrom: text(from),
      ...(r.to === null ? {} : { effectiveTo: text(r.to) }),
    });
  }
  return out;
}

/** The moves restoring one Store's Zone timeline from `s0` on, or none. */
function storeMoves(storeId: string, rows: readonly MembershipRow[], start: bigint, defaultZoneId: string): PriceChangeItem[] {
  const toRow = (m: MembershipRow): Row => ({ from: BigInt(m.f), to: m.t === null ? null : BigInt(m.t), value: m.zone });
  const head = rows.filter((m) => m.head).map(toRow);
  const before = rows.filter((m) => m.prior).map(toRow);
  const zone = (r: Row | undefined): string => r?.value ?? defaultZoneId;
  const s0 = firstDifference(head, before, start, zone);
  if (s0 === null) return [];
  const all = [...head, ...before];
  // The moves cover [s0, end): the last bound either timeline has (open when either is open).
  const end = all.some((r) => r.to === null) ? null : all.reduce<bigint>((m, r) => (r.to! > m ? r.to! : m), s0);
  if (end !== null && end <= s0) return [];
  const bounds = pointsFrom(s0, head, before).filter((p) => end === null || p < end);
  const segments: { from: bigint; to: bigint | null; zone: string }[] = [];
  bounds.forEach((p, i) => {
    const to = bounds[i + 1] ?? end;
    const z = zone(covering(before, p));
    const last = segments[segments.length - 1];
    if (last !== undefined && last.zone === z) last.to = to;
    else segments.push({ from: p, to, zone: z });
  });
  return segments.map((s) => ({
    op: "move_store_zone" as const,
    storeId,
    zoneId: s.zone,
    effectiveFrom: instantText(s.from),
    ...(s.to === null ? {} : { effectiveTo: instantText(s.to) }),
  }));
}

/** Items of one scope, operation, price and bounds share one item listing their products (≤ 5 000 per item). */
function merge(items: readonly PriceChangeItem[]): PriceChangeItem[] {
  const groups = new Map<string, { item: PriceChangeItem; products: string[] }>();
  for (const item of items) {
    if (item.op === "move_store_zone" || item.products.kind !== "items") {
      groups.set(`${groups.size}:${JSON.stringify(item)}`, { item, products: [] });
      continue;
    }
    const { products, ...rest } = item;
    const key = JSON.stringify(rest);
    const group = groups.get(key) ?? { item, products: [] };
    group.products.push(...products.productIds);
    groups.set(key, group);
  }
  const out: PriceChangeItem[] = [];
  for (const { item, products } of groups.values()) {
    if (item.op === "move_store_zone" || products.length === 0) {
      out.push(item);
      continue;
    }
    const ids = [...new Set(products)].sort();
    for (let i = 0; i < ids.length; i += MAX_PRODUCTS_PER_ITEM) {
      out.push({ ...item, products: { kind: "items", productIds: ids.slice(i, i + MAX_PRODUCTS_PER_ITEM) } } as PriceChangeItem);
    }
  }
  return out;
}

/**
 * The items of a rollback of revision `revision` from `from` on: ends first, then restored prices,
 * then Zone moves, in a deterministic order. The caller has checked `blockingRevisions` is empty
 * under the tenant's publish lock, so no revision after R touched these keys: the head is R's.
 */
export async function rollbackItems(client: Queryable, input: RollbackInput): Promise<PriceChangeItem[]> {
  const events = await client.query<EventRow>(
    `WITH ${TOUCHED}
     SELECT e.scope, e.price_zone_id::text AS zone, e.store_id::text AS store, e.product_id::text AS product,
            e.time_basis AS basis, e.price::text AS price, e.state = 'active' AS head, ${visibleBefore("e")} AS prior,
            CASE WHEN e.time_basis = 'absolute' THEN ${MICROS("e.effective_from")} ELSE ${MICROS("e.effective_from_local")} END AS f,
            CASE WHEN e.time_basis = 'absolute' THEN ${MICROS("e.effective_to")} ELSE ${MICROS("e.effective_to_local")} END AS t
       FROM price_events e JOIN ek ON ${ON_KEY}
      WHERE e.tenant_id = $1::uuid AND e.sell_unit = 'each' AND e.price_kind = 'regular'
        AND (e.state = 'active' OR ${visibleBefore("e")})
      ORDER BY e.scope, e.price_zone_id, e.store_id, e.product_id`,
    [input.tenantId, input.revision],
  );
  const memberships = await client.query<MembershipRow>(
    `WITH ${TOUCHED}
     SELECT m.store_id::text AS store, m.price_zone_id::text AS zone, m.state = 'active' AS head,
            ${visibleBefore("m")} AS prior,
            ${MICROS("m.effective_from")} AS f, ${MICROS("m.effective_to")} AS t
       FROM price_zone_memberships m JOIN mk ON m.price_book_id = mk.price_book_id AND m.store_id = mk.store_id
      WHERE m.tenant_id = $1::uuid AND (m.state = 'active' OR ${visibleBefore("m")})
      ORDER BY m.store_id`,
    [input.tenantId, input.revision],
  );
  const storeTargets = [...new Set(events.rows.flatMap((e) => (e.scope === "store" && e.basis === "store_local" && e.store !== null ? [e.store] : [])))];
  const from = await fromBounds(client, input.tenantId, input.from, storeTargets);
  const byKey = new Map<string, EventRow[]>();
  for (const e of events.rows) {
    const key = `${e.scope}|${e.zone ?? ""}|${e.store ?? ""}|${e.product}`;
    byKey.set(key, [...(byKey.get(key) ?? []), e]);
  }
  const ends: PriceChangeItem[] = [];
  const prices: PriceChangeItem[] = [];
  for (const rows of byKey.values()) {
    const sample = rows[0]!;
    const start = sample.basis === "absolute" ? from.absolute : (from.local.get(sample.scope === "store" ? sample.store! : TENANT_WIDE) ?? from.local.get(TENANT_WIDE)!);
    for (const item of keyItems(rows, start)) (item.op === "end_price" ? ends : prices).push(item);
  }
  const byStore = new Map<string, MembershipRow[]>();
  for (const m of memberships.rows) byStore.set(m.store, [...(byStore.get(m.store) ?? []), m]);
  const moves = [...byStore].flatMap(([store, rows]) => storeMoves(store, rows, from.absolute, input.defaultZoneId));
  return [...merge(ends), ...merge(prices), ...moves];
}
