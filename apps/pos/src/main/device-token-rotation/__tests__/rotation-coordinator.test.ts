import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeviceAuthDetector } from '../../pairing/device-auth-detector.js';
import type { PairingBinding } from '../../pairing/token-binding.js';
import type { RotationResult } from '../rotation-client.js';
import {
  OVERLAP_RETRY_DELAYS_MS,
  createDeviceTokenRotation,
  type RotationCredential,
} from '../rotation-coordinator.js';

const DAY = 24 * 60 * 60 * 1000;
const OLD = 'old-' + 'a'.repeat(24);
const NEW = 'new-' + 'b'.repeat(24);
const NEWER = 'newer-' + 'c'.repeat(22);
const EXPIRES_MS = Date.parse('2027-03-01T00:00:00.000Z');
const NEW_EXPIRES = '2027-05-30T00:00:00.000Z';
const BINDING: PairingBinding = {
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
  paired_at: 1_790_000_000,
};

const rotated = (token: string, expiresAt: string | null = NEW_EXPIRES): RotationResult => ({
  kind: 'rotated',
  token,
  expiresAt,
});

/** A pairing store holding one sealed token; `replaceRotatedToken` can be made to fail. */
function fakeStore(expiresAt: string | null) {
  let current: RotationCredential | null = { token: OLD, binding: BINDING, expiresAt };
  const store = {
    failNextReplace: false,
    readRotationCredential: vi.fn(() => Promise.resolve(current === null ? null : { ...current })),
    replaceRotatedToken: vi.fn(
      (
        binding: PairingBinding,
        token: string,
        expires: string | null,
      ): Promise<'replaced' | 'stale'> => {
        if (store.failNextReplace) {
          store.failNextReplace = false;
          return Promise.reject(new Error('crash between seal and switch'));
        }
        if (current === null || current.binding.paired_at !== binding.paired_at) {
          return Promise.resolve('stale');
        }
        current = { token, binding, expiresAt: expires };
        return Promise.resolve('replaced');
      },
    ),
    unpair: () => {
      current = null;
    },
    /** A new pairing (new epoch) with a far expiry. */
    repair: () => {
      current = {
        token: NEWER,
        binding: { ...BINDING, paired_at: BINDING.paired_at + 1 },
        expiresAt: new Date(EXPIRES_MS + 90 * DAY).toISOString(),
      };
    },
    held: () => current?.token ?? null,
  };
  return store;
}

function harness(opts: { expiresAt?: string | null; now: number; answers: RotationResult[] }) {
  const store = fakeStore(
    opts.expiresAt === undefined ? new Date(EXPIRES_MS).toISOString() : opts.expiresAt,
  );
  const answers = [...opts.answers];
  const presented: Array<{ token: string; key: string }> = [];
  const client = {
    rotate: vi.fn((token: string, key: string): Promise<RotationResult> => {
      presented.push({ token, key });
      const next = answers.shift();
      if (next === undefined) return Promise.reject(new Error('unexpected rotation call'));
      return Promise.resolve(next);
    }),
  };
  let clock = opts.now;
  let keySeq = 0;
  const sleep = vi.fn((ms: number): Promise<void> => {
    clock += ms;
    return Promise.resolve();
  });
  const rotation = createDeviceTokenRotation({
    store,
    client,
    now: () => clock,
    newIdempotencyKey: () => `rt373-key-${String(++keySeq).padStart(16, '0')}`,
    sleep,
  });
  return {
    store,
    client,
    presented,
    sleep,
    rotation,
    setNow: (ms: number) => {
      clock = ms;
    },
  };
}

