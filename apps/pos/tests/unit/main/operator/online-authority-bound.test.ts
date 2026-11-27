import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authorityClockOf,
  MANAGER_SESSION_BOUND_MS,
  newSaleBlock,
  offlineAuthorityExpired,
  onlineContactLostBound,
} from '../../../../src/main/operator/offline-authority.js';
import { OFFLINE_GRANT_MAX_TTL_MS } from '../../../../src/main/operator/offline-grant-store.js';
import { SessionManager } from '../../../../src/main/operator/session-manager.js';
import { CashierAdmissionKeeper } from '../../../../src/main/operator/cashier-admission-keeper.js';
import { RECONCILE_RETRY_MS } from '../../../../src/main/operator/offline-reconcile.js';
import {
  ADMITTED,
  fakeCashierAdmission,
} from '../../../../src/main/operator/__tests__/__helpers__/fake-cashier-admission.js';

/**
 * RT-309 (RT-113 10763 D6; coordinator decisions on #929):
 *
 *  - item 1: an online-confirmed cashier session is NOT bounded while its
 *    server contact holds (every answered heartbeat or reconcile re-confirms
 *    it), so a connected till is never blocked between heartbeats. Once a
 *    heartbeat is not answered, new sales are refused after
 *    `last confirmed contact + min(offline_grace, 72 h)`; grace 0 refuses them
 *    as soon as the heartbeat fails. A confirmed contact lifts the bound;
 *  - an `admitted` that raced a grant invalidation (a device 401) renews
 *    nothing;
 *  - item 2: a manager / admin session may start new sales for an absolute
 *    24 h from its online sign-in.
 *
 * After a bound only a NEW sale is refused (`offline_authority_expired`); the
 * session keeps running.
 */

const HOUR_MS = 3_600_000;
const TTL_S = 600;
const ADMISSION = {
  user_id: '0192f6a0-1b2c-7d3e-8f40-123456789abc',
  admission_id: '0192f6a0-aaaa-7bbb-8ccc-000000000001',
  admission_ttl_seconds: TTL_S,
  offline_grace_seconds: 24 * 3_600,
  admission_generation: 'gen-signin-0001',
};

function createCashier(m: SessionManager, over: Partial<typeof ADMISSION> = {}) {
  return m.create({
    operator_id: 'user_clerk_1',
    display_name: 'Cashier',
    role: 'cashier',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: '',
    cashier_admission: { ...ADMISSION, ...over, admission_requested_at_ms: performance.now() },
  });
}

function createManager(m: SessionManager, role: 'manager' | 'admin' = 'manager') {
  return m.create({
    operator_id: 'op-1',
    display_name: 'Manager',
    role,
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: 'be-1',
  });
}

