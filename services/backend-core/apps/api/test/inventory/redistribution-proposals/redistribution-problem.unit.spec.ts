/**
 * Jira RT-1600 — the join of the W3 reads into the engine's problem (`buildRedistributionProblem`): what the snapshot
 * does not carry (tracking, stocking unit, open Transfer quantities) and the stores with their exclusions.
 */
import { proposeRedistribution } from '../../../src/inventory/redistribution/propose';
import { DEFAULT_BUFFER_POLICY_V1, DEFAULT_LIMITS_V1 } from '../../../src/inventory/redistribution/policy';
import {
  buildRedistributionProblem,
  cellKey,
  type ProblemReads,
} from '../../../src/inventory/redistribution-proposals/redistribution-problem';

const id = (n: number): string => `0190f5a2-3b4c-7d8e-9f01-${n.toString(16).padStart(12, '0')}`;
const TENANT = id(0x1);
const X = id(0xb1);
const Y = id(0xb2);
const Z = id(0xb3);
const P = id(0xe1);
const Q = id(0xe2);
const AT = '2026-11-26T08:00:00.000Z';

const reads = (over: Partial<ProblemReads> = {}): ProblemReads => ({
  tenantId: TENANT,
  computedAt: AT,
  limits: DEFAULT_LIMITS_V1,
  buffer: DEFAULT_BUFFER_POLICY_V1,
  stores: [
    { storeId: X, readAt: '2026-11-26T07:59:59.100Z', exclusion: null },
    { storeId: Y, readAt: '2026-11-26T07:59:59.200Z', exclusion: null },
  ],
  inactiveStoreIds: [],
  rows: [
    { storeId: X, productId: P, availableToSell: '50.0000', reorderLevel: '10.0000' },
    { storeId: Y, productId: P, availableToSell: '2.0000', reorderLevel: '10.0000' },
  ],
  trackingModes: new Map([[P, 'none']]),
  establishedUnits: new Map([[cellKey(X, P), 'piece']]),
  open: [],
  ...over,
});

describe('buildRedistributionProblem', () => {
  it('fills the unit from the store, else from the product elsewhere, and proposes a move the engine validates', () => {
    const built = buildRedistributionProblem(reads());
    expect(built.problem.rows.map((r) => [r.storeId, r.stockingUnit, r.tracked])).toEqual([
      [X, 'piece', false],
      [Y, 'piece', false],
    ]);
    const result = proposeRedistribution(built.problem);
    expect(result.status).toBe('proposed');
    expect(result.moves).toEqual([
      { productId: P, sourceStoreId: X, destinationStoreId: Y, quantity: '8.0000', stockingUnit: 'piece', warnings: [] },
    ]);
  });

  it('treats a product of unknown tracking mode as tracked (never defaults to untracked)', () => {
    const built = buildRedistributionProblem(reads({ trackingModes: new Map() }));
    expect(built.problem.rows.every((r) => r.tracked)).toBe(true);
    const result = proposeRedistribution(built.problem);
    expect(result.status).toBe('nothing_to_move');
    expect(result.warnings.map((w) => w.code)).toContain('tracked_product_skipped');
  });

  it('skips and counts an untracked row whose unit cannot be resolved to exactly one', () => {
    const none = buildRedistributionProblem(reads({ establishedUnits: new Map() }));
    expect(none.problem.rows).toEqual([]);
    expect(none.warnings).toEqual([{ code: 'stocking_unit_mismatch', productId: P, count: 2, detail: 'stocking_unit_unresolved' }]);
    const two = buildRedistributionProblem(
      reads({
        stores: [...reads().stores, { storeId: Z, readAt: AT, exclusion: null }],
        rows: [...reads().rows, { storeId: Z, productId: P, availableToSell: '0.0000', reorderLevel: '5.0000' }],
        establishedUnits: new Map([[cellKey(X, P), 'piece'], [cellKey(Y, P), 'box']]),
      }),
    );
    expect(two.problem.rows.map((r) => [r.storeId, r.stockingUnit])).toEqual([[X, 'piece'], [Y, 'box']]);
    expect(two.warnings).toEqual([{ code: 'stocking_unit_mismatch', productId: P, count: 1, detail: 'stocking_unit_unresolved' }]);
  });

  it('nets open Transfer quantities per store and product, across units', () => {
    const built = buildRedistributionProblem(
      reads({
        establishedUnits: new Map([[cellKey(X, P), 'piece'], [cellKey(Y, P), 'piece']]),
        open: [
          { storeId: X, productId: P, stockingUnit: 'piece', outboundDraft: '3.0000', inbound: '0.0000' },
          { storeId: X, productId: P, stockingUnit: 'box', outboundDraft: '1.5000', inbound: '0.0000' },
          { storeId: Y, productId: P, stockingUnit: 'piece', outboundDraft: '0.0000', inbound: '4.0000' },
          { storeId: Y, productId: Q, stockingUnit: 'piece', outboundDraft: '0.0000', inbound: '9.0000' },
        ],
      }),
    );
    expect(built.problem.rows.map((r) => [r.storeId, r.openOutboundDraft, r.openInbound])).toEqual([
      [X, '4.5000', '0.0000'],
      [Y, '0.0000', '4.0000'],
    ]);
  });

  it('reports every store with its read time and exclusion; an excluded store is not a source, an inactive one neither way', () => {
    const built = buildRedistributionProblem(
      reads({
        stores: [
          { storeId: X, readAt: '2026-11-26T07:59:59.100Z', exclusion: 'pos_queue_unknown' },
          { storeId: Y, readAt: '2026-11-26T07:59:59.200Z', exclusion: null },
        ],
        inactiveStoreIds: [Z],
      }),
    );
    expect(built.stores).toEqual([
      { storeId: X, readAt: '2026-11-26T07:59:59.100Z', eligibleAsSource: false, exclusion: 'pos_queue_unknown' },
      { storeId: Y, readAt: '2026-11-26T07:59:59.200Z', eligibleAsSource: true, exclusion: null },
      { storeId: Z, readAt: AT, eligibleAsSource: false, exclusion: 'inactive' },
    ]);
    expect(built.problem.stores.map((s) => [s.storeId, s.tenantId, s.exclusion])).toEqual([
      [X, TENANT, 'pos_queue_unknown'],
      [Y, TENANT, undefined],
      [Z, TENANT, 'inactive'],
    ]);
    const result = proposeRedistribution(built.problem);
    expect(result.status).toBe('nothing_to_move');
    expect(result.warnings).toEqual(expect.arrayContaining([{ code: 'store_excluded_as_source', storeId: X, detail: 'pos_queue_unknown' }]));
  });
});
