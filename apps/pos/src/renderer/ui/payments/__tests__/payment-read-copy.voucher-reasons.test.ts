/**
 * RT-1331 — `payments.confirm` returns the real V-A refusal (`voucher_expired`, ...) for a
 * failed redeem. Owner decision (chat, 2026-11-19), superseding the one-generic-line rule
 * F-A4B-003: the cashier is told which voucher problem stopped the settle, and is never
 * offered a retry that cannot succeed.
 */
import { describe, expect, it } from 'vitest';

import {
  CONFIRM_ENDED_COPY,
  CONFIRM_RETRY_COPY,
  confirmEndedCopy,
  confirmNeedsReadBack,
  confirmRefusalCopy,
} from '../payment-read-copy.js';
import { settleVoucherRefusalCopy } from '../voucher-refusal-copy.js';
import type { RefusalReason } from '../../../../shared/payments/types.js';

const REDEEM_REASONS: readonly RefusalReason[] = [
  'voucher_not_found',
  'voucher_expired',
  'voucher_cancelled',
  'voucher_already_redeemed',
  'voucher_tenant_mismatch',
  'voucher_branch_mismatch',
];

describe('RT-1331 — a settle refused with a voucher reason names the voucher problem', () => {
  it.each(REDEEM_REASONS)('%s -> the voucher fact, never the retry line', (reason) => {
    expect(confirmRefusalCopy(reason, false)).toBe(settleVoucherRefusalCopy(reason));
    expect(confirmRefusalCopy(reason, true)).toBe(settleVoucherRefusalCopy(reason));
    expect(confirmRefusalCopy(reason, false)).not.toBe(CONFIRM_RETRY_COPY);
  });

  it.each(REDEEM_REASONS)(
    '%s -> main is still read back (the attempt may have ended)',
    (reason) => {
      expect(confirmNeedsReadBack(reason)).toBe(true);
    },
  );

  it('dependency_unavailable keeps the retry line: a retry can help there', () => {
    expect(confirmRefusalCopy('dependency_unavailable', false)).toBe(CONFIRM_RETRY_COPY);
  });
});

describe('RT-1331 — the attempt ended after a voucher refusal', () => {
  it.each(REDEEM_REASONS)('%s -> the voucher fact, then that the payment ended', (reason) => {
    const fact = settleVoucherRefusalCopy(reason) ?? '\u0000';
    const copy = confirmEndedCopy(reason);
    expect(copy).toContain(fact);
    expect(copy).toContain(CONFIRM_ENDED_COPY);
    expect(copy.indexOf(fact)).toBeLessThan(copy.indexOf(CONFIRM_ENDED_COPY));
  });

  // The ended line already tells the cashier what to do («اختر طريقة دفع ...»); the voucher
  // fact must not add a second, different instruction.
  it.each(REDEEM_REASONS)('%s -> exactly one «choose a payment method» instruction', (reason) => {
    expect(confirmEndedCopy(reason).split('اختر طريقة دفع').length - 1).toBe(1);
  });

  it.each([null, 'dependency_unavailable', 'attempt_terminal', 'internal_error'] as const)(
    'the reason %s -> the existing ended line, unchanged',
    (reason) => {
      expect(confirmEndedCopy(reason)).toBe(CONFIRM_ENDED_COPY);
    },
  );
});
