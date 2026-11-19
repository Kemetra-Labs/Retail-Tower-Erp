import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OfflineReconciler,
  RECONCILE_GATE_MAX_SERVER_ERRORS,
  RECONCILE_NUDGE_MIN_MS,
  RECONCILE_RETRY_MS,
} from '../../../../src/main/operator/offline-reconcile.js';
import type { CashierAdmissionResult } from '../../../../src/main/operator/cashier-admission-client.js';
import { authorityClockOf, newSaleBlock } from '../../../../src/main/operator/offline-authority.js';
import {
  SessionManager,
  type AuthorityLatchCause,
  type OperatorSessionRecord,
} from '../../../../src/main/operator/session-manager.js';
import {
  ADMITTED,
  FAKE_ADMISSION_ID,
  FAKE_GENERATION,
  FAKE_USER_ID,
  fakeCashierAdmission,
} from '../../../../src/main/operator/__tests__/__helpers__/fake-cashier-admission.js';

import { contractErrors } from './__helpers__/openapi-schema.js';

/**
 * RT-1312 F17 (RT-113 P4, D8; owner decision D2) — a cashier session admitted
 * OFFLINE from the sealed grant is reconciled with Backend-Core
 * (`mode: reconcile_offline`) on reconnect, then every 60 s until answered,
 * and the sales of that cashier are held out of the drain until the first
 * answer.
 */

const OTHER_USER_ID = '0192f6a0-1b2c-7d3e-8f40-00000000beef';

interface Harness {
  sessions: SessionManager;
  fake: ReturnType<typeof fakeCashierAdmission>;
  reconciler: OfflineReconciler;
  adopted: string[];
  conflicts: Array<{ session_id: string; cause: AuthorityLatchCause }>;
  /** The admission ids a late answer renewed under a live session (the keeper verifies early). */
  renewed: string[];
  logs: unknown[];
}

function harness(): Harness {
  const sessions = new SessionManager();
  const fake = fakeCashierAdmission();
  const adopted: string[] = [];
  const conflicts: Harness['conflicts'] = [];
  const renewed: string[] = [];
  const logs: unknown[] = [];
  const logger = {
    info: (...a: unknown[]) => logs.push(a),
    warn: (...a: unknown[]) => logs.push(a),
  };
  const reconciler = new OfflineReconciler({
    sessionManager: sessions,
    admission: fake.deps,
    onAdopted: (session_id) => adopted.push(session_id),
    onConflict: (session_id, cause) => conflicts.push({ session_id, cause }),
    onLiveAdmissionRenewed: (admission_id) => renewed.push(admission_id),
    logger,
  });
  sessions.onStarted((record) => {
    reconciler.onSessionStarted(record);
  });
  sessions.onEnded((record) => {
    reconciler.onSessionEnded(record);
  });
  return { sessions, fake, reconciler, adopted, conflicts, renewed, logs };
}

function signInOffline(
  sessions: SessionManager,
  user_id = FAKE_USER_ID,
  valid_for_ms = 3_600_000,
): OperatorSessionRecord {
  return sessions.create({
    operator_id: 'user_clerk_1',
    display_name: 'Mona',
    role: 'cashier',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: '',
    offline_admission: {
      user_id,
      valid_until_ms: Date.now() + valid_for_ms,
      deadline_mono_ms: performance.now() + valid_for_ms,
    },
  });
}

