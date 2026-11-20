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
 * would silently override it). The remedy is a corrective standard set (a blocker stays one even after the later revision is rolled back).
 *
 * Every statement runs on the caller's client inside its tenant transaction (RLS, FORCE) with an
 * explicit `tenant_id` predicate. Time arithmetic is exact: bounds are epoch microseconds.
 */
import type { PoolClient } from "pg";

import { readLatestAuditMetadataWithKey } from "../../audit";
import { liveAndNamedStores } from "../../stores";
import type { PriceChangeItem } from "./price-change-sets.dto";
import {
  PriceChangeSetConflictError,
  PriceChangeSetRollbackBlockedError,
  PriceChangeSetUnprocessableError,
  type ChangeSetState,
} from "./price-change-sets.projections";
import { EARLIEST_ACTIVATION } from "./price-change-set-staleness";

type Queryable = Pick<PoolClient, "query">;

/** The contract caps a set at 500 items, and a product selector at 5 000 ids. */
const MAX_ROLLBACK_ITEMS = 500;
const MAX_PRODUCTS_PER_ITEM = 5000;

/** A rollback the generator cannot express exactly (a key that mixes time bases, a sub-second local bound). */
class RollbackUnsupportedError extends Error {
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
 * draft, rolled back, the system legacy import, or itself a rollback set).
 */
export async function requireRollbackable(client: Queryable, tenantId: string, id: string): Promise<RollbackTarget> {
  const target = await rollbackTarget(client, tenantId, id, ["published", "superseded"]);
  if (target === null) throw new PriceChangeSetConflictError("change_set_invalid_state");
  // Review round 1 (t1): a rollback is not rolled back (no redo chain in v1).
  if (target.kind === "rollback") {
    throw new PriceChangeSetConflictError("change_set_invalid_state", "A rollback Change Set is not rolled back; author a corrective Change Set instead.");
  }
  const blocking = await blockingRevisions(client, tenantId, target.revisionNo);
  if (blocking.length > 0) throw new PriceChangeSetRollbackBlockedError(blocking);
  if (target.state !== "published") throw new PriceChangeSetConflictError("change_set_invalid_state");
  return target;
}

/**
 * Owner decision (RT-1484 PR-6, m2): a rollback takes effect from publish time. A rollback whose
 * restore would start more than this before now is refused: an explicit `from` at create (`422
 * rollback_from_past`), a validated set at publish (`409 stale_validation`, re-validation then
 * regenerates from now). The window covers normal approve-then-publish latency.
 */
export const ROLLBACK_FROM_SKEW_MS = 15 * 60_000;

/** The rollback set at publish, as the check reads it. */
export interface PublishingRollback {
  readonly tenantId: string;
  readonly changeSetId: string;
  readonly version: number;
  /** The set it rolls back; null for any other set. */
  readonly targetId: string | null;
  readonly nowMs: number;
}

/**
 * At publish, under the publish lock (lock order: the publish lock, the set's row, then the
 * target's row, which the publish UPDATEs to `rolled_back`): null for a set that is no rollback;
 * else the target while it is still `published` and unblocked, the set's earliest exact activation
 * is within `ROLLBACK_FROM_SKEW_MS` of now and its preview covers its Store population; else the
 * stale reason (`rollback_blocked`, `rollback_from_past`, `rollback_store_population_changed`).
 */
export async function publishableRollbackTarget(
  client: Queryable,
  p: PublishingRollback,
): Promise<RollbackTarget | null | { readonly stale: "rollback_blocked" | "rollback_from_past" | "rollback_store_population_changed" }> {
  if (p.targetId === null) return null;
  const target = await rollbackTarget(client, p.tenantId, p.targetId, ["published"]);
  if (target === null || (await blockingRevisions(client, p.tenantId, target.revisionNo)).length > 0) return { stale: "rollback_blocked" };
  const r = await client.query<{ at: Date | null }>(`SELECT ${EARLIEST_ACTIVATION("$1::uuid", "$2::uuid", "$3")} AS at`, [
    p.tenantId,
    p.changeSetId,
    p.version,
  ]);
  const at = r.rows[0]?.at ?? null;
  if (at !== null && at.getTime() < p.nowMs - ROLLBACK_FROM_SKEW_MS) return { stale: "rollback_from_past" };
  if (!(await previewCoversPopulation(client, p, await generatedFromMs(client, p.tenantId, p.changeSetId)))) return { stale: "rollback_store_population_changed" };
  return target;
}

