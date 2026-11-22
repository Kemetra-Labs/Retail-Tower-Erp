/**
 * The legacy instant-transfer drift report — Jira RT-1517 (RT-291 Gate 5, ruling O3, planning record section 7).
 *
 * Every leg of a legacy instant transfer (`createStockTransfer`, 974) whose effect is still `not_posted`: the stock
 * moved in Retail Tower but never reached ERPNext. Read only. None of these legs is posted after the fact, because that
 * would be a backdated ERP mutation (920); the tenant's first Count Session, or ERP reconciliation at switch-over, corrects
 * the ERPNext balance instead (RT-292).
 *
 * A shipment Transfer (RT-1513) writes `transfer_out` / `transfer_in` legs too, with the same `event_type`, and its
 * receipt legs stay `not_posted` until the dispatch is confirmed. Those legs carry the Transfer id as their
 * `transfer_group_id`, so any leg that belongs to a `shipment_transfers` row is excluded.
 *
 * A port: it takes the caller's `PoolClient`, so the caller's tenant context (RLS) stays in force.
 */
import type { PoolClient } from 'pg';

export interface LegacyTransferDriftRow {
  readonly movementId: string;
  readonly transferGroupId: string | null;
  readonly movementType: 'transfer_out' | 'transfer_in';
  readonly storeId: string;
  readonly tenantProductRef: string;
  /** Exact decimal as stored: negative for `transfer_out`, positive for `transfer_in`. */
  readonly quantity: string;
  readonly stockingUnit: string;
  /** ISO 8601. */
  readonly occurredAt: string;
}

interface DriftDbRow {
  id: string;
  transfer_group_id: string | null;
  movement_type: 'transfer_out' | 'transfer_in';
  store_id: string;
  tenant_product_ref: string;
  quantity: string;
  stocking_unit: string;
  occurred_at: Date;
}

/** The tenant's legacy transfer legs still `not_posted`, ordered by store, then time. */
export async function listLegacyTransferDrift(client: PoolClient, tenantId: string): Promise<LegacyTransferDriftRow[]> {
  const r = await client.query<DriftDbRow>(
    `SELECT sm.id, sm.transfer_group_id, sm.movement_type, sm.store_id, sm.tenant_product_ref,
            sm.quantity::text AS quantity, sm.stocking_unit, sm.occurred_at
       FROM stock_movements sm
       JOIN inventory_effect_integration iei ON iei.effect_id = sm.id AND iei.tenant_id = sm.tenant_id
      WHERE sm.tenant_id = $1
        AND sm.movement_type IN ('transfer_out', 'transfer_in')
        AND iei.state = 'not_posted'
        AND NOT EXISTS (
              SELECT 1 FROM shipment_transfers st WHERE st.tenant_id = sm.tenant_id AND st.id = sm.transfer_group_id)
      ORDER BY sm.store_id, sm.occurred_at, sm.id`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    movementId: row.id,
    transferGroupId: row.transfer_group_id,
    movementType: row.movement_type,
    storeId: row.store_id,
    tenantProductRef: row.tenant_product_ref,
    quantity: row.quantity,
    stockingUnit: row.stocking_unit,
    occurredAt: row.occurred_at.toISOString(),
  }));
}
