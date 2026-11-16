/**
 * RT-1423 — activation readiness is pure and fails closed: every boundary that cannot be proven is unmet and
 * named, the back-dated role is unmet while no evidence exists, and nothing is assumed.
 */
import {
  CONNECTOR_HEARTBEAT_MAX_AGE_MS,
  configuredReleases,
  evaluateReadiness,
  type ReadinessEvidence,
  type StoreEvidence,
} from '../../../src/inventory/count-sessions/count-readiness';

const NOW = new Date('2026-11-16T12:00:00Z');
const STORE = '00000000-0000-7000-8000-00000000570e';

const goodStore = (over: Partial<StoreEvidence> = {}): StoreEvidence => ({
  storeId: STORE,
  hasStockWarehouse: true,
  devices: [
    { deviceId: 'd1', hasHealthRow: true, lastSeenAt: NOW, pending: 0, deadLetter: 0, held: 0 },
  ],
  warehouses: [{ warehouseMapId: 'w1', erpnextWarehouseRef: 'Stores - RT', lastCompletedEndedAt: NOW }],
  ...over,
});

const ready = (over: Partial<ReadinessEvidence> = {}): ReadinessEvidence => ({
  now: NOW,
  stores: [goodStore()],
  connector: { lastSeenAt: NOW, version: 'abc123def456' },
  allowedConnectorReleases: ['abc123def456'],
  backDatedRoleVerified: true,
  ...over,
});

const codes = (e: ReadinessEvidence): string[] => evaluateReadiness(e).map((u) => u.code);

describe('evaluateReadiness', () => {
  it('is ready only when every boundary is proven', () => {
    expect(evaluateReadiness(ready())).toEqual([]);
  });

  it('is NEVER ready today: nothing reports the ERP back-dated role, so it is unmet and never fabricated', () => {
    expect(codes(ready({ backDatedRoleVerified: false }))).toEqual(['erp_back_dated_role_unverified']);
  });

  it('a tenant with no live store is not ready', () => {
    expect(codes(ready({ stores: [] }))).toEqual(['no_live_store']);
  });

  it('names a store without a stock warehouse mapping, with the store', () => {
    const [u] = evaluateReadiness(ready({ stores: [goodStore({ hasStockWarehouse: false })] }));
    expect(u).toMatchObject({ code: 'store_warehouse_unmapped', storeId: STORE });
  });

  it.each([
    ['a device never seen', { devices: [{ deviceId: 'd', hasHealthRow: false, lastSeenAt: null, pending: null, deadLetter: null, held: null }] }],
    ['a device with unknown queue counters', { devices: [{ deviceId: 'd', hasHealthRow: true, lastSeenAt: NOW, pending: null, deadLetter: 0, held: 0 }] }],
    ['a mapped warehouse with no completed import', { warehouses: [{ warehouseMapId: 'w', erpnextWarehouseRef: 'X', lastCompletedEndedAt: null }] }],
  ])('the barrier is unprovable for %s', (_name, over) => {
    const [u] = evaluateReadiness(ready({ stores: [goodStore(over as Partial<StoreEvidence>)] }));
    expect(u).toMatchObject({ code: 'store_barrier_unprovable', storeId: STORE });
  });

  it('a device with a pending queue is NOT an evidence gap (the cut itself waits for it)', () => {
    const busy = goodStore({
      devices: [{ deviceId: 'd', hasHealthRow: true, lastSeenAt: NOW, pending: 7, deadLetter: 0, held: 0 }],
    });
    expect(evaluateReadiness(ready({ stores: [busy] }))).toEqual([]);
  });

  it('refuses a Connector never seen or seen too long ago', () => {
    expect(codes(ready({ connector: { lastSeenAt: null, version: 'abc123def456' } }))).toEqual(['connector_not_seen']);
    const stale = new Date(NOW.getTime() - CONNECTOR_HEARTBEAT_MAX_AGE_MS - 1);
    expect(codes(ready({ connector: { lastSeenAt: stale, version: 'abc123def456' } }))).toEqual(['connector_not_seen']);
    const edge = new Date(NOW.getTime() - CONNECTOR_HEARTBEAT_MAX_AGE_MS);
    expect(codes(ready({ connector: { lastSeenAt: edge, version: 'abc123def456' } }))).toEqual([]);
  });

  it('refuses a Connector release that is not in the configured list, and an empty list refuses everything', () => {
    expect(codes(ready({ connector: { lastSeenAt: NOW, version: 'other' } }))).toEqual(['connector_version_unlisted']);
    expect(codes(ready({ connector: { lastSeenAt: NOW, version: null } }))).toEqual(['connector_version_unlisted']);
    expect(codes(ready({ allowedConnectorReleases: [] }))).toEqual(['connector_version_unlisted']);
  });

  it('lists tenant-wide boundaries first, then each store in order, all of them', () => {
    const e = ready({
      backDatedRoleVerified: false,
      connector: { lastSeenAt: null, version: null },
      stores: [goodStore({ storeId: 'b', hasStockWarehouse: false }), goodStore({ storeId: 'a', hasStockWarehouse: false })],
    });
    expect(evaluateReadiness(e).map((u) => [u.code, u.storeId])).toEqual([
      ['connector_not_seen', null],
      ['erp_back_dated_role_unverified', null],
      ['store_warehouse_unmapped', 'b'],
      ['store_warehouse_unmapped', 'a'],
    ]);
  });
});

describe('configuredReleases', () => {
  it('splits, trims and drops empties; unset is empty', () => {
    expect(configuredReleases(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(configuredReleases(undefined)).toEqual([]);
    expect(configuredReleases('')).toEqual([]);
  });
});
