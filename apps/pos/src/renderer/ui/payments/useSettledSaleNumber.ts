import { useEffect, useRef, useState } from 'react';

import type {
  SalesReadForHandoffRequest,
  SalesReadForHandoffResponse,
} from '../../../shared/bridge-api';

/**
 * RT-1322 (RT-249 N-S2, doc 20 §5.3, X-4) — Completion's own sale number.
 *
 * Once the payment is settled, ask main for the sale that finalized for THIS
 * handoff and attempt (`sales.readForHandoff`: the exact UNIQUE key, confirmed
 * against the attempt and the session's scope). It cannot return another sale,
 * which is what the removed `finalized_at >= settled_at` poll could not promise,
 * so asking repeatedly is safe. The asking is still bounded.
 *
 * Timing: a first read at once, then every 250 ms for 2 s, then every 1 s while
 * the elapsed time is under 15 s. A deadline timer ends it at 15 s whether or
 * not a read is still in flight, so a bridge that never answers cannot keep
 * Completion waiting. Polling stops on `ok`, on `refused` or a failed read, at
 * the bound, and on unmount.
 *
 * Nothing is claimed while waiting. `idle` means no call was made: finalization
 * is off, the surface is not settled, a key id is missing, or the bridge has no
 * `readForHandoff`.
 */

/** Delay between reads during the first {@link FAST_WINDOW_MS}. */
export const FAST_POLL_MS = 250;
export const FAST_WINDOW_MS = 2_000;
/** Delay between reads after the fast window. */
export const SLOW_POLL_MS = 1_000;
/** Total time asked for the number; at this point the neutral M-N5 line shows. */
export const POLL_BOUND_MS = 15_000;

export interface SettledSaleNumberValue {
  /** The sequence without leading zeros, or null when main could not parse it. */
  readonly short: string | null;
  /** The stored number as printed on the receipt. */
  readonly exact: string;
}

export type SettledSaleNumber =
  | { readonly status: 'idle' }
  | { readonly status: 'pending' }
  | { readonly status: 'ok'; readonly saleNumber: SettledSaleNumberValue }
  | { readonly status: 'unavailable' };

export interface UseSettledSaleNumberArgs {
  /** `phase === 'settled'` and `saleFinalization` on. Off makes no call. */
  readonly enabled: boolean;
  /** the sales bridge's `readForHandoff`, or null when the bridge does not have it. */
  readonly read: ((req: SalesReadForHandoffRequest) => Promise<SalesReadForHandoffResponse>) | null;
  readonly handoffActionId: string | null;
  readonly paymentAttemptId: string | null;
}

type Outcome = Exclude<SettledSaleNumber, { status: 'idle' } | { status: 'pending' }>;

/** The delay before the read after the one at `elapsedMs`. */
function nextDelay(elapsedMs: number): number {
  return elapsedMs < FAST_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;
}

export function useSettledSaleNumber({
  enabled,
  read,
  handoffActionId,
  paymentAttemptId,
}: UseSettledSaleNumberArgs): SettledSaleNumber {
  // The bridge object is rebuilt on every render in production; the effect must
  // depend on the key and the flag only, so it reads the function from a ref.
  const readRef = useRef(read);
  readRef.current = read;
  const canAsk = enabled && handoffActionId !== null && paymentAttemptId !== null;
  const hasRead = read !== null;
  const key = canAsk ? `${handoffActionId}\u0000${paymentAttemptId}` : null;

  // The outcome is stored with its key, so one for another payment is never
  // shown (a remount on a new attempt starts again from `pending`).
  const [outcome, setOutcome] = useState<{ key: string; value: Outcome } | null>(null);

  useEffect(() => {
    if (key === null || !hasRead || handoffActionId === null || paymentAttemptId === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: Outcome): void => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      setOutcome({ key, value });
    };

    const deadline = setTimeout(() => {
      finish({ status: 'unavailable' });
    }, POLL_BOUND_MS);

    const poll = (elapsedMs: number): void => {
      const ask = readRef.current;
      if (stopped || ask === null) return;
      void ask({ handoff_action_id: handoffActionId, payment_attempt_id: paymentAttemptId }).then(
        (res) => {
          if (stopped) return;
          if (res.kind === 'ok') {
            finish({
              status: 'ok',
              saleNumber: { short: res.short_number, exact: res.sale.sale_number },
            });
            return;
          }
          if (res.kind === 'refused') {
            finish({ status: 'unavailable' });
            return;
          }
          const delay = nextDelay(elapsedMs);
          if (elapsedMs + delay >= POLL_BOUND_MS) return; // the deadline ends it
          timer = setTimeout(() => {
            poll(elapsedMs + delay);
          }, delay);
        },
        () => {
          finish({ status: 'unavailable' });
        },
      );
    };
    poll(0);

    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(deadline);
    };
  }, [key, hasRead, handoffActionId, paymentAttemptId]);

  if (key === null || !hasRead) return { status: 'idle' };
  if (outcome !== null && outcome.key === key) return outcome.value;
  return { status: 'pending' };
}
