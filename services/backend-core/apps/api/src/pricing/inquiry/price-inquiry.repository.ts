/**
 * RT-1484 (RT-282 PR-08b) — loads the resolver's `ResolutionData` for one price key of one Store,
 * on the caller's client inside its tenant transaction (`runWithTenantContext`: tenant RLS,
 * FORCE, `isPlatformAdmin: false`), with an explicit `tenant_id` predicate on every statement.
 *
 * It reads Pricing data only (0121): the tenant's retail Book with its default Zone, the Store's
 * Zone memberships in that Book and the key's `regular` price events, each as visible at the
 * revision (`published_in_revision <= R AND (ended_in_revision IS NULL OR ended_in_revision > R)`,
 * data-model §2.3, §2.4), never by current `state`. Before the tenant's first revision nothing is
 * visible. It never reads `tenant_products.default_price` or `store_product_overrides`: inquiry
 * never falls back to the legacy catalogue price (price-inquiry.yaml "Authority").
 *
 * Timestamps: `timestamptz` columns arrive as `Date`; the `timestamp without time zone` local
 * bounds are read as text and rebuilt in the resolver's convention (a `Date` whose UTC fields are
 * the Store-local wall-clock value), so the Node process time zone never shifts them.
 */
import type { PoolClient } from "pg";

import type {
  ResolutionData,
  ResolutionPriceBook,
  ResolutionPriceEvent,
  ResolutionZoneMembership,
} from "../resolution/types";

type Queryable = Pick<PoolClient, "query">;

/** The loaded data, plus each loaded event's Change Set (the explain trace names it). */
export interface LoadedResolutionData extends ResolutionData {
  readonly changeSetOf: ReadonlyMap<string, string>;
}

/** The 0121 visibility rule for alias `t` at revision `$rev`. */
export const VISIBLE_AT = (t: string, rev: string): string =>
  `${t}.published_in_revision <= ${rev}::bigint AND (${t}.ended_in_revision IS NULL OR ${t}.ended_in_revision > ${rev}::bigint)`;

