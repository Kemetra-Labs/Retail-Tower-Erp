import { describe, expect, it } from 'vitest';

import { TILL_CLOCK_TOLERANCE_MS, tillClockSkewed } from '../till-clock.js';

/** RT-1312 F18 — the till clock window `[sent - tolerance, received + tolerance]`. */
describe('tillClockSkewed (RT-1312 F18)', () => {
  const sent = Date.parse('2026-11-10T10:00:00.000Z');
  const received = sent + 3_000;
  const at = (ms: number): string => new Date(ms).toISOString();

  it('keeps the Backend-Core tolerance of 120 s', () => {
    expect(TILL_CLOCK_TOLERANCE_MS).toBe(120_000);
  });

  it('accepts a server time inside the request window', () => {
    expect(tillClockSkewed(at(sent + 1_000), sent, received)).toBe(false);
  });

  it('accepts a server time exactly at either edge of the widened window', () => {
    expect(tillClockSkewed(at(sent - TILL_CLOCK_TOLERANCE_MS), sent, received)).toBe(false);
    expect(tillClockSkewed(at(received + TILL_CLOCK_TOLERANCE_MS), sent, received)).toBe(false);
  });

  it('refuses a server time more than the tolerance before the request was sent', () => {
    expect(tillClockSkewed(at(sent - TILL_CLOCK_TOLERANCE_MS - 1), sent, received)).toBe(true);
  });

  it('refuses a server time more than the tolerance after the answer was received', () => {
    expect(tillClockSkewed(at(received + TILL_CLOCK_TOLERANCE_MS + 1), sent, received)).toBe(true);
  });

  it('never refuses for latency alone: a slow answer widens the window', () => {
    const slowReceived = sent + 10 * 60_000;
    expect(tillClockSkewed(at(sent + 9 * 60_000), sent, slowReceived)).toBe(false);
  });

  it('does not refuse an unparseable server time (cannot be judged)', () => {
    expect(tillClockSkewed('not-a-date', sent, received)).toBe(false);
    expect(tillClockSkewed('', sent, received)).toBe(false);
  });
});
