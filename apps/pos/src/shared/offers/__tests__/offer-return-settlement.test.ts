/**
 * RT-1339 (RT-286 S7) — the return settlement refuses a sale line that breaks a capture
 * invariant (the golden vectors cover the settlement itself).
 */
import { describe, expect, it } from 'vitest';
import { settleOfferReturn, type SaleOfferLine } from '../offer-return-settlement.js';

const OFFER = { buyQuantity: 1, getQuantity: 1, percentOff: '40', maxApplicationsPerSale: null };

function settle(line: Partial<SaleOfferLine>, returnedNow = 1n) {
  const saleLine: SaleOfferLine = {
    lineRef: 'l1',
    productId: 'p1',
    unitPrice: '100.00',
    quantity: '1',
    lineAmount: '100.00',
    discountAmount: '0.00',
    ...line,
  };
  return settleOfferReturn({
    offer: OFFER,
    minorUnit: 2,
    saleLines: [saleLine],
    returnedBefore: new Map(),
    clawbacksBefore: 0n,
    returnedNow: new Map([['l1', returnedNow]]),
  });
}

describe('settleOfferReturn invariants', () => {
  it('settles a plain eligible line with no clawback', () => {
    expect(settle({})).toMatchObject({ refund: 10_000n, clawback: 0n, giveBack: 0n });
  });

  it.each([
    ['a fractional quantity', { quantity: '1.5' }, /non-whole quantity/],
    ['a zero quantity', { quantity: '0' }, /non-whole quantity/],
    ['too many units', { quantity: '100001' }, /too many units/],
    [
      'a discount that does not divide by the quantity',
      { quantity: '3', lineAmount: '300.00', discountAmount: '1.00' },
      /discount does not divide/,
    ],
    [
      'a net that does not divide by the quantity',
      { quantity: '3', lineAmount: '1.00' },
      /net does not divide/,
    ],
  ])('refuses %s', (_label, line, message) => {
    expect(() => settle(line)).toThrow(message);
  });

  it('names the invariant error', () => {
    try {
      settle({ quantity: '1.5' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).name).toBe('OfferReturnInvariantError');
    }
  });
});
