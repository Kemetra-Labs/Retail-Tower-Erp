/**
 * RT-1339 (RT-286 S7) — only a valid frozen `promotion` reaches the receipt, and only its
 * Arabic name, percent and discount.
 */
import { describe, expect, it } from 'vitest';
import { readReceiptLinePromotion } from '../receipt-promotion.js';

const VALID = { offer_name_ar: 'القطعة التانية بخصم 40%', percent_off: 40, discount_minor: 8_000 };

describe('readReceiptLinePromotion', () => {
  it('keeps the name, percent and discount and drops everything else', () => {
    expect(
      readReceiptLinePromotion({ ...VALID, offer_id: 'o-1', offer_version: 3, pack_revision: 118 }),
    ).toEqual(VALID);
  });

  it('accepts the bounds (1%, 100%, a zero discount, a 120-character name)', () => {
    expect(
      readReceiptLinePromotion({ ...VALID, percent_off: 1, discount_minor: 0 }),
    ).not.toBeNull();
    expect(
      readReceiptLinePromotion({ ...VALID, percent_off: 100, offer_name_ar: 'ع'.repeat(120) }),
    ).not.toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'promo'],
    ['an array', [VALID]],
    ['no name', { ...VALID, offer_name_ar: undefined }],
    ['an empty name', { ...VALID, offer_name_ar: '' }],
    ['a name over 120 characters', { ...VALID, offer_name_ar: 'ع'.repeat(121) }],
    ['a string percent', { ...VALID, percent_off: '40' }],
    ['a fractional percent', { ...VALID, percent_off: 40.5 }],
    ['a zero percent', { ...VALID, percent_off: 0 }],
    ['a percent over 100', { ...VALID, percent_off: 101 }],
    ['a string discount', { ...VALID, discount_minor: '8000' }],
    ['an unsafe discount', { ...VALID, discount_minor: Number.MAX_SAFE_INTEGER + 1 }],
    ['a negative discount', { ...VALID, discount_minor: -1 }],
  ])('refuses %s', (_label, value) => {
    expect(readReceiptLinePromotion(value)).toBeNull();
  });
});
