/**
 * RT-1577 (RT-1511 S2) — the Available-to-Sell facts of a PAGE of products at one store, for `posGetStoreAvailability`.
 * The set-based twin of `availability.query.ts` (one product): the same predicates (`availability.sql.ts`), restricted to
 * the page's product ids, so a 500-product page reads only those products' movements and reservations through the
 * `(tenant_id, store_id, tenant_product_ref)` index and never the whole store.
 *
 * ONE statement, so `asOf` (the clock of that statement) and every figure come from one snapshot. It always returns at
 * least one row, even for an empty id list, so a page with no products still has its `asOf`. A product with no movement
 * reads zero. In Transit is not read: the till does not show it, and it never enters ATS (A-6).
 */
import type { PoolClient } from 'pg';

import type { SnapshotFacts } from './availability.rules';
import { LOT_EXPIRED_SQL, MOVEMENT_SELLABLE_AT_PRIMARY_SQL, RESERVATION_ACTIVE_SQL } from './availability.sql';

interface FactsRow {
  readonly as_of: Date;
  readonly product_id: string | null;
  readonly primary_sellable: string;
  readonly expired_tracked_sellable: string;
  readonly active_reserved: string;
}

const PAGE_FACTS_SQL = `
  WITH loc AS (
    SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'
  ),
  biz AS (SELECT store_business_date($1) AS d),
  stock AS (
    SELECT m.tenant_product_ref AS product_id,
           SUM(m.quantity) AS total,
           COALESCE(SUM(m.quantity) FILTER (WHERE ${LOT_EXPIRED_SQL}), 0) AS expired
      FROM loc
      CROSS JOIN biz
      JOIN stock_movements m
        ON m.store_id = $1
       AND m.tenant_product_ref = ANY($2::uuid[])
       AND ${MOVEMENT_SELLABLE_AT_PRIMARY_SQL}
      LEFT JOIN tracking_identities ti ON ti.id = m.tracking_identity_id
     GROUP BY m.tenant_product_ref
  ),
  reserved AS (
    SELECT r.tenant_product_ref AS product_id, SUM(r.quantity) AS total
      FROM loc
      JOIN inventory_reservations r
        ON r.store_id = $1
       AND r.tenant_product_ref = ANY($2::uuid[])
       AND r.stock_location_id = loc.id
       AND ${RESERVATION_ACTIVE_SQL}
     GROUP BY r.tenant_product_ref
  )
  SELECT t.as_of,
         i.product_id,
         COALESCE(stock.total, 0)::numeric(19,4)::text AS primary_sellable,
         COALESCE(stock.expired, 0)::numeric(19,4)::text AS expired_tracked_sellable,
         COALESCE(reserved.total, 0)::numeric(19,4)::text AS active_reserved
    FROM (SELECT clock_timestamp() AS as_of) t
    LEFT JOIN (SELECT unnest($2::uuid[]) AS product_id) i ON true
    LEFT JOIN stock ON stock.product_id = i.product_id
    LEFT JOIN reserved ON reserved.product_id = i.product_id`;

/** The facts of each requested product, and the instant they were read. */
export async function readAvailabilityFactsOfPage(
  client: PoolClient,
  input: { readonly storeId: string; readonly productIds: readonly string[] },
): Promise<{ readonly asOf: Date; readonly byProduct: ReadonlyMap<string, SnapshotFacts> }> {
  const result = await client.query<FactsRow>(PAGE_FACTS_SQL, [input.storeId, input.productIds]);
  const byProduct = new Map<string, SnapshotFacts>();
  for (const row of result.rows) {
    if (row.product_id === null) continue;
    byProduct.set(row.product_id, {
      primarySellable: row.primary_sellable,
      expiredTrackedSellable: row.expired_tracked_sellable,
      activeReserved: row.active_reserved,
    });
  }
  // The `t` row always exists (an empty id list still LEFT JOINs it), so `as_of` is always present.
  return { asOf: (result.rows[0] as FactsRow).as_of, byProduct };
}
