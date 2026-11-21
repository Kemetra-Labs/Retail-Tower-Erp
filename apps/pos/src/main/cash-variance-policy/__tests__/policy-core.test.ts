/**
 * RT-388 — the pure policy rules (AD-CASH-001 D-1, DR-6): the fail-closed
 * fallback and the exact-decimal approval decision.
 */
import { describe, expect, it } from 'vitest';

import { fallbackPolicy, policyRequiresApproval, type VariancePolicy } from '../policy-core.js';

const REVISION = '0190f5a2-3b4c-7d8e-9f01-23456789abcd';

function limit(amount: string, currencyCode = 'EGP'): VariancePolicy {
  return {
    source: 'tenant',
    revisionId: REVISION,
    mode: 'limit',
    limitAmount: amount,
    currencyCode,
  };
}

function asks(policy: VariancePolicy | null, varianceMinor: number, currency = 'EGP'): boolean {
  return policyRequiresApproval({ policy, varianceMinor, shiftCurrencyCode: currency });
}

describe('fallbackPolicy (DR-6)', () => {
  it('is limit 0 in the shift currency, source fallback, no revision id', () => {
    expect(fallbackPolicy('EGP')).toEqual({
      source: 'fallback',
      revisionId: null,
      mode: 'limit',
      limitAmount: '0.00',
      currencyCode: 'EGP',
    });
  });

  it('writes the zero with the currency exponent (none for a zero-decimal currency)', () => {
    expect(fallbackPolicy('JPY')).toMatchObject({ limitAmount: '0', currencyCode: 'JPY' });
  });

  it('is limit 0 with a bare "0" for a currency the till has no exponent for', () => {
    expect(fallbackPolicy('XXX')).toMatchObject({ limitAmount: '0', currencyCode: 'XXX' });
  });
});

describe('policyRequiresApproval', () => {
  it('is never required for a legacy open (no frozen policy)', () => {
    expect(asks(null, 123_456)).toBe(false);
  });

  it('is never required for mode none', () => {
    const none: VariancePolicy = { source: 'system', revisionId: null, mode: 'none' };
    expect(asks(none, 999_999)).toBe(false);
  });

  it('is required exactly when |variance| exceeds the limit', () => {
    const policy = limit('100.00');
    expect(asks(policy, 0)).toBe(false);
    expect(asks(policy, 10_000)).toBe(false);
    expect(asks(policy, -10_000)).toBe(false);
    expect(asks(policy, 10_001)).toBe(true);
    expect(asks(policy, -10_001)).toBe(true);
  });

  it('compares a limit finer than the currency exactly', () => {
    const policy = limit('100.005');
    expect(asks(policy, 10_000)).toBe(false);
    expect(asks(policy, 10_001)).toBe(true);
  });

  it('works for a zero-decimal currency', () => {
    const policy = limit('500', 'JPY');
    expect(asks(policy, 500, 'JPY')).toBe(false);
    expect(asks(policy, -501, 'JPY')).toBe(true);
  });

  it('is exact at the largest amounts (no float)', () => {
    expect(asks(limit('999999999999999.9999'), Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(asks(limit('90071992547409.90'), Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('asks for any non-zero variance under the fallback limit 0', () => {
    const policy = fallbackPolicy('EGP');
    expect(asks(policy, 0)).toBe(false);
    expect(asks(policy, 1)).toBe(true);
    expect(asks(policy, -1)).toBe(true);
  });

  it('fails closed when the limit is in another currency than the shift', () => {
    const policy = limit('1000000.00', 'USD');
    expect(asks(policy, 0)).toBe(false);
    expect(asks(policy, 1)).toBe(true);
  });

  it('fails closed when the shift currency has no known exponent', () => {
    expect(asks(limit('100.00', 'XXX'), 1, 'XXX')).toBe(true);
    expect(asks(limit('100.00', 'XXX'), 0, 'XXX')).toBe(false);
  });
});
