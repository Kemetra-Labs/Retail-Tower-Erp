/**
 * RT-1062 — fixture for the console system-status spec.
 *
 * Builds on the RT-562 console sales fixture (tenants A and B; the tenant A
 * `all` owner SES_OWNER_ALL and `specific` tenant_admin SES_ADMIN_SPEC; the
 * store_manager SES_MANAGER and store_staff SES_STAFF, both outside the
 * allowed roles; the platform admin SES_PLATFORM; three bearers that must be
 * 401) and adds tenant C with an `all` owner (SES_C_OWNER) and nothing else,
 * the viewer of the cross-tenant checks.
 *
 * The seed holds no outbox event, no sale sync dead letter and no connector
 * registration: each spec case writes the state it needs with the helpers
 * below and removes it with `clearState`, since the read is computed on read.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `1062`
 * mnemonic (hex only).
 */
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { seedConsoleMember } from "../../_helpers/console-members";
import type { PgTestEnv } from "../../_helpers/postgres-container";
import { STORE_A_X, STORE_B_X, TENANT_A, TENANT_B } from "../../catalog/__support__/isolation-harness";
import { B_OCT02, seedConsoleSalesFixture, X_LEGACY } from "../../console-sales/__support__/console-sales-fixture";

export const TENANT_C = "0c000000-0000-7000-8000-00000010620c";
const USER_C_OWNER = "0c000000-0000-7000-8000-0000001062e1";
export const SES_C_OWNER = "0c000000-0000-7000-8000-0000001062f1";
/** The `created_by` of every seeded registration. */
export const ACTOR = "0a000000-0000-7000-8000-0000001062e0";

/** One `sale.captured` outbox event, `ageSeconds` old, in `state`. */
export async function insertSaleEvent(
  admin: Pool,
  e: { tenantId: string; state: "pending" | "claimed" | "failed" | "delivered" | "dead_lettered"; ageSeconds: number; eventType?: string },
): Promise<void> {
  await admin.query(
    `INSERT INTO outbox_events
       (event_id, tenant_id, event_type, payload, delivery_state, created_at, occurred_at,
        claimed_at, processed_at)
     VALUES ($1, $2, $3, '{}'::jsonb, $4,
             now() - make_interval(secs => $5), now() - make_interval(secs => $5),
             CASE WHEN $4 = 'claimed' THEN now() END,
             CASE WHEN $4 IN ('delivered', 'dead_lettered') THEN now() END)`,
    [randomUUID(), e.tenantId, e.eventType ?? "sale.captured", e.state, e.ageSeconds],
  );
}

/** An open (or resolved) sale sync dead letter on a tenant A or tenant B sale. */
export async function insertDeadletter(
  admin: Pool,
  d: { tenant: "A" | "B"; classification: "needs-repair" | "retryable"; resolved?: boolean },
): Promise<void> {
  const [tenantId, storeId, saleId] =
    d.tenant === "A" ? [TENANT_A, STORE_A_X, X_LEGACY] : [TENANT_B, STORE_B_X, B_OCT02];
  await admin.query(
    `INSERT INTO sale_sync_deadletters
       (sale_id, tenant_id, store_id, classification, reason_code, source_system, external_id, resolved_at)
     VALUES ($1, $2, $3, $4, 'validation_failure', 'rt1062-seed', $5, CASE WHEN $6 THEN now() END)`,
    [saleId, tenantId, storeId, d.classification, `rt1062-${randomUUID()}`, d.resolved === true],
  );
}

/**
 * A connector registration with its health row: `lastSeenSecondsAgo` null
 * is never seen (no health row); `disabled` sets `disabled_at`.
 */
export async function insertRegistration(
  admin: Pool,
  r: {
    tenantId: string;
    lastSeenSecondsAgo: number | null;
    disabled?: boolean;
    erpnextReachable?: boolean | null;
  },
): Promise<void> {
  const regId = randomUUID();
  await admin.query(
    `INSERT INTO connector_registration
       (id, tenant_id, display_name, erpnext_site_ref, environment, created_by, disabled_at)
     VALUES ($1, $2, 'RT-1062 connector', $3, 'pilot', $4, CASE WHEN $5 THEN now() END)`,
    [regId, r.tenantId, `erp-${regId}.example.test`, ACTOR, r.disabled === true],
  );
  if (r.lastSeenSecondsAgo === null) return;
  await admin.query(
    `INSERT INTO connector_health
       (id, tenant_id, connector_registration_id, last_seen_at, erpnext_reachable, reported_fields_at)
     VALUES ($1, $2, $3, now() - make_interval(secs => $4), $5, now())`,
    [randomUUID(), r.tenantId, regId, r.lastSeenSecondsAgo, r.erpnextReachable ?? null],
  );
}

/** Remove every outbox event, sale sync dead letter and connector registration the spec wrote. */
export async function clearState(admin: Pool): Promise<void> {
  await admin.query(`DELETE FROM outbox_events`);
  await admin.query(`DELETE FROM sale_sync_deadletters`);
  await admin.query(`DELETE FROM connector_health`);
  await admin.query(`DELETE FROM connector_registration`);
}

export async function seedConsoleSystemStatusFixture(env: PgTestEnv): Promise<void> {
  await seedConsoleSalesFixture(env);
  await env.admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt1062-actor@example.test')`, [ACTOR]);
  await env.admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'rt1062-c', 'RT-1062 Tenant C', 'EGP')`,
    [TENANT_C],
  );
  await seedConsoleMember(env.admin, {
    tenantId: TENANT_C,
    userId: USER_C_OWNER,
    email: "rt1062-owner-c@example.test",
    membershipId: "0c000000-0000-7000-8000-0000001062d1",
    roleId: "0c000000-0000-7000-8000-0000001062d2",
    roleCode: "owner",
    stores: "all",
    sessions: { [SES_C_OWNER]: null },
  });
  await clearState(env.admin);
}
