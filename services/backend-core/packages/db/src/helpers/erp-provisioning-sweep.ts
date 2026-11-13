/**
 * `sweepErpProvisioning` — RT-1358: the worker's pass over `erp_provisioning_request`.
 *
 *   1. LEASE RECLAIM: a non-terminal request whose lease expired gets its lease
 *      columns cleared (the recorded status is kept: it is a display trail, never
 *      the source of truth), so it is offered again. A `verifying` request is never
 *      reclaimed: its lease expiring means a provisioner that crashed before its
 *      outcome (it is offered again as it is). Audit `erp.provisioning.lease_expired`.
 *   2. HEARTBEAT HOLD: a `verifying` request whose provisioner reported
 *      `succeeded` (derived state: `verifying` with NO lease) waits here for the first heartbeat of
 *      its managed registration. Seen: the request becomes `succeeded` (audit
 *      `erp.provisioning.succeeded`). Not seen within `heartbeatTimeoutMs`:
 *      `failed_permanent` with an alert audit (`erp.provisioning.failed`).
 *
 * This and the api repository (`provisioning-request.repository.ts`) are the only
 * writers of the table; a fence test pins it. The sweep never touches the tenant
 * access state: the flip from `restricted` to `unrestricted` stays the platform
 * admin's manual mark-provisioned until the per-store gate (RT-1361) is on `main`.
 *
 * Runs in the platform-admin context (never the provisioner one), one short
 * transaction per request, so a failure in one request leaves the others done.
 */
import type { Pool, PoolClient } from "pg";

import { runWithTenantContext } from "../middleware/tenant-context";

const SYSTEM_ACTOR_USER_ID = "00000000-0000-7000-8000-000000001357";

export interface SweepResult {
  readonly leasesReclaimed: number;
  readonly succeeded: number;
  readonly timedOut: number;
}

export interface SweepInput {
  readonly now: Date;
  readonly heartbeatTimeoutMs: number;
  readonly limit?: number;
}

async function audit(client: PoolClient, tenantId: string, action: string, targetId: string, metadata: Record<string, string | number | boolean>): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES (gen_random_uuid(), $1, 'sweep', $2, NULL, $3, 'erp_provisioning_request', $4, NULL, $5::jsonb)`,
    [SYSTEM_ACTOR_USER_ID, tenantId, action, targetId, JSON.stringify(metadata)],
  );
}

export async function sweepErpProvisioning(pool: Pool, input: SweepInput): Promise<SweepResult> {
  const limit = input.limit ?? 100;
  const expired = await runWithTenantContext(pool, { tenantId: null, isPlatformAdmin: true }, async (client) => {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM erp_provisioning_request
        WHERE status NOT IN ('succeeded','failed_permanent','compensated','cancelled')
          AND status <> 'verifying' AND lease_id IS NOT NULL AND lease_expires_at <= $1
        ORDER BY lease_expires_at LIMIT $2`,
      [input.now, limit],
    );
    return r.rows.map((x) => x.id);
  });
  let leasesReclaimed = 0;
  for (const id of expired) {
    // sequential: one request per transaction keeps a failure local.
    leasesReclaimed += await runWithTenantContext(pool, { tenantId: null, isPlatformAdmin: true }, async (client) => {
      const r = await client.query<{ tenant_id: string }>(
        `UPDATE erp_provisioning_request
            SET lease_holder = NULL, lease_id = NULL, lease_expires_at = NULL
          WHERE id = $1::uuid AND lease_id IS NOT NULL AND lease_expires_at <= $2
            AND status NOT IN ('succeeded','failed_permanent','compensated','cancelled')
            AND status <> 'verifying'
          RETURNING tenant_id`,
        [id, input.now],
      );
      if (r.rows[0] === undefined) return 0;
      await audit(client, r.rows[0].tenant_id, "erp.provisioning.lease_expired", id, { reclaimed: true });
      return 1;
    });
  }

  const waiting = await runWithTenantContext(pool, { tenantId: null, isPlatformAdmin: true }, async (client) => {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM erp_provisioning_request WHERE status = 'verifying' AND lease_id IS NULL ORDER BY created_at LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => x.id);
  });
  let succeeded = 0;
  let timedOut = 0;
  for (const id of waiting) {
    // sequential: one request per transaction keeps a failure local.
    const verdict = await runWithTenantContext(pool, { tenantId: null, isPlatformAdmin: true }, async (client) => {
      const row = await client.query<{ tenant_id: string; connector_registration_id: string | null; reported_at: Date }>(
        `SELECT tenant_id, connector_registration_id, updated_at AS reported_at FROM erp_provisioning_request
          WHERE id = $1::uuid AND status = 'verifying' AND lease_id IS NULL FOR UPDATE SKIP LOCKED`,
        [id],
      );
      const r = row.rows[0];
      if (r === undefined) return "skip" as const;
      // connector_health is tenant-scoped: point this platform-admin transaction at the request's tenant.
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [r.tenant_id]);
      const seen = await client.query(
        `SELECT 1 FROM connector_health WHERE connector_registration_id = $1::uuid AND last_seen_at IS NOT NULL`,
        [r.connector_registration_id],
      );
      // The host that reported the outcome lives in the audit trail (the request keeps no holder).
      const by = await client.query<{ host: string | null }>(
        `SELECT metadata->>'host' AS host FROM audit_events
          WHERE target_id = $1::uuid AND action = 'erp.provisioning.step_recorded' AND metadata->>'outcome' = 'succeeded_reported'
          ORDER BY occurred_at DESC LIMIT 1`,
        [id],
      );
      const host = by.rows[0]?.host ?? null;
      if ((seen.rowCount ?? 0) > 0) {
        // A finished request records the host that provisioned the site (the OD-10 site count), with an ended lease.
        await client.query(
          `UPDATE erp_provisioning_request
              SET status = 'succeeded', last_error_class = NULL, last_reason = NULL, terminal_at = $2::timestamptz,
                  lease_holder = $3::text, lease_id = CASE WHEN $3::text IS NULL THEN NULL ELSE gen_random_uuid() END,
                  lease_expires_at = CASE WHEN $3::text IS NULL THEN NULL ELSE $2::timestamptz END
            WHERE id = $1::uuid`,
          [id, input.now, host],
        );
        await audit(client, r.tenant_id, "erp.provisioning.succeeded", id, { heartbeat: true, ...(host !== null ? { host } : {}) });
        return "succeeded" as const;
      }
      const reportedAt = r.reported_at;
      if (reportedAt.getTime() + input.heartbeatTimeoutMs <= input.now.getTime()) {
        await client.query(
          `UPDATE erp_provisioning_request
              SET status = 'failed_permanent', last_error_class = 'failed_transient',
                  last_reason = 'first heartbeat not seen in time', terminal_at = $2
            WHERE id = $1::uuid`,
          [id, input.now],
        );
        await audit(client, r.tenant_id, "erp.provisioning.failed", id, { reason: "heartbeat_timeout", alert: true });
        return "timed_out" as const;
      }
      return "skip" as const;
    });
    if (verdict === "succeeded") succeeded += 1;
    if (verdict === "timed_out") timedOut += 1;
  }
  return { leasesReclaimed, succeeded, timedOut };
}