function signInOnline(sessions: SessionManager): OperatorSessionRecord {
  return sessions.create({
    operator_id: 'user_clerk_1',
    display_name: 'Mona',
    role: 'cashier',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: '',
    cashier_admission: {
      user_id: FAKE_USER_ID,
      admission_id: FAKE_ADMISSION_ID,
      admission_ttl_seconds: 600,
      offline_grace_seconds: 86_400,
      admission_generation: FAKE_GENERATION,
    },
  });
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

const NO_CONNECTION: CashierAdmissionResult = { kind: 'no_connection' };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('what is reconciled', () => {
  it('sends reconcile_offline for an offline-admitted session, with its admission time and a fresh key', async () => {
    const h = harness();
    const record = signInOffline(h.sessions);
    await advance(0);
    expect(h.fake.reconcileCalls).toHaveLength(1);
    const req = h.fake.reconcileCalls[0];
    expect(req).toEqual({
      mode: 'reconcile_offline',
      user_id: FAKE_USER_ID,
      offline_admitted_at: record.started_at,
      idempotency_key: 'test-idempotency-key-0001',
    });
    // The wire body is the contract's strict union member: no takeover, no scope field.
    expect(contractErrors('PosCashierAdmissionReconcileRequest', req)).toEqual([]);
    expect(h.fake.admitCalls).toHaveLength(0);
  });

  it('does nothing for a session admitted online or for a manager session', async () => {
    const h = harness();
    signInOnline(h.sessions);
    h.sessions.end();
    h.sessions.create({
      operator_id: 'mgr',
      display_name: 'Sara',
      role: 'manager',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: 'bs-1',
    });
    await advance(RECONCILE_RETRY_MS * 3);
    expect(h.fake.reconcileCalls).toHaveLength(0);
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(false);
  });
});

describe('admitted', () => {
  it('turns the session online_confirmed, lifts the offline bound, refreshes the grant and arms the heartbeat', async () => {
    const h = harness();
    h.fake.setReconcile(NO_CONNECTION);
    const record = signInOffline(h.sessions, FAKE_USER_ID, 1_000);
    await advance(0);
    // The grant ran out while the till was offline: a new sale is blocked.
    await advance(5_000);
    expect(newSaleBlock(record, authorityClockOf())).toBe('offline_authority_expired');

    h.fake.setReconcile({ ...ADMITTED });
    await advance(RECONCILE_RETRY_MS);
    const now = h.sessions.getCurrent();
    expect(now?.authority).toBe('online_confirmed');
    expect(now?.admission_id).toBe(ADMITTED.admission_id);
    expect(now?.admission_generation).toBe(FAKE_GENERATION);
    expect(now?.admission_ttl_seconds).toBe(ADMITTED.admission_ttl_seconds);
    expect(newSaleBlock(record, authorityClockOf())).toBeNull();
    expect(h.fake.admitted.map((e) => e.admission_id)).toEqual([ADMITTED.admission_id]);
    expect(h.adopted).toEqual([record.id]);
    expect(h.conflicts).toEqual([]);
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(false);
  });

  it('stamps the admission deadline from when the request was SENT (monotonic)', async () => {
    const h = harness();
    let sentAt = -1;
    h.fake.setReconcile(() => {
      sentAt = performance.now();
      return Promise.resolve({ ...ADMITTED });
    });
    signInOffline(h.sessions);
    await advance(0);
    expect(h.sessions.getCurrent()?.admission_requested_at_ms).toBe(sentAt);
  });

  it('stops reconciling once answered', async () => {
    const h = harness();
    signInOffline(h.sessions);
    await advance(RECONCILE_RETRY_MS * 5);
    expect(h.fake.reconcileCalls).toHaveLength(1);
  });
});

describe('conflict and refusal (fail closed)', () => {
  it('active_elsewhere: invalidates the grant, latches the session superseded, releases the sales gate', async () => {
    const h = harness();
    const record = signInOffline(h.sessions);
    h.fake.setReconcile({ kind: 'active_elsewhere' });
    await advance(0);
    expect(h.fake.invalidated).toEqual([{ reason: 'active_elsewhere', user_id: FAKE_USER_ID }]);
    expect(h.conflicts).toEqual([{ session_id: record.id, cause: 'superseded_by_takeover' }]);
    expect(h.sessions.getCurrent()?.authority).toBe('offline_grant');
    expect(h.adopted).toEqual([]);
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(false);
    await advance(RECONCILE_RETRY_MS * 3);
    expect(h.fake.reconcileCalls).toHaveLength(1);
  });

  it('403 refused: invalidates the grant and ends the authority as account_disabled_mid_session', async () => {
    const h = harness();
    const record = signInOffline(h.sessions);
    h.fake.setReconcile({ kind: 'refused' });
    await advance(0);
    expect(h.fake.invalidated).toEqual([{ reason: 'refused', user_id: FAKE_USER_ID }]);
    expect(h.conflicts).toEqual([{ session_id: record.id, cause: 'account_disabled_mid_session' }]);
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(false);
    await advance(RECONCILE_RETRY_MS * 3);
    expect(h.fake.reconcileCalls).toHaveLength(1);
  });

  it('device 401: invalidates every grant, leaves revocation to the detector, retries, releases the gate', async () => {
    const h = harness();
    signInOffline(h.sessions);
    h.fake.setReconcile({ kind: 'device_unauthorized' });
    await advance(0);
    expect(h.fake.invalidated).toEqual([{ reason: 'device_unauthorized' }]);
    expect(h.conflicts).toEqual([]);
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(false);
    await advance(RECONCILE_RETRY_MS);
    expect(h.fake.reconcileCalls).toHaveLength(2);
  });

  it('a definite rejection (400 or a malformed answer) is logged, releases the gate and is not hammered', async () => {
    const h = harness();
    signInOffline(h.sessions);
    h.fake.setReconcile({ kind: 'rejected' });
    await advance(0);
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(false);
    expect(h.conflicts).toEqual([]);
    expect(h.sessions.getCurrent()?.authority).toBe('offline_grant');
    await advance(RECONCILE_RETRY_MS * 5);
    expect(h.fake.reconcileCalls).toHaveLength(1);
    expect(JSON.stringify(h.logs)).toContain('rejected');
  });

  it('an idempotency_conflict (409) is a definite answer too: no retry loop', async () => {
    const h = harness();
    signInOffline(h.sessions);
    h.fake.setReconcile({ kind: 'idempotency_conflict' });
    await advance(RECONCILE_RETRY_MS * 5);
    expect(h.fake.reconcileCalls).toHaveLength(1);
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(false);
  });
});

describe('unreachable (offline again, mid-reconcile)', () => {
  it('keeps the session offline, holds the sales, and retries every 60 s until admitted', async () => {
    const h = harness();
    signInOffline(h.sessions);
    h.fake.setReconcile(NO_CONNECTION);
    await advance(0);
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(true);
    await advance(RECONCILE_RETRY_MS);
    await advance(RECONCILE_RETRY_MS);
    expect(h.fake.reconcileCalls).toHaveLength(3);
    expect(h.sessions.getCurrent()?.authority).toBe('offline_grant');
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(true);
    expect(h.fake.invalidated).toEqual([]);

    h.fake.setReconcile({ ...ADMITTED });
    await advance(RECONCILE_RETRY_MS);
    expect(h.fake.reconcileCalls).toHaveLength(4);
    expect(h.sessions.getCurrent()?.authority).toBe('online_confirmed');
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(false);
    // Every attempt used a fresh key.
    const keys = h.fake.reconcileCalls.map((c) => c.idempotency_key);
    expect(new Set(keys).size).toBe(4);
  });

  it('a request that fails while in flight (went offline again) is retried, not adopted', async () => {
    const h = harness();
    signInOffline(h.sessions);
    let release: (r: CashierAdmissionResult) => void = () => undefined;
    h.fake.setReconcile(() => new Promise<CashierAdmissionResult>((r) => (release = r)));
    await advance(0);
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(true);
    release(NO_CONNECTION);
    await advance(0);
    expect(h.sessions.getCurrent()?.authority).toBe('offline_grant');
    h.fake.setReconcile({ ...ADMITTED });
    await advance(RECONCILE_RETRY_MS);
    expect(h.sessions.getCurrent()?.authority).toBe('online_confirmed');
  });

  it('a 5xx keeps the gate for a bounded number of attempts, then releases it but keeps retrying', async () => {
    const h = harness();
    signInOffline(h.sessions);
    h.fake.setReconcile({ kind: 'unavailable' });
    await advance(0);
    for (let i = 1; i < RECONCILE_GATE_MAX_SERVER_ERRORS; i += 1) {
      expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(true);
      await advance(RECONCILE_RETRY_MS);
    }
    expect(h.fake.reconcileCalls).toHaveLength(RECONCILE_GATE_MAX_SERVER_ERRORS);
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(false);
    await advance(RECONCILE_RETRY_MS);
    expect(h.fake.reconcileCalls).toHaveLength(RECONCILE_GATE_MAX_SERVER_ERRORS + 1);
  });

  it('a transport failure never counts toward the gate bound (the drain cannot send either)', async () => {
    const h = harness();
    signInOffline(h.sessions);
    h.fake.setReconcile(NO_CONNECTION);
    await advance(RECONCILE_RETRY_MS * (RECONCILE_GATE_MAX_SERVER_ERRORS + 3));
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(true);
  });
});

describe('the sales gate', () => {
  it('holds only the reconciling cashier’s sales', async () => {
    const h = harness();
    signInOffline(h.sessions);
    h.fake.setReconcile(NO_CONNECTION);
    await advance(0);
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(true);
    expect(h.reconciler.isSaleHeld(OTHER_USER_ID)).toBe(false);
  });

  it('a drain asking for a held cashier nudges a reconcile (reconnect), at most once per nudge interval', async () => {
    const h = harness();
    signInOffline(h.sessions);
    h.fake.setReconcile(NO_CONNECTION);
    await advance(0);
    expect(h.fake.reconcileCalls).toHaveLength(1);
    await advance(RECONCILE_NUDGE_MIN_MS - 1_000);
    h.reconciler.isSaleHeld(FAKE_USER_ID);
    await advance(0);
    expect(h.fake.reconcileCalls).toHaveLength(1); // too soon
    await advance(1_000);
    h.reconciler.isSaleHeld(FAKE_USER_ID);
    await advance(0);
    expect(h.fake.reconcileCalls).toHaveLength(2); // reconnect: do not wait for the 60 s tick
    // The nudge restarted the 60 s cadence: no extra attempt at the old tick.
    h.fake.setReconcile({ ...ADMITTED });
    await advance(RECONCILE_RETRY_MS - 1);
    expect(h.fake.reconcileCalls).toHaveLength(2);
    await advance(1);
    expect(h.fake.reconcileCalls).toHaveLength(3);
  });

  it('a drain polling every 5 s does not speed up a server that answers 5xx: one attempt per 60 s, gate open after the fifth', async () => {
    const h = harness();
    signInOffline(h.sessions);
    h.fake.setReconcile({ kind: 'unavailable' });
    await advance(0);
    const polled: boolean[] = [];
    for (let t = 5; t <= 240; t += 5) {
      await advance(5_000);
      polled.push(h.reconciler.isSaleHeld(FAKE_USER_ID));
    }
    expect(h.fake.reconcileCalls).toHaveLength(RECONCILE_GATE_MAX_SERVER_ERRORS);
    // Held through the fourth answer (t = 180 s), open once the fifth lands (t = 240 s).
    expect(polled.slice(0, -1).every(Boolean)).toBe(true);
    expect(polled.at(-1)).toBe(false);
  });

  it('a drain polling while the till is unreachable DOES bring a reconnect forward', async () => {
    const h = harness();
    signInOffline(h.sessions);
    h.fake.setReconcile(NO_CONNECTION);
    await advance(0);
    h.fake.setReconcile({ ...ADMITTED }); // the network is back
    await advance(RECONCILE_NUDGE_MIN_MS);
    h.reconciler.isSaleHeld(FAKE_USER_ID);
    await advance(0);
    expect(h.fake.reconcileCalls).toHaveLength(2);
    expect(h.sessions.getCurrent()?.authority).toBe('online_confirmed');
  });

  it('never runs two requests at once (single flight)', async () => {
    const h = harness();
    signInOffline(h.sessions);
    h.fake.setReconcile(() => new Promise<CashierAdmissionResult>(() => undefined));
    await advance(0);
    await advance(RECONCILE_NUDGE_MIN_MS + 1);
    h.reconciler.isSaleHeld(FAKE_USER_ID);
    await advance(RECONCILE_RETRY_MS * 3);
    expect(h.fake.reconcileCalls).toHaveLength(1);
  });
});

describe('the session goes away', () => {
  it('a sign-out before the answer cancels the retry timer', async () => {
    const h = harness();
    signInOffline(h.sessions);
    h.fake.setReconcile(NO_CONNECTION);
    await advance(0);
    h.sessions.end('signed_out');
    await advance(RECONCILE_RETRY_MS * 3);
    expect(h.fake.reconcileCalls).toHaveLength(1);
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(false);
  });

  it('an admitted answer for a session that ended meanwhile is released (end echoes its generation), never adopted', async () => {
    const h = harness();
    signInOffline(h.sessions);
    let release: (r: CashierAdmissionResult) => void = () => undefined;
    h.fake.setReconcile(() => new Promise<CashierAdmissionResult>((r) => (release = r)));
    await advance(0);
    h.sessions.end('signed_out');
    release({
      ...ADMITTED,
      admission_id: ADMITTED.admission_id,
      admission_generation: 'gen-rec-9',
    });
    await advance(0);
    expect(h.fake.endRequests).toEqual([
      { admission_id: ADMITTED.admission_id, admission_generation: 'gen-rec-9' },
    ]);
    expect(h.adopted).toEqual([]);
    expect(h.sessions.getCurrent()).toBeNull();
  });

  it('a conflict answer for a session that ended meanwhile still invalidates the grant (fail closed) but latches nothing', async () => {
    const h = harness();
    signInOffline(h.sessions);
    let release: (r: CashierAdmissionResult) => void = () => undefined;
    h.fake.setReconcile(() => new Promise<CashierAdmissionResult>((r) => (release = r)));
    await advance(0);
    h.sessions.end('signed_out');
    release({ kind: 'active_elsewhere' });
    await advance(0);
    expect(h.fake.invalidated).toEqual([{ reason: 'active_elsewhere', user_id: FAKE_USER_ID }]);
    expect(h.conflicts).toEqual([]);
  });

  it('a different session that replaced it is not adopted with the first one’s admission', async () => {
    const h = harness();
    let release: (r: CashierAdmissionResult) => void = () => undefined;
    let calls = 0;
    h.fake.setReconcile(() =>
      ++calls === 1
        ? new Promise<CashierAdmissionResult>((r) => (release = r))
        : Promise.resolve(NO_CONNECTION),
    );
    signInOffline(h.sessions);
    await advance(0);
    const second = signInOffline(h.sessions); // replaced without an end
    release({ ...ADMITTED });
    await advance(0);
    expect(h.sessions.getCurrent()?.id).toBe(second.id);
    expect(h.sessions.getCurrent()?.authority).toBe('offline_grant');
    expect(h.fake.endRequests).toHaveLength(1);
  });

  it('an answer that arrives after the pairing changed is released, not adopted', async () => {
    const sessions = new SessionManager();
    const fake = fakeCashierAdmission();
    let pairing = 1;
    fake.deps.grantSeam = {
      onCashierAdmitted: () => undefined,
      onCashierAdmissionInvalidated: () => undefined,
      pairingGeneration: () => pairing,
    };
    const adopted: string[] = [];
    const reconciler = new OfflineReconciler({
      sessionManager: sessions,
      admission: fake.deps,
      onAdopted: (id) => adopted.push(id),
      onConflict: () => undefined,
    });
    sessions.onStarted((r) => {
      reconciler.onSessionStarted(r);
    });
    let release: (r: CashierAdmissionResult) => void = () => undefined;
    fake.setReconcile(() => new Promise<CashierAdmissionResult>((r) => (release = r)));
    signInOffline(sessions);
    await advance(0);
    pairing = 2;
    release({ ...ADMITTED });
    await advance(0);
    expect(adopted).toEqual([]);
    expect(sessions.getCurrent()?.authority).toBe('offline_grant');
    expect(fake.endRequests).toHaveLength(1);
  });

  it('a late admitted for the id a NEW live session holds is not ended (that would end the live admission); the keeper is asked to verify early', async () => {
    const h = harness();
    let release: (r: CashierAdmissionResult) => void = () => undefined;
    h.fake.setReconcile(() => new Promise<CashierAdmissionResult>((r) => (release = r)));
    signInOffline(h.sessions);
    await advance(0);
    h.sessions.end('signed_out');
    signInOnline(h.sessions); // same user, same device: the server hands back the SAME admission id
    release({ ...ADMITTED, admission_generation: 'gen-rec-late' });
    await advance(0);
    expect(h.fake.endRequests).toEqual([]);
    expect(h.renewed).toEqual([ADMITTED.admission_id]);
    expect(h.sessions.getCurrent()?.authority).toBe('online_confirmed');
  });

  it('a pairing change while a request is in flight does not stop a transient failure from being retried on the live session', async () => {
    const sessions = new SessionManager();
    const fake = fakeCashierAdmission();
    let pairing = 1;
    fake.deps.grantSeam = {
      onCashierAdmitted: () => undefined,
      onCashierAdmissionInvalidated: () => undefined,
      pairingGeneration: () => pairing,
    };
    const adopted: string[] = [];
    const reconciler = new OfflineReconciler({
      sessionManager: sessions,
      admission: fake.deps,
      onAdopted: (id) => adopted.push(id),
      onConflict: () => undefined,
      onLiveAdmissionRenewed: () => undefined,
    });
    sessions.onStarted((r) => {
      reconciler.onSessionStarted(r);
    });
    let release: (r: CashierAdmissionResult) => void = () => undefined;
    fake.setReconcile(() => new Promise<CashierAdmissionResult>((r) => (release = r)));
    signInOffline(sessions);
    await advance(0);
    pairing = 2;
    release(NO_CONNECTION);
    await advance(0);
    expect(reconciler.isSaleHeld(FAKE_USER_ID)).toBe(true);
    fake.setReconcile({ ...ADMITTED });
    await advance(RECONCILE_RETRY_MS);
    expect(adopted).toHaveLength(1);
    expect(sessions.getCurrent()?.authority).toBe('online_confirmed');
  });
});

describe('shutdown latch', () => {
  it('stop() cancels the timer and an in-flight answer changes nothing', async () => {
    const h = harness();
    signInOffline(h.sessions);
    let release: (r: CashierAdmissionResult) => void = () => undefined;
    h.fake.setReconcile(() => new Promise<CashierAdmissionResult>((r) => (release = r)));
    await advance(0);
    h.reconciler.stop();
    release({ ...ADMITTED });
    await advance(RECONCILE_RETRY_MS * 3);
    expect(h.fake.reconcileCalls).toHaveLength(1);
    expect(h.sessions.getCurrent()?.authority).toBe('offline_grant');
    expect(h.adopted).toEqual([]);
    expect(h.fake.endRequests).toEqual([]);
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(false);
  });
});

describe('logging', () => {
  it('logs the outcome kind only: no user id, admission id, key, name or generation', async () => {
    const h = harness();
    signInOffline(h.sessions);
    await advance(0);
    const text = JSON.stringify(h.logs);
    expect(text).toContain('admitted');
    for (const secret of [
      FAKE_USER_ID,
      ADMITTED.admission_id,
      'test-idempotency-key',
      'Mona',
      FAKE_GENERATION,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