describe('RT-373 rotation threshold (fewer than 15 days left)', () => {
  it('does not rotate while more than 15 days remain', async () => {
    const h = harness({ now: EXPIRES_MS - 16 * DAY, answers: [] });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('not_due');
    expect(h.client.rotate).not.toHaveBeenCalled();
  });

  it('rotates once 15 days or fewer remain and stores the new token and expiry', async () => {
    const h = harness({ now: EXPIRES_MS - 14 * DAY, answers: [rotated(NEW)] });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('rotated');
    expect(h.presented.map((p) => p.token)).toEqual([OLD]);
    expect(h.store.replaceRotatedToken).toHaveBeenCalledWith(BINDING, NEW, NEW_EXPIRES);
    expect(h.store.held()).toBe(NEW);
  });

  it('after a stored 200 it never presents the previous token again', async () => {
    // The first 200 carries an expiry still under 15 days away, so the next tick rotates again.
    const stillDue = new Date(EXPIRES_MS).toISOString();
    const h = harness({
      now: EXPIRES_MS - 14 * DAY,
      answers: [rotated(NEW, stillDue), rotated(NEWER)],
    });
    await h.rotation.rotateIfDue();
    await h.rotation.rotateIfDue();
    expect(h.presented.map((p) => p.token)).toEqual([OLD, NEW]);
  });

  it('does not rotate past the 7-day grace (only a re-pair helps then)', async () => {
    const h = harness({ now: EXPIRES_MS + 7 * DAY, answers: [] });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('not_due');
    expect(h.client.rotate).not.toHaveBeenCalled();
  });

  it('unpaired → nothing to rotate', async () => {
    const h = harness({ now: EXPIRES_MS - DAY, answers: [] });
    h.store.unpair();
    await expect(h.rotation.rotateIfDue()).resolves.toBe('not_paired');
  });
});

describe('RT-373 unknown expiry: rotate once on first start to learn it', () => {
  it('rotates with an unknown expiry, then is not due while the learned one is far', async () => {
    const now = Date.parse('2026-12-01T00:00:00.000Z');
    const h = harness({
      expiresAt: null,
      now,
      answers: [rotated(NEW, '2027-03-01T00:00:00.000Z')],
    });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('rotated');
    await expect(h.rotation.rotateIfDue()).resolves.toBe('not_due');
    expect(h.client.rotate).toHaveBeenCalledTimes(1);
  });
});

describe('RT-373 the server hint (RT-639)', () => {
  it('rotates when the hint instant has passed even though the local expiry is far', async () => {
    const now = EXPIRES_MS - 40 * DAY;
    const h = harness({ now, answers: [rotated(NEW)] });
    h.rotation.observeHint({ rotateAfterMs: now - 1, urgent: false });
    await vi.waitFor(() => {
      expect(h.client.rotate).toHaveBeenCalledTimes(1);
    });
    expect(h.store.held()).toBe(NEW);
  });

  it('rotates at once on the urgent stage', async () => {
    const now = EXPIRES_MS - 40 * DAY;
    const h = harness({ now, answers: [rotated(NEW)] });
    h.rotation.observeHint({ rotateAfterMs: now + DAY, urgent: true });
    await vi.waitFor(() => {
      expect(h.client.rotate).toHaveBeenCalledTimes(1);
    });
  });

  it('a hint still in the future does not rotate', async () => {
    const now = EXPIRES_MS - 40 * DAY;
    const h = harness({ now, answers: [] });
    h.rotation.observeHint({ rotateAfterMs: now + DAY, urgent: false });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('not_due');
    expect(h.client.rotate).not.toHaveBeenCalled();
  });
});

