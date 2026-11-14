/**
 * RT-1389 — the ONLY place that sets `app.system_privilege` (migration 0111).
 *
 * Three non-human paths used to borrow the human platform-admin flag
 * (`app.is_platform_admin = 'true'`) to pass row-level security. After 0110 that
 * flag also reads every tenant's `tenant_access_entitlements` row, so each path
 * now runs with its own narrow privilege instead:
 *
 *   signup              public self-signup (request and completion): pending_signups
 *                       S/I/U, user_consents S/I, and the one `restricted` entitlement
 *                       INSERT pinned to the new tenant;
 *   provisioning_sweep  the worker sweep: erp_provisioning_request S/U;
 *   provisioner_lookup  the provisioner bearer verifier: erp_provisioner_credential S.
 *
 * Every other table is reached through the tenant pin (`tenantId`), exactly like a
 * tenant session. The setting holds one value at a time, so the three privileges
 * are mutually exclusive. Like `runAsProvisioner` (RT-1358), this always opens the
 * transaction with `app.is_platform_admin = 'false'`, reads the settings back and
 * fails closed if they did not hold. It never sets `app.is_provisioner`.
 *
 * No 0111 policy names `app.is_platform_admin`, so none of these sessions reaches a
 * platform-admin policy (the 0110 cross-tenant SELECT among them). A fence test pins
 * this file as the only setter and each value to its one call site.
 */
import type { Pool, PoolClient } from "pg";

import { runWithTenantContext } from "./tenant-context";

export type SystemPrivilege = "signup" | "provisioning_sweep" | "provisioner_lookup";

const PRIVILEGES: ReadonlySet<string> = new Set<SystemPrivilege>(["signup", "provisioning_sweep", "provisioner_lookup"]);

export interface SystemContext {
  /** The tenant to pin (tenant-scoped reads and writes), or null for none (the NIL tenant). */
  readonly tenantId: string | null;
  readonly privilege: SystemPrivilege;
}

export async function runWithSystemPrivilege<T>(pool: Pool, ctx: SystemContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!PRIVILEGES.has(ctx.privilege)) throw new Error("runWithSystemPrivilege: unknown privilege");
  // `runWithTenantContext` validates the tenant id, opens the transaction and sets `app.is_platform_admin = 'false'`.
  return await runWithTenantContext(pool, { tenantId: ctx.tenantId, isPlatformAdmin: false }, async (client) => {
    await client.query("SELECT set_config('app.system_privilege', $1, true)", [ctx.privilege]);
    const check = await client.query<{ admin: string | null; priv: string | null; prov: string | null }>(
      `SELECT current_setting('app.is_platform_admin', true) AS admin,
              current_setting('app.system_privilege', true) AS priv,
              coalesce(current_setting('app.is_provisioner', true), '') AS prov`,
    );
    const row = check.rows[0];
    if (row?.admin !== "false" || row.priv !== ctx.privilege || row.prov === "true") {
      throw new Error("system privilege context: the settings did not hold");
    }
    return await work(client);
  });
}
