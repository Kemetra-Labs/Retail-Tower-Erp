import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import { AUDIT_ACTION_CATEGORIES } from '../../../../src/shared/audit/event-shape.js';
import { isCentralAuditCategory } from '../../../../src/main/audit/central-audit-categories.js';
import { CashierAdmissionKeeper } from '../../../../src/main/operator/cashier-admission-keeper.js';
import type { CashierAdmissionResult } from '../../../../src/main/operator/cashier-admission-client.js';
import {
  OfflineReconciler,
  RECONCILE_RETRY_MS,
} from '../../../../src/main/operator/offline-reconcile.js';
import {
  OFFLINE_RECONCILED_CATEGORY,
  createOfflineReconciledAudit,
} from '../../../../src/main/operator/offline-reconcile-audit.js';
import {
  SessionManager,
  type OperatorSessionRecord,
} from '../../../../src/main/operator/session-manager.js';
import {
  ADMITTED,
  FAKE_ADMISSION_ID,
  FAKE_GENERATION,
  FAKE_USER_ID,
  fakeCashierAdmission,
} from '../../../../src/main/operator/__tests__/__helpers__/fake-cashier-admission.js';

/**
 * RT-309 (RT-113 10763 D8, §3) — when the reconnect reconcile answers
 * `admitted` and the offline-admitted session becomes online-confirmed, main
 * writes exactly one `operator.session.offline_reconciled` audit event. The
 * event is main-owned and its payload is empty: no grant field, admission id,
 * user id, PIN or secret.
 */

const TERMINAL_ID = 'term-1';
const OPERATOR_ID = 'user_clerk_1';

interface Harness {
  sessions: SessionManager;
  fake: ReturnType<typeof fakeCashierAdmission>;
  reconciler: OfflineReconciler;
  events: AuditEvent[];
  adopted: string[];
  pairing: { generation: number };
}

function harness(opts: { auditThrows?: boolean; terminalId?: string | null } = {}): Harness {
  const sessions = new SessionManager();
  const fake = fakeCashierAdmission();
  const pairing = { generation: 1 };
  fake.deps.grantSeam = {
    onCashierAdmitted: (e) => fake.admitted.push(e),
    onCashierAdmissionInvalidated: (e) => fake.invalidated.push(e),
    pairingGeneration: () => pairing.generation,
  };
  const events: AuditEvent[] = [];
  const adopted: string[] = [];
  let n = 0;
  const onReconciled = createOfflineReconciledAudit({
    audit: {
      emit: (e) => {
        if (opts.auditThrows === true) throw new Error('disk full');
        events.push(e);
      },
    },
    resolveTerminalId: () => (opts.terminalId === undefined ? TERMINAL_ID : opts.terminalId),
    uuid: () => `evt-${String((n += 1))}`,
    now: () => new Date('2026-11-27T10:00:00.000Z'),
  });
  const reconciler = new OfflineReconciler({
    sessionManager: sessions,
    admission: fake.deps,
    onAdopted: (id) => adopted.push(id),
    onConflict: () => undefined,
    onLiveAdmissionRenewed: () => undefined,
    onReconciled,
  });
  sessions.onStarted((r) => {
    reconciler.onSessionStarted(r);
  });
  sessions.onEnded((r) => {
    reconciler.onSessionEnded(r);
  });
  return { sessions, fake, reconciler, events, adopted, pairing };
}

