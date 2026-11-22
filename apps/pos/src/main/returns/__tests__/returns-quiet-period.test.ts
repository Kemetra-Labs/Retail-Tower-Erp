/**
 * RT-1498 close slice — the quiet period before a return may be closed as "not recorded"
 * (RT-196 OD-196-5, the RT-1548 contract): 15 minutes of ELAPSED time since the last send of that
 * return. A POS that cannot show the elapsed time treats it as NOT elapsed:
 *   • the app restarted since the last send (no in-memory anchor);
 *   • the wall clock stepped (back or forward) beyond a tolerance, so wall and monotonic disagree;
 *   • the journal's `last_attempt_at` is not the attempt this process anchored (another send ran);
 *   • there is no `last_attempt_at` at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLOCK_STEP_TOLERANCE_MS,
  RETURN_QUIET_PERIOD_MS,
  createReturnQuietPeriod,
} from '../returns-quiet-period.js';

const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const STAMP = new Date(T0).toISOString();
const RETURN_ID = '0190f5a2-3b4c-7d8e-9f01-000000000001';

function clocks() {
  const state = { wall: T0, mono: 5_000 };
  const quiet = createReturnQuietPeriod({ wall: () => state.wall, mono: () => state.mono });
  /** Real time passing: both clocks advance together. */
  const elapse = (ms: number): void => {
    state.wall += ms;
    state.mono += ms;
  };
  return { state, quiet, elapse };
}

const entry = (lastAttemptAt: string | null) => ({ returnId: RETURN_ID, lastAttemptAt });

describe('the quiet period is 15 minutes of elapsed time', () => {
  it('is 15 minutes and the clock-step tolerance is a minute', () => {
    expect(RETURN_QUIET_PERIOD_MS).toBe(15 * 60 * 1000);
    expect(CLOCK_STEP_TOLERANCE_MS).toBe(60 * 1000);
  });

  it('has not elapsed right after an attempt, and says when it will', () => {
    const { quiet, elapse } = clocks();
    quiet.markAttempt(RETURN_ID, STAMP);
    elapse(60_000);
    expect(quiet.check(entry(STAMP))).toEqual({
      kind: 'too_soon',
      notBefore: new Date(T0 + RETURN_QUIET_PERIOD_MS).toISOString(),
    });
  });

  it('has not elapsed one millisecond before 15 minutes, and has at exactly 15 minutes', () => {
    const { quiet, elapse } = clocks();
    quiet.markAttempt(RETURN_ID, STAMP);
    elapse(RETURN_QUIET_PERIOD_MS - 1);
    expect(quiet.check(entry(STAMP)).kind).toBe('too_soon');
    elapse(1);
    expect(quiet.check(entry(STAMP))).toEqual({ kind: 'elapsed' });
  });

  it('a newer attempt starts the period again', () => {
    const { quiet, elapse } = clocks();
    quiet.markAttempt(RETURN_ID, STAMP);
    elapse(RETURN_QUIET_PERIOD_MS + 1000);
    const later = new Date(T0 + RETURN_QUIET_PERIOD_MS + 1000).toISOString();
    quiet.markAttempt(RETURN_ID, later);
    expect(quiet.check(entry(later)).kind).toBe('too_soon');
  });
});

