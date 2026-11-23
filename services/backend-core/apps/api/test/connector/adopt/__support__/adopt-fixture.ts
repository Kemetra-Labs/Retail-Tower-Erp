/**
 * RT-1557 — fixture for the connector adoption HTTP spec.
 *
 * On top of the RT-1353 access fixture (tenants A / B; tenant-A owner `SES_OWNER_ALL` and
 * tenant_admin `SES_ADMIN_SPEC`; `SES_PLATFORM`, a platform admin who is a member of tenant B only,
 * so a call on tenant A proves "any tenant"), adds a SECOND platform admin (`SES_PLATFORM_2`) for the
 * "adopted by someone else" case, and a seeder of connector registrations in any state.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `1557` mnemonic (hex only).
 */
import type { Pool } from "pg";

import { seedConsoleMember } from "../../../_helpers/console-members";
import type { PgTestEnv } from "../../../_helpers/postgres-container";
import { TENANT_B } from "../../../catalog/__support__/isolation-harness";
import { seedAccessFixture, USER_PLATFORM } from "../../../tenant-access-entitlement/__support__/access-fixture";

const idB = (n: string): string => `0b000000-0000-7000-8000-00001557${n}`;

export const SES_PLATFORM_2 = idB("01b3");
export const USER_PLATFORM_2 = idB("02b3");
export const UNKNOWN_REGISTRATION = idB("0fff");
export { USER_PLATFORM };

export async function seedAdoptFixture(env: PgTestEnv): Promise<void> {
  await seedAccessFixture(env);
  await seedConsoleMember(env.admin, {
    tenantId: TENANT_B,
    userId: USER_PLATFORM_2,
    email: "rt1557-b3@example.test",
    membershipId: idB("04b3"),
    roleId: idB("05b3"),
    roleCode: "tenant_admin",
    stores: "all",
    sessions: { [SES_PLATFORM_2]: null },
  });
  await env.admin.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [USER_PLATFORM_2]);
}

export interface RegistrationSeed {
  readonly tenantId: string;
  readonly managedBy?: "provisioner";
  readonly disabled?: boolean;
}

let counter = 0;

/** Admin-pool: a fresh registration (a unique id and site ref per call); returns its id. Never deleted (a unique id per test). */
export async function seedRegistration(admin: Pool, seed: RegistrationSeed): Promise<string> {
  counter += 1;
  const suffix = String(counter).padStart(4, "0");
  const id = `0c000000-0000-7000-8000-00001557${suffix}`;
  await admin.query(
    `INSERT INTO connector_registration
       (id, tenant_id, display_name, erpnext_site_ref, environment, created_by, managed_by, disabled_at, disabled_by)
     VALUES ($1, $2, $3, $4, 'pilot', $5, $6, $7, $8)`,
    [
      id,
      seed.tenantId,
      `Adopt ${suffix}`,
      `adopt-${suffix}.example`,
      USER_PLATFORM,
      seed.managedBy ?? null,
      seed.disabled === true ? new Date() : null,
      seed.disabled === true ? USER_PLATFORM : null,
    ],
  );
  return id;
}

/** Admin-pool: the stored `managed_by` and `disabled_at` of a registration. */
export async function registrationState(
  admin: Pool,
  id: string,
): Promise<{ managed_by: string | null; disabled_at: Date | null } | null> {
  const r = await admin.query<{ managed_by: string | null; disabled_at: Date | null }>(
    `SELECT managed_by, disabled_at FROM connector_registration WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** Admin-pool: the adoption audit rows of a registration, oldest first. */
export async function adoptionAudits(
  admin: Pool,
  registrationId: string,
): Promise<Array<{ actor_user_id: string | null; tenant_id: string | null; target_type: string; metadata: Record<string, unknown> | null }>> {
  const r = await admin.query(
    `SELECT actor_user_id, tenant_id, target_type, metadata
       FROM audit_events
      WHERE action = 'connector.registration.adopted' AND target_id = $1
      ORDER BY occurred_at, id`,
    [registrationId],
  );
  return r.rows;
}
