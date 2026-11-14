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
 * A finished (`succeeded`) request records the host that provisioned the site in
 * `provisioned_host_label` (migration 0112, RT-1389), the OD-10 per-host site count
 * input; the host comes from the `step_recorded` audit row written with the
 * outcome. A request finished without a host in the audit trail keeps the column
 * NULL and is counted as `hostUnknown`, never under a made-up host.
 *
 * This and the api repository (`provisioning-request.repository.ts`) are the only
 * writers of the table; a fence test pins it. Every status change here goes through
 * the shared transition table (`erpProvisioningTransitionAllowed`, the one the api
 * repository uses) and the optimistic `version`; migration 0112's trigger rejects any
 * other from->to change in SQL. The sweep never touches the tenant access state: the
 * flip from `restricted` to `unrestricted` stays the platform admin's manual
 * mark-provisioned until the per-store gate (RT-1361) is on `main`.
 *
 * Runs on the narrow `provisioning_sweep` privilege (RT-1389, migration 0111:
 * erp_provisioning_request SELECT/UPDATE only), never the platform-admin or the
 * provisioner one. Tenant-scoped reads and writes (connector_health, audit_events)
 * go through the tenant pin of the request being handled. One short transaction per
 * request, so a failure in one request leaves the others done.
 */
import type { Pool, PoolClient } from "pg";

import { runWithSystemPrivilege, type SystemContext } from "../middleware/system-privilege";
import { erpProvisioningTransitionAllowed, type ErpProvisioningStatus } from "./erp-provisioning-transitions";

const SYSTEM_ACTOR_USER_ID = "00000000-0000-7000-8000-000000001357";

export interface SweepResult {
  readonly leasesReclaimed: number;
  readonly succeeded: number;
  readonly timedOut: number;
  /** Requests finished without a host in the audit trail (the host count under-counts them). */
  readonly hostUnknown: number;
}

/** The values the `erp_provisioning_request_last_error_class_valid` CHECK allows. */
type ErpProvisioningErrorClass = "failed_transient" | "permanently_rejected" | "conflict" | "capacity" | "compatibility" | "dependency";

const SWEEP_CTX: SystemContext = { tenantId: null, privilege: "provisioning_sweep" };

/** Point the sweep transaction at the tenant of a request it already read (never a caller-supplied id). */
async function pinTenant(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
}

/**
 * Move one request to `to` through the shared transition table and the optimistic
 * version (the same two checks as the api repository's `writeRequest`).
 */
async function moveStatus(
  client: PoolClient,
  row: { readonly id: string; readonly status: ErpProvisioningStatus; readonly version: number },
  to: ErpProvisioningStatus,
  set: { readonly lastErrorClass: ErpProvisioningErrorClass | null; readonly lastReason: string | null; readonly terminalAt: Date; readonly host: string | null },
): Promise<void> {
  if (!erpProvisioningTransitionAllowed(row.status, to)) {
    throw new Error(`erp_provisioning_request: transition ${row.status} -> ${to} is not allowed`);
  }
  const r = await client.query(
    `UPDATE erp_provisioning_request
        SET status = $3, last_error_class = $4, last_reason = $5, terminal_at = $6::timestamptz,
            provisioned_host_label = $7::text
      WHERE id = $1::uuid AND version = $2`,
    [row.id, row.version, to, set.lastErrorClass, set.lastReason, set.terminalAt, set.host],
  );
  if (r.rowCount !== 1) throw new Error("erp_provisioning_request: version conflict");
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
  const expired = await runWithSystemPrivilege(pool, SWEEP_CTX, async (client) => {
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
    leasesReclaimed += await runWithSystemPrivilege(pool, SWEEP_CTX, async (client) => {
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
      await pinTenant(client, r.rows[0].tenant_id);
      await audit(client, r.rows[0].tenant_id, "erp.provisioning.lease_expired", id, { reclaimed: true });
      return 1;
    });
  }

  const waiting = await runWithSystemPrivilege(pool, SWEEP_CTX, async (client) => {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM erp_provisioning_request WHERE status = 'verifying' AND lease_id IS NULL ORDER BY created_at LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => x.id);
  });
  let succeeded = 0;
  let timedOut = 0;
  let hostUnknown = 0;
  for (const id of waiting) {
    // sequential: one request per transaction keeps a failure local.
    const verdict = await runWithSystemPrivilege(pool, SWEEP_CTX, async (client) => {
      const row = await client.query<{ tenant_id: string; status: ErpProvisioningStatus; version: number; connector_registration_id: string | null; reported_at: Date }>(
        `SELECT tenant_id, status, version, connector_registration_id, updated_at AS reported_at FROM erp_provisioning_request
          WHERE id = $1::uuid AND status = 'verifying' AND lease_id IS NULL FOR UPDATE SKIP LOCKED`,
        [id],
      );
      const r = row.rows[0];
      if (r === undefined) return "skip" as const;
      // connector_health and audit_events are tenant-scoped: point this transaction at the request's tenant.
      await pinTenant(client, r.tenant_id);
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
        // A finished request records the host that provisioned the site (the OD-10 site count); no lease.
        await moveStatus(client, { id, status: r.status, version: r.version }, "succeeded", {
          lastErrorClass: null,
          lastReason: null,
          terminalAt: input.now,
          host,
        });
        await audit(client, r.tenant_id, "erp.provisioning.succeeded", id, { heartbeat: true, ...(host !== null ? { host } : {}) });
        return host === null ? ("succeeded_hostless" as const) : ("succeeded" as const);
      }
      const reportedAt = r.reported_at;
      if (reportedAt.getTime() + input.heartbeatTimeoutMs <= input.now.getTime()) {
        await moveStatus(client, { id, status: r.status, version: r.version }, "failed_permanent", {
          lastErrorClass: "failed_transient",
          lastReason: "first heartbeat not seen in time",
          terminalAt: input.now,
          host: null,
        });
        await audit(client, r.tenant_id, "erp.provisioning.failed", id, { reason: "heartbeat_timeout", alert: true });
        return "timed_out" as const;
      }
      return "skip" as const;
    });
    if (verdict === "succeeded" || verdict === "succeeded_hostless") succeeded += 1;
    if (verdict === "succeeded_hostless") hostUnknown += 1;
    if (verdict === "timed_out") timedOut += 1;
  }
  return { leasesReclaimed, succeeded, timedOut, hostUnknown };
}
