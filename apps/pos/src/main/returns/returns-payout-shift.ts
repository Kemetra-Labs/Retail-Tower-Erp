/**
 * RT-1543 follow-up (owner decision c18146) — a cash return payout needs an open shift.
 *
 * When shift cash-up is on for the till, every payout that takes cash out (`start`, `retry_drawer`,
 * `manual`) is refused `payout_no_open_shift` until a shift is open, so each payout can be reported
 * with its `shiftRef` and turning `POS_REFUND_SETTLE_BEFORE_POST_ENABLED` on later never strands a
 * return. A till with shift cash-up off is not asked: its payouts are unchanged (no `allocationRef`,
 * posted at acceptance).
 *
 * Fail closed: a flag read that throws, a shift read that throws and a blank shift id all refuse.
 * The reason name is the one the void payout already uses (`sale-void-payout-gate.ts`).
 */
import type { ReturnScope } from './returns-repository.js';

/** The refusal of a payout while shift cash-up is on and no shift is open. */
const PAYOUT_NO_OPEN_SHIFT = 'payout_no_open_shift';

export interface PayoutShiftRule {
  /** Shift cash-up is on for this till (`POS_PULSE_FEATURE_SHIFT_CASHUP`, read per call). */
  readonly enabled: () => boolean;
  /** The terminal's open shift id, or null when none is open. */
  readonly openShiftRef: (scope: ReturnScope) => string | null;
}

/**
 * `payout_no_open_shift` when a payout of this terminal must not run, else null. Absent rule: none.
 * Both reads happen per call; the shift is read only while the flag is on.
 */
export function payoutShiftRefusal(
  rule: PayoutShiftRule | undefined,
  scope: ReturnScope,
): typeof PAYOUT_NO_OPEN_SHIFT | null {
  if (rule === undefined) return null;
  try {
    if (!rule.enabled()) return null;
    const shift = rule.openShiftRef(scope);
    return shift === null || shift === '' ? PAYOUT_NO_OPEN_SHIFT : null;
  } catch {
    return PAYOUT_NO_OPEN_SHIFT;
  }
}