function signInOffline(sessions: SessionManager): OperatorSessionRecord {
  return sessions.create({
    operator_id: OPERATOR_ID,
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

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function deferred(h: Harness): (r: CashierAdmissionResult) => void {
  let release: (r: CashierAdmissionResult) => void = () => undefined;
  h.fake.setReconcile(() => new Promise<CashierAdmissionResult>((r) => (release = r)));
  return (r) => {
    release(r);
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the category', () => {
  it('is registered, and stays POS-local (not uploaded to central audit)', () => {
    expect(OFFLINE_RECONCILED_CATEGORY).toBe('operator.session.offline_reconciled');
    expect(AUDIT_ACTION_CATEGORIES).toContain(OFFLINE_RECONCILED_CATEGORY);
    expect(isCentralAuditCategory(OFFLINE_RECONCILED_CATEGORY)).toBe(false);
  });
});

describe('admitted: exactly one event per conversion', () => {
  it('writes one event attributed to the session, its operator and this terminal, with an empty payload', async () => {
    const h = harness();
    const record = signInOffline(h.sessions);
    await advance(0);
    expect(h.sessions.getCurrent()?.authority).toBe('online_confirmed');
    expect(h.events).toEqual([
      {
        event_id: 'evt-1',
        tenant_id: 't1',
        branch_id: 'b1',
        originating_terminal_id: TERMINAL_ID,
        acting_operator_id: OPERATOR_ID,
        session_id: record.id,
        shift_id: null,
        action_category: 'operator.session.offline_reconciled',
        created_at: '2026-11-27T10:00:00.000Z',
        approving_supervisor_id: null,
        payload: {},
      },
    ]);
  });

  it('the event carries no admission id, generation, user id, display name or key', async () => {
    const h = harness();
    signInOffline(h.sessions);
    await advance(0);
    const text = JSON.stringify(h.events);
    for (const secret of [
      FAKE_ADMISSION_ID,
      FAKE_GENERATION,
      FAKE_USER_ID,
      'Mona',
      ADMITTED.display_name,
      'idempotency',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('is written after a retry too, once, and never again for later ticks', async () => {
    const h = harness();
    h.fake.setReconcile({ kind: 'no_connection' });
    signInOffline(h.sessions);
    await advance(0);
    await advance(RECONCILE_RETRY_MS);
    expect(h.events).toEqual([]);
    h.fake.setReconcile({ ...ADMITTED });
    await advance(RECONCILE_RETRY_MS);
    await advance(RECONCILE_RETRY_MS * 5);
    expect(h.events).toHaveLength(1);
  });

  it('a drain nudge after the answer does not duplicate it (replay)', async () => {
    const h = harness();
    signInOffline(h.sessions);
    await advance(0);
    h.reconciler.isSaleHeld(FAKE_USER_ID);
    await advance(RECONCILE_RETRY_MS * 2);
    expect(h.fake.reconcileCalls).toHaveLength(1);
    expect(h.events).toHaveLength(1);
  });

  it('an audit write that throws still adopts the session (the audit never changes the outcome)', async () => {
    const h = harness({ auditThrows: true });
    const record = signInOffline(h.sessions);
    await advance(0);
    expect(h.sessions.getCurrent()?.authority).toBe('online_confirmed');
    expect(h.adopted).toEqual([record.id]);
  });

  it('an unknown terminal id writes nothing but still adopts', async () => {
    const h = harness({ terminalId: null });
    const record = signInOffline(h.sessions);
    await advance(0);
    expect(h.events).toEqual([]);
    expect(h.adopted).toEqual([record.id]);
  });
});

describe('no event without a conversion', () => {
  it.each<CashierAdmissionResult>([
    { kind: 'active_elsewhere' },
    { kind: 'refused' },
    { kind: 'device_unauthorized' },
    { kind: 'rejected' },
    { kind: 'idempotency_conflict' },
    { kind: 'no_connection' },
    { kind: 'no_token' },
    { kind: 'unavailable' },
    { kind: 'rate_limited' },
  ] as CashierAdmissionResult[])('$kind writes nothing', async (answer) => {
    const h = harness();
    h.fake.setReconcile(answer);
    signInOffline(h.sessions);
    await advance(0);
    await advance(RECONCILE_RETRY_MS);
    expect(h.events).toEqual([]);
  });

  it('an admitted for a session that ended before the answer (stale) writes nothing', async () => {
    const h = harness();
    signInOffline(h.sessions);
    const release = deferred(h);
    await advance(0);
    h.sessions.end('signed_out');
    release({ ...ADMITTED });
    await advance(0);
    expect(h.events).toEqual([]);
  });

  it('an admitted for a session that was replaced writes nothing', async () => {
    const h = harness();
    signInOffline(h.sessions);
    const release = deferred(h);
    await advance(0);
    h.fake.setReconcile({ kind: 'no_connection' });
    signInOffline(h.sessions);
    release({ ...ADMITTED });
    await advance(0);
    expect(h.events).toEqual([]);
  });

  it('an admitted that arrives after a re-pair writes nothing', async () => {
    const h = harness();
    signInOffline(h.sessions);
    const release = deferred(h);
    await advance(0);
    h.pairing.generation = 2;
    release({ ...ADMITTED });
    await advance(0);
    expect(h.events).toEqual([]);
  });

  it('an admitted after stop() (shutdown latch) writes nothing', async () => {
    const h = harness();
    signInOffline(h.sessions);
    const release = deferred(h);
    await advance(0);
    h.reconciler.stop();
    release({ ...ADMITTED });
    await advance(0);
    expect(h.events).toEqual([]);
  });

  it('a session admitted online is never reconciled, so writes nothing', async () => {
    const h = harness();
    h.sessions.create({
      operator_id: OPERATOR_ID,
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
    await advance(RECONCILE_RETRY_MS);
    expect(h.events).toEqual([]);
  });
});

describe('the keeper wires the hook', () => {
  it('passes onOfflineReconciled to its reconciler', async () => {
    const sessions = new SessionManager();
    const fake = fakeCashierAdmission();
    const seen: string[] = [];
    const keeper = new CashierAdmissionKeeper({
      sessionManager: sessions,
      admission: fake.deps,
      isAtSafePoint: () => true,
      onOfflineReconciled: (record) => seen.push(record.id),
    });
    const record = signInOffline(sessions);
    await advance(0);
    expect(seen).toEqual([record.id]);
    expect(sessions.getCurrent()?.authority).toBe('online_confirmed');
    keeper.stop();
  });
});
