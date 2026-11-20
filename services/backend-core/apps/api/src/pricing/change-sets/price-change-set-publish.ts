/**
 * RT-1484 (RT-282 PR-10b) — the writes of `publish` (spec 042 §3, §8, §10; spec 041 data-model
 * §2.3–§2.6; contract info **Publish**). The caller holds the tenant's pricing publish lock, has
 * re-checked staleness under it and runs everything below in ONE transaction, so a publish is
 * all-or-nothing and writes exactly ONE immutable Pricing Revision (528, 530):
 *
 *   1. `pricing_revisions`: the next `revision_no` (0121's insert trigger keeps it gapless) with
 *      `earliest_effective_at`, the G4 lower bound (data-model §2.5): the earliest line start, a
 *      `store_local` start taken at UTC+14:00 so it holds for every Store.
 *   2. The set moves to `published` at that revision (0121 `change_sets_revision_fk`; 0123's line
 *      guard needs it before a line records its publish).
 *   3. Supersede and replace, never edit (spec 041 §3.1, data-model §2.3): every event and Zone
 *      membership a line replaces is ended (`superseded`, `ended_in_revision`), and the parts of it
 *      no line of the set covers are carried forward as new rows (`carried_forward`, the same
 *      price or Zone, `supersedes_event_id` naming the old event). The arithmetic is PostgreSQL's
 *      multirange difference, exact to the microsecond on both time bases. A priced line's covered
 *      interval is `[effectiveFrom, effectiveTo)`; an end or reset covers from its instant on.
 *   4. One new event per priced line (its concrete `new_price`, bounds and time basis), and one new
 *      membership per Zone move.
 *   5. The per-line record (§10, Q-B5): `new_event_id` and `result_ids` (the carried-forward rows,
 *      a move's new membership), recorded on the lowest line that replaces each row (0123 residual:
 *      either line may record it, each row exactly once).
 *   6. The fan-out (data-model §2.6): the validated target Stores, every Store a written or ended
 *      Store event or membership names, every live Store for a Book event or a default-Zone event,
 *      and every live Store with a membership in a Zone a written or ended Zone event names. A
 *      superset is safe (POS applies whole revisions); a missed Store is not.
 *   7. A rollback (RT-1484 PR-6, spec 042 §8): its revision names the revision it rolls back
 *      (`rolls_back_revision_no`), and its target set becomes `rolled_back` (before step 8, so the
 *      target, whose rows this revision ends, is never also marked `superseded`).
 *   8. Published sets whose every event and membership row is now ended become `superseded`.
 *
 * No `price_history` write (spec 044 §4.5, RT-1484 comment 17829 decision 2) and no outbox event
 * (`pricing.revision.published` is RT-1486's). 0123's COMMIT-time checks (the record is complete,
 * the revision is a publish) run at COMMIT; nothing here issues `SET CONSTRAINTS`.
 */
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import { liveAndNamedStores } from "../../stores";
import type { StoredLine } from "./price-change-set-staleness";

type Queryable = Pick<PoolClient, "query">;

/** A publish of one approved set. */
export interface PublishWrite {
  readonly tenantId: string;
  readonly changeSetId: string;
  readonly version: number;
  readonly kind: "standard" | "emergency" | "rollback";
  readonly head: number;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly lines: readonly StoredLine[];
  readonly targetStoreIds: readonly string[];
  readonly defaultZoneId: string;
  /** For a rollback set: the published set it rolls back and that set's revision (else null). */
  readonly rollsBack: { readonly changeSetId: string; readonly revisionNo: number } | null;
}

/** A carried-forward part of a replaced row: its new id, the row and the line that records it. */
interface Remainder {
  readonly id: string;
  readonly replaced: string;
  readonly lineNo: number;
  readonly f: string | null;
  readonly t: string | null;
  readonly fl: string | null;
  readonly tl: string | null;
}

const REVISION_KIND = { standard: "publish", emergency: "emergency", rollback: "rollback" } as const;
const EVENT_SOURCE = { standard: "change_set", emergency: "emergency", rollback: "rollback" } as const;

