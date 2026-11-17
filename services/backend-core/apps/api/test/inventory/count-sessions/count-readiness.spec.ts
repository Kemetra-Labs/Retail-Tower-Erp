/**
 * RT-1423 (+ RT-1427 evidence) — activation readiness is pure and fails closed: every boundary that cannot be
 * proven is unmet and named. The Connector must have a fresh heartbeat, must have reported accepting
 * `inventory_count`, and must have reported the ERP back-dated role `verified` fresh by the server clock.
 */
import {
  CONNECTOR_HEARTBEAT_MAX_AGE_MS,
  evaluateReadiness,
  type ReadinessEvidence,
  type StoreEvidence,
} from '../../../src/inventory/count-sessions/count-readiness';

const NOW = new Date('2026-11-16T12:00:00Z');
const STORE = '00000000-0000-7000-8000-00000000570e';
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

const goodStore = (over: Partial<StoreEvidence> = {}): StoreEvidence => ({
  storeId: STORE,
  hasStockWarehouse: true,
  devices: [{ deviceId: 'd1', hasHealthRow: true, lastSeenAt: NOW, pending: 0, deadLetter: 0, held: 0 }],
  warehouses: [{ warehouseMapId: 'w1', erpnextWarehouseRef: 'Stores - RT', lastCompletedEndedAt: NOW }],
  ...over,
});

type Connector = ReadinessEvidence['connector'];
const goodConnector = (over: Partial<Connector> = {}): Connector => ({
  lastSeenAt: NOW,
  acceptedKinds: ['sale_post', 'reversal', 'inventory_count'],
  backDatedRoleStatus: 'verified',
  backDatedRoleReportedAt: NOW,
  ...over,
});

const ready = (over: Partial<ReadinessEvidence> = {}): ReadinessEvidence => ({
  now: NOW,
  stores: [goodStore()],
  connector: goodConnector(),
  ...over,
});

const codes = (e: ReadinessEvidence): string[] => evaluateReadiness(e).map((u) => u.code);
const withConnector = (over: Partial<Connector>): ReadinessEvidence => ready({ connector: goodConnector(over) });

