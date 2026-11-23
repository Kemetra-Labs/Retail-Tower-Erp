/**
 * RT-373 (RT-138 L4 / DL-4) — when the device credential should rotate.
 *
 * The contract (`pos-terminal-pairing.openapi.yaml`, "Credential rotation"):
 * a credential lives 90 days; the terminal rotates once fewer than 15 days
 * remain (`rotate_after = expires_at - 15 days`); a device past `expires_at`
 * may still rotate, and do nothing else, for 7 days (the rotate-only grace);
 * after that only a re-pair helps. Every device response may carry the
 * rotate-soon hint (RT-639) in two headers.
 *
 * Pure: no clock, no I/O.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** RT-138 L4: rotate when fewer than 15 days remain. */
export const ROTATE_BEFORE_MS = 15 * DAY_MS;
/** The rotate-only grace after `expires_at` (RT-369). */
export const GRACE_MS = 7 * DAY_MS;

/**
 * `fresh`: more than 15 days left. `due`: 15 days or fewer, not expired.
 * `grace`: expired, rotation still accepted. `lapsed`: past the grace.
 * `unknown`: the terminal does not know its expiry (it rotates once to learn it).
 */
type CredentialPhase = 'unknown' | 'fresh' | 'due' | 'grace' | 'lapsed';

export function credentialPhase(expiresAtMs: number | null, nowMs: number): CredentialPhase {
  if (expiresAtMs === null) return 'unknown';
  if (nowMs >= expiresAtMs + GRACE_MS) return 'lapsed';
  if (nowMs >= expiresAtMs) return 'grace';
  return nowMs >= expiresAtMs - ROTATE_BEFORE_MS ? 'due' : 'fresh';
}

/** The RT-639 hint from one device response. */
export interface RotationHint {
  /** `X-Device-Token-Rotate-After`: rotate at or after this instant. */
  rotateAfterMs: number;
  /** `X-Device-Token-Rotate-Stage: urgent` (3 days or less, or the overlap closing): rotate at once. */
  urgent: boolean;
}

const ROTATE_AFTER_HEADER = 'X-Device-Token-Rotate-After';
const ROTATE_STAGE_HEADER = 'X-Device-Token-Rotate-Stage';

/** The hint the headers carry, or null when absent or unreadable. Never throws. */
export function readRotationHint(headers: Headers): RotationHint | null {
  const after = headers.get(ROTATE_AFTER_HEADER);
  if (after === null) return null;
  const rotateAfterMs = Date.parse(after);
  if (Number.isNaN(rotateAfterMs)) return null;
  return { rotateAfterMs, urgent: headers.get(ROTATE_STAGE_HEADER) === 'urgent' };
}
