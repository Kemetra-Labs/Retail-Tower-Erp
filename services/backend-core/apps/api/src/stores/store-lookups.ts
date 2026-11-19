/**
 * RT-1484 — read-only lookups of the tenant's live stores (`deleted_at IS NULL`) for other
 * modules, on the caller's client and inside its tenant transaction (RLS). The `stores` module
 * owns the table (RT-1453), so a module that must enumerate or check stores asks here instead of
 * naming the table in its own SQL.
 */
import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

/** Whether `storeId` is a live store of `tenantId`. */
export async function isLiveStore(client: Queryable, tenantId: string, storeId: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM stores WHERE tenant_id = $1::uuid AND id = $2::uuid AND deleted_at IS NULL`,
    [tenantId, storeId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Up to `limit` live store ids of `tenantId`, ascending, strictly after `after` (keyset), limited
 * to `storeIds` when that is not null (an empty list reads nothing: fail closed).
 */
export async function liveStoreIdsAfter(
  client: Queryable,
  tenantId: string,
  page: { readonly after: string | null; readonly storeIds: readonly string[] | null; readonly limit: number },
): Promise<string[]> {
  const r = await client.query<{ id: string }>(
    `SELECT id::text AS id
       FROM stores
      WHERE tenant_id = $1::uuid
        AND deleted_at IS NULL
        AND ($2::uuid IS NULL OR id > $2::uuid)
        AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
      ORDER BY id
      LIMIT $4`,
    [tenantId, page.after, page.storeIds, page.limit],
  );
  return r.rows.map((row) => row.id);
}