describe('evaluateReadiness', () => {
  it('is ready only when every boundary is proven', () => {
    expect(evaluateReadiness(ready())).toEqual([]);
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

  it('names EVERY offending device and warehouse, one boundary each, with a structured subject (RT-1439)', () => {
    const many = goodStore({
      devices: [
        { deviceId: 'd1', hasHealthRow: false, lastSeenAt: null, pending: null, deadLetter: null, held: null },
        { deviceId: 'd2', hasHealthRow: true, lastSeenAt: NOW, pending: null, deadLetter: null, held: null },
        { deviceId: 'd3', hasHealthRow: true, lastSeenAt: NOW, pending: 0, deadLetter: 0, held: 0 },
      ],
      warehouses: [
        { warehouseMapId: 'w1', erpnextWarehouseRef: 'A', lastCompletedEndedAt: null },
        { warehouseMapId: 'w2', erpnextWarehouseRef: 'B', lastCompletedEndedAt: NOW },
        { warehouseMapId: 'w3', erpnextWarehouseRef: 'C', lastCompletedEndedAt: null },
      ],
    });
    const barrier = evaluateReadiness(ready({ stores: [many] }));
    expect(barrier.map((u) => u.subject)).toEqual([
      { deviceId: 'd1' },
      { deviceId: 'd2' },
      { warehouseRef: 'A' },
      { warehouseRef: 'C' },
    ]);
    expect(barrier.every((u) => u.code === 'store_barrier_unprovable' && u.storeId === STORE)).toBe(true);
  });

  it('only the barrier boundary has a subject; the others have no subject key at all', () => {
    const none = evaluateReadiness(
      ready({ stores: [goodStore({ hasStockWarehouse: false })], connector: goodConnector({ lastSeenAt: null }) }),
    );
    expect(none.map((u) => u.code)).toEqual(['connector_not_seen', 'store_warehouse_unmapped']);
    for (const u of none) expect(Object.keys(u)).not.toContain('subject');
  });

  it('a device with a pending queue is NOT an evidence gap (the cut itself waits for it)', () => {
    const busy = goodStore({
      devices: [{ deviceId: 'd', hasHealthRow: true, lastSeenAt: NOW, pending: 7, deadLetter: 0, held: 0 }],
    });
    expect(evaluateReadiness(ready({ stores: [busy] }))).toEqual([]);
  });
});

describe('the Connector evidence (connector_health, RT-1427)', () => {
  it('refuses a Connector never seen or seen too long ago', () => {
    expect(codes(withConnector({ lastSeenAt: null }))).toContain('connector_not_seen');
    expect(codes(withConnector({ lastSeenAt: ago(CONNECTOR_HEARTBEAT_MAX_AGE_MS + 1) }))).toContain('connector_not_seen');
    expect(codes(withConnector({ lastSeenAt: ago(CONNECTOR_HEARTBEAT_MAX_AGE_MS) }))).toEqual([]);
  });

  it('no connector_health row at all lists every Connector boundary', () => {
    const none = withConnector({ lastSeenAt: null, acceptedKinds: null, backDatedRoleStatus: null, backDatedRoleReportedAt: null });
    expect(codes(none)).toEqual(['connector_not_seen', 'connector_version_unlisted', 'erp_back_dated_role_unverified']);
  });

  it.each([
    ['never reported (null)', null],
    ['an empty list', []],
    ['kinds without inventory_count', ['sale_post', 'reversal']],
  ])('refuses accepted kinds: %s', (_name, kinds) => {
    expect(codes(withConnector({ acceptedKinds: kinds }))).toEqual(['connector_version_unlisted']);
  });

  it('accepts a Connector that reports inventory_count among its kinds', () => {
    expect(codes(withConnector({ acceptedKinds: ['inventory_count'] }))).toEqual([]);
  });

  it.each([
    ['no report (null)', null],
    ['missing', 'missing'],
    ['unknown', 'unknown'],
    ['an unrecognised value', 'granted'],
  ])('refuses a back-dated role status: %s', (_name, status) => {
    expect(codes(withConnector({ backDatedRoleStatus: status }))).toEqual(['erp_back_dated_role_unverified']);
  });

  it('refuses a verified role whose report is absent or stale by the SERVER clock, and accepts it at the edge', () => {
    expect(codes(withConnector({ backDatedRoleReportedAt: null }))).toEqual(['erp_back_dated_role_unverified']);
    expect(codes(withConnector({ backDatedRoleReportedAt: ago(CONNECTOR_HEARTBEAT_MAX_AGE_MS + 1) }))).toEqual([
      'erp_back_dated_role_unverified',
    ]);
    expect(codes(withConnector({ backDatedRoleReportedAt: ago(CONNECTOR_HEARTBEAT_MAX_AGE_MS) }))).toEqual([]);
  });

  it('a fresh heartbeat does not make a stale role report fresh (each window is judged on its own timestamp)', () => {
    const e = withConnector({ lastSeenAt: NOW, backDatedRoleReportedAt: ago(CONNECTOR_HEARTBEAT_MAX_AGE_MS * 4) });
    expect(codes(e)).toEqual(['erp_back_dated_role_unverified']);
  });

  it('lists tenant-wide boundaries first, then each store in order, all of them', () => {
    const e = ready({
      connector: goodConnector({ lastSeenAt: null, acceptedKinds: null, backDatedRoleStatus: 'unknown' }),
      stores: [goodStore({ storeId: 'b', hasStockWarehouse: false }), goodStore({ storeId: 'a', hasStockWarehouse: false })],
    });
    expect(evaluateReadiness(e).map((u) => [u.code, u.storeId])).toEqual([
      ['connector_not_seen', null],
      ['connector_version_unlisted', null],
      ['erp_back_dated_role_unverified', null],
      ['store_warehouse_unmapped', 'b'],
      ['store_warehouse_unmapped', 'a'],
    ]);
  });
});
