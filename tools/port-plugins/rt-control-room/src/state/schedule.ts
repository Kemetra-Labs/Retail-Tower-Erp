import { FULL_EVERY, POLL_MS } from "./blueprints";

export type ScheduleState = {
  /** Polls attempted so far (0 before the first load). */
  polls: number;
  /** Start time (ms) of the latest poll, or null before the first. */
  lastAt: number | null;
};

/**
 * When the next poll is due and whether it is full. Poll number n = polls + 1:
 * the first load is full, then every fifth poll (5, 10, ...); the others are
 * deltas. The first poll is due immediately, then 60 s after the previous start.
 */
export function nextPoll(state: ScheduleState, now: number): { at: number; full: boolean } {
  const number = state.polls + 1;
  return {
    at: state.lastAt === null ? now : state.lastAt + POLL_MS,
    full: number === 1 || number % FULL_EVERY === 0,
  };
}
