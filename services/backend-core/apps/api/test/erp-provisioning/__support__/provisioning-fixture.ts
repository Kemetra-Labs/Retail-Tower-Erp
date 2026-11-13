/**
 * RT-1358 — shared fixture of the provisioning specs: the test module, the
 * environment, and admin-pool helpers (RLS-exempt) to seed and inspect state.
 * `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { ErpnextPostingModule } from "../../../src/catalog/erpnext-posting/erpnext-posting.module";
import { ConnectorModule } from "../../../src/connector/connector.module";
import { ErpProvisioningModule } from "../../../src/erp-provisioning/erp-provisioning.module";
import { TenantAccessEntitlementModule } from "../../../src/tenant-access-entitlement/tenant-access-entitlement.module";
import { TENANT_A } from "../../catalog/__support__/isolation-harness";

process.env["DEPLOYMENT_ENVIRONMENT"] = "dev";

@Module({ imports: [ErpProvisioningModule, TenantAccessEntitlementModule, ConnectorModule, ErpnextPostingModule] })
export class ProvisioningTestModule {}

export const SYSTEM_ACTOR = "00000000-0000-7000-8000-000000001357";

/** Remove every provisioning artifact between tests (the step log refuses row DELETE, so TRUNCATE). */
export async function resetProvisioning(admin: Pool): Promise<void> {
  await admin.query(`TRUNCATE erp_provisioning_step_log, erp_provisioning_request`);
  await admin.query(`DELETE FROM erp_provisioner_credential`);
  await admin.query(`DELETE FROM auth_tokens WHERE scope = 'connector_provisioner'`);
  const owned = `SELECT id FROM connector_registration WHERE managed_by IS NOT NULL OR erpnext_site_ref IN ('manual-site', 'hand-made-site') OR erpnext_site_ref ~ '^t[0-9a-f]{20}-'`;
  await admin.query(`DELETE FROM connector_health WHERE connector_registration_id IN (${owned})`);
  await admin.query(`DELETE FROM auth_tokens WHERE connector_registration_id IN (${owned})`);
  await admin.query(`DELETE FROM connector_registration WHERE id IN (${owned})`);
  await admin.query(`DELETE FROM tenant_access_entitlements WHERE tenant_id = $1`, [TENANT_A]);
}

export async function restrictTenantA(admin: Pool): Promise<void> {
  await admin.query(`INSERT INTO tenant_access_entitlements (tenant_id, state) VALUES ($1, 'restricted')`, [TENANT_A]);
}

export async function requestsOf(admin: Pool, tenantId: string = TENANT_A): Promise<Array<Record<string, unknown>>> {
  return (await admin.query(`SELECT * FROM erp_provisioning_request WHERE tenant_id = $1 ORDER BY created_at`, [tenantId])).rows;
}

export async function managedRegistrations(admin: Pool, tenantId: string = TENANT_A): Promise<Array<Record<string, unknown>>> {
  return (await admin.query(`SELECT * FROM connector_registration WHERE tenant_id = $1 AND managed_by IS NOT NULL`, [tenantId])).rows;
}

export async function stepsOf(admin: Pool, requestId: string): Promise<Array<Record<string, unknown>>> {
  return (await admin.query(`SELECT * FROM erp_provisioning_step_log WHERE request_id = $1 ORDER BY created_at, attempt`, [requestId])).rows;
}

export async function auditsOf(admin: Pool, action: string): Promise<Array<Record<string, unknown>>> {
  return (await admin.query(`SELECT * FROM audit_events WHERE action = $1 ORDER BY occurred_at, id`, [action])).rows;
}

/** A first heartbeat for a registration (the Connector's report), written with the admin pool. */
export async function seedHeartbeat(admin: Pool, tenantId: string, registrationId: string): Promise<void> {
  await admin.query(
    `INSERT INTO connector_health (id, tenant_id, connector_registration_id, last_seen_at)
     VALUES (gen_random_uuid(), $1, $2, now())
     ON CONFLICT (connector_registration_id) DO UPDATE SET last_seen_at = now()`,
    [tenantId, registrationId],
  );
}

/** Make a request's lease already expired (the provisioner stopped acknowledging). */
export async function expireLease(admin: Pool, requestId: string): Promise<void> {
  await admin.query(`UPDATE erp_provisioning_request SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [requestId]);
}
