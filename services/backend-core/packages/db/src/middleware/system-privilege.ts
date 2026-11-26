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
 *   provisioner_lookup  the provisioner bearer verifier: erp_provisioner_credential S;
 *   membership_bootstrap (0120, RT-1457) the request bootstrap reads of the auth and context
 *                       guards: SELECT only on memberships, roles, tenants, stores, store_access.
 *   pricing_legacy_import (0123, RT-1485) the legacy price import CLI: the only path that may
 *                       write a `legacy_import` Change Set (0123 change_sets_assert_legacy_import).
 *                       No RLS policy names it; every row is reached through the tenant pin.
 *
 * Every other table is reached through the tenant pin (`tenantId`), exactly like a
 * tenant session. The setting holds one value at a time, so the privileges
 * are mutually exclusive. Like `runAsProvisioner` (RT-1358), this always opens the
 * transaction with `app.is_platform_admin = 'false'`, reads the settings back and
 * fails closed if they did not hold. It never sets `app.is_provisioner`.
 *
 * No 0111 policy names `app.is_platform_admin`, so none of these sessions reaches a
 * platform-admin policy (the 0110 cross-tenant SELECT among them). A fence test pins
 * this file as the only setter and each narrow value (all but `membership_bootstrap`) to its one
 * call site; `membership_bootstrap` is shared by the request bootstrap reads (RT-1457).
 */
import type { Pool, PoolClient } from "pg";

import { runWithTenantContext } from "./tenant-context";

export type SystemPrivilege = "signup" | "provisioning_sweep" | "provisioner_lookup" | "membership_bootstrap" | "pricing_legacy_import";

const PRIVILEGES: ReadonlySet<string> = new Set<SystemPrivilege>([
  "signup",
  "provisioning_sweep",
  "provisioner_lookup",
  "membership_bootstrap",
  "pricing_legacy_import",
]);

export interface SystemContext {
  /** The tenant to pin (tenant-scoped reads and writes), or null for none (the NIL tenant). */
  readonly tenantId: string | null;
  readonly privilege: SystemPrivilege;
}

export async function runWithSystemPrivilege<T>(pool: Pool, ctx: SystemContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!PRIVILEGES.has(ctx.privilege)) throw new Error("runWithSystemPrivilege: unknown privilege");
  // `runWithTenantContext` validates the tenant id, opens the transaction and sets `app.is_platform_admin = 'false'`.
  return await runWithTenantContext(pool, { tenantId: ctx.tenantId, isPlatformAdmin: false }, async (client) => {
    // RT-1461: one round trip. `priv` is set_config's own return value (the value it applied), so the
    // check never depends on the order Postgres evaluates the select list. The platform-admin and
    // provisioner flags were set by earlier statements of this transaction and this statement does not
    // touch them, so their reads are order-independent too. Verification is unchanged: any mismatch throws.
    const check = await client.query<{ admin: string | null; priv: string | null; prov: string | null }>(
      `SELECT set_config('app.system_privilege', $1, true) AS priv,
              current_setting('app.is_platform_admin', true) AS admin,
              coalesce(current_setting('app.is_provisioner', true), '') AS prov`,
      [ctx.privilege],
    );
    const row = check.rows[0];
    if (row?.admin !== "false" || row.priv !== ctx.privilege || row.prov === "true") {
      throw new Error("system privilege context: the settings did not hold");
    }
    return await work(client);
  });
}
