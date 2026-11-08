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

/** Unconfirmable in this build: unmet until the named issue ships a signal. */
const notYetConfirmable: Check = () => Promise.resolve(false);

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
  // RT-293 (Gate 8): the ERP-origin import with tracking. Not built yet.
  erp_tracking_import: notYetConfirmable,
  // G7-11 (RT-452): the Connector's batch posting. Its bench evidence is not a
  // signal this server can read, so it stays unmet until one exists.
  erp_batch_posting_verified: notYetConfirmable,
  // G7-12 (RT-453): the per-identity anchor. Not built yet.
  identity_anchor: notYetConfirmable,
  // RT-428 / RT-453: reconciliation at the tracking grain. Not built yet.
  tracking_grain_reconciliation: notYetConfirmable,
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
