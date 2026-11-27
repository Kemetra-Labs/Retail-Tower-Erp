import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import { AUDIT_ACTION_CATEGORIES } from '../../../../src/shared/audit/event-shape.js';
import { isCentralAuditCategory } from '../../../../src/main/audit/central-audit-categories.js';
import { CashierAdmissionKeeper } from '../../../../src/main/operator/cashier-admission-keeper.js';
import type { CashierAdmissionResult } from '../../../../src/main/operator/cashier-admission-client.js';
import { authorityClockOf, newSaleBlock } from '../../../../src/main/operator/offline-authority.js';
import {
  OfflineReconciler,
  RECONCILE_GATE_MAX_SERVER_ERRORS,
  RECONCILE_RETRY_MS,
} from '../../../../src/main/operator/offline-reconcile.js';
import {
  OFFLINE_RECONCILED_CATEGORY,
  OFFLINE_RECONCILE_FAILED_CATEGORY,
  createOfflineReconcileAudit,
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
 * RT-309 (RT-113 10763 D8, §3) — the offline reconcile's durable, main-owned
 * audit:
 *  - `admitted`: one `operator.session.offline_reconciled` record per
 *    conversion, durable BEFORE the session becomes online-confirmed. If it
 *    cannot be written the session keeps its offline bound and the admission is
 *    released (Codex review, #928);
 *  - an `admitted` whose request raced a grant invalidation is never adopted;
 *  - a definite answer that cannot establish authority (400 / malformed 200,
 *    409) blocks NEW sales and is audited as
 *    `operator.session.offline_reconcile_failed`.
 * Payloads carry no grant field, admission id, user id, PIN or secret.
 */

const TERMINAL_ID = 'term-1';
const OPERATOR_ID = 'user_clerk_1';

interface Harness {
  sessions: SessionManager;
  fake: ReturnType<typeof fakeCashierAdmission>;
  reconciler: OfflineReconciler;
  /** The durable store: one row per event id (`INSERT OR IGNORE`). */
  stored: Map<string, AuditEvent>;
  events: () => AuditEvent[];
  adopted: string[];
  warns: unknown[];
  pairing: { generation: number };
  invalidation: { seq: number };
}

interface HarnessOptions {
  /** The first N writes fail before storing anything. */
  failWrites?: number;
  /** The first N writes store the row and then throw (written, reported failed). */
  failAfterWrite?: number;
  terminalId?: string | null;
}

function harness(opts: HarnessOptions = {}): Harness {
  const sessions = new SessionManager();
  const fake = fakeCashierAdmission();
  const pairing = { generation: 1 };
  const invalidation = { seq: 0 };
  fake.deps.grantSeam = {
    onCashierAdmitted: (e) => fake.admitted.push(e),
    onCashierAdmissionInvalidated: (e) => fake.invalidated.push(e),
    pairingGeneration: () => pairing.generation,
    invalidationSeq: () => invalidation.seq,
  };
  const stored = new Map<string, AuditEvent>();
  const adopted: string[] = [];
  const warns: unknown[] = [];
  let failBefore = opts.failWrites ?? 0;
  let failAfter = opts.failAfterWrite ?? 0;
  const audit = createOfflineReconcileAudit({
    audit: {
      emit: (e) => {
        if (failBefore > 0) {
          failBefore -= 1;
          throw new Error('disk full');
        }
        if (!stored.has(e.event_id)) stored.set(e.event_id, e);
        if (failAfter > 0) {
          failAfter -= 1;
          throw new Error('lost acknowledgement');
        }
      },
    },
    resolveTerminalId: () => (opts.terminalId === undefined ? TERMINAL_ID : opts.terminalId),
    now: () => new Date('2026-11-27T10:00:00.000Z'),
    logger: { warn: (...a: unknown[]) => warns.push(a) },
  });
  const reconciler = new OfflineReconciler({
    sessionManager: sessions,
    admission: fake.deps,
    onAdopted: (id) => adopted.push(id),
    onConflict: () => undefined,
    onLiveAdmissionRenewed: () => undefined,
    audit,
  });
  sessions.onStarted((r) => {
    reconciler.onSessionStarted(r);
  });
  sessions.onEnded((r) => {
    reconciler.onSessionEnded(r);
  });
  return {
    sessions,
    fake,
    reconciler,
    stored,
    events: () => [...stored.values()],
    adopted,
    warns,
    pairing,
    invalidation,
  };
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

function reconciledEvents(h: Harness): AuditEvent[] {
  return h.events().filter((e) => e.action_category === OFFLINE_RECONCILED_CATEGORY);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the categories', () => {
  it.each([OFFLINE_RECONCILED_CATEGORY, OFFLINE_RECONCILE_FAILED_CATEGORY])(
    '%s is registered and stays POS-local (not uploaded to central audit)',
    (category) => {
      expect(AUDIT_ACTION_CATEGORIES).toContain(category);
      expect(isCentralAuditCategory(category)).toBe(false);
    },
  );

  it('have the planned names', () => {
    expect(OFFLINE_RECONCILED_CATEGORY).toBe('operator.session.offline_reconciled');
    expect(OFFLINE_RECONCILE_FAILED_CATEGORY).toBe('operator.session.offline_reconcile_failed');
  });
});

describe('admitted: one durable record per conversion, before the upgrade', () => {
  it('writes one event attributed to the session, its operator and this terminal, with an empty payload', async () => {
    const h = harness();
    const record = signInOffline(h.sessions);
    await advance(0);
    expect(h.sessions.getCurrent()?.authority).toBe('online_confirmed');
    expect(h.events()).toEqual([
      {
        event_id: expect.any(String) as string,
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

  it('the record is durable before the session is online-confirmed', async () => {
    const h = harness();
    let authorityAtWrite: string | undefined;
    const sessions = h.sessions;
    const original = h.stored.set.bind(h.stored);
    h.stored.set = (k, v) => {
      authorityAtWrite = sessions.getCurrent()?.authority;
      return original(k, v);
    };
    signInOffline(sessions);
    await advance(0);
    expect(authorityAtWrite).toBe('offline_grant');
    expect(sessions.getCurrent()?.authority).toBe('online_confirmed');
  });

  it('the event carries no admission id, generation, user id, display name or key', async () => {
    const h = harness();
    signInOffline(h.sessions);
    await advance(0);
    const text = JSON.stringify(h.events());
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

  it('is written after a retry too, once, and never again for later ticks or a nudge', async () => {
    const h = harness();
    h.fake.setReconcile({ kind: 'no_connection' });
    signInOffline(h.sessions);
    await advance(0);
    await advance(RECONCILE_RETRY_MS);
    expect(h.events()).toEqual([]);
    h.fake.setReconcile({ ...ADMITTED });
    await advance(RECONCILE_RETRY_MS);
    h.reconciler.isSaleHeld(FAKE_USER_ID);
    await advance(RECONCILE_RETRY_MS * 5);
    expect(reconciledEvents(h)).toHaveLength(1);
  });
});

describe('the record cannot be written: no upgrade without it (fail closed)', () => {
  it('first insert fails: the session keeps its offline bound, the admission is released, then exactly one record once it is durable', async () => {
    const h = harness({ failWrites: 1 });
    const record = signInOffline(h.sessions);
    await advance(0);
    expect(h.sessions.getCurrent()?.authority).toBe('offline_grant');
    expect(h.sessions.getCurrent()?.admission_id).toBeUndefined();
    expect(h.adopted).toEqual([]);
    expect(h.fake.endRequests).toEqual([
      { admission_id: ADMITTED.admission_id, admission_generation: ADMITTED.admission_generation },
    ]);
    // The grant is not refreshed from an answer that was not adopted.
    expect(h.fake.admitted).toEqual([]);
    expect(reconciledEvents(h)).toEqual([]);
    expect(JSON.stringify(h.warns)).toContain('operator.session.offline_reconciled.audit_failed');

    await advance(RECONCILE_RETRY_MS);
    expect(h.sessions.getCurrent()?.authority).toBe('online_confirmed');
    expect(h.adopted).toEqual([record.id]);
    expect(reconciledEvents(h)).toHaveLength(1);
  });

  it('a write that landed but reported failure is not duplicated by the retry (stable event id)', async () => {
    const h = harness({ failAfterWrite: 1 });
    signInOffline(h.sessions);
    await advance(0);
    expect(h.sessions.getCurrent()?.authority).toBe('offline_grant');
    await advance(RECONCILE_RETRY_MS);
    expect(h.sessions.getCurrent()?.authority).toBe('online_confirmed');
    expect(reconciledEvents(h)).toHaveLength(1);
  });

  it('an unknown terminal id never upgrades the session', async () => {
    const h = harness({ terminalId: null });
    signInOffline(h.sessions);
    await advance(0);
    await advance(RECONCILE_RETRY_MS * 3);
    expect(h.sessions.getCurrent()?.authority).toBe('offline_grant');
    expect(h.adopted).toEqual([]);
    expect(h.events()).toEqual([]);
  });

  it('repeated write failures release the sales gate after the bounded count (a sale is never stranded)', async () => {
    const h = harness({ failWrites: 100 });
    signInOffline(h.sessions);
    await advance(0);
    for (let i = 1; i < RECONCILE_GATE_MAX_SERVER_ERRORS; i += 1) {
      expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(true);
      await advance(RECONCILE_RETRY_MS);
    }
    expect(h.reconciler.isSaleHeld(FAKE_USER_ID)).toBe(false);
    expect(h.sessions.getCurrent()?.authority).toBe('offline_grant');
  });
});

describe('an admitted that raced a grant invalidation is never adopted', () => {
  it('a device 401 lands while the reconcile is in flight: released (end echoes its generation), retried, adopted later', async () => {
    const h = harness();
    const record = signInOffline(h.sessions);
    const release = deferred(h);
    await advance(0);
    h.invalidation.seq += 1; // the grant seam invalidated grants meanwhile
    release({ ...ADMITTED, admission_generation: 'gen-race' });
    await advance(0);
    expect(h.sessions.getCurrent()?.authority).toBe('offline_grant');
    expect(h.adopted).toEqual([]);
    expect(h.fake.admitted).toEqual([]);
    expect(h.fake.endRequests).toEqual([
      { admission_id: ADMITTED.admission_id, admission_generation: 'gen-race' },
    ]);
    expect(h.events()).toEqual([]);
    h.fake.setReconcile({ ...ADMITTED });
    await advance(RECONCILE_RETRY_MS);
    expect(h.adopted).toEqual([record.id]);
  });
});

describe('a definite answer that cannot establish authority blocks NEW sales and is audited', () => {
  it.each(['rejected', 'idempotency_conflict'] as const)(
    '%s with a still-valid grant: no new sale, the session keeps running, one failure record',
    async (kind) => {
      const h = harness();
      const record = signInOffline(h.sessions);
      expect(newSaleBlock(record, authorityClockOf())).toBeNull();
      h.fake.setReconcile({ kind });
      await advance(0);
      expect(newSaleBlock(record, authorityClockOf())).toBe('offline_authority_expired');
      expect(h.sessions.getCurrent()?.id).toBe(record.id);
      expect(h.sessions.getCurrent()?.authority_latch).toBeUndefined();
      expect(h.sessions.getCurrent()?.lock_state).toBe('active');
      expect(h.events().map((e) => [e.action_category, e.payload])).toEqual([
        [OFFLINE_RECONCILE_FAILED_CATEGORY, { outcome: kind }],
      ]);
      await advance(RECONCILE_RETRY_MS * 5);
      expect(h.fake.reconcileCalls).toHaveLength(1);
      expect(h.events()).toHaveLength(1);
    },
  );

  it('the block applies even when its audit cannot be written', async () => {
    const h = harness({ failWrites: 1 });
    const record = signInOffline(h.sessions);
    h.fake.setReconcile({ kind: 'rejected' });
    await advance(0);
    expect(newSaleBlock(record, authorityClockOf())).toBe('offline_authority_expired');
    expect(JSON.stringify(h.warns)).toContain(
      'operator.session.offline_reconcile_failed.audit_failed',
    );
  });
});

describe('no record without a decision', () => {
  it.each<CashierAdmissionResult>([
    { kind: 'active_elsewhere' },
    { kind: 'refused' },
    { kind: 'device_unauthorized' },
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
    expect(h.events()).toEqual([]);
  });

  it('an admitted for a session that ended before the answer (stale) writes nothing', async () => {
    const h = harness();
    signInOffline(h.sessions);
    const release = deferred(h);
    await advance(0);
    h.sessions.end('signed_out');
    release({ ...ADMITTED });
    await advance(0);
    expect(h.events()).toEqual([]);
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
    expect(h.events()).toEqual([]);
  });

  it('an admitted that arrives after a re-pair writes nothing', async () => {
    const h = harness();
    signInOffline(h.sessions);
    const release = deferred(h);
    await advance(0);
    h.pairing.generation = 2;
    release({ ...ADMITTED });
    await advance(0);
    expect(h.events()).toEqual([]);
  });

  it('an admitted after stop() (shutdown latch) writes nothing', async () => {
    const h = harness();
    signInOffline(h.sessions);
    const release = deferred(h);
    await advance(0);
    h.reconciler.stop();
    release({ ...ADMITTED });
    await advance(0);
    expect(h.events()).toEqual([]);
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
    expect(h.events()).toEqual([]);
  });
});

describe('the keeper wires the hooks', () => {
  it('passes offlineReconcileAudit to its reconciler', async () => {
    const sessions = new SessionManager();
    const fake = fakeCashierAdmission();
    const seen: Array<[string, string]> = [];
    const keeper = new CashierAdmissionKeeper({
      sessionManager: sessions,
      admission: fake.deps,
      isAtSafePoint: () => true,
      offlineReconcileAudit: {
        reconciled: (record, event_id) => {
          seen.push([record.id, event_id]);
          return true;
        },
        failed: () => undefined,
      },
    });
    const record = signInOffline(sessions);
    await advance(0);
    expect(seen.map(([id]) => id)).toEqual([record.id]);
    expect(sessions.getCurrent()?.authority).toBe('online_confirmed');
    keeper.stop();
  });
});
