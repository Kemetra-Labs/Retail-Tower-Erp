/**
 * RT-308 (RT-113 P3, 10763 D6) — the bound on an offline-admitted session:
 * expired when EITHER the wall clock or the monotonic clock reaches the
 * grant's expiry; missing bounds count as expired; other sessions are never
 * bound here; the latch is reported first.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  authorityClockOf,
  newSaleBlock,
  offlineAuthorityExpired,
  type OfflineAuthorityFields,
} from '../offline-authority.js';

const WALL = 1_800_000_000_000;
const MONO = 50_000;

function offline(over: Partial<OfflineAuthorityFields> = {}): OfflineAuthorityFields {
  return {
    authority: 'offline_grant',
    authority_valid_until_ms: WALL,
    authority_deadline_mono_ms: MONO,
    ...over,
  };
}

describe('offlineAuthorityExpired', () => {
  it('is valid strictly before both bounds', () => {
    expect(offlineAuthorityExpired(offline(), { wall_ms: WALL - 1, mono_ms: MONO - 1 })).toBe(
      false,
    );
  });

  it('expires at exactly the wall bound', () => {
    expect(offlineAuthorityExpired(offline(), { wall_ms: WALL, mono_ms: MONO - 1 })).toBe(true);
  });

  it('expires at the monotonic bound even when the wall clock was set back', () => {
    expect(offlineAuthorityExpired(offline(), { wall_ms: WALL - 3_600_000, mono_ms: MONO })).toBe(
      true,
    );
  });

  it.each([
    ['no wall bound', { authority: 'offline_grant', authority_deadline_mono_ms: MONO }],
    ['no monotonic bound', { authority: 'offline_grant', authority_valid_until_ms: WALL }],
    ['a NaN bound', offline({ authority_valid_until_ms: Number.NaN })],
  ] as [string, OfflineAuthorityFields][])('fails closed with %s', (_label, fields) => {
    expect(offlineAuthorityExpired(fields, { wall_ms: 0, mono_ms: 0 })).toBe(true);
  });

  it('fails closed on an unreadable clock', () => {
    expect(offlineAuthorityExpired(offline(), { wall_ms: Number.NaN, mono_ms: 0 })).toBe(true);
  });

  it.each([
    ['online_confirmed', { authority: 'online_confirmed' }],
    ['absent', {}],
  ] as [string, Partial<OfflineAuthorityFields>][])(
    'never bounds a session whose authority is %s',
    (_label, authority) => {
      expect(
        offlineAuthorityExpired(
          { ...authority, authority_valid_until_ms: 0, authority_deadline_mono_ms: 0 },
          { wall_ms: WALL, mono_ms: MONO },
        ),
      ).toBe(false);
    },
  );
});

describe('newSaleBlock', () => {
  const late = { wall_ms: WALL + 1, mono_ms: MONO + 1 };
  const early = { wall_ms: WALL - 1, mono_ms: MONO - 1 };

  it('the latch first, then the offline expiry, else nothing', () => {
    expect(newSaleBlock(offline({ authority_latch: 'superseded_by_takeover' }), late)).toBe(
      'authority_conflict',
    );
    expect(newSaleBlock(offline(), late)).toBe('offline_authority_expired');
    expect(newSaleBlock(offline(), early)).toBeNull();
    expect(newSaleBlock({ authority: 'online_confirmed' }, late)).toBeNull();
  });
});

describe('authorityClockOf', () => {
  it('reads the given clocks', () => {
    expect(
      authorityClockOf(
        () => new Date(WALL),
        () => MONO,
      ),
    ).toEqual({
      wall_ms: WALL,
      mono_ms: MONO,
    });
  });

  it('defaults to the wall clock and performance.now()', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1234);
    const before = Date.now();
    const c = authorityClockOf();
    expect(c.mono_ms).toBe(1234);
    expect(c.wall_ms).toBeGreaterThanOrEqual(before);
    vi.restoreAllMocks();
  });
});
