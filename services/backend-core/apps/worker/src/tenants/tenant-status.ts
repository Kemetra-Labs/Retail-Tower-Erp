/**
 * RT-1525 — the worker's read of a tenant's status, owned by `tenants` (module-map.json).
 *
 * Runs on the CALLER's client, so the caller's transaction and tenant GUC stay in force.
 */
import type { PoolClient } from "pg";

/** Whether the tenant is active and not deleted. */
export async function isTenantActive(client: Pick<PoolClient, "query">, tenantId: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM tenants WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, [tenantId]);
  return (r.rowCount ?? 0) > 0;
}
