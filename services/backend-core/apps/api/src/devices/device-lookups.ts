/**
 * RT-1484 — a read-only lookup of the tenant's devices for other modules, on the caller's client
 * inside its tenant transaction (RLS). The devices module owns `devices` (RT-1453), so Pricing asks
 * here how many active devices a Store has (the Impact Preview's `devices`, spec 042 §6).
 */
import type { PoolClient } from "pg";

/** Active (not retired) devices per Store of `storeIds`; a Store with none is absent. */
export async function activeDeviceCountsByStore(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  storeIds: readonly string[],
): Promise<Map<string, number>> {
  if (storeIds.length === 0) return new Map();
  const r = await client.query<{ store_id: string; n: number }>(
    `SELECT store_id::text AS store_id, count(*)::int AS n
       FROM devices
      WHERE tenant_id = $1::uuid AND store_id = ANY($2::uuid[]) AND retired_at IS NULL
      GROUP BY store_id`,
    [tenantId, storeIds],
  );
  return new Map(r.rows.map((row) => [row.store_id, row.n]));
}
