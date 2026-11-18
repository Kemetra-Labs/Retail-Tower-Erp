/**
 * The devices of a store with their last stored sale queue, as a public port of `device-health`
 * (RT-1453). Store deletion (its preview and its write: one evaluator) used to query `devices` and
 * `device_health` itself with its own copy of the trust-state CASE and the queue-unknown rule. It asks
 * this port instead, on the caller's client (so the caller's transaction and RLS context stay in
 * force), over the SAME read model the fleet-health list uses (`DEVICE_HEALTH_SELECT_SQL`).
 *
 * A till's queue is "unknown" (`null`), never zero, when it has no stored beat or the beat carries no
 * queue counter: the same rule as `saleQueueOf` in the health projections.
 */
import type { PoolClient } from "pg";

import { DEVICE_HEALTH_SELECT_SQL } from "./device-health.service";
import type { DeviceHealthReadRow, TrustState } from "./device-health.projections";

interface StoreDeviceFact {
  readonly deviceId: string;
  readonly label: string | null;
  readonly trustState: TrustState;
  /** The last stored heartbeat time; null when the till never reported. */
  readonly lastSeenAt: Date | null;
  /** The last stored sale queue; null when unknown (no beat, or a NULL counter). */
  readonly queue: { readonly pending: number; readonly deadLetter: number; readonly held: number } | null;
}

/** $1 tenant, $2 store. Every device of the store, retired included, by id. */
const STORE_DEVICES_SQL = `${DEVICE_HEALTH_SELECT_SQL}
   WHERE d.tenant_id = $1::uuid AND d.store_id = $2::uuid
   ORDER BY d.id`;

export async function readStoreDeviceFacts(
  client: PoolClient,
  scope: { readonly tenantId: string; readonly storeId: string },
): Promise<StoreDeviceFact[]> {
  const r = await client.query<DeviceHealthReadRow>(STORE_DEVICES_SQL, [scope.tenantId, scope.storeId]);
  return r.rows.map((row) => ({
    deviceId: row.device_id,
    label: row.label,
    trustState: row.trust_state,
    lastSeenAt: row.heartbeat_at,
    queue:
      row.heartbeat_at === null ||
      row.sale_queue_pending === null ||
      row.sale_queue_dead_letter === null ||
      row.sale_queue_held === null
        ? null
        : { pending: row.sale_queue_pending, deadLetter: row.sale_queue_dead_letter, held: row.sale_queue_held },
  }));
}