/**
 * CodeRabbit 4642497268 (belt and braces, under the publish lock that every Store lifecycle write
 * also takes): no preview row or membership change of the set activates before the instant its
 * items were generated from (unknown: fail closed), and every Store of its stored target
 * population has a preview row or membership change.
 */
async function previewCoversPopulation(client: Queryable, p: PublishingRollback, fromMs: number | null): Promise<boolean> {
  if (fromMs === null) return false;
  const r = await client.query<{ ok: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM price_change_set_preview_lines l
                         WHERE l.tenant_id = $1::uuid AND l.change_set_id = $2::uuid AND l.change_set_version = $3 AND l.effective_from < $4)
        AND NOT EXISTS (SELECT 1 FROM price_change_set_preview_memberships m
                         WHERE m.tenant_id = $1::uuid AND m.change_set_id = $2::uuid AND m.change_set_version = $3 AND m.effective_from < $4)
        AND NOT EXISTS (SELECT 1 FROM price_change_set_validations v, jsonb_array_elements(v.target_stores) AS t(store)
                         WHERE v.tenant_id = $1::uuid AND v.change_set_id = $2::uuid AND v.change_set_version = $3
                           AND NOT EXISTS (SELECT 1 FROM price_change_set_preview_lines l
                                            WHERE l.tenant_id = $1::uuid AND l.change_set_id = $2::uuid AND l.change_set_version = $3
                                              AND l.store_id = (t.store ->> 'storeId')::uuid)
                           AND NOT EXISTS (SELECT 1 FROM price_change_set_preview_memberships m
                                            WHERE m.tenant_id = $1::uuid AND m.change_set_id = $2::uuid AND m.change_set_version = $3
                                              AND m.store_id = (t.store ->> 'storeId')::uuid)) AS ok`,
    [p.tenantId, p.changeSetId, p.version, new Date(fromMs).toISOString()],
  );
  return r.rows[0]?.ok ?? false;
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

/** A maximal interval `[from, to)` (open when `to` is null) where the two timelines differ. */
interface Segment {
  from: bigint;
  to: bigint | null;
}

/**
 * Review round 1 (m1): the intervals at or after `start` where the head and the R − 1 timelines
 * hold different values, adjacent ones merged, ascending. Both timelines are constant between two
 * consecutive bounds, so each elementary interval is judged at its start. Empty: nothing differs.
 */
function differingSegments(head: readonly Row[], before: readonly Row[], start: bigint, value: (r: Row | undefined) => string | null): Segment[] {
  const points = pointsFrom(start, head, before);
  const out: Segment[] = [];
  points.forEach((p, i) => {
    if (value(covering(head, p)) === value(covering(before, p))) return;
    const to = points[i + 1] ?? null;
    const last = out[out.length - 1];
    if (last !== undefined && last.to === p) last.to = to;
    else out.push({ from: p, to });
  });
  return out;
}

/** `row` clipped to `seg`, or null when they do not meet. */
function clipRow(row: Row, seg: Segment): Segment | null {
  const from = row.from > seg.from ? row.from : seg.from;
  const to = row.to === null ? seg.to : seg.to === null ? row.to : row.to < seg.to ? row.to : seg.to;
  return to !== null && to <= from ? null : { from, to };
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
  /**
   * CodeRabbit 4642497268: the Store snapshot to take time zones from (live Stores plus the named
   * ones). `validate` passes the one list it also reaches and hashes with, so a Store created
   * between two reads can never be counted in the target Store set without bounding `from`.
   * Omitted (create, under the publish lock): read here.
   */
  readonly stores?: readonly StoreForPricing[] | undefined;
}

type StoreForPricing = Awaited<ReturnType<typeof liveAndNamedStores>>[number];

/**
 * The Store ids a rollback of `revision` can name: the Store targets of the price events and the
 * Stores of the memberships it published or ended (the snapshot `validate` reads must hold them).
 */
async function rollbackStoreIds(client: Queryable, tenantId: string, revision: number): Promise<string[]> {
  const r = await client.query<{ id: string }>(
    `SELECT DISTINCT store_id::text AS id FROM price_events
      WHERE tenant_id = $1::uuid AND (published_in_revision = $2 OR ended_in_revision = $2) AND store_id IS NOT NULL
     UNION
     SELECT DISTINCT store_id::text FROM price_zone_memberships
      WHERE tenant_id = $1::uuid AND (published_in_revision = $2 OR ended_in_revision = $2)`,
    [tenantId, revision],
  );
  return r.rows.map((row) => row.id);
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
async function fromBounds(
  client: Queryable,
  tenantId: string,
  from: string,
  named: readonly string[],
  snapshot: readonly StoreForPricing[] | undefined,
): Promise<{ absolute: bigint; local: Map<string, bigint> }> {
  const stores = snapshot ?? (await liveAndNamedStores(client, tenantId, named));
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

/**
 * The items restoring one priced key from the rollback instant on, or none (review round 1, m1):
 *   - where every differing interval holds an R − 1 price, one `set_price` per R − 1 event clipped
 *     to each differing interval; rows where the head already equals R − 1 are left alone (an
 *     older set's untouched rows stay its own);
 *   - where the head holds a price R − 1 did not (R priced an empty interval), only an open
 *     `end_price` can remove it, so the key is ended at the first difference `s0` and every R − 1
 *     event after `s0` is re-created. Known v1 limitation: later rows of older sets on the key are
 *     then re-written at their own prices and those sets may become `superseded`.
 */
function keyItems(rows: readonly EventRow[], start: bigint): PriceChangeItem[] {
  const bases = new Set(rows.map((r) => r.basis));
  if (bases.size > 1) throw new RollbackUnsupportedError("a price key mixes time bases between the target revision and the head");
  const basis = rows[0]!.basis;
  const toRow = (e: EventRow): Row => ({ from: BigInt(e.f), to: e.t === null ? null : BigInt(e.t), value: e.price });
  const head = rows.filter((e) => e.head).map(toRow);
  const before = rows.filter((e) => e.prior).map(toRow).sort((x, y) => (x.from < y.from ? -1 : 1));
  const segments = differingSegments(head, before, start, (r) => r?.value ?? null);
  if (segments.length === 0) return [];
  // Delta review B-1: judged at EVERY elementary point from the start (R − 1 coverage may end
  // inside a merged differing interval, e.g. a bounded R − 1 promo under an open R price).
  const needsEnd = pointsFrom(start, head, before).some((p) => covering(head, p) !== undefined && covering(before, p) === undefined);
  const text = basis === "absolute" ? instantText : localText;
  const sample = rows[0]!;
  const scope =
    sample.scope === "book"
      ? { kind: "book" as const }
      : sample.scope === "zone"
        ? { kind: "zone" as const, zoneId: sample.zone! }
        : { kind: "stores" as const, storeIds: [sample.store!] };
  const products = { kind: "items" as const, productIds: [sample.product] };
  const s0 = segments[0]!.from;
  const out: PriceChangeItem[] = [];
  if (needsEnd) out.push({ op: "end_price", scope, products, sellUnit: "each", timeBasis: basis, effectiveFrom: text(s0) });
  const spans: readonly Segment[] = needsEnd ? [{ from: s0, to: null }] : segments;
  for (const span of spans) {
    for (const r of before) {
      const part = clipRow(r, span);
      if (part === null) continue;
      out.push({
        op: "set_price",
        scope,
        products,
        sellUnit: "each",
        price: r.value,
        timeBasis: basis,
        effectiveFrom: text(part.from),
        ...(part.to === null ? {} : { effectiveTo: text(part.to) }),
      });
    }
  }
  return out;
}

/**
 * The moves restoring one Store's Zone timeline from the rollback instant on, or none: one move per
 * differing interval into the R − 1 Zone (the default Zone where R − 1 had no membership, which
 * resolves identically); intervals where the head already equals R − 1 are left alone (review
 * round 1, m1), so an older set's later membership is not re-written.
 */
function storeMoves(storeId: string, rows: readonly MembershipRow[], start: bigint, defaultZoneId: string): PriceChangeItem[] {
  const toRow = (m: MembershipRow): Row => ({ from: BigInt(m.f), to: m.t === null ? null : BigInt(m.t), value: m.zone });
  const head = rows.filter((m) => m.head).map(toRow);
  const before = rows.filter((m) => m.prior).map(toRow);
  const zone = (r: Row | undefined): string => r?.value ?? defaultZoneId;
  const moves: { from: bigint; to: bigint | null; zone: string }[] = [];
  for (const seg of differingSegments(head, before, start, zone)) {
    // Inside one differing interval R − 1 may still change Zone: one move per R − 1 Zone.
    const points = pointsFrom(seg.from, before).filter((p) => seg.to === null || p < seg.to);
    points.forEach((p, i) => {
      const z = zone(covering(before, p));
      const to = points[i + 1] ?? seg.to;
      const last = moves[moves.length - 1];
      if (last !== undefined && last.to === p && last.zone === z) last.to = to;
      else moves.push({ from: p, to, zone: z });
    });
  }
  return moves.map((m) => ({
    op: "move_store_zone" as const,
    storeId,
    zoneId: m.zone,
    effectiveFrom: instantText(m.from),
    ...(m.to === null ? {} : { effectiveTo: instantText(m.to) }),
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
  const items = await generatedItems(client, input).catch((err: unknown) => {
    // Review round 1 (m3): a key the items cannot express exactly is a 422, never a 500.
    if (err instanceof RollbackUnsupportedError) {
      throw new PriceChangeSetUnprocessableError("rollback_unsupported", "The rollback cannot be expressed exactly as Change Set items; author a corrective Change Set.");
    }
    throw err;
  });
  if (items.length === 0) {
    throw new PriceChangeSetUnprocessableError("change_set_empty", "Nothing the target's revision changed differs from the rollback instant on.");
  }
  if (items.length > MAX_ROLLBACK_ITEMS) {
    throw new PriceChangeSetUnprocessableError(
      "change_set_too_large",
      `The rollback needs more than ${MAX_ROLLBACK_ITEMS} items; author corrective Change Sets instead.`,
    );
  }
  return items;
}

async function generatedItems(client: Queryable, input: RollbackInput): Promise<PriceChangeItem[]> {
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
  const from = await fromBounds(client, input.tenantId, input.from, storeTargets, input.stores);
  const byKey = new Map<string, EventRow[]>();
  for (const e of events.rows) {
    const key = `${e.scope}|${e.zone ?? ""}|${e.store ?? ""}|${e.product}`;
    const group = byKey.get(key);
    if (group === undefined) byKey.set(key, [e]);
    else group.push(e);
  }
  const ends: PriceChangeItem[] = [];
  const prices: PriceChangeItem[] = [];
  for (const rows of byKey.values()) {
    const sample = rows[0]!;
    const start = sample.basis === "absolute" ? from.absolute : (from.local.get(sample.scope === "store" ? sample.store! : TENANT_WIDE) ?? from.local.get(TENANT_WIDE)!);
    for (const item of keyItems(rows, start)) (item.op === "end_price" ? ends : prices).push(item);
  }
  const byStore = new Map<string, MembershipRow[]>();
  for (const m of memberships.rows) {
    // Review round 1 (Atlassian 4642337989): append in place, never copy the group per row.
    const group = byStore.get(m.store);
    if (group === undefined) byStore.set(m.store, [m]);
    else group.push(m);
  }
  const moves = [...byStore].flatMap(([store, rows]) => storeMoves(store, rows, from.absolute, input.defaultZoneId));
  return [...merge(ends), ...merge(prices), ...moves];
}

/** JSON with object keys sorted at every level. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Whether two item lists are equal, key order aside (stored items come back from jsonb, which reorders keys). */
export function sameItems(a: readonly PriceChangeItem[], b: readonly PriceChangeItem[]): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Delta review m-d, RT-1532: the start a rollback was requested with, read from the set's own
 * `rollback_from` / `rollback_from_defaulted` columns (0127), never from an audit row. An omitted
 * `from` ("at publish") is `-Infinity`, so validation uses now; an explicit one is `rollback_from`.
 * Fail closed: a rollback set whose columns are NULL (created before 0127 and not filled by its
 * backfill, 0128) or an absent set is `409 change_set_invalid_state`, never now.
 */
async function requestedFromMs(client: Queryable, tenantId: string, setId: string): Promise<number> {
  const r = await client.query<{ rollback_from: Date | null; rollback_from_defaulted: boolean | null }>(
    `SELECT rollback_from, rollback_from_defaulted FROM change_sets WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, setId],
  );
  const row = r.rows[0];
  if (row?.rollback_from_defaulted === true) return Number.NEGATIVE_INFINITY;
  const at = row?.rollback_from instanceof Date ? row.rollback_from.getTime() : Number.NaN;
  if (row?.rollback_from_defaulted !== false || Number.isNaN(at)) {
    throw new PriceChangeSetConflictError("change_set_invalid_state", "The rollback start time is unavailable; cancel and recreate the rollback.");
  }
  return at;
}

