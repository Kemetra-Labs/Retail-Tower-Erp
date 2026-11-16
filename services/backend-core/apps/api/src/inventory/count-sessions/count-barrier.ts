/**
 * Count Cut barrier — Jira RT-1420 (RT-292 Gate 6, decisions 824-826), as
 * decided by the captain from a read-only survey of `main` (2026-11-16).
 *
 * The cut is allowed only when EVERY device of the store that is not revoked,
 * retired or expired (read from `devices`, never from `device_health`) shows
 * all of:
 *   - a `device_health` row;
 *   - `last_seen_at` (server clock) at or after the cut request time;
 *   - `sale_queue_pending`, `sale_queue_dead_letter` and `sale_queue_held` all
 *     non-NULL and all 0 (migration 0090, RT-1312; not in the Drizzle schema);
 * and EVERY mapped warehouse of the store (an active `stock` mapping, the ones the
 * import runs on) has a latest completed
 * `erp_stock_import_runs` run whose `ended_at` is at or after the cut request
 * time. No other signal is used.
 *
 * RESIDUAL GAP (recorded in the PR and the report): the queue counts are
 * self-reported by the till and cover sales only; there is no device-monotonic
 * sequence, so a sale made offline and not yet queued is not provable.
 */
import type { PoolClient } from 'pg';

export interface BarrierDevice {
  readonly deviceId: string;
  readonly hasHealthRow: boolean;
  readonly lastSeenAt: Date | null;
  readonly pending: number | null;
  readonly deadLetter: number | null;
  readonly held: number | null;
}

export interface BarrierWarehouse {
  readonly warehouseMapId: string;
  readonly erpnextWarehouseRef: string;
  /** `ended_at` of the warehouse's latest completed import run, or null when none. */
  readonly lastCompletedEndedAt: Date | null;
}

type DeviceBlockReason =
  'no_heartbeat' | 'stale_heartbeat' | 'queue_unknown' | 'queue_pending';
type WarehouseBlockReason = 'import_not_past_cut';

export interface BarrierVerdict {
  readonly allowed: boolean;
  readonly devices: ReadonlyArray<{
    readonly deviceId: string;
    readonly reason: DeviceBlockReason;
  }>;
  readonly warehouses: ReadonlyArray<{
    readonly warehouseRef: string;
    readonly reason: WarehouseBlockReason;
  }>;
}

/** The first reason a device blocks the cut, or null when it is drained and current. */
function deviceReason(cutRequestedAt: Date, d: BarrierDevice): DeviceBlockReason | null {
  if (!d.hasHealthRow || d.lastSeenAt === null) return 'no_heartbeat';
  if (d.lastSeenAt.getTime() < cutRequestedAt.getTime()) return 'stale_heartbeat';
  if (d.pending === null || d.deadLetter === null || d.held === null) return 'queue_unknown';
  if (d.pending !== 0 || d.deadLetter !== 0 || d.held !== 0) return 'queue_pending';
  return null;
}

/** PURE: decide the barrier from what the database reported. */
export function evaluateBarrier(
  cutRequestedAt: Date,
  devices: readonly BarrierDevice[],
  warehouses: readonly BarrierWarehouse[],
): BarrierVerdict {
  const blockedDevices = devices.flatMap((d) => {
    const reason = deviceReason(cutRequestedAt, d);
    return reason === null ? [] : [{ deviceId: d.deviceId, reason }];
  });
  const blockedWarehouses = warehouses
    .filter(
      (w) =>
        w.lastCompletedEndedAt === null ||
        w.lastCompletedEndedAt.getTime() < cutRequestedAt.getTime(),
    )
    .map((w) => ({ warehouseRef: w.erpnextWarehouseRef, reason: 'import_not_past_cut' as const }));
  return {
    allowed: blockedDevices.length === 0 && blockedWarehouses.length === 0,
    devices: blockedDevices,
    warehouses: blockedWarehouses,
  };
}

interface DeviceRow {
  device_id: string;
  has_health: boolean;
  last_seen_at: Date | null;
  pending: number | null;
  dead_letter: number | null;
  held: number | null;
}

export interface BarrierInputs {
  readonly devices: readonly BarrierDevice[];
  readonly warehouses: readonly BarrierWarehouse[];
}

/** Read the barrier's inputs for one store on the tenant-context client. */
export async function readBarrier(
  client: PoolClient,
  storeId: string,
  cutRequestedAt: Date,
): Promise<BarrierVerdict> {
  const inputs = await readBarrierInputs(client, storeId);
  return evaluateBarrier(cutRequestedAt, inputs.devices, inputs.warehouses);
}

/** The devices and mapped warehouses a store's barrier is decided from (RT-1423 readiness reads them too). */
export async function readBarrierInputs(client: PoolClient, storeId: string): Promise<BarrierInputs> {
  const devices = await client.query<DeviceRow>(
    `SELECT d.id AS device_id,
            (h.device_id IS NOT NULL) AS has_health,
            h.last_seen_at,
            h.sale_queue_pending     AS pending,
            h.sale_queue_dead_letter AS dead_letter,
            h.sale_queue_held        AS held
       FROM devices d
       LEFT JOIN device_health h ON h.device_id = d.id
      WHERE d.store_id = $1
        AND d.revoked_at IS NULL
        AND d.retired_at IS NULL
        AND d.expires_at > now()
      ORDER BY d.id`,
    [storeId],
  );
  const warehouses = await client.query<{ id: string; ref: string; ended_at: Date | null }>(
    `SELECT m.id, m.erpnext_warehouse_ref AS ref,
            (SELECT r.ended_at
               FROM erp_stock_import_runs r
              WHERE r.warehouse_map_id = m.id AND r.status = 'completed' AND r.ended_at IS NOT NULL
              ORDER BY r.ended_at DESC LIMIT 1) AS ended_at
       FROM erpnext_warehouse_map m
      WHERE m.store_id = $1 AND m.purpose = 'stock' AND m.retired_at IS NULL
      ORDER BY m.id`,
    [storeId],
  );
  return {
    devices: devices.rows.map((r) => ({
      deviceId: r.device_id,
      hasHealthRow: r.has_health,
      lastSeenAt: r.last_seen_at,
      pending: r.pending,
      deadLetter: r.dead_letter,
      held: r.held,
    })),
    warehouses: warehouses.rows.map((r) => ({
      warehouseMapId: r.id,
      erpnextWarehouseRef: r.ref,
      lastCompletedEndedAt: r.ended_at,
    })),
  };
}