/** The set's validation lines, the first three parameters of every statement below. */
const LINES_OF = `l.tenant_id = $1::uuid AND l.change_set_id = $2::uuid AND l.change_set_version = $3`;

/**
 * The parts of each replaced row (events, or memberships for Zone moves) that no line of the set
 * covers, with the lowest line that replaces the row. `basis` picks the bounds columns.
 */
async function remaindersOf(client: Queryable, w: PublishWrite, table: "price_events" | "price_zone_memberships", basis: "absolute" | "store_local"): Promise<Remainder[]> {
  const local = basis === "store_local";
  const range = local ? "tsrange" : "tstzrange";
  const [from, to] = local ? ["effective_from_local", "effective_to_local"] : ["effective_from", "effective_to"];
  const moves = table === "price_zone_memberships";
  const r = await client.query<{ replaced: string; line_no: number; lo: string; hi: string | null }>(
    `SELECT c.id::text AS replaced, c.line_no, lower(s)::text AS lo, upper(s)::text AS hi
       FROM (SELECT x.id, min(l.line_no) AS line_no, range_agg(${range}(l.${from}, l.${to}, '[)')) AS cov
               FROM price_change_set_lines l CROSS JOIN LATERAL unnest(l.replaced_ids) AS x(id)
              WHERE ${LINES_OF} AND l.time_basis = $4 AND (l.op = 'move_store_zone') = $5
              GROUP BY x.id) c
       JOIN ${table} e ON e.tenant_id = $1::uuid AND e.id = c.id ${moves ? "" : "AND e.time_basis = $4"}
      CROSS JOIN LATERAL unnest(${range.replace("range", "multirange")}(${range}(e.${from}, e.${to}, '[)')) - c.cov) AS s
      ORDER BY c.line_no, c.id, lower(s)`,
    [w.tenantId, w.changeSetId, w.version, basis, moves],
  );
  return r.rows.map((row) => ({
    id: newId(),
    replaced: row.replaced,
    lineNo: row.line_no,
    f: local ? null : row.lo,
    t: local ? null : row.hi,
    fl: local ? row.lo : null,
    tl: local ? row.hi : null,
  }));
}

