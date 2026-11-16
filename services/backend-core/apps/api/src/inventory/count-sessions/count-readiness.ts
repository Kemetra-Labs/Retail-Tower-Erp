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
 *   - `connector_version_unlisted`      the Connector's reported release is not in the deploy-configured list
 *                                       of releases known to carry the count writer (empty by default);
 *   - `erp_back_dated_role_unverified`  the Connector's ERP user must hold the back-dated stock role (G6-6),
 *                                       and Backend-Core has NO evidence of it: the heartbeat carries no
 *                                       capability field. Unmet until a heartbeat capability exists (a
 *                                       separate gated change), never fabricated.
 */
import type { BarrierDevice, BarrierWarehouse } from './count-barrier';

type ReadinessCode =
  | 'no_live_store'
  | 'store_warehouse_unmapped'
  | 'store_barrier_unprovable'
  | 'connector_not_seen'
  | 'connector_version_unlisted'
  | 'erp_back_dated_role_unverified';

export interface UnmetReadiness {
  readonly code: ReadinessCode;
  /** The store the boundary is about; null for a tenant-wide boundary. */
  readonly storeId: string | null;
  readonly message: string;
}

export interface StoreEvidence {
  readonly storeId: string;
  readonly hasStockWarehouse: boolean;
  readonly devices: readonly BarrierDevice[];
  readonly warehouses: readonly BarrierWarehouse[];
}

interface ConnectorEvidence {
  /** The newest `connector_health` row of the tenant, or null when there is none. */
  readonly lastSeenAt: Date | null;
  readonly version: string | null;
}

export interface ReadinessEvidence {
  readonly now: Date;
  readonly stores: readonly StoreEvidence[];
  readonly connector: ConnectorEvidence;
  /** Releases known to accept `inventory_count` (deploy configuration). */
  readonly allowedConnectorReleases: readonly string[];
  /** Always false until the heartbeat can report the ERP user's back-dated role. */
  readonly backDatedRoleVerified: boolean;
}

/** A heartbeat older than this is not proof the Connector is running. */
export const CONNECTOR_HEARTBEAT_MAX_AGE_MS = 15 * 60 * 1000;

function barrierProblem(s: StoreEvidence): string | null {
  const blind = s.devices.find((d) => !d.hasHealthRow || d.lastSeenAt === null);
  if (blind) return `device ${blind.deviceId} has never reported a heartbeat`;
  const unknown = s.devices.find((d) => d.pending === null || d.deadLetter === null || d.held === null);
  if (unknown) return `device ${unknown.deviceId} does not report its sale queue`;
  const noImport = s.warehouses.find((w) => w.lastCompletedEndedAt === null);
  if (noImport) return `warehouse ${noImport.erpnextWarehouseRef} has no completed ERP stock import`;
  return null;
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
  const problem = barrierProblem(s);
  if (problem !== null) {
    out.push({ code: 'store_barrier_unprovable', storeId: s.storeId, message: `The Count Cut barrier cannot be proven: ${problem}.` });
  }
  return out;
}

function connectorBoundaries(e: ReadinessEvidence): UnmetReadiness[] {
  const seen = e.connector.lastSeenAt;
  if (seen === null || e.now.getTime() - seen.getTime() > CONNECTOR_HEARTBEAT_MAX_AGE_MS) {
    return [{ code: 'connector_not_seen', storeId: null, message: 'No recent Connector heartbeat.' }];
  }
  const out: UnmetReadiness[] = [];
  if (e.connector.version === null || !e.allowedConnectorReleases.includes(e.connector.version)) {
    out.push({
      code: 'connector_version_unlisted',
      storeId: null,
      message: 'The Connector release is not known to accept the count work item.',
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
  if (!e.backDatedRoleVerified) {
    out.push({
      code: 'erp_back_dated_role_unverified',
      storeId: null,
      message: 'There is no evidence that the Connector ERP user holds the back-dated stock role.',
    });
  }
  for (const s of e.stores) out.push(...storeBoundaries(s));
  return out;
}

/** The deploy-configured releases that carry the count writer: `COUNT_CONNECTOR_RELEASES=sha1,sha2`. */
export function configuredReleases(raw: string | undefined): readonly string[] {
  return (raw ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}
