/**
 * Jira RT-1600 — the accept re-check of each listed line (drop or reduce, with the reason) and the grouping of the
 * kept lines into W3 draft Transfers (one per store pair, split at 100 lines, each product once per Transfer).
 */
import { DEFAULT_BUFFER_POLICY_V1, TRANSFER_LINE_MAX } from '../../../src/inventory/redistribution/policy';
import {
  groupIntoTransfers,
  planAccept,
  type AcceptFacts,
  type AcceptLine,
} from '../../../src/inventory/redistribution-proposals/redistribution-accept.plan';
import { cellKey } from '../../../src/inventory/redistribution-proposals/redistribution-problem';

const id = (n: number): string => `0190f5a2-3b4c-7d8e-9f01-${n.toString(16).padStart(12, '0')}`;
const X = id(0xb1);
const Y = id(0xb2);
const Z = id(0xb3);
const P = id(0xe1);
const Q = id(0xe2);

const line = (seq: number, over: Partial<AcceptLine> = {}): AcceptLine => ({
  id: id(0xd00 + seq),
  lineSeq: seq,
  productId: P,
  sourceStoreId: X,
  destinationStoreId: Y,
  quantity: '8.0000',
  stockingUnit: 'piece',
  ...over,
});

/** X has 50 of P (level 10, buffer 1: surplus 39); Y has 2 (level 10: gap 8); Z has 0 (level 10: gap 10). */
const facts = (over: Partial<AcceptFacts> = {}): AcceptFacts => ({
  freshStores: new Set([X, Y, Z]),
  rows: new Map([
    [cellKey(X, P), { availableToSell: '50.0000', reorderLevel: '10.0000' }],
    [cellKey(Y, P), { availableToSell: '2.0000', reorderLevel: '10.0000' }],
    [cellKey(Z, P), { availableToSell: '0.0000', reorderLevel: '10.0000' }],
    [cellKey(X, Q), { availableToSell: '50.0000', reorderLevel: '10.0000' }],
    [cellKey(Y, Q), { availableToSell: '0.0000', reorderLevel: '10.0000' }],
  ]),
  openOutbound: new Map(),
  openInbound: new Map(),
  trackingModes: new Map([[P, 'none'], [Q, 'none']]),
  establishedUnits: new Map([[cellKey(X, P), 'piece']]),
  authorized: () => true,
  buffer: DEFAULT_BUFFER_POLICY_V1,
  ...over,
});

const outcomes = (lines: AcceptLine[], f: AcceptFacts) => planAccept(lines, f).map((d) => [d.outcome, d.createdQuantity, d.reason]);

describe('planAccept: the re-check of each line', () => {
  it('creates a line that can still be given in full', () => {
    expect(outcomes([line(1)], facts())).toEqual([['created', '8.0000', null]]);
  });

  it.each([
    ['the source is no longer fresh', { freshStores: new Set([Y]) }, 'source_not_fresh'],
    ['the product is no longer sellable at the destination', { rows: new Map([[cellKey(X, P), { availableToSell: '50.0000', reorderLevel: '10.0000' }]]) }, 'product_not_sellable'],
    ['the product is tracked now', { trackingModes: new Map([[P, 'batch']]) }, 'transfer_rule_refused'],
    ['the product mode is unknown', { trackingModes: new Map<string, string>() }, 'transfer_rule_refused'],
    ['the source established another unit', { establishedUnits: new Map([[cellKey(X, P), 'box']]) }, 'stocking_unit_changed'],
    ['the destination established another unit', { establishedUnits: new Map([[cellKey(Y, P), 'box']]) }, 'stocking_unit_changed'],
    ['the caller has no W3 authority over the stores', { authorized: () => false }, 'transfer_rule_refused'],
  ] as const)('drops the line when %s', (_label, over, reason) => {
    expect(outcomes([line(1)], facts(over as Partial<AcceptFacts>))).toEqual([['dropped', null, reason]]);
  });

  it('reduces to the source surplus net of open drafts, and drops when nothing is left', () => {
    // 50 - 10 - 1 - 36 open outbound = 3
    expect(outcomes([line(1)], facts({ openOutbound: new Map([[cellKey(X, P), 360_000n]]) }))).toEqual([
      ['reduced', '3.0000', 'source_available_insufficient'],
    ]);
    expect(outcomes([line(1)], facts({ openOutbound: new Map([[cellKey(X, P), 390_000n]]) }))).toEqual([
      ['dropped', null, 'source_available_insufficient'],
    ]);
  });

  it('reduces to the destination gap net of open inbound, and drops when the gap closed', () => {
    expect(outcomes([line(1)], facts({ openInbound: new Map([[cellKey(Y, P), 50_000n]]) }))).toEqual([
      ['reduced', '3.0000', 'destination_gap_closed'],
    ]);
    const closed = facts({
      rows: new Map([
        [cellKey(X, P), { availableToSell: '50.0000', reorderLevel: '10.0000' }],
        [cellKey(Y, P), { availableToSell: '12.0000', reorderLevel: '10.0000' }],
      ]),
    });
    expect(outcomes([line(1)], closed)).toEqual([['dropped', null, 'destination_gap_closed']]);
  });

  it('shares one source between lines in line order, net of what the earlier lines took', () => {
    // Surplus 39 at X: line 1 to Y takes 8, line 2 to Z asks 35 and gets 31.
    const plan = outcomes([line(2, { destinationStoreId: Z, quantity: '35.0000' }), line(1)], facts());
    expect(plan).toEqual([
      ['created', '8.0000', null],
      ['reduced', '10.0000', 'destination_gap_closed'],
    ]);
  });

  it('a store without a reorder level has neither a surplus nor a gap', () => {
    const f = facts({
      rows: new Map([
        [cellKey(X, P), { availableToSell: '50.0000', reorderLevel: null }],
        [cellKey(Y, P), { availableToSell: '2.0000', reorderLevel: '10.0000' }],
      ]),
    });
    expect(outcomes([line(1)], f)).toEqual([['dropped', null, 'source_available_insufficient']]);
  });
});

describe('groupIntoTransfers', () => {
  const kept = (lines: AcceptLine[]) => lines.map((l) => ({ line: l, quantity: l.quantity }));

  it('makes one Transfer per store pair, lines in line order', () => {
    const groups = groupIntoTransfers(kept([line(3, { destinationStoreId: Z }), line(2, { productId: Q }), line(1)]));
    expect(groups.map((g) => [g.sourceStoreId, g.destinationStoreId, g.lines.map((k) => k.line.lineSeq)])).toEqual([
      [X, Y, [1, 2]],
      [X, Z, [3]],
    ]);
  });

  it('splits a pair at 100 lines (the W3 limit): 250 lines are Transfers of 100, 100 and 50', () => {
    const lines = Array.from({ length: 250 }, (_, i) => line(i + 1, { productId: id(0x10000 + i) }));
    const groups = groupIntoTransfers(kept(lines));
    expect(TRANSFER_LINE_MAX).toBe(100);
    expect(groups.map((g) => g.lines.length)).toEqual([100, 100, 50]);
    expect(groups.flatMap((g) => g.lines.map((k) => k.line.lineSeq))).toEqual(lines.map((l) => l.lineSeq));
  });

  it('never puts one product twice on a Transfer', () => {
    const groups = groupIntoTransfers(kept([line(1), line(2)]));
    expect(groups.map((g) => g.lines.length)).toEqual([1, 1]);
  });
});