describe('RT-373 a lost response survives through the 10-minute overlap', () => {
  it('retries with the token it still holds and a NEW Idempotency-Key each time', async () => {
    const h = harness({
      now: EXPIRES_MS - DAY,
      answers: [{ kind: 'retryable' }, { kind: 'retryable' }, rotated(NEW)],
    });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('rotated');
    expect(h.presented.map((p) => p.token)).toEqual([OLD, OLD, OLD]);
    expect(new Set(h.presented.map((p) => p.key)).size).toBe(3);
    expect(h.store.held()).toBe(NEW);
  });

  it('every retry lands inside the 10-minute overlap', () => {
    const total = OVERLAP_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(OVERLAP_RETRY_DELAYS_MS.length).toBeGreaterThan(0);
    expect(total).toBeLessThan(10 * 60 * 1000);
  });

  it('gives up after the overlap budget, keeps the old token, and reports failed', async () => {
    const answers: RotationResult[] = Array.from(
      { length: OVERLAP_RETRY_DELAYS_MS.length + 1 },
      () => ({ kind: 'retryable' }),
    );
    const h = harness({ now: EXPIRES_MS - DAY, answers });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('failed');
    expect(h.store.held()).toBe(OLD);
  });

  it('keeps at most one rotation in flight', async () => {
    const h = harness({ now: EXPIRES_MS - DAY, answers: [rotated(NEW)] });
    const [a, b] = await Promise.all([h.rotation.rotateIfDue(), h.rotation.rotateIfDue()]);
    expect([a, b]).toEqual(['rotated', 'rotated']);
    expect(h.client.rotate).toHaveBeenCalledTimes(1);
  });
});

describe('RT-373 a crash between seal and switch', () => {
  it('a failed store write keeps the old token, which rotates again inside the overlap', async () => {
    const h = harness({ now: EXPIRES_MS - DAY, answers: [rotated(NEW), rotated(NEWER)] });
    h.store.failNextReplace = true;
    await expect(h.rotation.rotateIfDue()).resolves.toBe('rotated');
    // The server already moved OLD to its previous slot; OLD still authenticates
    // for 10 minutes, so the retry presents it with a fresh key.
    expect(h.presented.map((p) => p.token)).toEqual([OLD, OLD]);
    expect(new Set(h.presented.map((p) => p.key)).size).toBe(2);
    expect(h.store.held()).toBe(NEWER);
  });

  it('a process that died before storing rotates with the old token on its next start', async () => {
    const first = harness({ now: EXPIRES_MS - DAY, answers: [rotated(NEW)] });
    first.store.failNextReplace = true;
    // Nothing was stored; a fresh process (new coordinator) on the same store state:
    const restarted = harness({ now: EXPIRES_MS - DAY, answers: [rotated(NEWER)] });
    await expect(restarted.rotation.rotateIfDue()).resolves.toBe('rotated');
    expect(restarted.presented.map((p) => p.token)).toEqual([OLD]);
  });

  it('a rotation whose pairing was replaced meanwhile is dropped', async () => {
    const h = harness({ now: EXPIRES_MS - DAY, answers: [rotated(NEW)] });
    h.store.replaceRotatedToken.mockResolvedValueOnce('stale');
    await expect(h.rotation.rotateIfDue()).resolves.toBe('stale');
  });
});

describe('RT-373 refusals', () => {
  it('429 defers until Retry-After has passed', async () => {
    const now = EXPIRES_MS - DAY;
    const h = harness({
      now,
      answers: [{ kind: 'rate_limited', retryAfterMs: 60_000 }, rotated(NEW)],
    });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('deferred');
    await expect(h.rotation.rotateIfDue()).resolves.toBe('not_due');
    h.setNow(now + 60_000);
    await expect(h.rotation.rotateIfDue()).resolves.toBe('rotated');
  });

  it('401 stops rotating this pairing (a re-pair is the way back)', async () => {
    const h = harness({ now: EXPIRES_MS - DAY, answers: [{ kind: 'unauthorized' }] });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('unauthorized');
    await expect(h.rotation.rotateIfDue()).resolves.toBe('not_due');
    expect(h.client.rotate).toHaveBeenCalledTimes(1);
  });

  it('a request the server rejects (400/409) is not retried in a loop', async () => {
    const h = harness({ now: EXPIRES_MS - DAY, answers: [{ kind: 'rejected', status: 409 }] });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('failed');
    expect(h.client.rotate).toHaveBeenCalledTimes(1);
  });
});

