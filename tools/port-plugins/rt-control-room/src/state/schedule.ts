import { FULL_EVERY, MAX_BACKOFF_MS, POLL_MS } from "./blueprints";

export type ScheduleState = {
  /** Polls attempted so far (0 before the first load). */
  polls: number;
  /** Start time (ms) of the latest poll, or null before the first. */
  lastAt: number | null;
  /**
   * Polls that read the core collections successfully. Only these advance the full-poll
   * cadence, so a failed full poll is retried as a full poll. Defaults to `polls`.
   */
  okPolls?: number;
  /** Failed polls in a row (0 after a good one). Each one doubles the wait, up to `MAX_BACKOFF_MS`. */
  failures?: number;
};

/** The wait before the next poll: 60 s, then 2 min, 4 min, and never more than 5 min while polls keep failing. */
export function delayAfter(failures: number): number {
  return Math.min(POLL_MS * 2 ** Math.max(0, failures), MAX_BACKOFF_MS);
}

/**
 * When the next poll is due and whether it is full. Poll number n = okPolls + 1:
 * the first load is full, then every fifth successful poll (5, 10, ...); the others are
 * deltas. The first poll is due immediately, then `delayAfter(failures)` after the previous start.
 */
export function nextPoll(state: ScheduleState, now: number): { at: number; full: boolean } {
  const number = (state.okPolls ?? state.polls) + 1;
  return {
    at: state.lastAt === null ? now : state.lastAt + delayAfter(state.failures ?? 0),
    full: number === 1 || number % FULL_EVERY === 0,
  };
}