/** A local wall-clock column as text with milliseconds, e.g. `2026-11-01T00:00:00.000`. */
export const LOCAL_TEXT = (column: string): string => `to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;

interface BookRow {
  id: string;
  tenant_id: string;
  currency_code: string;
  tax_price_basis: string;
  default_zone_id: string;
}

interface MembershipRow {
  id: string;
  tenant_id: string;
  price_book_id: string;
  price_zone_id: string;
  store_id: string;
  effective_from: Date;
  effective_to: Date | null;
  published_in_revision: string;
  ended_in_revision: string | null;
}

interface EventRow {
  id: string;
  tenant_id: string;
  price_book_id: string;
  scope: string;
  price_zone_id: string | null;
  store_id: string | null;
  product_id: string;
  sell_unit: string;
  price_kind: string;
  price: string;
  time_basis: string;
  effective_from: Date | null;
  effective_to: Date | null;
  effective_from_local: string | null;
  effective_to_local: string | null;
  published_in_revision: string;
  ended_in_revision: string | null;
  change_set_id: string;
}

export const wallClock = (text: string | null): Date | null => (text === null ? null : new Date(`${text}Z`));
const revisionNo = (text: string | null): number | null => (text === null ? null : Number(text));

/** The tenant's retail Book with its default Zone (v1: at most one, never retired), or null. */
export async function loadBook(client: Queryable, tenantId: string): Promise<ResolutionPriceBook | null> {
  const r = await client.query<BookRow>(
    `SELECT b.id::text AS id, b.tenant_id::text AS tenant_id, b.currency_code, b.tax_price_basis,
            z.id::text AS default_zone_id
       FROM price_books b
       JOIN price_zones z ON z.tenant_id = b.tenant_id AND z.price_book_id = b.id AND z.is_default
      WHERE b.tenant_id = $1::uuid AND b.pricing_context = 'retail' AND b.retired_at IS NULL`,
    [tenantId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    currencyCode: row.currency_code,
    taxPriceBasis: row.tax_price_basis,
    defaultZoneId: row.default_zone_id,
  };
}

/** The Book's Zone memberships visible at `revision`: of one Store, or of every Store (`storeId` null). */
export async function loadMemberships(
  client: Queryable,
  key: { tenantId: string; bookId: string; storeId: string | null; revision: number },
): Promise<ResolutionZoneMembership[]> {
  const r = await client.query<MembershipRow>(
    `SELECT m.id::text AS id, m.tenant_id::text AS tenant_id, m.price_book_id::text AS price_book_id,
            m.price_zone_id::text AS price_zone_id, m.store_id::text AS store_id, m.effective_from, m.effective_to,
            m.published_in_revision::text AS published_in_revision, m.ended_in_revision::text AS ended_in_revision
       FROM price_zone_memberships m
      WHERE m.tenant_id = $1::uuid AND m.price_book_id = $2::uuid AND ($3::uuid IS NULL OR m.store_id = $3::uuid)
        AND ${VISIBLE_AT("m", "$4")}
      ORDER BY m.effective_from, m.id`,
    [key.tenantId, key.bookId, key.storeId, key.revision],
  );
  return r.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    priceBookId: row.price_book_id,
    priceZoneId: row.price_zone_id,
    storeId: row.store_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    publishedInRevision: Number(row.published_in_revision),
    endedInRevision: revisionNo(row.ended_in_revision),
  }));
}

/**
 * The `regular` events of `productIds` in `sellUnit` visible at `revision`; Store-scope ones only of
 * `storeId` (or of every Store when it is null).
 */
export async function loadEvents(
  client: Queryable,
  key: {
    tenantId: string;
    bookId: string;
    storeId: string | null;
    productIds: readonly string[];
    sellUnit: string;
    revision: number;
  },
): Promise<{ events: ResolutionPriceEvent[]; changeSetOf: Map<string, string> }> {
  const r = await client.query<EventRow>(
    `SELECT e.id::text AS id, e.tenant_id::text AS tenant_id, e.price_book_id::text AS price_book_id, e.scope,
            e.price_zone_id::text AS price_zone_id, e.store_id::text AS store_id, e.product_id::text AS product_id,
            e.sell_unit, e.price_kind, e.price::text AS price, e.time_basis, e.effective_from, e.effective_to,
            ${LOCAL_TEXT("e.effective_from_local")} AS effective_from_local,
            ${LOCAL_TEXT("e.effective_to_local")} AS effective_to_local,
            e.published_in_revision::text AS published_in_revision, e.ended_in_revision::text AS ended_in_revision,
            e.change_set_id::text AS change_set_id
       FROM price_events e
      WHERE e.tenant_id = $1::uuid AND e.price_book_id = $2::uuid AND e.product_id = ANY($3::uuid[])
        AND e.sell_unit = $4 AND e.price_kind = 'regular'
        AND (e.scope <> 'store' OR $5::uuid IS NULL OR e.store_id = $5::uuid)
        AND ${VISIBLE_AT("e", "$6")}
      ORDER BY e.id`,
    [key.tenantId, key.bookId, key.productIds, key.sellUnit, key.storeId, key.revision],
  );
  const changeSetOf = new Map<string, string>();
  const events = r.rows.map((row): ResolutionPriceEvent => {
    changeSetOf.set(row.id, row.change_set_id);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      priceBookId: row.price_book_id,
      scope: row.scope,
      priceZoneId: row.price_zone_id,
      storeId: row.store_id,
      productId: row.product_id,
      sellUnit: row.sell_unit,
      priceKind: row.price_kind,
      price: row.price,
      timeBasis: row.time_basis,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      effectiveFromLocal: wallClock(row.effective_from_local),
      effectiveToLocal: wallClock(row.effective_to_local),
      publishedInRevision: Number(row.published_in_revision),
      endedInRevision: revisionNo(row.ended_in_revision),
    };
  });
  return { events, changeSetOf };
}

/**
 * The pricing data of `productId` / `sellUnit` at `storeId` as known at `revision` (null: the
 * tenant has published none, so no membership or event is visible).
 */
export async function loadResolutionData(
  client: Queryable,
  key: { tenantId: string; storeId: string; productId: string; sellUnit: string; revision: number | null },
): Promise<LoadedResolutionData> {
  const book = await loadBook(client, key.tenantId);
  if (book === null || key.revision === null) return { book, memberships: [], events: [], changeSetOf: new Map() };
  const scoped = { ...key, bookId: book.id, revision: key.revision };
  const memberships = await loadMemberships(client, scoped);
  const { events, changeSetOf } = await loadEvents(client, { ...scoped, productIds: [key.productId] });
  return { book, memberships, events, changeSetOf };
}
