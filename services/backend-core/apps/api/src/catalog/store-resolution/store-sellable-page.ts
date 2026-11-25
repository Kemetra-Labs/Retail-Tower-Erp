/**
 * RT-1577 (RT-1511 S2) — one keyset page of a store's SELLABLE catalogue with each product's active low-stock level, the
 * catalog's port for the POS availability snapshot (`inventory/availability`, `posGetStoreAvailability`).
 *
 * The product set is the read-down's, by construction: the same resolver fragments (`Tenant ⊕ Store Override`, 003 §6.4)
 * and the same predicate (`classifyResolvedSellability`), so the two POS feeds never disagree on which products a store
 * sells. Runs on the caller's tenant-scoped client; it pins `app.current_store` itself (the override rows are RLS'd by
 * store).
 *
 * Paging follows the SCANNED products, not the emitted ones (the read-down's RT-394 rule): a page can hold fewer sellable
 * products than `limit`, even none, and still say that more follow, so an excluded product never ends the walk early.
 *
 * The low-stock level is `product_stock_levels.reorder_level` (0078): the store's active level when it has one, otherwise
 * the tenant default, the same resolution the low-stock list uses. `null` when neither is set.
 */
import type { PoolClient } from "pg";

import {
  classifyResolvedSellability,
  pinOverrideStore,
  RESOLVED_STORE_COLUMNS_SQL,
  storeOverrideJoinSql,
  type ResolvedStoreColumns,
} from "./store-product-resolution";

/** One sellable product of the page. */
interface SellableStoreProduct {
  readonly productId: string;
  /** The active low-stock level (`numeric(19,4)::text`), or null when the store and the tenant set none. */
  readonly lowStockLevel: string | null;
}

/** One page of the store's sellable catalogue. */
interface StoreSellablePage {
  readonly items: readonly SellableStoreProduct[];
  /** The last product SCANNED (sellable or not): the next page starts after it. Null when nothing was scanned. */
  readonly lastScannedProductId: string | null;
  /** True when products beyond the scanned ones exist. */
  readonly hasMore: boolean;
}

interface ScanRow extends ResolvedStoreColumns {
  readonly product_id: string;
  readonly retired_at: Date | null;
  readonly low_stock_level: string | null;
}

/** The scan of the tenant's products at store $2 that pass `filter` (on `tp`), in product id order. */
const scanSql = (filter: string): string => `
  SELECT tp.id AS product_id,
         tp.retired_at AS retired_at,
         ${RESOLVED_STORE_COLUMNS_SQL},
         (SELECT psl.reorder_level::text
            FROM product_stock_levels psl
           WHERE psl.tenant_id = tp.tenant_id
             AND psl.product_id = tp.id
             AND psl.retired_at IS NULL
             AND (psl.store_id = $2 OR psl.store_id IS NULL)
           ORDER BY psl.store_id NULLS LAST
           LIMIT 1) AS low_stock_level
    FROM tenant_products tp
    ${storeOverrideJoinSql("$2")}
   WHERE tp.tenant_id = $1
     AND ${filter}
   ORDER BY tp.id`;

const PAGE_SQL = `${scanSql("($3::uuid IS NULL OR tp.id > $3::uuid)")}
   LIMIT $4`;

/** RT-1600: the same scan, restricted to named products. */
const BY_IDS_SQL = scanSql("tp.id = ANY($3::uuid[])");

const sellableOf = (rows: readonly ScanRow[]): SellableStoreProduct[] =>
  rows
    .filter((row) => classifyResolvedSellability(row).kind === "sellable")
    .map((row) => ({ productId: row.product_id, lowStockLevel: row.low_stock_level }));

/** Scan `limit` products after `afterProductId` (null = from the start) and keep the sellable ones. */
export async function readStoreSellablePage(
  client: PoolClient,
  input: { readonly tenantId: string; readonly storeId: string; readonly afterProductId: string | null; readonly limit: number },
): Promise<StoreSellablePage> {
  await pinOverrideStore(client, input.storeId);
  // Over-fetch by one: the extra row only says whether another page follows.
  const result = await client.query<ScanRow>(PAGE_SQL, [input.tenantId, input.storeId, input.afterProductId, input.limit + 1]);
  const scanned = result.rows.slice(0, input.limit);
  return {
    items: sellableOf(scanned),
    lastScannedProductId: scanned.at(-1)?.product_id ?? null,
    hasMore: result.rows.length > input.limit,
  };
}

/**
 * RT-1600: which of `productIds` the store sells, with each one's low-stock level: the page's product set and level
 * rule, for a caller that needs a few named products (the W9 redistribution accept re-check) rather than the whole
 * catalogue. Pins `app.current_store` like the page read.
 */
export async function readStoreSellableProducts(
  client: PoolClient,
  input: { readonly tenantId: string; readonly storeId: string; readonly productIds: readonly string[] },
): Promise<SellableStoreProduct[]> {
  if (input.productIds.length === 0) return [];
  await pinOverrideStore(client, input.storeId);
  const result = await client.query<ScanRow>(BY_IDS_SQL, [input.tenantId, input.storeId, input.productIds]);
  return sellableOf(result.rows);
}