function blocked(record: Parameters<typeof newSaleBlock>[0]) {
  return newSaleBlock(record, authorityClockOf());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-27T08:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('onlineContactLostBound (pure)', () => {
  const now = { wall_ms: 1_800_000_000_000, mono_ms: 900_000 };
  const contact = { confirmed_wall_ms: now.wall_ms - 60_000, confirmed_mono_ms: 840_000 };

  it('is the last confirmed contact + the grace', () => {
    expect(onlineContactLostBound({ ...contact, offline_grace_seconds: 3_600 }, now)).toEqual({
      valid_until_ms: contact.confirmed_wall_ms + 3_600_000,
      deadline_mono_ms: contact.confirmed_mono_ms + 3_600_000,
    });
  });

  it('grace 0: the bound is the last contact itself (already reached)', () => {
    const b = onlineContactLostBound({ ...contact, offline_grace_seconds: 0 }, now);
    expect(b.deadline_mono_ms).toBe(contact.confirmed_mono_ms);
    expect(b.deadline_mono_ms).toBeLessThan(now.mono_ms);
  });

  it('never exceeds the 72 h grant ceiling', () => {
    const b = onlineContactLostBound({ ...contact, offline_grace_seconds: 30 * 86_400 }, now);
    expect(b.deadline_mono_ms - contact.confirmed_mono_ms).toBe(OFFLINE_GRANT_MAX_TTL_MS);
  });

  it('a confirmed stamp in the future cannot extend it', () => {
    const b = onlineContactLostBound(
      {
        confirmed_wall_ms: now.wall_ms + 10 * HOUR_MS,
        confirmed_mono_ms: now.mono_ms + 10 * HOUR_MS,
        offline_grace_seconds: 0,
      },
      now,
    );
    expect(b).toEqual({ valid_until_ms: now.wall_ms, deadline_mono_ms: now.mono_ms });
  });

  it.each([
    [
      'no confirmed stamp',
      { confirmed_wall_ms: undefined, confirmed_mono_ms: 1, offline_grace_seconds: 60 },
    ],
    [
      'a NaN stamp',
      { confirmed_wall_ms: Number.NaN, confirmed_mono_ms: 1, offline_grace_seconds: 60 },
    ],
    ['no grace', { ...contact, offline_grace_seconds: undefined }],
    ['a negative grace', { ...contact, offline_grace_seconds: -1 }],
  ])('fails closed (expired at once) on %s', (_l, input) => {
    expect(onlineContactLostBound(input, now)).toEqual({
      valid_until_ms: now.wall_ms,
      deadline_mono_ms: now.mono_ms,
    });
  });
});

describe('an online-confirmed session (SessionManager)', () => {
  it('is never bounded while its contact holds, however long', () => {
    const m = new SessionManager();
    const record = createCashier(m, { offline_grace_seconds: 0 });
    vi.advanceTimersByTime(100 * HOUR_MS);
    expect(blocked(record)).toBeNull();
    expect(record.authority_valid_until_ms).toBeUndefined();
  });

  it('contact lost with grace 0: new sales are refused at once; the session keeps running', () => {
    const m = new SessionManager();
    const record = createCashier(m, { offline_grace_seconds: 0 });
    vi.advanceTimersByTime(300_000);
    expect(m.markContactLost(record.id)).toBe(true);
    expect(blocked(record)).toBe('offline_authority_expired');
    expect(m.getCurrent()?.id).toBe(record.id);
    expect(m.getCurrent()?.lock_state).toBe('active');
  });

  it('contact lost with a short grace: allowed until last contact + grace, then refused', () => {
    const m = new SessionManager();
    const record = createCashier(m, { offline_grace_seconds: 900 });
    vi.advanceTimersByTime(300_000);
    m.markContactLost(record.id);
    vi.advanceTimersByTime(600_000 - 1);
    expect(blocked(record)).toBeNull();
    vi.advanceTimersByTime(1);
    expect(blocked(record)).toBe('offline_authority_expired');
  });

  it('a later loss never moves the bound set by the first one', () => {
    const m = new SessionManager();
    const record = createCashier(m, { offline_grace_seconds: 900 });
    m.markContactLost(record.id);
    const first = record.authority_deadline_mono_ms;
    vi.advanceTimersByTime(300_000);
    m.markContactLost(record.id);
    expect(record.authority_deadline_mono_ms).toBe(first);
  });

  it('a confirmed contact (renewal) lifts the bound', () => {
    const m = new SessionManager();
    const record = createCashier(m, { offline_grace_seconds: 0 });
    m.markContactLost(record.id);
    expect(blocked(record)).toBe('offline_authority_expired');
    m.renewAdmission(record.id, {
      admission_id: ADMISSION.admission_id,
      admission_ttl_seconds: TTL_S,
      offline_grace_seconds: 0,
      admission_generation: 'gen-2',
    });
    expect(blocked(record)).toBeNull();
    expect(record.authority_valid_until_ms).toBeUndefined();
  });

  it('a wall clock set back cannot extend a lost-contact bound', () => {
    const m = new SessionManager();
    const record = createCashier(m, { offline_grace_seconds: 900 });
    m.markContactLost(record.id);
    vi.advanceTimersByTime(900_000);
    expect(
      offlineAuthorityExpired(record, {
        wall_ms: Date.now() - 48 * HOUR_MS,
        mono_ms: performance.now(),
      }),
    ).toBe(true);
  });

  it('markContactLost only touches the CURRENT online-confirmed session', () => {
    const m = new SessionManager();
    const record = createCashier(m);
    expect(m.markContactLost('another-session')).toBe(false);
    expect(record.authority_valid_until_ms).toBeUndefined();
    const manager = createManager(new SessionManager());
    expect(new SessionManager().markContactLost(manager.id)).toBe(false);
  });

  it('fails closed without a confirmed contact stamp', () => {
    expect(blocked({ authority: 'online_confirmed' })).toBe('offline_authority_expired');
  });

  it('the bounds and stamps are main-only: never in the renderer bridge view', () => {
    const m = new SessionManager();
    createCashier(m);
    const view = m.getCurrentBridgeView() as unknown as Record<string, unknown>;
    for (const f of [
      'authority_valid_until_ms',
      'authority_deadline_mono_ms',
      'authority_confirmed_wall_ms',
      'authority_confirmed_mono_ms',
      'manager_valid_until_ms',
      'manager_deadline_mono_ms',
    ]) {
      expect(view).not.toHaveProperty(f);
    }
  });
});

describe('end to end through the keeper', () => {
  const ANSWER = { ...ADMITTED, offline_grace_seconds: 0, admission_ttl_seconds: TTL_S };

  function keeperFor(fake: ReturnType<typeof fakeCashierAdmission>, sessions: SessionManager) {
    return new CashierAdmissionKeeper({
      sessionManager: sessions,
      admission: fake.deps,
      isAtSafePoint: () => true,
    });
  }

  it('grace 0: connected across heartbeat gaps stays allowed; a failed heartbeat refuses at once; a reconnect lifts it', async () => {
    const sessions = new SessionManager();
    const fake = fakeCashierAdmission(ANSWER);
    const keeper = keeperFor(fake, sessions);
    const record = createCashier(sessions, { offline_grace_seconds: 0 });
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(150_000); // half a heartbeat interval
      expect(blocked(record)).toBeNull();
    }
    expect(fake.admitCalls.length).toBeGreaterThanOrEqual(3);
    fake.setAdmit({ kind: 'no_connection' });
    const calls = fake.admitCalls.length;
    while (fake.admitCalls.length === calls) await vi.advanceTimersByTimeAsync(1_000);
    expect(blocked(record)).toBe('offline_authority_expired');
    expect(sessions.getCurrent()?.id).toBe(record.id);
    fake.setAdmit(ANSWER);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(blocked(record)).toBeNull();
    keeper.stop();
  });

  it('a short nonzero grace: refused only after last contact + grace', async () => {
    const sessions = new SessionManager();
    const fake = fakeCashierAdmission({ ...ANSWER, offline_grace_seconds: 1_200 });
    const keeper = keeperFor(fake, sessions);
    const record = createCashier(sessions, { offline_grace_seconds: 1_200 });
    await vi.advanceTimersByTimeAsync(300_000); // first heartbeat answered (contact at t=300 s)
    fake.setAdmit({ kind: 'no_connection' });
    await vi.advanceTimersByTimeAsync(300_000); // next one fails (t=600 s)
    expect(record.authority_valid_until_ms).toBeDefined();
    expect(blocked(record)).toBeNull();
    await vi.advanceTimersByTimeAsync(900_000); // t=1500 s = contact + 1200 s
    expect(blocked(record)).toBe('offline_authority_expired');
    keeper.stop();
  });

  it('a 400 heartbeat answer does not confirm the contact either', async () => {
    const sessions = new SessionManager();
    const fake = fakeCashierAdmission(ANSWER);
    const keeper = keeperFor(fake, sessions);
    const record = createCashier(sessions, { offline_grace_seconds: 0 });
    fake.setAdmit({ kind: 'rejected' });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(blocked(record)).toBe('offline_authority_expired');
    keeper.stop();
  });

  it('a device 401 that lands while a heartbeat is in flight: its admitted renews nothing', async () => {
    const sessions = new SessionManager();
    const fake = fakeCashierAdmission(ANSWER);
    let invalidations = 0;
    fake.deps.grantSeam = {
      onCashierAdmitted: (e) => fake.admitted.push(e),
      onCashierAdmissionInvalidated: (e) => fake.invalidated.push(e),
      invalidationSeq: () => invalidations,
    };
    let release: (r: typeof ANSWER) => void = () => undefined;
    fake.setAdmit(() => new Promise((r) => (release = r)));
    const keeper = keeperFor(fake, sessions);
    const record = createCashier(sessions, { offline_grace_seconds: 0 });
    await vi.advanceTimersByTimeAsync(300_000); // heartbeat in flight
    invalidations += 1; // the device 401 invalidated every grant meanwhile
    release({ ...ANSWER, admission_generation: 'gen-raced' });
    await vi.advanceTimersByTimeAsync(0);
    expect(record.admission_generation).toBe(ADMISSION.admission_generation);
    expect(fake.admitted).toEqual([]);
    expect(blocked(record)).toBe('offline_authority_expired');
    // Verified again soon, with a fresh answer.
    fake.setAdmit(ANSWER);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(blocked(record)).toBeNull();
    keeper.stop();
  });

  it('the reconcile adopting an expired offline-admitted session confirms its contact: new sales resume', async () => {
    const sessions = new SessionManager();
    const fake = fakeCashierAdmission();
    fake.setReconcile({ kind: 'no_connection' });
    const keeper = keeperFor(fake, sessions);
    const record = sessions.create({
      operator_id: 'user_clerk_1',
      display_name: 'Cashier',
      role: 'cashier',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: '',
      offline_admission: {
        user_id: ADMISSION.user_id,
        valid_until_ms: Date.now() + 1_000,
        deadline_mono_ms: performance.now() + 1_000,
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(blocked(record)).toBe('offline_authority_expired');
    fake.setReconcile({ ...ADMITTED });
    await vi.advanceTimersByTimeAsync(RECONCILE_RETRY_MS);
    expect(record.authority).toBe('online_confirmed');
    expect(record.authority_valid_until_ms).toBeUndefined();
    expect(blocked(record)).toBeNull();
    keeper.stop();
  });
});

describe('a manager / admin session: absolute 24 h from the online sign-in (D6 item 2)', () => {
  it.each(['manager', 'admin'] as const)(
    '%s: new sales allowed until 24 h, then refused',
    (role) => {
      const m = new SessionManager();
      const record = createManager(m, role);
      expect(record.manager_valid_until_ms).toBe(Date.now() + MANAGER_SESSION_BOUND_MS);
      vi.advanceTimersByTime(MANAGER_SESSION_BOUND_MS - 1);
      expect(blocked(record)).toBeNull();
      vi.advanceTimersByTime(1);
      expect(blocked(record)).toBe('offline_authority_expired');
      expect(m.getCurrent()?.id).toBe(record.id);
    },
  );

  it('nothing on the session extends it (re-auth only refreshes the credential)', () => {
    const m = new SessionManager();
    const record = createManager(m);
    const until = record.manager_valid_until_ms;
    vi.advanceTimersByTime(12 * HOUR_MS);
    m.noteActivity(new Date().toISOString());
    m.lock(new Date().toISOString());
    m.unlock(new Date().toISOString());
    expect(record.manager_valid_until_ms).toBe(until);
  });

  it('every manager / admin session the SessionManager creates carries the bound', () => {
    for (const role of ['manager', 'admin'] as const) {
      const record = createManager(new SessionManager(), role);
      expect(Number.isFinite(record.manager_valid_until_ms)).toBe(true);
      expect(Number.isFinite(record.manager_deadline_mono_ms)).toBe(true);
    }
  });

  it('fails closed on a partial or unreadable manager bound', () => {
    expect(blocked({ role: 'manager', manager_valid_until_ms: Number.MAX_SAFE_INTEGER })).toBe(
      'offline_authority_expired',
    );
    expect(
      blocked({
        role: 'admin',
        manager_valid_until_ms: Number.NaN,
        manager_deadline_mono_ms: 1e15,
      }),
    ).toBe('offline_authority_expired');
  });

  it('a cashier session carries no manager bound', () => {
    const record = createCashier(new SessionManager());
    expect(record.manager_valid_until_ms).toBeUndefined();
  });
});
