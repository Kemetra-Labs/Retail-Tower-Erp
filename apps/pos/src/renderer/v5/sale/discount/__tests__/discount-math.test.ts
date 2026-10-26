/**
 * RT-855 — the renderer's discount reading: the sheet's value against the line
 * gross (the same shared math main applies), and the cart totals it shows.
 */
import { describe, expect, it } from 'vitest';

import { cartDiscountTotals, readDiscountEntry } from '../discount-math';
import {
  addRefusalCopy,
  approvalRefusalCopy,
  amountHelp,
  approvedByLabel,
  DISCOUNT_COPY,
  reasonLabel,
} from '../discount-copy';

describe('readDiscountEntry — percent (OD-28-2: whole 1–100)', () => {
  it('reads the §5 example: 10% of 90.00 is 9.00, net 81.00', () => {
    expect(readDiscountEntry('percent', '10', 9000)).toEqual({
      kind: 'ok',
      discount: { kind: 'percent', value: 10 },
      token: 'manual_pct_10',
      amountMinor: 900,
      netMinor: 8100,
    });
  });

  it('rounds half up once on the line gross (15% of 29.50 → 4.43)', () => {
    expect(readDiscountEntry('percent', '15', 2950)).toMatchObject({ amountMinor: 443 });
  });

  it('accepts Arabic-Indic digits and 100% (a free line)', () => {
    expect(readDiscountEntry('percent', '١٠٠', 2950)).toMatchObject({
      token: 'manual_pct_100',
      netMinor: 0,
    });
  });

  it.each(['0', '101', '10.5', '-5', '010', 'abc'])('refuses %s', (raw) => {
    expect(readDiscountEntry('percent', raw, 9000)).toEqual({ kind: 'invalid' });
  });

  it('is empty before anything is typed', () => {
    expect(readDiscountEntry('percent', '  ', 9000)).toEqual({ kind: 'empty' });
  });
});

describe('readDiscountEntry — fixed amount (§3.2: ≤ the line gross)', () => {
  it('reads EGP into minor units and names the token in minor units', () => {
    expect(readDiscountEntry('amount', '5.00', 6800)).toMatchObject({
      token: 'manual_amt_500',
      amountMinor: 500,
      netMinor: 6300,
    });
  });

  it('allows exactly the gross (net 0) and the Arabic decimal separator', () => {
    expect(readDiscountEntry('amount', '68', 6800)).toMatchObject({ netMinor: 0 });
    expect(readDiscountEntry('amount', '٥٫٥', 6800)).toMatchObject({ amountMinor: 550 });
  });

  it('refuses an amount above the gross in the sheet (OD-6)', () => {
    expect(readDiscountEntry('amount', '68.01', 6800)).toEqual({ kind: 'over_gross' });
  });

  it.each(['0', '0.00', '1.234', '1,000', 'x'])('refuses %s', (raw) => {
    expect(readDiscountEntry('amount', raw, 6800)).toEqual({ kind: 'invalid' });
  });

  it('refuses a value the shared math cannot honour (an unsafe gross)', () => {
    expect(readDiscountEntry('percent', '10', Number.MAX_SAFE_INTEGER)).toEqual({
      kind: 'invalid',
    });
  });
});

describe('cartDiscountTotals', () => {
  const lines = [
    { lineId: 'a', lineSubtotalMinor: 9000 },
    { lineId: 'b', lineSubtotalMinor: 6800 },
  ];

  it('sums the known discounts and gives the net', () => {
    const totals = cartDiscountTotals(
      lines,
      [
        { placeholderId: 'p1', lineId: 'a', token: 'manual_pct_10' },
        { placeholderId: 'p2', lineId: 'b', token: 'manual_amt_500' },
      ],
      15800,
    );
    expect(totals.byLine.get('a')).toBe(900);
    expect(totals.byLine.get('b')).toBe(500);
    expect(totals.discountTotalMinor).toBe(1400);
    expect(totals.netMinor).toBe(14400);
  });

  it('makes the totals unknown when a discount’s token is not known here', () => {
    const totals = cartDiscountTotals(lines, [{ placeholderId: 'p1', lineId: 'a' }], 15800);
    expect(totals.byLine.get('a')).toBeNull();
    expect(totals.discountTotalMinor).toBeNull();
    expect(totals.netMinor).toBeNull();
  });

  it('ignores a placeholder on a removed line or with no line, as main does', () => {
    const totals = cartDiscountTotals(
      lines,
      [
        { placeholderId: 'p1', lineId: 'gone', token: 'manual_pct_10' },
        { placeholderId: 'p2', lineId: null, token: 'manual_pct_10' },
      ],
      15800,
    );
    expect(totals.byLine.size).toBe(0);
    expect(totals.discountTotalMinor).toBe(0);
    expect(totals.netMinor).toBe(15800);
  });

  it('is unknown when a token cannot be honoured on its line', () => {
    const totals = cartDiscountTotals(
      lines,
      [{ placeholderId: 'p1', lineId: 'b', token: 'manual_amt_9999' }],
      15800,
    );
    expect(totals.netMinor).toBeNull();
  });
});

describe('discount copy', () => {
  it('words the line and field labels as D1 has them', () => {
    expect(approvedByLabel('سارة عبد الحميد')).toBe('بموافقة: سارة عبد الحميد');
    expect(amountHelp('90.00 EGP')).toBe('حتى إجمالي الصنف: 90.00 EGP.');
    expect(reasonLabel('loyal_or_contract_customer')).toBe('عميل دائم / تعاقد');
  });

  it('places each add refusal where D1 draws it; other codes get the generic line', () => {
    expect(addRefusalCopy('approval_invalid').place).toBe('approval');
    expect(addRefusalCopy('approval_stale').place).toBe('stale');
    expect(addRefusalCopy('invalid_payload')).toEqual({
      message: DISCOUNT_COPY.overGross,
      place: 'sheet',
    });
    expect(addRefusalCopy('manager_attribution_required')).toEqual({
      message: DISCOUNT_COPY.cashierHint,
      place: 'sheet',
    });
    expect(addRefusalCopy('line_discounted').message).toBe(DISCOUNT_COPY.qtyRefused);
    expect(addRefusalCopy('frozen')).toEqual({ message: DISCOUNT_COPY.unavailable, place: 'cart' });
  });

  it('never says which part of an approval failed (RT-114 C3)', () => {
    expect(approvalRefusalCopy('approval_unavailable').message).toBe(DISCOUNT_COPY.approverInvalid);
    expect(approvalRefusalCopy('approval_stale').place).toBe('stale');
    expect(approvalRefusalCopy('approval_invalid').message).toBe(DISCOUNT_COPY.approvalInvalid);
    expect(approvalRefusalCopy('session_locked').message).toBe(DISCOUNT_COPY.unavailable);
  });
});
