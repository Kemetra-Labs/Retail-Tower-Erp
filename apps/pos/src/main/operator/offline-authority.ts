import { OFFLINE_GRANT_MAX_TTL_MS } from './offline-grant-store.js';
import type { OperatorSessionRecord } from './session-manager.js';

/**
 * RT-308 (RT-113 P3, 10763 D6) — the bound on a session admitted OFFLINE from a
 * sealed grant, and (RT-309) the D6 bounds on the other sessions:
 *
 *  - an `offline_grant` cashier session: its grant's expiry;
 *  - an `online_confirmed` cashier session (RT-309 D6 item 1, coordinator
 *    decision on #929): NOT bounded while its server contact holds (each
 *    answered heartbeat or reconcile re-confirms it). When a heartbeat is not
 *    answered (connectivity lost, or any answer that does not confirm the
 *    admission), the bound starts at the LAST confirmed contact:
 *    `last_confirmed + min(offline_grace, 72 h)` ({@link onlineContactLostBound}).
 *    Grace 0 therefore refuses new sales as soon as a heartbeat fails;
 *  - a manager / admin session (RT-309 D6 item 2, coordinator decision): an
 *    absolute 24 h from its online sign-in. Re-auth does not extend it.
 *
 * A bound is held twice: as a wall-clock instant and as the same instant on the
 * monotonic clock (`performance.now()`). It has expired when EITHER clock
 * reaches it: a wall clock set back cannot extend a running session (the
 * monotonic clock does not move back), and a wall clock moved forward only
 * ends it sooner (fail closed). Missing or unreadable bounds count as expired.
 *
 * After expiry the session keeps running (D6): the current sale may complete or
 * be held (parked), the same-operator unlock still works, and nothing is
 * reversed or discarded (RT-24 I-8). Only a NEW sale is refused, with
 * `offline_authority_expired`, exactly where a latched session is refused with
 * `authority_conflict` (`cart.create`, a line added to an empty cart, an undo
 * that would bring an emptied cart back, `cart.resume`).
 */

export type NewSaleBlock = 'authority_conflict' | 'offline_authority_expired';

/** The session fields the bounds read. `role` is optional only for partial fixtures. */
export type OfflineAuthorityFields = Pick<
  OperatorSessionRecord,
  | 'authority'
  | 'authority_latch'
  | 'authority_valid_until_ms'
  | 'authority_deadline_mono_ms'
  | 'authority_confirmed_wall_ms'
  | 'authority_confirmed_mono_ms'
  | 'manager_valid_until_ms'
  | 'manager_deadline_mono_ms'
> &
  Partial<Pick<OperatorSessionRecord, 'role'>>;

/** Wall and monotonic "now", in milliseconds. */
export interface AuthorityClock {
  wall_ms: number;
  mono_ms: number;
}

/** A bound on both clocks. */
export interface AuthorityBound {
  valid_until_ms: number;
  deadline_mono_ms: number;
}

/** RT-309 (D6 item 2): a manager / admin session may start new sales for 24 h from sign-in. */
export const MANAGER_SESSION_BOUND_MS = 24 * 60 * 60 * 1000;

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

/** When the last server contact confirmed the admission, and the grace it carried. */
export interface ConfirmedContact {
  confirmed_wall_ms: number | undefined;
  confirmed_mono_ms: number | undefined;
  offline_grace_seconds: number | undefined;
}

/**
 * RT-309 (D6 item 1) — the bound of an online-confirmed session whose server
 * contact was lost: the last confirmed contact plus `min(offline_grace, 72 h)`,
 * the expiry an offline grant written from that same answer has. Any unreadable
 * input fails closed (the bound is `now`, expired at once). A confirmed stamp
 * later than `now` is read as `now` (it can never extend the bound).
 */
export function onlineContactLostBound(
  contact: ConfirmedContact,
  now: AuthorityClock,
): AuthorityBound {
  const expired = { valid_until_ms: now.wall_ms, deadline_mono_ms: now.mono_ms };
  const {
    confirmed_wall_ms: wall,
    confirmed_mono_ms: mono,
    offline_grace_seconds: grace,
  } = contact;
  if (!isFiniteNumber(wall) || !isFiniteNumber(mono) || !isFiniteNumber(grace) || grace < 0) {
    return expired;
  }
  if (!isFiniteNumber(now.wall_ms) || !isFiniteNumber(now.mono_ms)) return expired;
  const graceMs = Math.min(grace * 1000, OFFLINE_GRANT_MAX_TTL_MS);
  return {
    valid_until_ms: Math.min(wall, now.wall_ms) + graceMs,
    deadline_mono_ms: Math.min(mono, now.mono_ms) + graceMs,
  };
}

/** True when `now` reached the bound on either clock, or the bound is unreadable. */
function reached(wall: number | undefined, mono: number | undefined, now: AuthorityClock): boolean {
  if (!isFiniteNumber(wall) || !isFiniteNumber(mono)) return true;
  if (!isFiniteNumber(now.wall_ms) || !isFiniteNumber(now.mono_ms)) return true;
  return now.wall_ms >= wall || now.mono_ms >= mono;
}

/** An online-confirmed session holds its contact while no contact-lost bound is set. */
function onlineExpired(session: OfflineAuthorityFields, now: AuthorityClock): boolean {
  const lost =
    session.authority_valid_until_ms !== undefined ||
    session.authority_deadline_mono_ms !== undefined;
  if (lost)
    return reached(session.authority_valid_until_ms, session.authority_deadline_mono_ms, now);
  // Connected: it must still carry its confirmed contact (fail closed without it).
  return (
    !isFiniteNumber(session.authority_confirmed_wall_ms) ||
    !isFiniteNumber(session.authority_confirmed_mono_ms)
  );
}

/**
 * RT-309 (D6 item 2) — the manager / admin 24 h. `SessionManager.create` stamps
 * it on EVERY manager / admin session (tested), so a record with no manager
 * bound at all can only be a hand-built one outside the SessionManager (test
 * fixtures); it is not bounded here. A partial or unreadable bound counts as
 * expired (fail closed).
 */
function managerExpired(session: OfflineAuthorityFields, now: AuthorityClock): boolean {
  const wall = session.manager_valid_until_ms;
  const mono = session.manager_deadline_mono_ms;
  if (wall === undefined && mono === undefined) return false;
  return reached(wall, mono, now);
}

/**
 * True when the session's authority has expired (see the module doc). A
 * session with no authority that is not a manager / admin session is never
 * expired here.
 */
export function offlineAuthorityExpired(
  session: OfflineAuthorityFields,
  now: AuthorityClock,
): boolean {
  if (session.authority === 'offline_grant') {
    return reached(session.authority_valid_until_ms, session.authority_deadline_mono_ms, now);
  }
  if (session.authority === 'online_confirmed') return onlineExpired(session, now);
  if (session.role === 'manager' || session.role === 'admin') return managerExpired(session, now);
  return false;
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
