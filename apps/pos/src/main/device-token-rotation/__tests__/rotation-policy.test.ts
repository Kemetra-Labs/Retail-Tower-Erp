import { describe, expect, it } from 'vitest';

import {
  GRACE_MS,
  ROTATE_BEFORE_MS,
  credentialPhase,
  readRotationHint,
} from '../rotation-policy.js';

const DAY = 24 * 60 * 60 * 1000;
const EXPIRES = Date.parse('2027-03-01T00:00:00.000Z');

describe('RT-373 credential phase (RT-138 L4: rotate when fewer than 15 days remain)', () => {
  it('uses the ratified 15-day threshold and 7-day rotate-only grace', () => {
    expect(ROTATE_BEFORE_MS).toBe(15 * DAY);
    expect(GRACE_MS).toBe(7 * DAY);
  });

  it.each([
    ['more than 15 days left', EXPIRES - 15 * DAY - 1, 'fresh'],
    ['exactly 15 days left', EXPIRES - 15 * DAY, 'due'],
    ['one day left', EXPIRES - DAY, 'due'],
    ['at expiry', EXPIRES, 'grace'],
    ['inside the grace', EXPIRES + 7 * DAY - 1, 'grace'],
    ['grace elapsed', EXPIRES + 7 * DAY, 'lapsed'],
  ] as const)('%s → %s', (_name, now, phase) => {
    expect(credentialPhase(EXPIRES, now)).toBe(phase);
  });

  it('an unknown expiry is its own phase (the terminal rotates once to learn it)', () => {
    expect(credentialPhase(null, EXPIRES)).toBe('unknown');
  });
});

describe('RT-373 rotate-soon hint headers (RT-639)', () => {
  function headers(init: Record<string, string>): Headers {
    return new Headers(init);
  }

  it('reads the rotate-after instant and the stage', () => {
    expect(
      readRotationHint(
        headers({
          'X-Device-Token-Rotate-After': '2027-02-14T00:00:00.000Z',
          'X-Device-Token-Rotate-Stage': 'warning',
        }),
      ),
    ).toEqual({ rotateAfterMs: Date.parse('2027-02-14T00:00:00.000Z'), urgent: false });
  });

  it('marks the urgent stage', () => {
    expect(
      readRotationHint(
        headers({
          'X-Device-Token-Rotate-After': '2027-02-14T00:00:00.000Z',
          'X-Device-Token-Rotate-Stage': 'urgent',
        }),
      ),
    ).toEqual({ rotateAfterMs: Date.parse('2027-02-14T00:00:00.000Z'), urgent: true });
  });

  it.each([
    ['no headers', {}],
    ['an unreadable instant', { 'X-Device-Token-Rotate-After': 'soon' }],
  ])('%s → no hint', (_name, init: Record<string, string>) => {
    expect(readRotationHint(headers(init))).toBeNull();
  });
});
