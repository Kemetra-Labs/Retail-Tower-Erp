/**
 * Jira RT-1513 — the pure shipment Transfer rules: lifecycle, In Transit arithmetic, receipt and close plans, the
 * legal-entity seam and the frozen wire bodies (posting-feed.yaml 1.17.0-draft). No database.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../../../src/common/hashing/canonical-json';
import {
  TransferRuleError,
  applyCommand,
  assertErpQuantity,
  assertSameLegalEntity,
  dispatchBody,
  dispatchExternalId,
  inTransitOf,
  planClose,
  planReceipt,
  receiptExternalId,
  receiveBody,
  stateAfterReceipt,
  type LineQuantities,
  type TransferCommand,
  type TransferState,
} from '../../../src/inventory/shipment-transfers/shipment-transfer.rules';
import {
  evaluateTransferReadiness,
  type TransferReadinessEvidence,
} from '../../../src/inventory/shipment-transfers/shipment-transfer-activation.service';
import { aggregateLegState } from '../../../src/inventory/shipment-transfers/shipment-transfer.store';

const line = (id: string, over: Partial<LineQuantities> = {}): LineQuantities => ({
  id,
  lineSeq: 1,
  quantity: '10.0000',
  dispatchedQuantity: '10.0000',
  receivedQuantity: '0.0000',
  shortClosedQuantity: '0.0000',
  ...over,
});

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (e) {
    return e instanceof TransferRuleError ? e.code : `unexpected:${(e as Error).message}`;
  }
  return null;
};

describe('lifecycle (802)', () => {
  const allowed: Array<[TransferCommand, TransferState[]]> = [
    ['approve', ['draft']],
    ['cancel', ['draft', 'approved']],
    ['dispatch', ['approved']],
    ['receive', ['in_transit', 'partially_received']],
    ['close', ['received', 'partially_received', 'in_transit']],
  ];
  const states: TransferState[] = ['draft', 'approved', 'in_transit', 'partially_received', 'received', 'closed', 'cancelled'];

  it.each(allowed)('%s is allowed only from %j and refused everywhere else (409)', (command, from) => {
    for (const s of states) {
      expect(codeOf(() => applyCommand(s, command))).toBe(from.includes(s) ? null : 'shipment_transfer_not_in_state');
    }
  });

  it('cancel is never allowed once goods are in transit, and terminal states accept nothing', () => {
    expect(codeOf(() => applyCommand('in_transit', 'cancel'))).toBe('shipment_transfer_not_in_state');
    for (const c of ['approve', 'cancel', 'dispatch', 'receive', 'close'] as const) {
      expect(codeOf(() => applyCommand('closed', c))).toBe('shipment_transfer_not_in_state');
      expect(codeOf(() => applyCommand('cancelled', c))).toBe('shipment_transfer_not_in_state');
    }
  });

  it('names the state each command leaves, and leaves receive to the lines', () => {
    expect(applyCommand('draft', 'approve')).toBe('approved');
    expect(applyCommand('approved', 'dispatch')).toBe('in_transit');
    expect(applyCommand('approved', 'cancel')).toBe('cancelled');
    expect(applyCommand('received', 'close')).toBe('closed');
    expect(applyCommand('in_transit', 'receive')).toBeNull();
  });
});

describe('In Transit is dispatched - received - short-closed (G4-1)', () => {
  it('is exact and never a Stock Location', () => {
    expect(inTransitOf(line('a'))).toBe(100000n);
    expect(inTransitOf(line('a', { receivedQuantity: '4.0000' }))).toBe(60000n);
    expect(inTransitOf(line('a', { receivedQuantity: '4.0000', shortClosedQuantity: '6.0000' }))).toBe(0n);
    expect(inTransitOf(line('a', { dispatchedQuantity: '0.0000' }))).toBe(0n);
  });

  it('carries a fractional quantity without float error', () => {
    expect(inTransitOf(line('a', { quantity: '0.3000', dispatchedQuantity: '0.3000', receivedQuantity: '0.1000' }))).toBe(2000n);
  });
});

describe('receipts (803, 804, 809-813)', () => {
  const lines = [line('a'), line('b', { lineSeq: 2, quantity: '5.0000', dispatchedQuantity: '5.0000' })];

  it('plans a partial receipt and leaves the Transfer partially received', () => {
    const plan = planReceipt(lines, [{ transferLineId: 'a', quantity: '4' }]);
    expect(plan).toEqual([{ transferLineId: 'a', quantity: 40000n, receivedAfter: 40000n }]);
    expect(stateAfterReceipt(lines, plan)).toBe('partially_received');
  });

  it('is received only when every line reaches zero in transit', () => {
    const plan = planReceipt(lines, [
      { transferLineId: 'a', quantity: '10' },
      { transferLineId: 'b', quantity: '5' },
    ]);
    expect(stateAfterReceipt(lines, plan)).toBe('received');
    const partial = planReceipt(lines, [{ transferLineId: 'a', quantity: '10' }]);
    expect(stateAfterReceipt(lines, partial)).toBe('partially_received');
  });

  it('a second receipt takes only what is still in transit', () => {
    const afterFirst = [line('a', { receivedQuantity: '4.0000' })];
    expect(planReceipt(afterFirst, [{ transferLineId: 'a', quantity: '6' }])[0]!.receivedAfter).toBe(100000n);
    expect(codeOf(() => planReceipt(afterFirst, [{ transferLineId: 'a', quantity: '6.0001' }]))).toBe('over_receipt_requires_approval');
  });

  it('refuses an over-receipt (813), an unknown line, a duplicate line and a non-positive quantity', () => {
    expect(codeOf(() => planReceipt(lines, [{ transferLineId: 'a', quantity: '10.0001' }]))).toBe('over_receipt_requires_approval');
    expect(codeOf(() => planReceipt(lines, [{ transferLineId: 'zzz', quantity: '1' }]))).toBe('validation_error');
    expect(
      codeOf(() => planReceipt(lines, [{ transferLineId: 'a', quantity: '1' }, { transferLineId: 'a', quantity: '1' }])),
    ).toBe('validation_error');
    expect(codeOf(() => planReceipt(lines, [{ transferLineId: 'a', quantity: '0' }]))).toBe('validation_error');
  });
});

describe('close and short-close (812)', () => {
  it('closes a fully received Transfer with no reason, and refuses a reason when nothing is in transit', () => {
    const done = [line('a', { receivedQuantity: '10.0000' })];
    expect(planClose(done, null)).toEqual({ shortClose: false, lines: [] });
    expect(codeOf(() => planClose(done, 'why'))).toBe('validation_error');
  });

  it('needs a reason while any quantity is in transit, and writes off exactly the remainder', () => {
    const open = [line('a', { receivedQuantity: '4.0000' }), line('b', { receivedQuantity: '10.0000' })];
    expect(codeOf(() => planClose(open, null))).toBe('short_close_reason_required');
    expect(codeOf(() => planClose(open, '   '))).toBe('short_close_reason_required');
    expect(planClose(open, 'lost')).toEqual({ shortClose: true, lines: [{ transferLineId: 'a', quantity: 60000n }] });
  });
});

describe('legal entity (817, 963) and ERP quantity limits', () => {
  it('refuses stores of different legal entities with the typed code, and allows the same entity', () => {
    const entity = (s: string): string => (s === 'x' ? 'company-1' : 'company-2');
    expect(codeOf(() => assertSameLegalEntity(entity, 'x', 'y'))).toBe('cross_legal_entity_transfer');
    expect(codeOf(() => assertSameLegalEntity(entity, 'x', 'x'))).toBeNull();
  });

  it('refuses a quantity above 13 integer digits, the limit of one ERP row', () => {
    expect(codeOf(() => assertErpQuantity(9_999_999_999_999n * 10_000n, 'q'))).toBeNull();
    expect(codeOf(() => assertErpQuantity(10_000_000_000_000n * 10_000n, 'q'))).toBe('validation_error');
  });
});

describe('leg keys and frozen wire bodies (876, 877, 888, 889)', () => {
  const T = '00000000-0000-7000-8000-00000000d0e1';
  const R = '00000000-0000-7000-8000-00000000d2e1';

  it('keys each leg by its own id', () => {
    expect(dispatchExternalId(T)).toBe(`transfer_dispatch:${T}`);
    expect(receiptExternalId(R)).toBe(`transfer_receipt:${R}`);
  });

  it('builds the dispatch body exactly as the contract fixture shapes it', () => {
    const body = dispatchBody({
      transferRef: T,
      sourceStoreId: 's1',
      destinationStoreId: 's2',
      sourceWarehouseRef: 'Store A - RT',
      transitWarehouseRef: 'Goods In Transit - RT',
      postingDatetime: '2026-11-20T09:30:00.000000Z',
      lines: [
        { lineSeq: 1, transferLineRef: 'l1', erpnextItemRef: 'PANADOL-24', erpnextBatchRef: null, quantity: '10', unit: 'Box' },
        { lineSeq: 2, transferLineRef: 'l2', erpnextItemRef: 'AMOXIL-12', erpnextBatchRef: 'AMX-2611', quantity: '4', unit: 'Strip' },
      ],
    });
    expect(body).toEqual({
      transferRef: T, sourceStoreId: 's1', destinationStoreId: 's2',
      sourceWarehouseRef: { doctype: 'Warehouse', name: 'Store A - RT' },
      transitWarehouseRef: { doctype: 'Warehouse', name: 'Goods In Transit - RT' },
      postingDatetime: '2026-11-20T09:30:00.000000Z',
      lines: [
        { lineSeq: 1, transferLineRef: 'l1', erpnextItemRef: { doctype: 'Item', name: 'PANADOL-24' }, erpnextBatchRef: null, quantity: '10', unit: 'Box' },
        { lineSeq: 2, transferLineRef: 'l2', erpnextItemRef: { doctype: 'Item', name: 'AMOXIL-12' }, erpnextBatchRef: { doctype: 'Batch', name: 'AMX-2611' }, quantity: '4', unit: 'Strip' },
      ],
    });
  });

  it('builds the receipt body naming the confirmed dispatch document and each dispatch row', () => {
    const body = receiveBody({
      transferRef: T, receiptRef: R, destinationStoreId: 's2',
      transitWarehouseRef: 'Goods In Transit - RT', destinationWarehouseRef: 'Store B - RT',
      dispatchDocument: { doctype: 'Stock Entry', name: 'MAT-STE-2026-00042' },
      postingDatetime: '2026-11-21T11:00:00.000000Z',
      lines: [{ lineSeq: 1, dispatchLineSeq: 2, transferLineRef: 'l2', erpnextItemRef: 'AMOXIL-12', erpnextBatchRef: 'AMX-2611', quantity: '3', unit: 'Strip' }],
    });
    expect(body['dispatchDocumentRef']).toEqual({ doctype: 'Stock Entry', name: 'MAT-STE-2026-00042' });
    expect((body['lines'] as Array<Record<string, unknown>>)[0]).toMatchObject({ lineSeq: 1, dispatchLineSeq: 2 });
  });

  it('hashes canonically: key order never changes the payload hash', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    const h = (x: unknown): string => createHash('sha256').update(canonicalJson(x as Record<string, unknown>)).digest('hex');
    expect(h(a)).toBe(h(b));
  });

  it('refuses an empty body and one above the 100-row limit of one Stock Entry', () => {
    const base = {
      transferRef: T, sourceStoreId: 's1', destinationStoreId: 's2', sourceWarehouseRef: 'A', transitWarehouseRef: 'T',
      postingDatetime: '2026-11-20T09:30:00.000000Z',
    };
    const one = { lineSeq: 1, transferLineRef: 'l', erpnextItemRef: 'I', erpnextBatchRef: null, quantity: '1', unit: 'u' };
    expect(() => dispatchBody({ ...base, lines: [] })).toThrow(RangeError);
    expect(() => dispatchBody({ ...base, lines: Array.from({ length: 101 }, () => one) })).toThrow(RangeError);
    expect(() => dispatchBody({ ...base, lines: Array.from({ length: 100 }, () => one) })).not.toThrow();
  });
});

describe('leg integration state (G2-3, DC-3)', () => {
  it.each<[string[], string]>([
    [[], 'not_posted'],
    [['not_posted'], 'not_posted'],
    [['pending', 'pending'], 'pending'],
    [['confirmed', 'confirmed'], 'confirmed'],
    [['confirmed', 'pending'], 'pending'],
    [['pending', 'rejected'], 'rejected'],
    [['confirmed', 'reconciliation_required'], 'reconciliation_required'],
  ])('%j -> %s', (states, expected) => {
    expect(aggregateLegState(states)).toBe(expected);
  });
});

describe('activation readiness (fails closed)', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const fresh = new Date('2026-11-20T11:55:00Z');
  const ready: TransferReadinessEvidence = {
    now,
    hasTransitWarehouse: true,
    connector: {
      lastSeenAt: fresh,
      acceptedKinds: ['sale_post', 'transfer_dispatch', 'transfer_receive'],
      backDatedRoleStatus: 'verified',
      backDatedRoleReportedAt: fresh,
    },
  };

  it('is ready when the Connector accepts both transfer kinds, is fresh and verified, and a transit warehouse exists', () => {
    expect(evaluateTransferReadiness(ready)).toEqual([]);
  });

  it.each<[string, Partial<TransferReadinessEvidence>, string]>([
    ['no heartbeat', { connector: { ...ready.connector, lastSeenAt: null } }, 'connector_not_seen'],
    ['a stale heartbeat', { connector: { ...ready.connector, lastSeenAt: new Date('2026-11-20T11:00:00Z') } }, 'connector_not_seen'],
    ['kinds never reported', { connector: { ...ready.connector, acceptedKinds: null } }, 'connector_version_unlisted'],
    ['only the dispatch kind', { connector: { ...ready.connector, acceptedKinds: ['transfer_dispatch'] } }, 'connector_version_unlisted'],
    ['an unverified role', { connector: { ...ready.connector, backDatedRoleStatus: 'unknown' } }, 'erp_back_dated_role_unverified'],
    ['a stale role report', { connector: { ...ready.connector, backDatedRoleReportedAt: new Date('2026-11-20T10:00:00Z') } }, 'erp_back_dated_role_unverified'],
    ['no transit warehouse', { hasTransitWarehouse: false }, 'transit_warehouse_unmapped'],
  ])('is not ready with %s', (_why, over, code) => {
    expect(evaluateTransferReadiness({ ...ready, ...over }).map((u) => u.code)).toEqual([code]);
  });
});
