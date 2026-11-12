/**
 * RT-1339 (RT-286 S7) — the exact-decimal helpers of the POS offer evaluator: parsing,
 * the refusals, and formatting (no float anywhere).
 */
import { describe, expect, it } from 'vitest';
import {
  OfferDecimalError,
  formatMinor,
  grossMinor,
  percentOf,
  scaled,
  wholeUnits,
} from '../offer-decimal.js';

describe('offer decimal', () => {
  it('scales a decimal string, accepting trailing zeros beyond the scale', () => {
    expect(scaled('40', 2)).toBe(4_000n);
    expect(scaled('40.0000', 2)).toBe(4_000n);
    expect(scaled('0.05', 2)).toBe(5n);
  });

  it.each(['', 'abc', '-1', '1.', '1e3', '1.234'])('refuses %j at scale 2', (value) => {
    expect(() => scaled(value, 2)).toThrow(OfferDecimalError);
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
});
