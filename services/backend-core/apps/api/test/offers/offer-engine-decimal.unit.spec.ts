/**
 * RT-1378 — the exact-decimal helpers of the shared Offer Engine: parsing, the refusals,
 * and formatting (no float anywhere). Moved from the POS copy; `formatColumnAmount` came from
 * the Backend-Core copy.
 */
import {
  OfferDecimalError,
  formatMinor,
  grossMinor,
  percentOf,
  scaled,
  wholeUnits,
  formatColumnAmount,
} from '@data-pulse-2/offer-engine';

describe('offer decimal', () => {
  it('scales a decimal string, accepting trailing zeros beyond the scale', () => {
    expect(scaled('40', 2)).toBe(4_000n);
    expect(scaled('40.0000', 2)).toBe(4_000n);
    expect(scaled('0.05', 2)).toBe(5n);
  });

  it.each(['', 'abc', '-1', '1.', '1e3', '1.234'])('refuses %j at scale 2', (value) => {
    expect(() => scaled(value, 2)).toThrow(OfferDecimalError);
  });

  it.each([
    ['40.0000', 2, 4_000n],
    ['1.5', 2, 150n],
    ['0', 2, 0n],
    ['0.000', 2, 0n],
    ['1.50', 2, 150n],
    ['100', 0, 100n],
    ['12.3400', 4, 123_400n],
  ])('scales %j at scale %i to %s', (value, scale, expected) => {
    expect(scaled(value, scale)).toBe(expected);
  });

  it.each([
    ['1.001', 2],
    ['1.', 2],
    ['abc', 2],
    ['1.5', 0],
  ])('refuses %j at scale %i', (value, scale) => {
    expect(() => scaled(value, scale)).toThrow(OfferDecimalError);
  });

  // RT-1613: the trailing-zero strip must be linear (CodeQL js/polynomial-redos, alert 83).
  it('handles a very long zero run in linear time', () => {
    const started = Date.now();
    expect(() => scaled(`1.${'0'.repeat(100_000)}1`, 2)).toThrow(OfferDecimalError);
    expect(scaled(`1.${'0'.repeat(100_000)}`, 2)).toBe(100n);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('names the error and keeps a given message', () => {
    const plain = new OfferDecimalError('x', 2);
    expect(plain.name).toBe('OfferDecimalError');
    expect(plain.message).toContain('at most 2 fractional digits');
    expect(new OfferDecimalError('x', 2, 'custom').message).toBe('custom');
  });

  it('formats minor units with exactly the minor-unit digits, signed', () => {
    expect(formatMinor(12_000n, 2)).toBe('120.00');
    expect(formatMinor(5n, 2)).toBe('0.05');
    expect(formatMinor(-1_234n, 2)).toBe('-12.34');
    expect(formatMinor(7n, 0)).toBe('7');
    expect(formatMinor(-7n, 0)).toBe('-7');
  });

  it('rounds a percent half up once at the minor unit', () => {
    expect(percentOf(20_000n, '40')).toBe(8_000n);
    expect(percentOf(999n, '40')).toBe(400n);
    expect(percentOf(1n, '50')).toBe(1n);
  });

  it('counts whole units, or null for a fractional quantity', () => {
    expect(wholeUnits('2')).toBe(2n);
    expect(wholeUnits('2.000000')).toBe(2n);
    expect(wholeUnits('1.5')).toBeNull();
  });

  it('multiplies unit price by quantity in minor units', () => {
    expect(grossMinor('10.00', '3', 2)).toBe(3_000n);
    expect(grossMinor('10.00', '1.5', 2)).toBe(1_500n);
  });

  it('formats a column amount at scale 4, for any minor unit', () => {
    expect(formatColumnAmount(8_000n, 2)).toBe('80.0000');
    expect(formatColumnAmount(5n, 2)).toBe('0.0500');
    expect(formatColumnAmount(0n, 2)).toBe('0.0000');
    expect(formatColumnAmount(7n, 0)).toBe('7.0000');
    expect(formatColumnAmount(1_234n, 3)).toBe('1.2340');
  });
});