describe('RT-373 CodeRabbit round 1', () => {
  it('a forced recovery that joins a scheduled "not due" run decides again, forced', async () => {
    // Expired in the grace, but a 429 backoff is running: the scheduled run says not_due,
    // the forced one must answer deferred (→ other), never reach the roster.
    const now = EXPIRES_MS + DAY;
    const h = harness({ now, answers: [{ kind: 'rate_limited', retryAfterMs: 60_000 }] });
    await h.rotation.rotateIfDue(); // sets the 429 backoff
    const roster = vi.fn(() => Promise.resolve('unauthorized' as const));
    const scheduled = h.rotation.rotateIfDue();
    const recovery = h.rotation.recoveryFirst(roster)();
    await expect(scheduled).resolves.toBe('not_due');
    await expect(recovery).resolves.toBe('other');
    expect(roster).not.toHaveBeenCalled();
  });

  it('after stop no new try starts, not even a retry waking from its sleep', async () => {
    const h = harness({ now: EXPIRES_MS - DAY, answers: [{ kind: 'retryable' }, rotated(NEW)] });
    h.sleep.mockImplementationOnce(() => {
      h.rotation.stop();
      return Promise.resolve();
    });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('failed');
    expect(h.client.rotate).toHaveBeenCalledTimes(1);
    expect(h.store.held()).toBe(OLD);
  });
});

describe('RT-373 review fixes', () => {
  it('a 429 on a retry after a lost answer waits Retry-After inside the overlap, then rotates with the old token', async () => {
    const h = harness({
      now: EXPIRES_MS - DAY,
      answers: [
        { kind: 'retryable' },
        { kind: 'rate_limited', retryAfterMs: 90_000 },
        rotated(NEW),
      ],
    });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('rotated');
    expect(h.presented.map((p) => p.token)).toEqual([OLD, OLD, OLD]);
    expect(h.sleep).toHaveBeenCalledWith(90_000);
  });

  it('a Retry-After past the overlap budget stops retrying (deferred)', async () => {
    const h = harness({
      now: EXPIRES_MS - DAY,
      answers: [{ kind: 'retryable' }, { kind: 'rate_limited', retryAfterMs: 20 * 60_000 }],
    });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('deferred');
  });

  it('a device 401 with an unknown expiry rotates first instead of confirming a revocation', async () => {
    const h = harness({ expiresAt: null, now: EXPIRES_MS, answers: [rotated(NEW)] });
    const roster = vi.fn(() => Promise.resolve('unauthorized' as const));
    await expect(h.rotation.recoveryFirst(roster)()).resolves.toBe('ok');
    expect(roster).not.toHaveBeenCalled();
  });

  it('a device 401 past the grace by this clock still lets the server decide', async () => {
    const h = harness({ now: EXPIRES_MS + 30 * DAY, answers: [{ kind: 'unauthorized' }] });
    const roster = vi.fn(() => Promise.resolve('ok' as const));
    await expect(h.rotation.recoveryFirst(roster)()).resolves.toBe('unauthorized');
    expect(roster).not.toHaveBeenCalled();
  });

  it('after a failed rotation the next one waits a backoff', async () => {
    const now = EXPIRES_MS - DAY;
    const h = harness({ now, answers: [{ kind: 'rejected', status: 409 }, rotated(NEW)] });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('failed');
    await expect(h.rotation.rotateIfDue()).resolves.toBe('not_due');
    h.setNow(now + 5 * 60_000);
    await expect(h.rotation.rotateIfDue()).resolves.toBe('rotated');
  });

  it('a 401 on the rotation is not final: tried again after an hour', async () => {
    const now = EXPIRES_MS - DAY;
    const h = harness({ now, answers: [{ kind: 'unauthorized' }, rotated(NEW)] });
    await expect(h.rotation.rotateIfDue()).resolves.toBe('unauthorized');
    h.setNow(now + 60 * 60_000);
    await expect(h.rotation.rotateIfDue()).resolves.toBe('rotated');
  });

  it('a hint seen for an earlier pairing is dropped when the pairing changes', async () => {
    const now = EXPIRES_MS - 40 * DAY;
    const h = harness({ now, answers: [] });
    await h.rotation.rotateIfDue(); // reads the first pairing
    h.rotation.observeHint({ rotateAfterMs: now + DAY, urgent: false });
    h.store.repair();
    h.setNow(now + 2 * DAY);
    await expect(h.rotation.rotateIfDue()).resolves.toBe('not_due');
    expect(h.client.rotate).not.toHaveBeenCalled();
  });
});