/** The instant a rollback set's items were last generated from (its newest audit record of it), or null. */
async function generatedFromMs(client: Queryable, tenantId: string, setId: string): Promise<number | null> {
  const meta = await readLatestAuditMetadataWithKey(client, { tenantId, targetType: "price_change_set", targetId: setId, metadataKey: "rollback_from" });
  const at = typeof meta?.["rollback_from"] === "string" ? Date.parse(meta["rollback_from"]) : Number.NaN;
  return Number.isNaN(at) ? null : at;
}

/**
 * RT-1484 PR-6 (owner decision on m2): a rollback set's items regenerated at validate from
 * max(requested `from`, now), against ONE Store snapshot that validation also reaches and hashes
 * with (CodeRabbit 4642497268). The caller resolves the target first with `requireRollbackable`
 * (RT-1533: its refusals answer before `price_book_missing`).
 */
export async function regeneratedRollback(
  client: Queryable,
  input: { readonly tenantId: string; readonly setId: string; readonly target: RollbackTarget; readonly nowMs: number; readonly defaultZoneId: string },
): Promise<{ readonly items: PriceChangeItem[]; readonly stores: readonly StoreForPricing[]; readonly fromMs: number; readonly from: string }> {
  const { target } = input;
  const fromMs = Math.max(await requestedFromMs(client, input.tenantId, input.setId), input.nowMs);
  const from = new Date(fromMs).toISOString();
  const stores = await liveAndNamedStores(client, input.tenantId, await rollbackStoreIds(client, input.tenantId, target.revisionNo));
  const items = await rollbackItems(client, { tenantId: input.tenantId, revision: target.revisionNo, from, defaultZoneId: input.defaultZoneId, stores });
  return { items, stores, fromMs, from };
}

/**
 * Delta review m-a (fail closed): no activation of a rollback's validation (every preview row's and
 * membership change's exact instant) starts before the `from` its items were regenerated from.
 */
export function refuseActivationBefore(fromMs: number | null, effectiveMs: readonly number[]): void {
  if (fromMs !== null && effectiveMs.some((ms) => ms < fromMs)) {
    throw new PriceChangeSetConflictError("change_set_invalid_state", "A rollback activation would start before its start time; validate again.");
  }
}
