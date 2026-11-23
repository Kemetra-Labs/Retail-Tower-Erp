/**
 * RT-373 (RT-138 L4, RT-287 F12) — the POS device token rotation client.
 *
 * Rotates the device credential through `posRotateTerminalToken` and keeps the
 * till working across every failure the contract names:
 *
 *  - When: 15 days or fewer left, inside the 7-day rotate-only grace, once
 *    per process while the expiry is unknown (to learn it), or on the server's
 *    RT-639 hint (rotate-after passed, or the `urgent` stage). Never past the
 *    grace: only a re-pair helps then.
 *  - At most one rotation in flight; a NEW `Idempotency-Key` on every attempt.
 *  - Seal before switch: the new token and its expiry are sealed into the
 *    RT-306 envelope in ONE secret write, which replaces the old token. Every
 *    device client reads the token per call, so the next call sends the new
 *    one, and the previous token is never presented again after a stored 200.
 *  - A lost response, a 5xx, or a crash or failure between the 200 and that
 *    write: the server has moved the old token to its 10-minute "previous"
 *    slot, so the old token still authenticates. The rotation is retried with
 *    it inside that window ({@link OVERLAP_RETRY_DELAYS_MS}); a restart does the
 *    same on its first tick. The till is never bricked by a lost answer.
 *  - Grace: a device 401 while expired-in-grace is the expiry, not a
 *    revocation. {@link DeviceTokenRotation.recoveryFirst} wraps the RT-215
 *    confirmation probe: it rotates first, and only a refused rotation (401)
 *    confirms. Outside the grace the probe is unchanged.
 *  - 401 on the rotation: revoked, retired, unknown or lapsed. Rotation stops
 *    for that pairing; the RT-215 flow (two device 401s) takes the till to the
 *    re-pair screen. 429: wait for `Retry-After`.
 *
 * SECRET: the token stays in the main process; logs carry event names and
 * outcomes only, never a token, key, URL or body.
 */
import type { Logger } from 'pino';

import type { DeviceAuthOutcome } from '../pairing/device-auth-detector.js';
import type { DeviceTokenRotationStore, RotationCredential } from '../pairing/store.js';
import type { PairingBinding } from '../pairing/token-binding.js';
import type { RotationClient, RotationResult } from './rotation-client.js';
import { credentialPhase, type RotationHint } from './rotation-policy.js';

export type { RotationCredential };

/**
 * Waits before each retry after a lost answer. They add up to 6.5 minutes, so
 * every retry lands inside the server's 10-minute overlap, with room for the
 * request timeouts.
 */
export const OVERLAP_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000, 60_000, 120_000, 185_000];

/** Hints observed this soon after a stored rotation came from requests sent with the old token. */
const STALE_HINT_WINDOW_MS = 2 * 60 * 1000;
/**
 * No new try starts later than this after the first send of a rotation: the
 * server keeps the old token for 10 minutes after a rotation the till may not
 * have seen, and each try can take up to its 15 s timeout.
 */
const OVERLAP_BUDGET_MS = 9 * 60 * 1000;
/** After a rejected or exhausted rotation, no new one (tick or hint) for this long. */
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
/** A refused (401) pairing is not tried again for this long (a proxy 401 is not forever). */
const REFUSAL_HOLD_MS = 60 * 60 * 1000;

type RotationOutcome =
  | 'not_paired'
  | 'not_due'
  | 'rotated'
  | 'unauthorized'
  | 'deferred'
  | 'failed'
  | 'stale';

interface DeviceTokenRotationDeps {
  store: DeviceTokenRotationStore;
  client: RotationClient;
  now: () => number;
  /** A fresh key per attempt (16–128 printable ASCII, no whitespace). */
  newIdempotencyKey: () => string;
  sleep: (ms: number) => Promise<void>;
  logger?: Pick<Logger, 'info' | 'warn'> | undefined;
}

