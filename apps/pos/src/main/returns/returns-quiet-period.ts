/**
 * RT-1498 close slice — the quiet period before a permanently-unknown return may be closed as "not
 * recorded" (RT-196 OD-196-5; the RT-1548 contract's quiet-period rule).
 *
 * The close rests on Backend-Core's late-commit bound (BR-7): a `recordReturn` request commits within
 * 60 s of receipt or never. That bound only covers a client that has SENT NOTHING for its quiet period,
 * so a close needs 15 minutes of ELAPSED time since the return's last send. Elapsed time, not a
 * timestamp difference: a client that cannot show the time has elapsed (its wall clock stepped, or it
 * restarted) treats it as NOT elapsed. The contract says exactly that.
 *
 * How the elapsed time is shown, with no persisted boot id (so no migration):
 *   • every send of a return is anchored IN MEMORY at the instant it was attempted, on the monotonic
 *     clock (`performance.now()`) and on the wall clock, together with the journal's own
 *     `last_attempt_at` stamp;
 *   • a check measures the monotonic time since the anchor and cross-checks the wall clock against it:
 *     they must agree within a tolerance, or the clock was stepped;
 *   • a return this process never sent (the app restarted since) has no anchor, so its period is
 *     unproven, however old `last_attempt_at` is; so is a journal row whose `last_attempt_at` is not
 *     the attempt this process anchored (another send ran).
 *
 * The cost of failing safe: after a restart the manager resends the row (a new anchor) and waits the
 * period again. Never the other way: an unproven period never permits a close.
 */

/** OD-196-5: at least 15 minutes since the last send of the return. */
export const RETURN_QUIET_PERIOD_MS = 15 * 60 * 1000;

/**
 * How far the wall clock may drift from the monotonic clock over the period before it counts as stepped.
 * An NTP slew moves it by milliseconds; a manual or RTC correction by minutes.
 */
export const CLOCK_STEP_TOLERANCE_MS = 60 * 1000;

/** The most anchors kept (the oldest is forgotten first): a till journals a handful of returns a day. */
const MAX_ANCHORS = 1000;

export interface QuietPeriodClocks {
  /** Wall-clock epoch milliseconds. */
  readonly wall: () => number;
  /** A monotonic clock in milliseconds (`performance.now()`): never goes backwards, restarts at boot. */
  readonly mono: () => number;
}

/** Why the elapsed time cannot be shown. */
type UnprovenCause = 'no_attempt' | 'no_anchor' | 'clock_step';

export type QuietPeriodCheck =
  | { readonly kind: 'elapsed' }
  /** The period is running; it is over no earlier than `notBefore` (an ISO-8601 instant). */
  | { readonly kind: 'too_soon'; readonly notBefore: string }
  | { readonly kind: 'unproven'; readonly cause: UnprovenCause };

export interface ReturnQuietPeriod {
  /** Anchor an attempt of `returnId` that the journal stamped `attemptStamp` (called as it is recorded). */
  markAttempt(returnId: string, attemptStamp: string): void;
  /** Whether 15 minutes of elapsed time since this return's last attempt can be shown. */
  check(entry: {
    readonly returnId: string;
    readonly lastAttemptAt: string | null;
  }): QuietPeriodCheck;
}

interface Anchor {
  readonly stamp: string;
  readonly wallMs: number;
  readonly monoMs: number;
}

function defaultClocks(): QuietPeriodClocks {
  return { wall: () => Date.now(), mono: () => performance.now() };
}

export function createReturnQuietPeriod(
  clocks: QuietPeriodClocks = defaultClocks(),
): ReturnQuietPeriod {
  const anchors = new Map<string, Anchor>();

  return {
    markAttempt(returnId, attemptStamp) {
      const wallMs = Date.parse(attemptStamp);
      const monoMs = clocks.mono();
      // An unreadable stamp or clock is never anchored: the check then finds no anchor.
      if (!Number.isFinite(wallMs) || !Number.isFinite(monoMs)) {
        anchors.delete(returnId);
        return;
      }
      anchors.delete(returnId); // re-insert: the newest anchor is the last to be forgotten
      anchors.set(returnId, { stamp: attemptStamp, wallMs, monoMs });
      if (anchors.size > MAX_ANCHORS) {
        const oldest = anchors.keys().next();
        if (oldest.done !== true) anchors.delete(oldest.value);
      }
    },

    check(entry) {
      if (entry.lastAttemptAt === null || !Number.isFinite(Date.parse(entry.lastAttemptAt))) {
        return { kind: 'unproven', cause: 'no_attempt' };
      }
      const anchor = anchors.get(entry.returnId);
      if (anchor?.stamp !== entry.lastAttemptAt) return { kind: 'unproven', cause: 'no_anchor' };
      const monoElapsed = clocks.mono() - anchor.monoMs;
      const wallElapsed = clocks.wall() - anchor.wallMs;
      const steppedOrBroken =
        !Number.isFinite(monoElapsed) ||
        !Number.isFinite(wallElapsed) ||
        monoElapsed < 0 ||
        Math.abs(wallElapsed - monoElapsed) > CLOCK_STEP_TOLERANCE_MS;
      if (steppedOrBroken) return { kind: 'unproven', cause: 'clock_step' };
      if (monoElapsed >= RETURN_QUIET_PERIOD_MS) return { kind: 'elapsed' };
      return {
        kind: 'too_soon',
        notBefore: new Date(anchor.wallMs + RETURN_QUIET_PERIOD_MS).toISOString(),
      };
    },
  };
}
