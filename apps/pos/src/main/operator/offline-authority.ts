import type { OperatorSessionRecord } from './session-manager.js';

/**
 * RT-308 (RT-113 P3, 10763 D6) — the bound on a session admitted OFFLINE from a
 * sealed grant.
 *
 * Such a session carries its grant's expiry twice: as a wall-clock instant and
 * as the same instant on the monotonic clock (`performance.now()`), taken at
 * admission. The authority has expired when EITHER clock reaches it: a wall
 * clock set back cannot extend a running session (the monotonic clock does not
 * move back), and a wall clock moved forward only ends it sooner (fail closed).
 *
 * After expiry the session keeps running (D6): the current sale may complete or
 * be held (parked), the same-operator unlock still works, and nothing is
 * reversed or discarded (RT-24 I-8). Only a NEW sale is refused, with
 * `offline_authority_expired`, exactly where a latched session is refused with
 * `authority_conflict` (`cart.create`, a line added to an empty cart, an undo
 * that would bring an emptied cart back, `cart.resume`).
 */

export type NewSaleBlock = 'authority_conflict' | 'offline_authority_expired';

/** The session fields the bound reads. */
export type OfflineAuthorityFields = Pick<
  OperatorSessionRecord,
  'authority' | 'authority_latch' | 'authority_valid_until_ms' | 'authority_deadline_mono_ms'
>;

/** Wall and monotonic "now", in milliseconds. */
export interface AuthorityClock {
  wall_ms: number;
  mono_ms: number;
}

/** The production clocks: the wall clock and `performance.now()`. */
export function authorityClockOf(
  wall: () => Date = () => new Date(),
  mono: () => number = () => performance.now(),
): AuthorityClock {
  return { wall_ms: wall().getTime(), mono_ms: mono() };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * True when an offline-admitted session's authority has expired. A session
 * whose authority is not `offline_grant` is never expired here. An
 * offline-admitted session that lacks either bound counts as expired.
 */
export function offlineAuthorityExpired(
  session: OfflineAuthorityFields,
  now: AuthorityClock,
): boolean {
  if (session.authority !== 'offline_grant') return false;
  const wall = session.authority_valid_until_ms;
  const mono = session.authority_deadline_mono_ms;
  if (!isFiniteNumber(wall) || !isFiniteNumber(mono)) return true;
  if (!isFiniteNumber(now.wall_ms) || !isFiniteNumber(now.mono_ms)) return true;
  return now.wall_ms >= wall || now.mono_ms >= mono;
}

/**
 * Why this session may not start a NEW sale, or null when it may. The latch
 * (RT-113 P2) is reported first.
 */
export function newSaleBlock(
  session: OfflineAuthorityFields,
  now: AuthorityClock,
): NewSaleBlock | null {
  if (session.authority_latch !== undefined) return 'authority_conflict';
  return offlineAuthorityExpired(session, now) ? 'offline_authority_expired' : null;
}