describe('a POS that cannot show the elapsed time treats it as not elapsed', () => {
  it('app restart: a fresh process has no anchor for the journal row', () => {
    const { quiet, elapse } = clocks();
    quiet.markAttempt(RETURN_ID, STAMP);
    elapse(RETURN_QUIET_PERIOD_MS * 4);
    const restarted = createReturnQuietPeriod({
      wall: () => T0 + RETURN_QUIET_PERIOD_MS * 4,
      mono: () => 1,
    });
    expect(restarted.check(entry(STAMP))).toEqual({ kind: 'unproven', cause: 'no_anchor' });
  });

  it('no attempt stamp at all', () => {
    const { quiet } = clocks();
    expect(quiet.check(entry(null))).toEqual({ kind: 'unproven', cause: 'no_attempt' });
  });

  it('an unreadable attempt stamp', () => {
    const { quiet } = clocks();
    expect(quiet.check(entry('not-a-time'))).toEqual({ kind: 'unproven', cause: 'no_attempt' });
  });

  it('the journal row names an attempt this process did not anchor', () => {
    const { quiet, elapse } = clocks();
    quiet.markAttempt(RETURN_ID, STAMP);
    elapse(RETURN_QUIET_PERIOD_MS * 2);
    const other = new Date(T0 + 1000).toISOString();
    expect(quiet.check(entry(other))).toEqual({ kind: 'unproven', cause: 'no_anchor' });
  });

  it('wall clock stepped FORWARD past the tolerance: the monotonic clock says too soon', () => {
    const { quiet, state, elapse } = clocks();
    quiet.markAttempt(RETURN_ID, STAMP);
    elapse(60_000);
    state.wall += RETURN_QUIET_PERIOD_MS; // someone set the clock 15 minutes ahead
    expect(quiet.check(entry(STAMP))).toEqual({ kind: 'unproven', cause: 'clock_step' });
  });

  it('wall clock stepped BACK past the tolerance', () => {
    const { quiet, state, elapse } = clocks();
    quiet.markAttempt(RETURN_ID, STAMP);
    elapse(RETURN_QUIET_PERIOD_MS + 1000);
    state.wall -= 10 * 60_000;
    expect(quiet.check(entry(STAMP))).toEqual({ kind: 'unproven', cause: 'clock_step' });
  });

  it('a step inside the tolerance (an NTP slew) does not make it unproven', () => {
    const { quiet, state, elapse } = clocks();
    quiet.markAttempt(RETURN_ID, STAMP);
    elapse(RETURN_QUIET_PERIOD_MS);
    state.wall += CLOCK_STEP_TOLERANCE_MS - 1;
    expect(quiet.check(entry(STAMP))).toEqual({ kind: 'elapsed' });
  });

  it('a monotonic clock that moved backwards is unproven', () => {
    const { quiet, state, elapse } = clocks();
    quiet.markAttempt(RETURN_ID, STAMP);
    elapse(RETURN_QUIET_PERIOD_MS);
    state.mono = 10;
    expect(quiet.check(entry(STAMP))).toEqual({ kind: 'unproven', cause: 'clock_step' });
  });

  it('a non-finite clock reading is unproven', () => {
    const state = { wall: T0, mono: 0 };
    const quiet = createReturnQuietPeriod({ wall: () => state.wall, mono: () => state.mono });
    quiet.markAttempt(RETURN_ID, STAMP);
    state.mono = Number.NaN;
    expect(quiet.check(entry(STAMP))).toEqual({ kind: 'unproven', cause: 'clock_step' });
  });

  it('an unreadable stamp is never anchored', () => {
    const { quiet } = clocks();
    quiet.markAttempt(RETURN_ID, 'not-a-time');
    expect(quiet.check(entry('not-a-time')).kind).toBe('unproven');
  });
});

describe('the production clocks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('default to Date.now and performance.now when no clocks are given', () => {
    const wall = vi.spyOn(Date, 'now').mockReturnValue(T0);
    const mono = vi.spyOn(performance, 'now').mockReturnValue(5_000);
    const quiet = createReturnQuietPeriod();
    quiet.markAttempt(RETURN_ID, STAMP);
    expect(quiet.check(entry(STAMP)).kind).toBe('too_soon');

    wall.mockReturnValue(T0 + RETURN_QUIET_PERIOD_MS);
    mono.mockReturnValue(5_000 + RETURN_QUIET_PERIOD_MS);
    expect(quiet.check(entry(STAMP))).toEqual({ kind: 'elapsed' });
    expect(wall).toHaveBeenCalled();
    expect(mono).toHaveBeenCalled();
  });
});

describe('the anchor table is bounded', () => {
  it('keeps the most recent anchors and forgets the oldest', () => {
    const { quiet } = clocks();
    for (let i = 0; i < 1100; i += 1) quiet.markAttempt(`ret-${String(i)}`, STAMP);
    expect(quiet.check({ returnId: 'ret-0', lastAttemptAt: STAMP })).toEqual({
      kind: 'unproven',
      cause: 'no_anchor',
    });
    expect(quiet.check({ returnId: 'ret-1099', lastAttemptAt: STAMP }).kind).toBe('too_soon');
  });
});
