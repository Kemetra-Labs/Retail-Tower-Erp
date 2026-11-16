/**
 * Count activation readiness — Jira RT-1423 (RT-292 Gate 6, G6-7). PURE: it decides from evidence the
 * database reported; it never assumes. Activation FAILS CLOSED: every boundary below that cannot be proven is
 * unmet, and the first unmet one is named, store by store. There is no override.
 *
 * The boundaries, each with a typed code:
 *   - `no_live_store`                   the tenant has no live store to count;
 *   - `store_warehouse_unmapped`        a live store has no active `stock` ERP warehouse mapping;
 *   - `store_barrier_unprovable`        a live store's Count Cut barrier cannot be trusted: a device with no
 *                                       heartbeat, a device whose queue counters are unknown, or a mapped
 *                                       warehouse with no completed ERP stock import (RT-1420 barrier inputs);
 *   - `connector_not_seen`              no Connector heartbeat at all, or a stale one;
 *   - `connector_version_unlisted`      the Connector has not reported that it accepts the `inventory_count`
 *                                       work item (`connector_health.accepted_work_item_kinds`, RT-1427); a
 *                                       Connector that never reported its kinds is refused. (The code keeps
 *                                       the name it was agreed under; it no longer reads a release list.)
 *   - `erp_back_dated_role_unverified`  the Connector's ERP user must hold the back-dated stock role (G6-6):
 *                                       the Connector's own report (`back_dated_role_status`) must be
 *                                       `verified` and fresh by the server clock (`back_dated_role_reported_at`,
 *                                       the same window as the heartbeat). `missing`, `unknown`, no report and
 *                                       a stale report are all unmet. Never assumed.
 */
import type { BarrierDevice, BarrierWarehouse } from './count-barrier';

type ReadinessCode =
  | 'no_live_store'
  | 'store_warehouse_unmapped'
  | 'store_barrier_unprovable'
  | 'connector_not_seen'
  | 'connector_version_unlisted'
  | 'erp_back_dated_role_unverified';

/**
 * RT-1439 (RT-1437 A3; `inventory.yaml` 1.19.0-draft): the ONE device or ERP warehouse a boundary
 * is about, as a structured id so a client can link to the screen that clears it instead of
 * parsing `message`. Exactly one member is set.
 */
export type ReadinessSubject =
  | { readonly deviceId: string; readonly warehouseRef?: never }
  | { readonly warehouseRef: string; readonly deviceId?: never };

export interface UnmetReadiness {
  readonly code: ReadinessCode;
  /** The store the boundary is about; null for a tenant-wide boundary. */
  readonly storeId: string | null;
  readonly message: string;
  /** Present only on `store_barrier_unprovable`: the device or warehouse that cannot be proven. */
  readonly subject?: ReadinessSubject;
}

export interface StoreEvidence {
  readonly storeId: string;
  readonly hasStockWarehouse: boolean;
  readonly devices: readonly BarrierDevice[];
  readonly warehouses: readonly BarrierWarehouse[];
}

interface ConnectorEvidence {
  /** The newest `connector_health` row of the tenant: the server-clock heartbeat time, or null for no row. */
  readonly lastSeenAt: Date | null;
  /** The work-item kinds the Connector reported accepting; null = never reported. */
  readonly acceptedKinds: readonly string[] | null;
  /** `verified`, `missing`, `unknown`, or null = no evidence. */
  readonly backDatedRoleStatus: string | null;
  /** SERVER clock of the last role report: freshness is judged by this, never by the Connector clock. */
  readonly backDatedRoleReportedAt: Date | null;
}

export interface ReadinessEvidence {
  readonly now: Date;
  readonly stores: readonly StoreEvidence[];
  readonly connector: ConnectorEvidence;
}

/** A heartbeat older than this is not proof the Connector is running. */
export const CONNECTOR_HEARTBEAT_MAX_AGE_MS = 15 * 60 * 1000;

/** One barrier problem: what is wrong, and the one device or warehouse it is about. */
interface BarrierProblem {
  readonly message: string;
  readonly subject: ReadinessSubject;
}

/**
 * EVERY problem of the store's barrier, one per offending device or warehouse (RT-1439), in the
 * order devices (no heartbeat, then unknown queue, for each device by its first problem), then
 * warehouses with no completed ERP stock import. A device with two problems is one entry (its
 * first): the subject is the device, and clearing it clears both.
 */
function barrierProblems(s: StoreEvidence): BarrierProblem[] {
  const out: BarrierProblem[] = [];
  for (const d of s.devices) {
    if (!d.hasHealthRow || d.lastSeenAt === null) {
      out.push({ message: `device ${d.deviceId} has never reported a heartbeat`, subject: { deviceId: d.deviceId } });
    } else if (d.pending === null || d.deadLetter === null || d.held === null) {
      out.push({ message: `device ${d.deviceId} does not report its sale queue`, subject: { deviceId: d.deviceId } });
    }
  }
  for (const w of s.warehouses) {
    if (w.lastCompletedEndedAt === null) {
      out.push({
        message: `warehouse ${w.erpnextWarehouseRef} has no completed ERP stock import`,
        subject: { warehouseRef: w.erpnextWarehouseRef },
      });
    }
  }
  return out;
}

function storeBoundaries(s: StoreEvidence): UnmetReadiness[] {
  const out: UnmetReadiness[] = [];
  if (!s.hasStockWarehouse) {
    out.push({
      code: 'store_warehouse_unmapped',
      storeId: s.storeId,
      message: 'The store has no active stock warehouse mapping.',
    });
    return out;
  }
  for (const problem of barrierProblems(s)) {
    out.push({
      code: 'store_barrier_unprovable',
      storeId: s.storeId,
      message: `The Count Cut barrier cannot be proven: ${problem.message}.`,
      subject: problem.subject,
    });
  }
  return out;
}

function isFresh(at: Date | null, now: Date): boolean {
  return at !== null && now.getTime() - at.getTime() <= CONNECTOR_HEARTBEAT_MAX_AGE_MS;
}

function connectorBoundaries(e: ReadinessEvidence): UnmetReadiness[] {
  const out: UnmetReadiness[] = [];
  if (!isFresh(e.connector.lastSeenAt, e.now)) {
    out.push({ code: 'connector_not_seen', storeId: null, message: 'No recent Connector heartbeat.' });
  }
  if (e.connector.acceptedKinds === null || !e.connector.acceptedKinds.includes('inventory_count')) {
    out.push({
      code: 'connector_version_unlisted',
      storeId: null,
      message: 'The Connector has not reported that it accepts the count work item.',
    });
  }
  const role = e.connector.backDatedRoleStatus === 'verified' && isFresh(e.connector.backDatedRoleReportedAt, e.now);
  if (!role) {
    out.push({
      code: 'erp_back_dated_role_unverified',
      storeId: null,
      message: 'The Connector has not reported a fresh verification of the ERP back-dated stock role.',
    });
  }
  return out;
}

/** Every unmet boundary, tenant-wide first, then per store in the order given. Empty means ready. */
export function evaluateReadiness(e: ReadinessEvidence): UnmetReadiness[] {
  const out: UnmetReadiness[] = [];
  if (e.stores.length === 0) {
    out.push({ code: 'no_live_store', storeId: null, message: 'The tenant has no live store.' });
  }
  out.push(...connectorBoundaries(e));
  for (const s of e.stores) out.push(...storeBoundaries(s));
  return out;
}
