/**
 * The raw facts of the delayed-transfer health alert — Jira RT-1516 (RT-291 Gate 5, W3 S07-D02, ruling O4).
 *
 * Read by `console-system-status` (the `shipmentTransfers` component), which applies the rules. This port only reads, on
 * the caller's guarded query function, inside the caller's tenant context: like every system-status check it names no
 * tenant and relies on the tenant's FORCE RLS, so it sees one tenant only.
 *
 *   - `delayedThresholdDays`: the tenant's `delayed_transfer_threshold_days` (0125, default 3 with no settings row).
 *   - `openTransferAgesSeconds`: for each Transfer still `in_transit` or `partially_received` (goods still in transit), the
 *     whole seconds since dispatch. A received, closed or cancelled Transfer is not open, so its alert clears.
 *   - `workItems`: each `transfer_dispatch` / `transfer_receive` work item (one `posting_status_id`) whose leg effects are
 *     `pending`, `rejected` or `reconciliation_required`, with the whole seconds since it entered that state (the effect's
 *     `updated_at`, set by every transition). A confirmed posting is not listed, so its alert clears. The work item is
 *     found through the inventory effect, so this module reads no catalog table.
 *
 * Ages are `now()` on the database clock, never the API clock.
 */
import type { QueryResult, QueryResultRow } from 'pg';

/** The caller's query function (a status check passes its deadline-guarded one). */
export type HealthQuery = <R extends QueryResultRow>(sql: string, params?: unknown[]) => Promise<QueryResult<R>>;

export type StuckCandidateState = 'pending' | 'rejected' | 'reconciliation_required';

export interface ShipmentTransferHealthRaw {
  readonly delayedThresholdDays: number;
  readonly openTransferAgesSeconds: readonly number[];
  readonly workItems: readonly { readonly state: StuckCandidateState; readonly ageSeconds: number }[];
}

const DEFAULT_THRESHOLD_DAYS = 3;

const THRESHOLD_SQL = `SELECT delayed_transfer_threshold_days AS threshold_days FROM tenant_inventory_settings LIMIT 1`;

const OPEN_TRANSFERS_SQL = `
  SELECT GREATEST(0, floor(extract(epoch FROM (now() - dispatched_at))))::bigint AS age_seconds
    FROM shipment_transfers
   WHERE state IN ('in_transit', 'partially_received')
     AND dispatched_at IS NOT NULL
`;

const WORK_ITEMS_SQL = `
  SELECT iei.state AS state,
         GREATEST(0, floor(extract(epoch FROM (now() - min(iei.updated_at)))))::bigint AS age_seconds
    FROM inventory_effect_integration iei
    JOIN stock_movements sm ON sm.id = iei.effect_id AND sm.tenant_id = iei.tenant_id
   WHERE iei.state IN ('pending', 'rejected', 'reconciliation_required')
     AND sm.movement_type IN ('transfer_out', 'transfer_in')
     AND EXISTS (SELECT 1 FROM shipment_transfers st WHERE st.tenant_id = sm.tenant_id AND st.id = sm.transfer_group_id)
   GROUP BY iei.posting_status_id, iei.state
`;

export async function readShipmentTransferHealth(query: HealthQuery): Promise<ShipmentTransferHealthRaw> {
  const threshold = await query<{ threshold_days: number }>(THRESHOLD_SQL);
  const open = await query<{ age_seconds: string }>(OPEN_TRANSFERS_SQL);
  const items = await query<{ state: StuckCandidateState; age_seconds: string }>(WORK_ITEMS_SQL);
  return {
    delayedThresholdDays: threshold.rows[0]?.threshold_days ?? DEFAULT_THRESHOLD_DAYS,
    openTransferAgesSeconds: open.rows.map((r) => Number(r.age_seconds)),
    workItems: items.rows.map((r) => ({ state: r.state, ageSeconds: Number(r.age_seconds) })),
  };
}
