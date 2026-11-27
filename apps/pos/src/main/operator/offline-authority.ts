import { OFFLINE_GRANT_MAX_TTL_MS } from './offline-grant-store.js';
import type { OperatorSessionRecord } from './session-manager.js';

/**
 * RT-308 (RT-113 P3, 10763 D6) — the bound on a session admitted OFFLINE from a
 * sealed grant. RT-309 (D6): an online-confirmed cashier session is bounded the
 * same way, by the bound its latest admission stamped ({@link onlineAuthorityBound}).
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

/** The admission fields an online bound is computed from. */
export interface OnlineAdmissionBoundInput {
  offline_grace_seconds: number;
  admission_ttl_seconds: number;
  /** When the request that got this `admitted` was SENT (monotonic ms); now when absent. */
  admission_requested_at_ms?: number | undefined;
}

/** A bound on both clocks (the session's `authority_valid_until_ms` / `authority_deadline_mono_ms`). */
export interface AuthorityBound {
  valid_until_ms: number;
  deadline_mono_ms: number;
}

/**
 * RT-309 — the margin past the next heartbeat (TTL/2) that the online floor
 * allows: one failed-tick retry (`FAILED_TICK_RETRY_MS` in
 * `cashier-admission-keeper.ts`, not imported here to keep this module free of
 * the keeper's dependencies).
 */
export const HEARTBEAT_RETRY_MARGIN_MS = 60_000;

function isNonNegativeFinite(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0;
}

/**
 * RT-309 (10763 D6; RT-308 scope note c13973 item 1) — the bound of an
 * online-confirmed cashier session, stamped at each `admitted` (sign-in,
 * takeover, heartbeat, reconcile) with `now` = the time the answer was
 * received.
 *
 * D6: "each session carries `authority_valid_until`, equal to its grant's
 * expiry". The grant written from this same `admitted` expires at
 * `received + min(offline_grace, 72 h)` (`offline-grant-store.ts`), so that is
 * the bound.
 *
 * Derivation (an owner decision is requested in the PR): with that bound alone,
 * grace 0 (OD8, "offline disabled") or a grace shorter than the heartbeat
 * interval would block a healthy, CONNECTED till between two heartbeats. So
 * the bound is floored at the NEXT heartbeat plus one failed-tick retry:
 * `sent + TTL/2 + 60 s` (the keeper heartbeats at most every TTL/2 and retries a
 * failed tick within 60 s), never past the server admission's own deadline
 * (`sent + TTL`). A till that stays connected is restamped before the floor
 * ends; a till that lost connectivity is bounded at most that long beyond its
 * grace. Whatever the inputs, the bound never exceeds the 72 h grant ceiling.
 *
 * Any unreadable input fails closed: the bound is `now` (expired at once). A
 * send stamp in the future is read as `now`.
 */
export function onlineAuthorityBound(
  admission: OnlineAdmissionBoundInput,
  now: AuthorityClock,
): AuthorityBound {
  const expired = { valid_until_ms: now.wall_ms, deadline_mono_ms: now.mono_ms };
  const grace = admission.offline_grace_seconds;
  const ttl = admission.admission_ttl_seconds;
  const stamp = admission.admission_requested_at_ms ?? now.mono_ms;
  if (!isNonNegativeFinite(grace) || !isNonNegativeFinite(ttl) || !isFiniteNumber(stamp)) {
    return expired;
  }
  if (!isFiniteNumber(now.wall_ms) || !isFiniteNumber(now.mono_ms)) return expired;
  const sentAt = Math.min(stamp, now.mono_ms);
  const ttlMs = ttl * 1000;
  const graceLeftMs = Math.min(grace * 1000, OFFLINE_GRANT_MAX_TTL_MS);
  const floorLeftMs = sentAt + Math.min(ttlMs, ttlMs / 2 + HEARTBEAT_RETRY_MARGIN_MS) - now.mono_ms;
  const leftMs = Math.min(OFFLINE_GRANT_MAX_TTL_MS, Math.max(0, graceLeftMs, floorLeftMs));
  return { valid_until_ms: now.wall_ms + leftMs, deadline_mono_ms: now.mono_ms + leftMs };
}

/**
 * True when the session's authority has expired. RT-309 (D6): an
 * `online_confirmed` session is bounded like an `offline_grant` one, by the
 * bound its latest admission stamped ({@link onlineAuthorityBound}). Either
 * kind that lacks a bound, or carries an unreadable one, counts as expired
 * (fail closed). A session with no authority (manager / admin) is never
 * expired here.
 */
export function offlineAuthorityExpired(
  session: OfflineAuthorityFields,
  now: AuthorityClock,
): boolean {
  if (session.authority !== 'offline_grant' && session.authority !== 'online_confirmed') {
    return false;
  }
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
