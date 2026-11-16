/**
 * Jira RT-1424 — the pure rules of the late-count compensation (RT-292 G6-5, conditions A to I): one refusal test per
 * condition, the worked example (Retail 5, ERP 7 resolves to 7 / 7), the deterministic key and the post-write
 * invariants. No I/O; the database behaviour is `late-compensation.db.spec.ts`.
 */
import {
  compensationKey,
  dec,
  decText,
  evaluateCompensation,
  type CompensationEvidence,
  type CompensationPlan,
  type CompensationRefusal,
  type LedgerRow,
} from '../../../src/inventory/count-sessions/late-compensation.rules';
import { checkInvariants } from '../../../src/inventory/count-sessions/late-compensation.service';

const CUT = new Date('2026-11-16T10:00:00Z');
const LATE_ID = '0a000000-0000-7000-8000-0000000000a1';
const COUNT_EFFECT = '0a000000-0000-7000-8000-0000000000c1';
const PRODUCT = '0a000000-0000-7000-8000-0000000000b1';
const STORE = '0a000000-0000-7000-8000-0000000000d1';
const LOC = '0a000000-0000-7000-8000-0000000000e1';
const DOC = JSON.stringify({ doctype: 'Stock Reconciliation', name: 'MAT-RECO-1' });

const ledger = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  isCancelled: false,
  postingDate: '2026-11-16',
  postingTime: '09:59:00',
  actualQty: '-2.000000',
  stockUom: 'Nos',
  creation: new Date('2026-11-16T10:05:00Z'),
  ...over,
});

/** Retail 5 / ERP 7: ERP held 10, the count found 7 (correction -3), a late sale of 2 reached Retail after the cut. */
function base(over: Partial<CompensationEvidence> = {}): CompensationEvidence {
  return {
    session: { state: 'needs_attention', cutAt: CUT },
    finding: {
      id: 'f1',
      sessionId: 's1',
      productId: PRODUCT,
      quantity: '2.0000',
      eventType: 'sale',
      eventReference: 'sale-1',
      sourceSystem: 'pos',
      externalId: 'ext-1',
      effectId: LATE_ID,
      erpStamp: new Date('2026-11-16T09:59:00Z'),
      detectedInState: 'posting',
    },
    late: {
      id: LATE_ID,
      storeId: STORE,
      productId: PRODUCT,
      quantity: '-2.0000',
      unit: 'each',
      locationId: LOC,
      status: 'sellable',
      movementType: 'sale',
      origin: 'retail',
      eventType: 'sale',
      eventRefId: 'sale-1',
      sourceSystem: 'pos',
      externalId: 'ext-1',
      receivedAt: new Date('2026-11-16T10:10:00Z'),
      integrationState: 'confirmed',
      erpDocumentRef: JSON.stringify({ doctype: 'Sales Invoice', name: 'SINV-1' }),
      erpConfirmedAt: new Date('2026-11-16T10:12:00Z'),
    },
    storeId: STORE,
    countEffects: [{ id: COUNT_EFFECT, movementType: 'count_correction', compensates: null, locationId: LOC, status: 'sellable' }],
    stockCountId: 'sc1',
    countLine: {
      result: 'adjusted',
      verifiedQtyAfter: '7.0000',
      countedQuantity: '7.0000',
      unit: 'each',
      intentStatus: 'posted',
      documentRef: DOC,
      postedAt: new Date('2026-11-16T10:20:00Z'),
    },
    countRows: [ledger({ postingTime: '10:00:00.000001', actualQty: '-1.000000' })],
    lateRows: [ledger()],
    bin: { quantity: '7', readAt: new Date('2026-11-16T10:30:00Z'), uom: 'each' },
    position: { operationalPosition: '5', expectedErpBook: '5', operationalUnit: 'each', erpStockUom: 'each' },
    ...over,
  };
}

function refused(e: CompensationEvidence): CompensationRefusal {
  const r = evaluateCompensation(e);
  if (r.ok) throw new Error('expected a refusal');
  return r;
}