export interface DeviceTokenRotation {
  /** Rotate when the credential is due; one rotation at a time. Never throws. */
  rotateIfDue(): Promise<RotationOutcome>;
  /** An RT-639 hint from a device response; a due hint starts a rotation. */
  observeHint(hint: RotationHint | null): void;
  /**
   * Shutdown latch (quit): no new try starts, including a retry waking from its
   * sleep, so no rotation commits on the server once its answer can no longer be
   * stored. A request already on the wire finishes; if its answer comes too late,
   * the old token still authenticates for 10 minutes and the next start retries.
   */
  stop(): void;
  /** Wrap the RT-215 confirmation probe: unless the credential is live, rotate first. */
  recoveryFirst(probe: () => Promise<DeviceAuthOutcome>): () => Promise<DeviceAuthOutcome>;
}

function bindingKey(binding: PairingBinding): string {
  return `${binding.tenant_id}|${binding.branch_id}|${binding.terminal_id}|${String(binding.paired_at)}`;
}

function expiryMs(expiresAt: string | null): number | null {
  if (expiresAt === null) return null;
  const ms = Date.parse(expiresAt);
  return Number.isNaN(ms) ? null : ms;
}

export function createDeviceTokenRotation(deps: DeviceTokenRotationDeps): DeviceTokenRotation {
  let inFlight: Promise<RotationOutcome> | null = null;
  /** Whether the run in flight is a forced (RT-215 recovery) one. */
  let inFlightForced = false;
  /** Shutdown latch: no new try starts once set. */
  let stopped = false;
  let hint: RotationHint | null = null;
  /** The pairing the last read credential belonged to; a new one drops the old hint. */
  let currentKey: string | null = null;
  /** The pairing whose rotation was refused (401), and when. */
  let refused: { key: string; atMs: number } | null = null;
  /** 429 or a failure backoff: no attempt before this instant. */
  let notBeforeMs = 0;
  /** A rotation already ran while the expiry was unknown and taught nothing. */
  let unknownTried = false;
  let lastRotatedAtMs = Number.NEGATIVE_INFINITY;

  function log(event: string, outcome: RotationOutcome): void {
    const level = outcome === 'rotated' ? 'info' : 'warn';
    deps.logger?.[level]({ event, outcome }, 'device token rotation');
  }

  function hintDue(nowMs: number): boolean {
    return hint !== null && (hint.urgent || hint.rotateAfterMs <= nowMs);
  }

  /** A credential of another pairing than the last one read: its hint and history go. */
  function track(key: string): void {
    if (currentKey !== null && currentKey !== key) {
      hint = null;
      unknownTried = false;
    }
    currentKey = key;
  }

  function isRefused(key: string, nowMs: number): boolean {
    return refused !== null && refused.key === key && nowMs - refused.atMs < REFUSAL_HOLD_MS;
  }

  /**
   * Why this credential may not rotate now, or null when it may. `force` is the
   * RT-215 confirmation: a device 401 with a credential not known to be live
   * (expired, past the grace by this clock, or of unknown expiry) tries one
   * rotation and lets the server decide; a 401 there confirms the revocation.
   */
  function blocker(cred: RotationCredential, force: boolean): RotationOutcome | null {
    const nowMs = deps.now();
    const phase = credentialPhase(expiryMs(cred.expiresAt), nowMs);
    if (isRefused(bindingKey(cred.binding), nowMs)) return 'not_due';
    if (force) {
      if (phase === 'fresh' || phase === 'due') return 'not_due';
      return nowMs < notBeforeMs ? 'deferred' : null;
    }
    if (phase === 'lapsed' || nowMs < notBeforeMs) return 'not_due';
    if (phase === 'due' || phase === 'grace') return null;
    if (phase === 'unknown' && !unknownTried) return null;
    return hintDue(nowMs) ? null : 'not_due';
  }

  async function adopt(
    cred: RotationCredential,
    result: Extract<RotationResult, { kind: 'rotated' }>,
  ): Promise<RotationOutcome | 'retry'> {
    let stored: 'replaced' | 'stale';
    try {
      stored = await deps.store.replaceRotatedToken(cred.binding, result.token, result.expiresAt);
    } catch {
      // Not stored: the old token is now the server's previous one, valid 10 minutes.
      log('device_token.rotation.store_failed', 'failed');
      return 'retry';
    }
    if (stored === 'stale') return 'stale';
    hint = null;
    lastRotatedAtMs = deps.now();
    if (result.expiresAt === null) unknownTried = true;
    return 'rotated';
  }

  async function settle(
    cred: RotationCredential,
    result: RotationResult,
  ): Promise<RotationOutcome | 'retry'> {
    switch (result.kind) {
      case 'rotated':
        return adopt(cred, result);
      case 'unauthorized':
        refused = { key: bindingKey(cred.binding), atMs: deps.now() };
        return 'unauthorized';
      case 'rate_limited':
        notBeforeMs = deps.now() + result.retryAfterMs;
        return 'deferred';
      case 'rejected':
        return 'failed';
      case 'retryable':
        return 'retry';
    }
  }

  /** The held credential, re-read before a retry; null if the pairing changed. */
  async function stillHeld(binding: PairingBinding): Promise<RotationCredential | null> {
    const cred = await deps.store.readRotationCredential();
    return cred !== null && bindingKey(cred.binding) === bindingKey(binding) ? cred : null;
  }

  /**
   * The wait before the next try, or null to stop. A lost answer waits the next
   * overlap delay. A 429 after an earlier try of the same rotation waits its
   * `Retry-After`: that earlier try may have rotated, so the old token has at
   * most 10 minutes left. A 429 on the first try only defers.
   */
  function nextWait(
    outcome: RotationOutcome | 'retry',
    result: RotationResult,
    tries: number,
  ): number | null {
    if (outcome === 'retry') return OVERLAP_RETRY_DELAYS_MS[tries - 1] ?? null;
    if (result.kind === 'rate_limited' && tries > 1) return result.retryAfterMs;
    return null;
  }

  async function attempt(force: boolean): Promise<RotationOutcome> {
    let cred = await deps.store.readRotationCredential();
    if (cred === null) return 'not_paired';
    track(bindingKey(cred.binding));
    const blocked = blocker(cred, force);
    if (blocked !== null) return blocked;
    const binding = cred.binding;
    const deadlineMs = deps.now() + OVERLAP_BUDGET_MS;
    for (let tries = 1; ; tries += 1) {
      // After stop (quit), never start a try: its answer could not be stored.
      if (stopped) return 'failed';
      const result = await deps.client.rotate(cred.token, deps.newIdempotencyKey());
      const outcome = await settle(cred, result);
      const waitMs = nextWait(outcome, result, tries);
      if (waitMs === null || deps.now() + waitMs > deadlineMs) {
        return outcome === 'retry' ? 'failed' : outcome;
      }
      await deps.sleep(waitMs);
      const held = await stillHeld(binding);
      if (held === null) return 'stale';
      cred = held;
    }
  }

  function run(force: boolean): Promise<RotationOutcome> {
    if (inFlight !== null && force && !inFlightForced) {
      // A scheduled run's "not due" is no answer for the RT-215 recovery: decide again, forced.
      return inFlight.then((outcome) => (outcome === 'not_due' ? run(true) : outcome));
    }
    if (inFlight === null) inFlightForced = force;
    inFlight ??= attempt(force)
      .catch((): RotationOutcome => 'failed')
      .then((outcome) => {
        if (outcome === 'failed') {
          notBeforeMs = Math.max(notBeforeMs, deps.now() + FAILURE_BACKOFF_MS);
        }
        if (outcome !== 'not_due' && outcome !== 'not_paired') {
          log(`device_token.rotation.${outcome}`, outcome);
        }
        return outcome;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    rotateIfDue: () => run(false),

    stop() {
      stopped = true;
    },

    observeHint(next) {
      if (next === null) return;
      const nowMs = deps.now();
      if (nowMs - lastRotatedAtMs < STALE_HINT_WINDOW_MS) return;
      hint = next;
      if (hintDue(nowMs)) void run(false);
    },

    recoveryFirst(probe) {
      return async () => {
        const outcome = await run(true);
        if (outcome === 'rotated') return 'ok';
        if (outcome === 'unauthorized') return 'unauthorized';
        if (outcome === 'deferred' || outcome === 'failed') return 'other';
        return probe();
      };
    },
  };
}
