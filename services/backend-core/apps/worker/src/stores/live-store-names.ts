/**
 * RT-1525 — the worker's read of live (not deleted) stores, owned by `stores` (module-map.json).
 *
 * Runs on the CALLER's client, so the caller's transaction and tenant GUC stay in force.
 */
import type { PoolClient } from "pg";

/** The name of each of `storeIds` that is the tenant's and not deleted; a deleted or foreign id is absent. */
export async function liveStoreNames(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  storeIds: readonly string[],
): Promise<Map<string, string>> {
  if (storeIds.length === 0) return new Map();
  const r = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM stores WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
    [tenantId, storeIds],
  );
  return new Map(r.rows.map((row) => [row.id, row.name]));
}
