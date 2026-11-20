/**
 * RT-1484 (RT-282 PR-10b) — the staleness check `submit`, `approve` and `publish` run (spec 042 §3,
 * Q-B7, Q-B8; contract info **Staleness**). Every statement runs on the caller's client inside its
 * tenant transaction (RLS, FORCE) with an explicit `tenant_id` predicate; `publish` runs it under
 * the tenant's pricing publish lock, so no revision or Store lifecycle write lands in between.
 *
 * A validated set is stale when:
 *   1. its target Stores changed: the stored lines, reached again at the head with the same rule
 *      as `validate` (`currentTargetStores`), hash to another `targetStoreSetHash`, or a line no
 *      longer reaches what it was validated for (a retired Zone, a Store deleted). A Store
 *      lifecycle write produces no revision, so this runs on every call (Q-B8);
 *   2. the head moved past `validatedAtRevision` and a later revision INTERSECTS the set:
 *      a. it published or ended an event of one of the set's products and fanned out to one of
 *         the set's target Stores (a shared Store, product and sell unit, judged on the fan-out);
 *      b. it published or ended a Zone membership of one of the set's target Stores; or
 *      c. it published or ended a membership in a Zone one of the set's Zone lines targets (any
 *         membership at all when a line targets the Book's default Zone, which every Store
 *         without a membership falls back to).
 *     Fail closed: (a) pairs every product of the set with every target Store and (c) ignores the
 *     line's interval, so the check may stale a set a finer rule would keep, never the reverse.
 *   3. (Review round 1, M1; CodeRabbit 4641764676) a `standard` set's earliest exact per-Store
 *      activation instant (its stored preview rows and membership changes, `EARLIEST_ACTIVATION`)
 *      is at or before now plus the minimum lead time: a set approved in time but published late
 *      would otherwise publish a past-dated price. In v1 the lead time is 0, so this is "at or
 *      before now", and re-validation classes the line `past_dated` (blocking). With a lead time
 *      above 0 an instant still in the future but inside the lead time is stale here too, and
 *      re-validation refuses it as `422 lead_time_violation` rather than classing it
 *      `past_dated`. Emergency and rollback sets are exempt (their own governed path, spec 042
 *      §5, §7).
 * Not stale with a moved head: the caller advances `validatedAtRevision` to the head.
 */
import type { PoolClient } from "pg";

import type { ResolutionPriceBook } from "../resolution/types";
import { LOCAL_TEXT, wallClock } from "../inquiry/price-inquiry.repository";
import { targetStoreSetHash } from "./price-change-set-hashes";
import { currentTargetStores, type StoredLineReach } from "./price-change-set-validation";
import { DEFAULT_MIN_LEAD_TIME_MS } from "./price-change-set-lead-time";
import { headRevision, loadReachContext } from "./price-change-set-validation.repository";
import type { ChangeSetKindForValidation } from "./price-change-set-validation.types";

type Queryable = Pick<PoolClient, "query">;

/** A stored line of the set's validation, as the staleness check and publish read it. */
export interface StoredLine extends StoredLineReach {
  readonly lineNo: number;
  readonly productId: string | null;
  readonly replacedIds: readonly string[];
}

/** A stored line row: its identity and target, then its bounds (both time bases). */
type LineRow = Pick<StoredLine, "op" | "scope"> & {
  readonly line_no: number;
  readonly replaced_ids: string[];
  readonly price_zone_id: string | null;
  readonly store_id: string | null;
  readonly product_id: string | null;
  readonly time_basis: "store_local" | "absolute";
} & Readonly<Record<"effective_from" | "effective_to", Date | null>> &
  Readonly<Record<"effective_from_local" | "effective_to_local", string | null>>;

/** The lines of the set's validation at `version`, in line order. */
export async function loadStoredLines(client: Queryable, tenantId: string, changeSetId: string, version: number): Promise<StoredLine[]> {
  const r = await client.query<LineRow>(
    `SELECT l.line_no, l.op, l.scope, l.price_zone_id::text AS price_zone_id, l.store_id::text AS store_id,
            l.product_id::text AS product_id, l.time_basis, l.effective_from, l.effective_to,
            ${LOCAL_TEXT("l.effective_from_local")} AS effective_from_local,
            ${LOCAL_TEXT("l.effective_to_local")} AS effective_to_local,
            l.replaced_ids::text[] AS replaced_ids
       FROM price_change_set_lines l
      WHERE l.tenant_id = $1::uuid AND l.change_set_id = $2::uuid AND l.change_set_version = $3
      ORDER BY l.line_no`,
    [tenantId, changeSetId, version],
  );
  return r.rows.map((l) => ({
    lineNo: l.line_no,
    op: l.op,
    scope: l.scope,
    priceZoneId: l.price_zone_id,
    storeId: l.store_id,
    productId: l.product_id,
    replacedIds: l.replaced_ids,
    bounds: {
      timeBasis: l.time_basis,
      effectiveFrom: l.effective_from,
      effectiveTo: l.effective_to,
      effectiveFromLocal: wallClock(l.effective_from_local),
      effectiveToLocal: wallClock(l.effective_to_local),
    },
  }));
}

