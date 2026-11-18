/**
 * The active ERPNext warehouse mappings of a store, as a public port of `catalog` (RT-1453).
 * Store deletion (its preview and its write: one evaluator) used to name `erpnext_warehouse_map` itself;
 * it asks this port instead, on the caller's client (so the caller's transaction and RLS context stay in
 * force). Active = not retired. The mapping is kept by a deletion (the ERP engine owns the accounting
 * side); the preview only states it.
 */
import type { PoolClient } from "pg";

/** The warehouse refs of the store's active mappings by id, capped at `limit` (a preview list, never a guard). */
export async function listActiveWarehouseRefsOfStore(client: PoolClient, storeId: string, limit: number): Promise<string[]> {
  const r = await client.query<{ ref: string }>(
    `SELECT erpnext_warehouse_ref AS ref FROM erpnext_warehouse_map
      WHERE store_id = $1 AND retired_at IS NULL ORDER BY id LIMIT $2`,
    [storeId, limit],
  );
  return r.rows.map((row) => row.ref);
}
