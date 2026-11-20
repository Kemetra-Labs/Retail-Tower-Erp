/**
 * Every tenant id (any status), read as platform admin. Shared by the
 * per-tenant sweeps whose tables have tenant-only policies and no
 * platform-admin branch: the cashier-admission replay purge (RT-209) and the
 * catalogue import retention job (RT-1503).
 *
 * It reads tenant ids and nothing else, through the `tenants` policy's
 * is_platform_admin branch (the RT-179 stock sweep's boundary); each sweep
 * then works under one tenant's own GUC. Every tenant is listed, whatever its
 * status: a suspended or deleted tenant's data still ages out.
 *
 * One site for this read keeps the RT-1389 platform-admin ratchet
 * (system-privilege-fences.spec.ts) from growing with each new sweep.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

export function listAllTenantIds(pool: Pool): Promise<string[]> {
  return runWithTenantContext(pool, { tenantId: null, isPlatformAdmin: true }, async (client) => {
    const r = await client.query<{ id: string }>(`SELECT id FROM tenants ORDER BY id`);
    return r.rows.map((row) => row.id);
  });
}
