/**
 * The RT-50 Q13 preconditions of switching tracked selling on — Jira RT-451 S2
 * (contract `TrackedSellingPrecondition`, `inventory/inventory.yaml`
 * 1.12.0-draft; owner decisions OD-T3 and OD-T5, RT-451 comment 16215).
 *
 * Fail closed: a precondition the server cannot confirm from its own data or
 * from code shipped in this build is UNMET. Each entry names the issue whose
 * runtime will let it be confirmed; until then it stays unmet, so switching
 * tracked selling on is refused (409 `tracked_selling_preconditions_unmet`).
 *
 * Evaluated in the caller's tenant transaction, so a check and the write that
 * depends on it see one state.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

/** Contract `TrackedSellingPrecondition`, in the contract's order. */
export const TRACKED_SELLING_PRECONDITIONS = [
  'sale_effects_active',
  'status_moves_available',
  'erp_tracking_import',
  'erp_batch_posting_verified',
  'identity_anchor',
  'tracking_grain_reconciliation',
] as const;

export type TrackedSellingPrecondition = (typeof TRACKED_SELLING_PRECONDITIONS)[number];

type Check = (client: PoolClient, tenantId: string) => Promise<boolean>;

const CHECKS: Readonly<Record<TrackedSellingPrecondition, Check>> = {
  // RT-427: sale / void / return Inventory effects are activated for the tenant.
  sale_effects_active: async (client, tenantId) => {
    const r = await client.query<{ active: boolean }>(
      `SELECT sale_effects_activated_at IS NOT NULL AS active
         FROM tenant_inventory_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    return r.rows[0]?.active === true;
  },
  // RT-435: status moves and the return-inspection landing ship in this build
  // (`createStatusMove`, `setReturnLandingPolicy`) for every tenant.
  status_moves_available: () => Promise.resolve(true),
  // RT-1288 (Gate 8 P4): the ERP-origin stock import ran. Every live store has an
  // active `stock` warehouse mapping and a completed import run on that mapping
  // (a run on a retired mapping does not count: the store was re-pointed).
  erp_tracking_import: async (client, tenantId) => {
    const r = await client.query<{ met: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM stores WHERE tenant_id = $1 AND deleted_at IS NULL)
              AND NOT EXISTS (
                SELECT 1 FROM stores s
                 WHERE s.tenant_id = $1 AND s.deleted_at IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM erpnext_warehouse_map m
                      WHERE m.tenant_id = $1 AND m.store_id = s.id
                        AND m.purpose = 'stock' AND m.retired_at IS NULL
                        AND EXISTS (SELECT 1 FROM erp_stock_import_runs r
                                     WHERE r.tenant_id = $1 AND r.warehouse_map_id = m.id
                                       AND r.status = 'completed'))) AS met`,
      [tenantId],
    );
    return r.rows[0]?.met === true;
  },
  // G7-11 (RT-452): the Connector's batch posting. Its bench evidence is not
  // something this server can read, so the owner attests it (owner decision
  // 2026-11-12), recorded by the operator CLI `inventory-effects
  // attest-batch-posting` on the tenant's settings row (migration 0104).
  erp_batch_posting_verified: async (client, tenantId) => {
    const r = await client.query<{ met: boolean }>(
      `SELECT erp_batch_posting_attested_at IS NOT NULL AS met
         FROM tenant_inventory_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    return r.rows[0]?.met === true;
  },
  // G7-12 (RT-453): every live store has its per-identity anchor (taken by the
  // operator CLI `inventory-effects anchor-identities`).
  identity_anchor: async (client) => {
    const r = await client.query<{ met: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM stores WHERE deleted_at IS NULL)
              AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.deleted_at IS NULL
                                AND NOT EXISTS (SELECT 1 FROM inventory_identity_anchors a
                                                 WHERE a.store_id = s.id)) AS met`,
    );
    return r.rows[0]?.met === true;
  },
  // RT-428 / RT-453: reconciliation at the tracking grain is in place: every
  // live store has an identity anchor and a 017 stock run completed after it
  // (that run compared the store's tracked products at identity grain).
  tracking_grain_reconciliation: async (client) => {
    const r = await client.query<{ met: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM stores WHERE deleted_at IS NULL)
              AND NOT EXISTS (
                SELECT 1 FROM stores s
                 WHERE s.deleted_at IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM erpnext_reconciliation_run run
                      WHERE run.store_id = s.id AND run.kind = 'stock' AND run.status = 'completed'
                        AND run.finished_at > (SELECT max(a.activated_at) FROM inventory_identity_anchors a
                                                WHERE a.store_id = s.id))) AS met`,
    );
    return r.rows[0]?.met === true;
  },
};

/** The Q13 precondition checks (a provider, so a test can stand in for the build's signals). */
@Injectable()
export class TrackedSellingPreconditions {
  /** The preconditions that do not hold now, in the contract's order. */
  async unmet(client: PoolClient, tenantId: string): Promise<TrackedSellingPrecondition[]> {
    const unmet: TrackedSellingPrecondition[] = [];
    for (const name of TRACKED_SELLING_PRECONDITIONS) {
      if (!(await CHECKS[name](client, tenantId))) unmet.push(name);
    }
    return unmet;
  }
}
