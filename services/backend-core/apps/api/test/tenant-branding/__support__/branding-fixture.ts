/**
 * RT-473 S2 — fixture for the tenant-branding HTTP spec.
 *
 * On top of the RT-192 read-store-scope seed (tenants A / B, the tenant-A
 * `all` owner SES_OWNER_ALL and the `specific` tenant_admin SES_ADMIN_SPEC),
 * adds:
 *
 *   tenant A  SES_MANAGER   store_manager (not an allowed role → 404)
 *   tenant B  SES_OWNER_B   owner, `all`
 *   devices   DEV_A (STORE_A_X) and DEV_B (STORE_B_X), each with a real
 *             pairing token (the `device` bearer).
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `0473`
 * mnemonic (hex only).
 */
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import type { Pool } from "pg";

import { seedConsoleMember } from "../../_helpers/console-members";
import type { PgTestEnv } from "../../_helpers/postgres-container";
import { STORE_A_X, STORE_B_X, TENANT_A, TENANT_B } from "../../catalog/__support__/isolation-harness";
import { seedReadStoreScope } from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";

const id = (n: string): string => `0a000000-0000-7000-8000-00000473${n}`;
const idB = (n: string): string => `0b000000-0000-7000-8000-00000473${n}`;

export const SES_MANAGER = id("01a1");
export const SES_OWNER_B = idB("01b1");
const USER_MANAGER = id("02a1");
const USER_OWNER_B = idB("02b1");

export const DEV_A = id("03a1");
export const DEV_B = idB("03b1");
export const TOKEN_A = generateRawToken();
export const TOKEN_B = generateRawToken();

/** The `all` owner of tenant A (the RT-192 seed's USER_OWNER_ALL). */
export const USER_OWNER_ALL = "0a000000-0000-7000-8000-0000019202a3";

async function seedMembers(admin: Pool): Promise<void> {
  await seedConsoleMember(admin, {
    tenantId: TENANT_A,
    userId: USER_MANAGER,
    email: "rt473-manager@example.test",
    membershipId: id("04a1"),
    roleId: id("05a1"),
    roleCode: "store_manager",
    stores: [STORE_A_X],
    sessions: { [SES_MANAGER]: null },
  });
  await seedConsoleMember(admin, {
    tenantId: TENANT_B,
    userId: USER_OWNER_B,
    email: "rt473-owner-b@example.test",
    membershipId: idB("04b1"),
    roleId: idB("05b1"),
    roleCode: "owner",
    stores: "all",
    sessions: { [SES_OWNER_B]: null },
  });
}

async function seedDevices(admin: Pool): Promise<void> {
  const devices = [
    { id: DEV_A, tenantId: TENANT_A, storeId: STORE_A_X, token: TOKEN_A },
    { id: DEV_B, tenantId: TENANT_B, storeId: STORE_B_X, token: TOKEN_B },
  ];
  await admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash, expires_at)
     SELECT d.id, d.tenant_id, d.store_id, 'RT-473 till', d.token_hash, now() + interval '30 days'
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::bytea[]) AS d(id, tenant_id, store_id, token_hash)`,
    [devices.map((d) => d.id), devices.map((d) => d.tenantId), devices.map((d) => d.storeId), devices.map((d) => hashToken(d.token))],
  );
}

export async function seedBrandingFixture(env: PgTestEnv): Promise<void> {
  await seedReadStoreScope(env);
  await seedMembers(env.admin);
  await seedDevices(env.admin);
}

/** Admin-pool counts of a tenant's stored logo rows and renditions. */
export async function storedCounts(admin: Pool, tenantId: string): Promise<{ logos: number; renditions: number }> {
  const r = await admin.query<{ logos: string; renditions: string }>(
    `SELECT (SELECT count(*) FROM tenant_logos WHERE tenant_id = $1)::text AS logos,
            (SELECT count(*) FROM tenant_logo_renditions WHERE tenant_id = $1)::text AS renditions`,
    [tenantId],
  );
  return { logos: Number(r.rows[0]!.logos), renditions: Number(r.rows[0]!.renditions) };
}

/** Admin-pool audit rows of one action for a tenant, oldest first. */
export async function logoAudits(
  admin: Pool,
  tenantId: string,
  action: string,
): Promise<Array<{ actor_user_id: string | null; target_id: string; metadata: Record<string, unknown> }>> {
  const r = await admin.query(
    `SELECT actor_user_id, target_id::text AS target_id, metadata
       FROM audit_events WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
    [tenantId, action],
  );
  return r.rows;
}

/** The tenant's display name as stored. */
export async function tenantName(admin: Pool, tenantId: string): Promise<string> {
  const r = await admin.query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
  return r.rows[0]!.name;
}
