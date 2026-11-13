/**
 * RT-1358 — the ONLY place that sets `app.is_provisioner` (migration 0109, note 1
 * of the #569 review: the setting is enforced by code, not by the database).
 *
 * `runAsProvisioner` is used on the provisioner-bearer path only. It always sets
 * `app.is_platform_admin = 'false'` in the same transaction and reads both
 * settings back, so a provisioner session can never be a platform admin too.
 * The provisioner policies of the three 0109 tables are the only ones that read
 * the setting, so this session cannot write `tenant_access_entitlements` or any
 * other table. The bearer verifier and the platform-admin credential routes use
 * `runWithTenantContext` (platform admin) and never touch this setting.
 *
 * A fence test pins that this file is the only source file naming the setting.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runAsProvisioner<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  // `runWithTenantContext` opens the transaction and sets the NIL tenant and `app.is_platform_admin = 'false'`.
  return await runWithTenantContext(pool, { tenantId: null, isPlatformAdmin: false }, async (client) => {
    await client.query("SELECT set_config('app.is_provisioner', 'true', true)");
    const check = await client.query<{ admin: string; prov: string }>(
      `SELECT current_setting('app.is_platform_admin', true) AS admin, current_setting('app.is_provisioner', true) AS prov`,
    );
    if (check.rows[0]?.admin !== "false" || check.rows[0]?.prov !== "true") {
      throw new Error("provisioner context: the settings did not hold");
    }
    return await work(client);
  });
}

/**
 * Point the provisioner transaction at one tenant, for the tenant-scoped reads
 * and writes of one request (auth_tokens, connector_registration, audit). The
 * provisioner policies stay cross-tenant; this only satisfies the tenant
 * isolation policies of the other tables, with the tenant of a request row the
 * service has already locked (never a caller-supplied id).
 */
export async function pointAtTenant(client: PoolClient, tenantId: string): Promise<void> {
  if (!UUID_RE.test(tenantId)) throw new Error("pointAtTenant: tenantId must be a UUID");
  await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
}