/** Steps 1 and 2: the revision and the set's move to `published`. Returns the new revision number. */
async function issueRevision(client: Queryable, w: PublishWrite): Promise<number> {
  const revisionNo = w.head + 1;
  await client.query(
    `INSERT INTO pricing_revisions (id, tenant_id, revision_no, change_set_id, kind, rolls_back_revision_no, published_by_user_id,
                                   earliest_effective_at, correlation_id)
     SELECT $4::uuid, $1::uuid, $5::bigint, $2::uuid, $6, $9::bigint, $7::uuid,
            (SELECT min(COALESCE(l.effective_from, (l.effective_from_local - interval '14 hours') AT TIME ZONE 'UTC'))
               FROM price_change_set_lines l WHERE ${LINES_OF}),
            $8::uuid`,
    [w.tenantId, w.changeSetId, w.version, newId(), revisionNo, REVISION_KIND[w.kind], w.actorUserId, w.correlationId, w.rollsBack?.revisionNo ?? null],
  );
  await client.query(
    `UPDATE change_sets
        SET state = 'published', revision_no = $3, published_by_user_id = $4, published_at = now(),
            validated_at_revision = GREATEST(validated_at_revision, $5)
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [w.tenantId, w.changeSetId, revisionNo, w.actorUserId, w.head],
  );
  return revisionNo;
}

/** Step 3: end every replaced event and membership in this revision. */
async function endReplaced(client: Queryable, w: PublishWrite, revisionNo: number): Promise<void> {
  const replaced = [...new Set(w.lines.flatMap((l) => l.replacedIds))];
  if (replaced.length === 0) return;
  for (const table of ["price_events", "price_zone_memberships"]) {
    await client.query(
      `UPDATE ${table} SET state = 'superseded', ended_in_revision = $3
        WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) AND state = 'active'`,
      [w.tenantId, replaced, revisionNo],
    );
  }
}

/** Steps 3 and 4: the carried-forward rows and the new events and memberships. Returns the line records. */
async function writeRows(client: Queryable, w: PublishWrite, revisionNo: number): Promise<Map<number, { newEventId: string | null; resultIds: string[] }>> {
  const eventRest = [...(await remaindersOf(client, w, "price_events", "absolute")), ...(await remaindersOf(client, w, "price_events", "store_local"))];
  const moveRest = await remaindersOf(client, w, "price_zone_memberships", "absolute");
  await endReplaced(client, w, revisionNo);
  const common = [w.tenantId, revisionNo, w.changeSetId, EVENT_SOURCE[w.kind], w.actorUserId, w.correlationId];
  if (eventRest.length > 0) {
    await client.query(
      `INSERT INTO price_events (id, tenant_id, price_book_id, scope, price_zone_id, store_id, product_id, sell_unit, price_kind, price,
                                 currency_code, time_basis, effective_from, effective_to, effective_from_local, effective_to_local,
                                 published_in_revision, supersedes_event_id, change_set_id, source, carried_forward, created_by_user_id, correlation_id)
       SELECT x.id, e.tenant_id, e.price_book_id, e.scope, e.price_zone_id, e.store_id, e.product_id, e.sell_unit, e.price_kind, e.price,
              e.currency_code, e.time_basis, x.f, x.t, x.fl, x.tl, $2, e.id, $3::uuid, $4, true, $5::uuid, $6::uuid
         FROM jsonb_to_recordset($7::jsonb) AS x(id uuid, replaced uuid, f timestamptz, t timestamptz, fl timestamp, tl timestamp)
         JOIN price_events e ON e.tenant_id = $1::uuid AND e.id = x.replaced`,
      [...common, JSON.stringify(eventRest)],
    );
  }
  const priced = w.lines.filter((l) => l.op === "set_price" || l.op === "adjust_amount" || l.op === "adjust_percent").map((l) => ({ line_no: l.lineNo, id: newId() }));
  if (priced.length > 0) {
    await client.query(
      `INSERT INTO price_events (id, tenant_id, price_book_id, scope, price_zone_id, store_id, product_id, sell_unit, price_kind, price,
                                 currency_code, time_basis, effective_from, effective_to, effective_from_local, effective_to_local,
                                 published_in_revision, supersedes_event_id, change_set_id, source, carried_forward, created_by_user_id, correlation_id)
       SELECT x.id, l.tenant_id, l.price_book_id, l.scope, l.price_zone_id, l.store_id, l.product_id, l.sell_unit, 'regular', l.new_price,
              b.currency_code, l.time_basis, l.effective_from, l.effective_to, l.effective_from_local, l.effective_to_local,
              $2, CASE WHEN cardinality(l.replaced_ids) = 1 THEN l.replaced_ids[1] END, $3::uuid, $4, false, $5::uuid, $6::uuid
         FROM jsonb_to_recordset($8::jsonb) AS x(line_no int, id uuid)
         JOIN price_change_set_lines l
           ON l.tenant_id = $1::uuid AND l.change_set_id = $3::uuid AND l.change_set_version = $7 AND l.line_no = x.line_no
         JOIN price_books b ON b.tenant_id = l.tenant_id AND b.id = l.price_book_id`,
      [...common, w.version, JSON.stringify(priced)],
    );
  }
  const moved = w.lines.filter((l) => l.op === "move_store_zone").map((l) => ({ line_no: l.lineNo, id: newId() }));
  const memberships = [
    ...moveRest.map((m) => ({ id: m.id, replaced: m.replaced, line_no: null, f: m.f, t: m.t })),
    ...moved.map((m) => ({ id: m.id, replaced: null, line_no: m.line_no, f: null, t: null })),
  ];
  if (memberships.length > 0) {
    await client.query(
      `INSERT INTO price_zone_memberships (id, tenant_id, price_book_id, price_zone_id, store_id, effective_from, effective_to,
                                           published_in_revision, carried_forward, created_by_user_id, correlation_id)
       SELECT x.id, $1::uuid, COALESCE(o.price_book_id, l.price_book_id), COALESCE(o.price_zone_id, l.price_zone_id),
              COALESCE(o.store_id, l.store_id), COALESCE(x.f, l.effective_from), CASE WHEN o.id IS NULL THEN l.effective_to ELSE x.t END,
              $2, o.id IS NOT NULL, $4::uuid, $5::uuid
         FROM jsonb_to_recordset($7::jsonb) AS x(id uuid, replaced uuid, line_no int, f timestamptz, t timestamptz)
         LEFT JOIN price_zone_memberships o ON o.tenant_id = $1::uuid AND o.id = x.replaced
         LEFT JOIN price_change_set_lines l
           ON l.tenant_id = $1::uuid AND l.change_set_id = $3::uuid AND l.change_set_version = $6 AND l.line_no = x.line_no`,
      [w.tenantId, revisionNo, w.changeSetId, w.actorUserId, w.correlationId, w.version, JSON.stringify(memberships)],
    );
  }
  const records = new Map<number, { newEventId: string | null; resultIds: string[] }>();
  const recordOf = (lineNo: number) => {
    const r = records.get(lineNo) ?? { newEventId: null, resultIds: [] };
    records.set(lineNo, r);
    return r;
  };
  for (const p of priced) recordOf(p.line_no).newEventId = p.id;
  for (const m of [...eventRest, ...moveRest]) recordOf(m.lineNo).resultIds.push(m.id);
  for (const m of moved) recordOf(m.line_no).resultIds.push(m.id);
  return records;
}

/** Step 5: each line's publish record, set once (0123 `price_change_set_lines_guard`). */
async function recordLines(client: Queryable, w: PublishWrite, records: ReadonlyMap<number, { newEventId: string | null; resultIds: string[] }>): Promise<void> {
  if (records.size === 0) return;
  const rows = [...records].map(([lineNo, r]) => ({ line_no: lineNo, new_event_id: r.newEventId, result_ids: r.resultIds }));
  await client.query(
    `UPDATE price_change_set_lines l
        SET new_event_id = x.new_event_id, result_ids = ARRAY(SELECT jsonb_array_elements_text(x.result_ids))::uuid[]
       FROM jsonb_to_recordset($4::jsonb) AS x(line_no int, new_event_id uuid, result_ids jsonb)
      WHERE ${LINES_OF} AND l.line_no = x.line_no`,
    [w.tenantId, w.changeSetId, w.version, JSON.stringify(rows)],
  );
}

async function liveStoreIds(client: Queryable, tenantId: string): Promise<Set<string>> {
  const all = await liveAndNamedStores(client, tenantId, []);
  return new Set(all.filter((s) => s.live).map((s) => s.id));
}

/** Step 6: the Stores revision `revisionNo` can change. */
async function fanOut(client: Queryable, w: PublishWrite, revisionNo: number): Promise<number> {
  const touched = await client.query<{ scope: string | null; zone: string | null; store: string | null }>(
    `SELECT DISTINCT e.scope, e.price_zone_id::text AS zone, e.store_id::text AS store FROM price_events e
      WHERE e.tenant_id = $1::uuid AND (e.published_in_revision = $2 OR e.ended_in_revision = $2)
     UNION
     SELECT DISTINCT 'store', NULL, m.store_id::text FROM price_zone_memberships m
      WHERE m.tenant_id = $1::uuid AND (m.published_in_revision = $2 OR m.ended_in_revision = $2)`,
    [w.tenantId, revisionNo],
  );
  const stores = new Set(w.targetStoreIds);
  const zones = new Set<string>();
  let everyStore = false;
  for (const t of touched.rows) {
    if (t.store !== null) stores.add(t.store);
    if (t.scope === "book" || t.zone === w.defaultZoneId) everyStore = true;
    else if (t.zone !== null) zones.add(t.zone);
  }
  // Review round 1, m6: the tenant's Stores are loaded only when a Book or Zone row needs them.
  const liveIds = everyStore || zones.size > 0 ? await liveStoreIds(client, w.tenantId) : new Set<string>();
  if (everyStore) for (const id of liveIds) stores.add(id);
  if (zones.size > 0) {
    const members = await client.query<{ store: string }>(
      `SELECT DISTINCT m.store_id::text AS store FROM price_zone_memberships m
        WHERE m.tenant_id = $1::uuid AND m.price_zone_id = ANY($2::uuid[])
          AND m.published_in_revision <= $3 AND (m.ended_in_revision IS NULL OR m.ended_in_revision > $3)`,
      [w.tenantId, [...zones], revisionNo],
    );
    for (const m of members.rows) if (liveIds.has(m.store)) stores.add(m.store);
  }
  await client.query(
    `INSERT INTO pricing_revision_stores (tenant_id, store_id, revision_no, created_by_user_id, correlation_id)
     SELECT $1::uuid, s, $2, $3::uuid, $4::uuid FROM unnest($5::uuid[]) AS s`,
    [w.tenantId, revisionNo, w.actorUserId, w.correlationId, [...stores]],
  );
  return stores.size;
}

/** A published set this revision completed superseding, as its audit row names it. */
interface SupersededSet {
  readonly id: string;
  readonly kind: string;
  readonly version: number;
  readonly previewHash: string | null;
  readonly reasonPresent: boolean;
}

/** Step 7: a rollback's target becomes `rolled_back` (0121 `change_sets_guard`: only its derived state changes). */
async function markRolledBack(client: Queryable, w: PublishWrite): Promise<void> {
  if (w.rollsBack === null) return;
  const r = await client.query(
    `UPDATE change_sets SET state = 'rolled_back'
      WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'published' AND revision_no = $3`,
    [w.tenantId, w.rollsBack.changeSetId, w.rollsBack.revisionNo],
  );
  // The caller checked the target under the publish lock; anything else is a defect (500, rolled back).
  if (r.rowCount !== 1) throw new Error("rollback target is no longer published");
}

/** Step 8: the published sets this revision completed superseding. */
async function supersedeCompleted(client: Queryable, w: PublishWrite, revisionNo: number): Promise<SupersededSet[]> {
  const r = await client.query<SupersededSet>(
    `UPDATE change_sets c SET state = 'superseded'
      WHERE c.tenant_id = $1::uuid AND c.id <> $2::uuid AND c.state = 'published'
        AND c.revision_no IN (SELECT e.published_in_revision FROM price_events e WHERE e.tenant_id = $1::uuid AND e.ended_in_revision = $3
                              UNION SELECT m.published_in_revision FROM price_zone_memberships m WHERE m.tenant_id = $1::uuid AND m.ended_in_revision = $3)
        AND NOT EXISTS (SELECT 1 FROM price_events e WHERE e.tenant_id = $1::uuid AND e.published_in_revision = c.revision_no AND e.state = 'active')
        AND NOT EXISTS (SELECT 1 FROM price_zone_memberships m WHERE m.tenant_id = $1::uuid AND m.published_in_revision = c.revision_no AND m.state = 'active')
      RETURNING c.id::text AS id, c.kind, c.version, c.preview_hash AS "previewHash", c.reason IS NOT NULL AS "reasonPresent"`,
    [w.tenantId, w.changeSetId, revisionNo],
  );
  return r.rows;
}

/** What a publish wrote, for its audit row. */
export interface PublishResult {
  readonly revisionNo: number;
  readonly fanOutStores: number;
  readonly superseded: readonly SupersededSet[];
}

/** Every replaced event and membership is still active (else a later write ended it: stale). */
export async function replacedStillActive(client: Queryable, tenantId: string, lines: readonly StoredLine[]): Promise<boolean> {
  const ids = [...new Set(lines.flatMap((l) => l.replacedIds))];
  if (ids.length === 0) return true;
  const r = await client.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM price_events WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) AND state = 'active')::int
          + (SELECT count(*) FROM price_zone_memberships WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) AND state = 'active')::int AS n`,
    [tenantId, ids],
  );
  return r.rows[0]?.n === ids.length;
}

/** Publishes the approved set: one revision, its rows, the per-line record and the fan-out. */
export async function writePublication(client: Queryable, w: PublishWrite): Promise<PublishResult> {
  const revisionNo = await issueRevision(client, w);
  const records = await writeRows(client, w, revisionNo);
  await recordLines(client, w, records);
  const fanOutStores = await fanOut(client, w, revisionNo);
  await markRolledBack(client, w);
  const superseded = await supersedeCompleted(client, w, revisionNo);
  return { revisionNo, fanOutStores, superseded };
}