describe('RT-373 grace: a device 401 in the grace rotates first, then confirms nothing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('in the grace the confirmation rotates instead of calling the roster', async () => {
    const h = harness({ now: EXPIRES_MS + DAY, answers: [rotated(NEW)] });
    const roster = vi.fn(() => Promise.resolve('unauthorized' as const));
    await expect(h.rotation.recoveryFirst(roster)()).resolves.toBe('ok');
    expect(roster).not.toHaveBeenCalled();
    expect(h.store.held()).toBe(NEW);
  });

  it('outside the grace the confirmation is the roster call, unchanged', async () => {
    const h = harness({ now: EXPIRES_MS - 30 * DAY, answers: [] });
    const roster = vi.fn(() => Promise.resolve('ok' as const));
    await expect(h.rotation.recoveryFirst(roster)()).resolves.toBe('ok');
    expect(roster).toHaveBeenCalledTimes(1);
    expect(h.client.rotate).not.toHaveBeenCalled();
  });

  it('in the grace a transient rotation failure is no answer (confirm again later), never a revocation', async () => {
    const answers: RotationResult[] = Array.from(
      { length: OVERLAP_RETRY_DELAYS_MS.length + 1 },
      () => ({ kind: 'retryable' }),
    );
    const h = harness({ now: EXPIRES_MS + DAY, answers });
    const roster = vi.fn(() => Promise.resolve('unauthorized' as const));
    await expect(h.rotation.recoveryFirst(roster)()).resolves.toBe('other');
    expect(roster).not.toHaveBeenCalled();
  });

  it('expired in the grace: the RT-215 detector clears after the rotation (no revocation)', async () => {
    vi.useFakeTimers();
    const h = harness({ now: EXPIRES_MS + DAY, answers: [rotated(NEW)] });
    const onConfirmed = vi.fn();
    const detector = createDeviceAuthDetector({
      probe: h.rotation.recoveryFirst(() => Promise.resolve('unauthorized' as const)),
      confirmDelayMs: () => 5_000,
      onConfirmed,
    });
    detector.observe('cashier_admissions', 401);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(detector.state).toBe('clear');
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('revoked: the rotation is refused (401) and the RT-215 flow confirms the revocation', async () => {
    vi.useFakeTimers();
    const h = harness({ now: EXPIRES_MS + DAY, answers: [{ kind: 'unauthorized' }] });
    const onConfirmed = vi.fn();
    const detector = createDeviceAuthDetector({
      probe: h.rotation.recoveryFirst(() => Promise.resolve('unauthorized' as const)),
      confirmDelayMs: () => 5_000,
      onConfirmed,
    });
    detector.observe('read_down', 401);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(detector.state).toBe('confirmed');
    expect(onConfirmed).toHaveBeenCalledWith('read_down');
  });

  it('revoked outside the grace: the roster confirms, exactly as before RT-373', async () => {
    vi.useFakeTimers();
    const h = harness({ now: EXPIRES_MS - 30 * DAY, answers: [] });
    const onConfirmed = vi.fn();
    const detector = createDeviceAuthDetector({
      probe: h.rotation.recoveryFirst(() => Promise.resolve('unauthorized' as const)),
      confirmDelayMs: () => 5_000,
      onConfirmed,
    });
    detector.observe('cashier_admissions', 401);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onConfirmed).toHaveBeenCalledWith('cashier_admissions');
    expect(h.client.rotate).not.toHaveBeenCalled();
  });
});