/**
 * The earliest exact per-Store activation instant of a set's stored preview at a version: its
 * preview rows' and membership changes' `effective_from` (null: none). `t`, `id` and `v` are SQL
 * expressions for the tenant, the set and the version. `publicationStatus` (read time) and rule 3
 * use it. v1 deviation (review round 1, m4): the instants are the ones stored at validation, so a
 * Store time-zone change after publish is not reflected (a follow-up computes them from the live
 * Store zones).
 */
export const EARLIEST_ACTIVATION = (t: string, id: string, v: string): string =>
  `(SELECT min(q.at) FROM (
      SELECT min(p.effective_from) AS at FROM price_change_set_preview_lines p
       WHERE p.tenant_id = ${t} AND p.change_set_id = ${id} AND p.change_set_version = ${v}
      UNION ALL
      SELECT min(m.effective_from) FROM price_change_set_preview_memberships m
       WHERE m.tenant_id = ${t} AND m.change_set_id = ${id} AND m.change_set_version = ${v}) q)`;

/** What the check needs of the set and its validation. */
export interface StalenessInput {
  readonly tenantId: string;
  readonly changeSetId: string;
  readonly version: number;
  readonly kind: ChangeSetKindForValidation;
  readonly nowMs: number;
  readonly book: ResolutionPriceBook;
  readonly validatedAtRevision: number;
  readonly targetStoreSetHash: string;
  /** The stored target Store ids (`price_change_set_validations.target_stores`). */
  readonly targetStoreIds: readonly string[];
  readonly lines: readonly StoredLine[];
}

/** Rule 1: the target Stores the lines reach at the head hash to the stored hash. */
async function targetStoresHold(client: Queryable, input: StalenessInput, head: number): Promise<boolean> {
  const named = new Set<string>();
  for (const l of input.lines) if (l.storeId !== null) named.add(l.storeId);
  const ctx = await loadReachContext(client, {
    tenantId: input.tenantId,
    kind: input.kind,
    nowMs: input.nowMs,
    revision: head,
    book: input.book,
    ids: { productIds: [], categoryIds: [], storeIds: [...named] },
  });
  const stores = currentTargetStores(ctx, input.lines);
  return stores !== null && targetStoreSetHash(stores) === input.targetStoreSetHash;
}

/** Rule 2: a revision in (validatedAtRevision, head] intersects the set. */
async function laterRevisionIntersects(client: Queryable, input: StalenessInput, head: number): Promise<boolean> {
  const products = [...new Set(input.lines.flatMap((l) => (l.productId === null ? [] : [l.productId])))];
  const zones = [...new Set(input.lines.flatMap((l) => (l.scope === "zone" && l.op !== "move_store_zone" && l.priceZoneId !== null ? [l.priceZoneId] : [])))];
  const r = await client.query<{ hit: boolean }>(
    `SELECT EXISTS (
              SELECT 1 FROM price_events e
               WHERE e.tenant_id = $1::uuid AND e.product_id = ANY($4::uuid[])
                 AND ((e.published_in_revision > $2 AND e.published_in_revision <= $3)
                      OR (e.ended_in_revision > $2 AND e.ended_in_revision <= $3))
                 AND EXISTS (SELECT 1 FROM pricing_revision_stores f
                              WHERE f.tenant_id = e.tenant_id AND f.store_id = ANY($5::uuid[])
                                AND f.revision_no > $2 AND f.revision_no <= $3
                                AND f.revision_no IN (e.published_in_revision, e.ended_in_revision)))
            OR EXISTS (
              SELECT 1 FROM price_zone_memberships m
               WHERE m.tenant_id = $1::uuid
                 AND ((m.published_in_revision > $2 AND m.published_in_revision <= $3)
                      OR (m.ended_in_revision > $2 AND m.ended_in_revision <= $3))
                 AND (m.store_id = ANY($5::uuid[]) OR m.price_zone_id = ANY($6::uuid[]) OR $7::boolean)) AS hit`,
    [input.tenantId, input.validatedAtRevision, head, products, input.targetStoreIds, zones, zones.includes(input.book.defaultZoneId)],
  );
  return r.rows[0]?.hit ?? true;
}

/** Rule 3: a standard set's earliest activation is no longer at least the lead time ahead. */
async function startsTooSoon(client: Queryable, input: StalenessInput): Promise<boolean> {
  if (input.kind !== "standard") return false;
  const r = await client.query<{ at: Date | null }>(`SELECT ${EARLIEST_ACTIVATION("$1::uuid", "$2::uuid", "$3")} AS at`, [
    input.tenantId,
    input.changeSetId,
    input.version,
  ]);
  const at = r.rows[0]?.at ?? null;
  // At or before (CodeRabbit 4641764676): an activation at publish time is already in the past.
  return at !== null && at.getTime() <= input.nowMs + DEFAULT_MIN_LEAD_TIME_MS;
}

/** Whether the set is stale at the head, and the head it was checked at. */
export async function checkStaleness(client: Queryable, input: StalenessInput): Promise<{ readonly stale: boolean; readonly head: number }> {
  const head = await headRevision(client, input.tenantId);
  if (await startsTooSoon(client, input)) return { stale: true, head };
  if (!(await targetStoresHold(client, input, head))) return { stale: true, head };
  if (head > input.validatedAtRevision && (await laterRevisionIntersects(client, input, head))) return { stale: true, head };
  return { stale: false, head };
}
