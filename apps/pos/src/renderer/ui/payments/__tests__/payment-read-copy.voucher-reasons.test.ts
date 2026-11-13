/**
 * RT-1331 — `payments.confirm` now returns the real V-A refusal (`voucher_expired`, ...) for a
 * failed redeem instead of `dependency_unavailable`. The cashier still sees ONE generic line
 * (security decision F-A4B-003): no per-reason copy ships in this slice.
 */
import { describe, expect, it } from 'vitest';

import { confirmNeedsReadBack, confirmRefusalCopy } from '../payment-read-copy.js';
import type { RefusalReason } from '../../../../shared/payments/types.js';

const REDEEM_REASONS: readonly RefusalReason[] = [
  'voucher_not_found',
  'voucher_expired',
  'voucher_cancelled',
  'voucher_already_redeemed',
  'voucher_tenant_mismatch',
  'voucher_branch_mismatch',
];

describe('RT-1331 — a confirm refused with a voucher reason reads like dependency_unavailable', () => {
  it.each(REDEEM_REASONS)('%s -> the same copy as dependency_unavailable', (reason) => {
    expect(confirmRefusalCopy(reason, false)).toBe(
      confirmRefusalCopy('dependency_unavailable', false),
    );
    expect(confirmRefusalCopy(reason, true)).toBe(
      confirmRefusalCopy('dependency_unavailable', true),
    );
  });

  it.each(REDEEM_REASONS)(
    '%s -> main is read back, exactly as for dependency_unavailable',
    (reason) => {
      expect(confirmNeedsReadBack(reason)).toBe(confirmNeedsReadBack('dependency_unavailable'));
      expect(confirmNeedsReadBack(reason)).toBe(true);
    },
  );
});
