/**
 * RT-1138: fixture for the cashier suspension HTTP spec.
 *
 * On top of the RT-192 read-store-scope seed (tenants A / B, STORE_A_X / STORE_A_Y
 * / STORE_B_X, the tenant-A `all` owner SES_OWNER_ALL, SES_OWNER_ALL_ACTIVE with
 * STORE_A_X active, and the `specific` tenant_admin SES_ADMIN_SPEC granted
 * STORE_A_X only), adds:
 *
 *   tenant A  SES_MANAGER   store_manager (`all`)
 *   tenant A  SES_STAFF     store_staff (a session, and also a cashier)
 *   tenant A  CASHIER_ALL   store_staff reaching every store
 *   tenant A  CASHIER_X     store_staff granted STORE_A_X only
 *   tenant A  CASHIER_Y     store_staff granted STORE_A_Y only
 *   tenant B  SES_OWNER_B   owner
 *   tenant B  CASHIER_B     store_staff (`all`)
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `1138`
 * mnemonic (hex only).
 */
import type { Pool } from "pg";

import { seedConsoleMember } from "../../_helpers/console-members";
import type { PgTestEnv } from "../../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, TENANT_A, TENANT_B } from "../../catalog/__support__/isolation-harness";
import { seedReadStoreScope } from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";

const id = (n: string): string => `0a000000-0000-7000-8000-00001138${n}`;
const idB = (n: string): string => `0b000000-0000-7000-8000-00001138${n}`;

export const SES_MANAGER = id("01a1");
export const SES_STAFF = id("01a2");
export const SES_OWNER_B = idB("01b1");

export const USER_MANAGER = id("02a1");
export const USER_STAFF = id("02a2");
export const CASHIER_ALL = id("02a3");
export const CASHIER_X = id("02a4");
export const CASHIER_Y = id("02a5");
export const CASHIER_B = idB("02b2");
export const UNKNOWN_USER = id("0fff");
export const UNKNOWN_STORE = id("0ffe");

export async function seedSuspensionFixture(env: PgTestEnv): Promise<void> {
  await seedReadStoreScope(env);
  const members = [
    { tenantId: TENANT_A, userId: USER_MANAGER, n: "a1", roleCode: "store_manager", stores: "all", sessions: { [SES_MANAGER]: null }, make: id },
    { tenantId: TENANT_A, userId: USER_STAFF, n: "a2", roleCode: "store_staff", stores: "all", sessions: { [SES_STAFF]: null }, make: id },
    { tenantId: TENANT_A, userId: CASHIER_ALL, n: "a3", roleCode: "store_staff", stores: "all", sessions: {}, make: id },
    { tenantId: TENANT_A, userId: CASHIER_X, n: "a4", roleCode: "store_staff", stores: [STORE_A_X], sessions: {}, make: id },
    { tenantId: TENANT_A, userId: CASHIER_Y, n: "a5", roleCode: "store_staff", stores: [STORE_A_Y], sessions: {}, make: id },
    { tenantId: TENANT_B, userId: idB("02b1"), n: "b1", roleCode: "owner", stores: "all", sessions: { [SES_OWNER_B]: null }, make: idB },
    { tenantId: TENANT_B, userId: CASHIER_B, n: "b2", roleCode: "store_staff", stores: "all", sessions: {}, make: idB },
  ] as const;
  for (const m of members) {
    await seedConsoleMember(env.admin, {
      tenantId: m.tenantId,
      userId: m.userId,
      email: `rt1138-${m.n}@example.test`,
      membershipId: m.make(`04${m.n}`),
      roleId: m.make(`05${m.n}`),
      roleCode: m.roleCode,
      stores: m.stores,
      sessions: m.sessions,
    });
  }
}

/** Admin-pool: the stored row of a cashier at a store (null: never suspended). */
export async function suspensionRow(
  admin: Pool,
  tenantId: string,
  storeId: string,
  userId: string,
): Promise<{ status: string; changed_by_user_id: string } | null> {
  const r = await admin.query(
    `SELECT status, changed_by_user_id FROM cashier_suspensions WHERE tenant_id = $1 AND store_id = $2 AND user_id = $3`,
    [tenantId, storeId, userId],
  );
  return r.rows[0] ?? null;
}

/** Admin-pool: remove every row of a tenant (the test reset; the application never deletes one). */
export async function clearSuspensions(admin: Pool, tenantId: string): Promise<void> {
  await admin.query(`DELETE FROM cashier_suspensions WHERE tenant_id = $1`, [tenantId]);
}

/** Admin-pool audit rows of one action for a tenant, oldest first. */
export async function suspensionAudits(
  admin: Pool,
  tenantId: string,
  action: string,
): Promise<Array<{ actor_user_id: string | null; store_id: string | null; target_type: string; target_id: string; metadata: Record<string, unknown> | null }>> {
  const r = await admin.query(
    `SELECT actor_user_id, store_id, target_type, target_id::text AS target_id, metadata
       FROM audit_events WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
    [tenantId, action],
  );
  return r.rows;
}
