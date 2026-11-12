/**
 * The tenant access state read, shared by every enforcement point (RT-1353):
 * POS pairing-code issue and completion, the ERP posting row creation and the
 * ERP posting feed.
 *
 * The one rule: a tenant with NO `tenant_access_entitlements` row is
 * `unrestricted` (`0104`), so every existing tenant is unaffected. Only an
 * explicit `restricted` row restricts.
 *
 * Both readers run inside the tenant's RLS context, so a row of another tenant
 * is never visible; an unreadable row reads as no row, which is `unrestricted`
 * (fail open by the owner's rule: existing tenants must not change). The
 * writer of a `restricted` row (RT-1350) runs as a platform admin in the
 * tenant's context, so it can always see its own row.
 */
import type { Pool, PoolClient } from "pg";

import { runWithTenantContext } from "../middleware/tenant-context";
import type { TenantAccessState } from "../schema/tenant-access-entitlements";

/** The state inside an open tenant-scoped transaction. */
export async function readTenantAccessState(
  client: Pick<PoolClient, "query">,
  tenantId: string,
): Promise<TenantAccessState> {
  const r = await client.query<{ state: TenantAccessState }>(
    `SELECT state FROM tenant_access_entitlements WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  return r.rows[0]?.state ?? "unrestricted";
}

/** True when the tenant is `restricted`, in a short transaction under the tenant's own context. */
export async function isTenantRestricted(pool: Pool, tenantId: string): Promise<boolean> {
  return await runWithTenantContext(pool, { tenantId, isPlatformAdmin: false }, async (client) => {
    return (await readTenantAccessState(client, tenantId)) === "restricted";
  });
}
