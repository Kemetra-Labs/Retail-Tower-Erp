/**
 * RT-1543 follow-up — the pure rule behind the no-open-shift payout refusal: a payout needs an open
 * shift only while shift cash-up is on for the till, and anything unreadable counts as "no shift".
 */
import { describe, expect, it, vi } from 'vitest';

import { payoutShiftRefusal } from '../returns-payout-shift.js';
import type { ReturnScope } from '../returns-repository.js';

const SCOPE: ReturnScope = { tenantId: 't', branchId: 'b', terminalId: 'term' };
const REFUSED = 'payout_no_open_shift';

describe('payoutShiftRefusal', () => {
  it('has no rule when none is composed', () => {
    expect(payoutShiftRefusal(undefined, SCOPE)).toBeNull();
  });

  it('does not read the shift while shift cash-up is off', () => {
    const openShiftRef = vi.fn(() => null);
    expect(payoutShiftRefusal({ enabled: () => false, openShiftRef }, SCOPE)).toBeNull();
    expect(openShiftRef).not.toHaveBeenCalled();
  });

  it('allows a payout with an open shift, reading it for this terminal', () => {
    const openShiftRef = vi.fn(() => 'shift-1');
    expect(payoutShiftRefusal({ enabled: () => true, openShiftRef }, SCOPE)).toBeNull();
    expect(openShiftRef).toHaveBeenCalledWith(SCOPE);
  });

  it('refuses with the flag on and no shift', () => {
    expect(payoutShiftRefusal({ enabled: () => true, openShiftRef: () => null }, SCOPE)).toBe(
      REFUSED,
    );
  });

  it('refuses a blank shift id: not a usable shift', () => {
    expect(payoutShiftRefusal({ enabled: () => true, openShiftRef: () => '' }, SCOPE)).toBe(
      REFUSED,
    );
  });

  it('fails closed when the flag read throws', () => {
    const rule = {
      enabled: (): boolean => {
        throw new Error('flag read failed');
      },
      openShiftRef: () => 'shift-1',
    };
    expect(payoutShiftRefusal(rule, SCOPE)).toBe(REFUSED);
  });

  it('fails closed when the shift read throws', () => {
    const rule = {
      enabled: () => true,
      openShiftRef: (): string | null => {
        throw new Error('db closed');
      },
    };
    expect(payoutShiftRefusal(rule, SCOPE)).toBe(REFUSED);
  });
});
