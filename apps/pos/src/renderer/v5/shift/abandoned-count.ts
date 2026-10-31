import { useEffect, useLayoutEffect, useRef } from 'react';

import { isShiftAmountWithinBound } from '../../../shared/shift-cashup/amount-bound';
import type { ShiftCashupBridgeAPI } from '../../../shared/shift-cashup/types';
import { callShift } from './shift-bridge';
import { parseShiftAmount } from './shift-format';

interface Input {
  readonly bridge: ShiftCashupBridgeAPI;
  readonly currencyCode: string;
  /** The count field as typed. */
  readonly count: string;
  /** The count the approval dialog is open for, or null. */
  readonly approving: number | null;
}

/** Reports a walk-away; the answer is never read, a failure is silent. */
function report(bridge: ShiftCashupBridgeAPI, countedCashMinor: number): void {
  void callShift(() => bridge.abandonCount({ countedCashMinor }));
}

/** The typed count when it is one main would accept, else null. */
function plausibleCount(input: Pick<Input, 'count' | 'currencyCode'>): number | null {
  const counted = parseShiftAmount(input.count);
  if (counted === null) return null;
  return isShiftAmountWithinBound('counted_cash', counted, input.currencyCode) ? counted : null;
}

/**
 * RT-1003 — the blind count the cashier walked away from, reported once as an
 * `abandoned` Count Attempt (amount only; main derives the rest):
 *
 *   • `abandonApproval(count)`: the approval dialog was dismissed (Cancel,
 *     Escape) — the count it carries, already refused by main;
 *   • on leaving the close panel: the count the open approval dialog carries,
 *     else a valid typed count not sent as typed (`markSent` records what the
 *     close sent). Nothing typed, an invalid or implausible entry, or a count
 *     already sent unchanged reports nothing.
 *
 * The unmount reads only committed values (the layout effect), and the flags
 * are set synchronously by the panel's handlers, so a panel removed before
 * its clearing render commits neither reports a closed shift
 * (`markCompleted`) nor reports a dismissed approval twice (PR #169 review).
 */
export function useAbandonedCount(input: Input): {
  markSent: (count: string) => void;
  markCompleted: () => void;
  abandonApproval: (countedCashMinor: number) => void;
} {
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const sent = useRef<string | null>(null);
  /** The approval opened by the last send was answered (dismissed or approved). */
  const approvalHandled = useRef(false);
  const completed = useRef(false);

  useEffect(
    () => () => {
      if (completed.current) return;
      const { bridge, approving } = latest.current;
      if (approving !== null) {
        if (!approvalHandled.current) report(bridge, approving);
        return;
      }
      if (latest.current.count === sent.current) return;
      const counted = plausibleCount(latest.current);
      if (counted !== null) report(bridge, counted);
    },
    [],
  );

  return {
    markSent: (count) => {
      sent.current = count;
      approvalHandled.current = false;
    },
    markCompleted: () => {
      completed.current = true;
    },
    abandonApproval: (countedCashMinor) => {
      approvalHandled.current = true;
      report(latest.current.bridge, countedCashMinor);
    },
  };
}
