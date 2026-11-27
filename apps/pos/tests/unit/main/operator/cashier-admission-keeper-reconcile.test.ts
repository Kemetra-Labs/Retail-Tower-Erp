import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CashierAdmissionKeeper,
  SAFE_POINT_RECHECK_MS,
  heartbeatIntervalMs,
} from '../../../../src/main/operator/cashier-admission-keeper.js';
import { SessionManager } from '../../../../src/main/operator/session-manager.js';
import {
  ADMITTED,
  FAKE_USER_ID,
  fakeCashierAdmission,
} from '../../../../src/main/operator/__tests__/__helpers__/fake-cashier-admission.js';

/**
 * RT-1312 F17 (RT-113 P4, D8) — the keeper owns the offline reconcile of the
 * current session: `admitted` makes it online-confirmed AND arms the heartbeat;
 * a refusal latches it like a lost heartbeat does (no new sale, ended at its
 * first safe point, nothing reversed); RT-309 D9: a conflict locks it instead.
 */

const TTL_S = 600;

function setup() {
  const sessions = new SessionManager();
  const fake = fakeCashierAdmission();
  fake.setReconcile({ ...ADMITTED, admission_ttl_seconds: TTL_S });
  fake.setAdmit({ ...ADMITTED, admission_ttl_seconds: TTL_S });
  const safe = { value: true };
  const ends: (string | undefined)[] = [];
  sessions.onEnded((_r, cause) => ends.push(cause));
  const keeper = new CashierAdmissionKeeper({
    sessionManager: sessions,
    admission: fake.deps,
    isAtSafePoint: () => safe.value,
  });
  return { sessions, fake, keeper, safe, ends };
}

function signInOffline(sessions: SessionManager) {
  return sessions.create({
    operator_id: 'user_clerk_1',
    display_name: 'Mona',
    role: 'cashier',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: '',
    offline_admission: {
      user_id: FAKE_USER_ID,
      valid_until_ms: Date.now() + 3_600_000,
      deadline_mono_ms: performance.now() + 3_600_000,
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('offline reconcile through the keeper', () => {
  it('reconciles an offline session, then keeps the new admission live with a heartbeat', async () => {
    const h = setup();
    signInOffline(h.sessions);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fake.reconcileCalls).toHaveLength(1);
    expect(h.sessions.getCurrent()?.authority).toBe('online_confirmed');
    expect(h.fake.admitCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs(TTL_S));
    expect(h.fake.admitCalls).toHaveLength(1);
    expect(h.fake.admitCalls[0]).toMatchObject({
      mode: 'online',
      user_id: FAKE_USER_ID,
      takeover: false,
    });
    expect(h.fake.reconcileCalls).toHaveLength(1);
  });

  it('ending the adopted session releases its admission (the generation echoed)', async () => {
    const h = setup();
    signInOffline(h.sessions);
    await vi.advanceTimersByTimeAsync(0);
    h.sessions.end('signed_out');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fake.endRequests).toEqual([
      { admission_id: ADMITTED.admission_id, admission_generation: ADMITTED.admission_generation },
    ]);
  });

  // RT-309 D9 (RT-309 c19114, 10763 D9): a conflict no longer latches and ends
  // the session; it locks it (`authority_conflict`) for the cashier's decision
  // (take over here / end here, `authority-conflict.test.ts`).
  it('active_elsewhere locks the session for the cashier decision and never ends it on its own', async () => {
    const h = setup();
    h.fake.setReconcile({ kind: 'active_elsewhere' });
    const record = signInOffline(h.sessions);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sessions.getCurrent()?.id).toBe(record.id);
    expect(h.sessions.getCurrent()?.lock_cause).toBe('authority_conflict');
    expect(h.sessions.getCurrent()?.authority_latch).toBeUndefined();
    await vi.advanceTimersByTimeAsync(SAFE_POINT_RECHECK_MS * 10);
    expect(h.ends).toEqual([]); // nothing ends until the cashier decides
  });

  it('a 403 latches the session and ends it account_disabled_mid_session', async () => {
    const h = setup();
    h.fake.setReconcile({ kind: 'refused' });
    signInOffline(h.sessions);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.ends).toEqual(['account_disabled_mid_session']);
    expect(h.fake.invalidated).toEqual([{ reason: 'refused', user_id: FAKE_USER_ID }]);
  });

  it('exposes the sales gate for the drain, held until the first answer', async () => {
    const h = setup();
    h.fake.setReconcile({ kind: 'no_connection' });
    signInOffline(h.sessions);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.keeper.isSaleHeldForReconcile(FAKE_USER_ID)).toBe(true);
    h.fake.setReconcile({ ...ADMITTED, admission_ttl_seconds: TTL_S });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.keeper.isSaleHeldForReconcile(FAKE_USER_ID)).toBe(false);
  });

  it('stop() silences the reconcile as it does every keeper timer', async () => {
    const h = setup();
    h.fake.setReconcile({ kind: 'no_connection' });
    signInOffline(h.sessions);
    await vi.advanceTimersByTimeAsync(0);
    h.keeper.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.fake.reconcileCalls).toHaveLength(1);
    expect(h.keeper.isSaleHeldForReconcile(FAKE_USER_ID)).toBe(false);
  });
});
