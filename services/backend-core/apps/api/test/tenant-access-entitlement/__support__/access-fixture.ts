/**
 * RT-1353 — fixture for the tenant access entitlement HTTP spec.
 *
 * On top of the RT-192 read-store-scope seed (tenants A / B, the tenant-A `all`
 * owner SES_OWNER_ALL and the `specific` tenant_admin SES_ADMIN_SPEC), adds:
 *
 *   tenant A  SES_MANAGER   store_manager
 *   tenant A  SES_STAFF     store_staff (no role of the read)
 *   tenant B  SES_OWNER_B   owner
 *   tenant B  SES_PLATFORM  a platform admin who is a tenant_admin MEMBER of tenant B
 *                           only (so a call on tenant A proves "any tenant")
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `1353`
 * mnemonic (hex only).
 */
import type { Pool } from "pg";

import { seedConsoleMember } from "../../_helpers/console-members";
import type { PgTestEnv } from "../../_helpers/postgres-container";
import { STORE_A_X, TENANT_A, TENANT_B } from "../../catalog/__support__/isolation-harness";
import { seedReadStoreScope } from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";

const id = (n: string): string => `0a000000-0000-7000-8000-00001353${n}`;
const idB = (n: string): string => `0b000000-0000-7000-8000-00001353${n}`;

export const SES_MANAGER = id("01a1");
export const SES_STAFF = id("01a2");
export const SES_OWNER_B = idB("01b1");
export const SES_PLATFORM = idB("01b2");
export const USER_PLATFORM = idB("02b2");
export const UNKNOWN_TENANT = id("0fff");

export async function seedAccessFixture(env: PgTestEnv): Promise<void> {
  await seedReadStoreScope(env);
  const members = [
    { tenantId: TENANT_A, userId: id("02a1"), n: "a1", roleCode: "store_manager", session: SES_MANAGER, make: id },
    { tenantId: TENANT_A, userId: id("02a2"), n: "a2", roleCode: "store_staff", session: SES_STAFF, make: id },
    { tenantId: TENANT_B, userId: idB("02b1"), n: "b1", roleCode: "owner", session: SES_OWNER_B, make: idB },
    { tenantId: TENANT_B, userId: USER_PLATFORM, n: "b2", roleCode: "tenant_admin", session: SES_PLATFORM, make: idB },
  ] as const;
  for (const m of members) {
    await seedConsoleMember(env.admin, {
      tenantId: m.tenantId,
      userId: m.userId,
      email: `rt1353-${m.n}@example.test`,
      membershipId: m.make(`04${m.n}`),
      roleId: m.make(`05${m.n}`),
      roleCode: m.roleCode,
      stores: m.tenantId === TENANT_A ? [STORE_A_X] : "all",
      sessions: { [m.session]: null },
    });
  }
  await env.admin.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [USER_PLATFORM]);
}

/** Admin-pool: the stored row of a tenant (or null: no row = unrestricted). */
export async function accessRow(admin: Pool, tenantId: string): Promise<Record<string, unknown> | null> {
  const r = await admin.query(`SELECT * FROM tenant_access_entitlements WHERE tenant_id = $1`, [tenantId]);
  return r.rows[0] ?? null;
}

/** Admin-pool: a plain `restricted` row. */
export async function restrict(admin: Pool, tenantId: string): Promise<void> {
  await admin.query(`INSERT INTO tenant_access_entitlements (tenant_id, state) VALUES ($1, 'restricted')`, [tenantId]);
}

/** Admin-pool: remove the row (the test reset; the application never deletes one). */
export async function clearAccess(admin: Pool, tenantId: string): Promise<void> {
  await admin.query(`DELETE FROM tenant_access_entitlements WHERE tenant_id = $1`, [tenantId]);
}

/** Admin-pool audit rows of one action for a tenant, oldest first. */
export async function accessAudits(
  admin: Pool,
  tenantId: string,
  action: string,
): Promise<Array<{ actor_user_id: string | null; target_id: string; metadata: Record<string, unknown> | null }>> {
  const r = await admin.query(
    `SELECT actor_user_id, target_id::text AS target_id, metadata
       FROM audit_events WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
    [tenantId, action],
  );
  return r.rows;
}