describe('late-compensation rules (RT-1424)', () => {
  it('resolves Retail 5 / ERP 7 to 7 / 7: the compensation is +2, projected expected 7, the Bin 7', () => {
    const r = evaluateCompensation(base()) as CompensationPlan;
    expect(r.ok).toBe(true);
    expect(r.quantity).toBe('2');
    expect(r.projectedExpected).toBe('7');
    expect(r.countEffectId).toBe(COUNT_EFFECT);
    expect(r.absorbingDocument).toBe(DOC);
    expect(dec(r.quantity)).toBe(-dec('-2.0000'));
  });

  describe('A: causal link', () => {
    it.each([
      ['a late event found before approval', { finding: { ...base().finding, detectedInState: 'submitted' } }],
      ['a session that has not been approved', { session: { state: 'submitted', cutAt: CUT } }],
      ['a missing Count Cut', { session: { state: 'needs_attention', cutAt: null } }],
      ['a missing late event', { late: null }],
      ['references that differ (external id)', { late: { ...base().late!, externalId: 'other' } }],
      ['another product', { late: { ...base().late!, productId: 'other' } }],
      ['another store', { late: { ...base().late!, storeId: 'other' } }],
      ['an event learned before the cut', { late: { ...base().late!, receivedAt: new Date('2026-11-16T09:00:00Z') } }],
      ['an ERP stamp after the cut', { finding: { ...base().finding, erpStamp: new Date('2026-11-16T10:00:01Z') } }],
      ['a finding quantity that is not the event quantity', { finding: { ...base().finding, quantity: '1.0000' } }],
      ['a count with no correction at the position', { countEffects: [] }],
      [
        'two corrections at the position',
        {
          countEffects: [
            { id: 'x1', movementType: 'count_correction', compensates: null, locationId: LOC, status: 'sellable' },
            { id: 'x2', movementType: 'count_correction', compensates: null, locationId: LOC, status: 'sellable' },
          ],
        },
      ],
      ['a count correction at another status', { countEffects: [{ id: 'x', movementType: 'count_correction', compensates: null, locationId: LOC, status: 'damaged' }] }],
      ['a late event that is itself a count correction', { late: { ...base().late!, movementType: 'count_correction' } }],
      ['no stock count on the line', { stockCountId: null }],
    ])('refuses %s', (_name, over) => {
      const r = refused(base(over as Partial<CompensationEvidence>));
      expect(r.condition).toBe('A');
      expect(r.code).toBe('compensation_link_invalid');
    });
  });

  describe('B: independent ERP read-back', () => {
    it.each([
      ['no count chunk', { countLine: null }],
      ['a chunk that was not posted', { countLine: { ...base().countLine!, intentStatus: 'pending' } }],
      ['a verified no-op chunk (no count ledger row exists)', { countLine: { ...base().countLine!, result: 'verified_noop' } }],
      ['a count verified at another quantity', { countLine: { ...base().countLine!, verifiedQtyAfter: '6.0000' } }],
      ['no count ledger row', { countRows: [] }],
      ['a cancelled count ledger row', { countRows: [ledger({ isCancelled: true })] }],
      ['no late event ledger row', { lateRows: [] }],
      ['a late event ledger row cancelled after it was read', { lateRows: [ledger(), ledger({ isCancelled: true })] }],
      ['a late ledger row with no posting stamp (imported before 0118)', { lateRows: [ledger({ postingDate: null, postingTime: null })] }],
      ['a count ledger row with no posting stamp', { countRows: [ledger({ postingDate: null, postingTime: null })] }],
      ['ledger rows in different units', { lateRows: [ledger(), ledger({ stockUom: 'Box' })] }],
    ])('refuses %s', (_name, over) => {
      const r = refused(base(over as Partial<CompensationEvidence>));
      expect(r.condition).toBe('B');
      expect(r.code).toBe('compensation_erp_evidence_missing');
    });
  });

  describe('C: ERP ordering and absorption', () => {
    it.each([
      ['a late event still pending in ERP', { late: { ...base().late!, integrationState: 'pending' } }],
      ['a late event not posted at all', { late: { ...base().late!, integrationState: 'not_posted' } }],
      ['a late event rejected by ERP', { late: { ...base().late!, integrationState: 'rejected' } }],
      ['a late ledger posting equal to the count', { lateRows: [ledger({ postingTime: '10:00:00.000001' })] }],
      ['a late ledger posting after the count', { lateRows: [ledger({ postingTime: '10:00:05' })] }],
      ['a late ledger posting on a later day', { lateRows: [ledger({ postingDate: '2026-11-17' })] }],
      [
        'an equal posting stamp where the late row was created AFTER the count row (the tie goes to creation)',
        {
          lateRows: [ledger({ postingTime: '10:00:00.000001', creation: new Date('2026-11-16T10:06:00Z') })],
          countRows: [ledger({ postingTime: '10:00:00.000001', actualQty: '-1.000000', creation: new Date('2026-11-16T10:05:00Z') })],
        },
      ],
    ])('refuses %s', (_name, over) => {
      const r = refused(base(over as Partial<CompensationEvidence>));
      expect(r.condition).toBe('C');
      expect(r.code).toBe('compensation_erp_order_unproven');
    });

    it('accepts an equal posting stamp when the late row was created BEFORE the count row (creation breaks the tie)', () => {
      const e = base({
        lateRows: [ledger({ postingTime: '10:00:00.000001', creation: new Date('2026-11-16T10:04:00Z') })],
        countRows: [ledger({ postingTime: '10:00:00.000001', actualQty: '-1.000000', creation: new Date('2026-11-16T10:05:00Z') })],
      });
      expect(evaluateCompensation(e).ok).toBe(true);
    });

    it('orders by the latest of several late rows: one row after the count refuses', () => {
      const e = base({ lateRows: [ledger({ actualQty: '-1.000000' }), ledger({ actualQty: '-1.000000', postingTime: '10:00:05' })] });
      expect(refused(e).code).toBe('compensation_erp_order_unproven');
    });

    it('accepts an ERP-origin (`external`) late event too', () => {
      const e = base({ late: { ...base().late!, origin: 'erp_external', integrationState: 'external', erpDocumentRef: null } });
      expect(evaluateCompensation(e).ok).toBe(true);
    });
  });

  it('F: refuses when the absorbing ERP document is not named', () => {
    const r = refused(base({ countLine: { ...base().countLine!, documentRef: null } }));
    expect(r.condition).toBe('F');
    expect(r.code).toBe('compensation_not_explainable');
  });

  describe('H: exact quantity', () => {
    it.each([
      ['a ledger quantity that is a part of the event', { lateRows: [ledger({ actualQty: '-1.000000' })] }],
      ['a ledger quantity larger than the event', { lateRows: [ledger({ actualQty: '-3.000000' })] }],
      ['a ledger quantity of the other sign', { lateRows: [ledger({ actualQty: '2.000000' })] }],
      ['a late event in another unit than the count', { late: { ...base().late!, unit: 'box' } }],
    ])('refuses %s', (_name, over) => {
      const r = refused(base(over as Partial<CompensationEvidence>));
      expect(r.condition).toBe('H');
      expect(r.code).toBe('compensation_quantity_mismatch');
    });

    it('sums several ledger rows of one voucher into the exact event quantity', () => {
      const e = base({ lateRows: [ledger({ actualQty: '-1.000000' }), ledger({ actualQty: '-1.000000' })] });
      expect(evaluateCompensation(e).ok).toBe(true);
    });
  });

  describe('D: consistency with the Bin (unrelated divergence cannot be masked)', () => {
    it.each([
      ['no position', { position: null }],
      ['no Bin snapshot', { bin: null }],
      ['a Bin read before the late event was confirmed', { bin: { quantity: '7', readAt: new Date('2026-11-16T10:11:00Z'), uom: 'each' } }],
      ['a Bin read before the ledger rows were created', { bin: { quantity: '7', readAt: new Date('2026-11-16T10:04:00Z'), uom: 'each' } }],
      ['a Bin in another unit', { bin: { quantity: '7', readAt: new Date('2026-11-16T10:30:00Z'), uom: 'box' } }],
      ['unrelated divergence: the Bin is 9', { bin: { quantity: '9', readAt: new Date('2026-11-16T10:30:00Z'), uom: 'each' } }],
      ['unrelated divergence: Retail operational is 4', { position: { operationalPosition: '4', expectedErpBook: '5', operationalUnit: 'each', erpStockUom: 'each' } }],
      ['a second uncompensated late event of the same product (operational 3, expected 3, Bin 7)', { position: { operationalPosition: '3', expectedErpBook: '3', operationalUnit: 'each', erpStockUom: 'each' } }],
      ['a pending term already inside expected (expected 4, operational 5)', { position: { operationalPosition: '5', expectedErpBook: '4', operationalUnit: 'each', erpStockUom: 'each' } }],
    ])('refuses %s', (_name, over) => {
      const r = refused(base(over as Partial<CompensationEvidence>));
      expect(r.condition).toBe('D');
      expect(r.code).toBe('compensation_book_inconsistent');
    });
  });

  describe('G: deterministic key', () => {
    const k = { sessionId: 's', countEffectId: 'c', lateEffectId: 'l' };
    it('is stable, hex and derived from the three immutable references only', () => {
      expect(compensationKey(k)).toBe(compensationKey({ ...k }));
      expect(compensationKey(k)).toMatch(/^[0-9a-f]{64}$/);
      expect(compensationKey({ ...k, lateEffectId: 'm' })).not.toBe(compensationKey(k));
      expect(compensationKey({ ...k, sessionId: 't' })).not.toBe(compensationKey(k));
      expect(compensationKey({ ...k, countEffectId: 'd' })).not.toBe(compensationKey(k));
    });
  });

  describe('I: post-write invariants', () => {
    const pos = (over: Record<string, string> = {}) =>
      ({
        storeId: STORE,
        tenantProductRef: PRODUCT,
        anchorGeneration: 1,
        anchorQuantity: '10',
        operationalPosition: '5',
        pendingErp: '0',
        pendingRetail: '0',
        expectedErpBook: '5',
        latestErpConfirmedAt: null,
        operationalUnit: 'each',
        erpStockUom: 'each',
        legacyOnHand: '5',
        ...over,
      }) as never;
    const other = { ...(pos() as object), tenantProductRef: 'other-product', operationalPosition: '3', expectedErpBook: '3' } as never;
    const book = (p: unknown, extra: unknown[] = []) => new Map<string, never>([[PRODUCT, p as never], ...(extra.map((x) => [(x as { tenantProductRef: string }).tenantProductRef, x as never]) as Array<[string, never]>)]);
    const goodAfter = pos({ operationalPosition: '7', expectedErpBook: '7', legacyOnHand: '7' });

    it('passes for the worked example', () => {
      expect(checkInvariants(book(pos()), book(goodAfter), PRODUCT, '2', '7', '7')).toBeNull();
    });
    it('fails when the operational position is not the Bin', () => {
      expect(checkInvariants(book(pos()), book(pos({ operationalPosition: '8', expectedErpBook: '7' })), PRODUCT, '2', '7', '7')).not.toBeNull();
    });
    it('fails when a pending ERP term appeared', () => {
      expect(checkInvariants(book(pos()), book(pos({ operationalPosition: '7', expectedErpBook: '7', pendingErp: '2' })), PRODUCT, '2', '7', '7')).toMatch(/pending/);
    });
    it('fails when a pending Retail term appeared', () => {
      expect(checkInvariants(book(pos()), book(pos({ operationalPosition: '7', expectedErpBook: '7', pendingRetail: '2' })), PRODUCT, '2', '7', '7')).toMatch(/pending/);
    });
    it('fails when the position moved by more than the compensation', () => {
      expect(checkInvariants(book(pos({ operationalPosition: '4' })), book(goodAfter), PRODUCT, '2', '7', '7')).toMatch(/moved by more/);
    });
    it('does not read other lines back: unrelated traffic on another product cannot refuse a compensation', () => {
      const changed = { ...(other as object), operationalPosition: '9' } as never;
      expect(checkInvariants(book(pos(), [other]), book(goodAfter, [changed]), PRODUCT, '2', '7', '7')).toBeNull();
    });
  });

  it('dec/decText are exact and round-trip', () => {
    expect(decText(dec('-2.5'))).toBe('-2.5');
    expect(decText(dec('100.000000'))).toBe('100');
    expect(decText(dec('0.000001'))).toBe('0.000001');
    expect(() => dec('1e3')).toThrow();
    expect(dec('7') + dec('2')).toBe(dec('9'));
  });
});
