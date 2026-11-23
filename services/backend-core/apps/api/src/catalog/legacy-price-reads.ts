/**
 * RT-1485 PR-16a-2a — read-only reads of the legacy price columns for the Pricing legacy import
 * (spec 044 §4.2, §4.3, §4.5), on the caller's client inside its tenant transaction (RLS). The
 * catalog module owns `tenant_products`, `store_product_overrides`, `price_history` and
 * `catalog_change_log`, so Pricing asks here instead of naming the tables. Nothing here writes.
 */
import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

/** A priced live tenant product (`retired_at IS NULL AND default_price IS NOT NULL`). */
export interface LegacyTenantPrice {
  readonly productId: string;
  readonly price: string;
  readonly currencyCode: string;
}

/** A priced live override (`retired_at IS NULL AND price IS NOT NULL`). */
export interface LegacyOverridePrice extends LegacyTenantPrice {
  readonly storeId: string;
}

/**
 * The tenant's priced live legacy rows, ordered by product (and Store), so a plan is deterministic.
 * The import reads every Store's overrides, so it sets the tenant-wide store GUC (`'*'`) for the
 * rest of the caller's transaction, as the console catalogue detail does: `store_product_overrides`
 * otherwise shows no row when `app.current_store` is empty (0011 carve-out, fail closed).
 */
export async function readLegacyPrices(
  client: Queryable,
  tenantId: string,
): Promise<{ book: LegacyTenantPrice[]; store: LegacyOverridePrice[] }> {
  const book = await client.query<LegacyTenantPrice>(
    `SELECT id::text AS "productId", default_price::text AS price, default_currency_code AS "currencyCode"
       FROM tenant_products
      WHERE tenant_id = $1::uuid AND retired_at IS NULL AND default_price IS NOT NULL
      ORDER BY id`,
    [tenantId],
  );
  await client.query("SELECT set_config('app.current_store', '*', true)");
  const store = await client.query<LegacyOverridePrice>(
    `SELECT store_id::text AS "storeId", product_id::text AS "productId", price::text AS price, currency_code AS "currencyCode"
       FROM store_product_overrides
      WHERE tenant_id = $1::uuid AND retired_at IS NULL AND price IS NOT NULL
      ORDER BY product_id, store_id`,
    [tenantId],
  );
  return { book: book.rows, store: store.rows };
}

/** The import watermark (§4.3 step 2): the tenant's highest `catalog_change_log.sequence`, 0 when none. */
export async function catalogChangeLogHead(client: Queryable, tenantId: string): Promise<number> {
  const r = await client.query<{ head: string }>(
    `SELECT COALESCE(max(sequence), 0)::text AS head FROM catalog_change_log WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  return Number(r.rows[0]?.head ?? "0");
}

/** How many `price_history` rows the tenant has (§4.5: expected 0, F2). */
export async function legacyPriceHistoryCount(client: Queryable, tenantId: string): Promise<number> {
  const r = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM price_history WHERE tenant_id = $1::uuid`, [tenantId]);
  return Number(r.rows[0]?.n ?? "0");
}
