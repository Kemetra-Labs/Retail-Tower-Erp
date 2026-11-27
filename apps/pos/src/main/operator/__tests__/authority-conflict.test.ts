import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { AuditEvent, OperatorRefusal } from '../../../shared/audit/event-shape.js';
import { AuthorityConflictResolver } from '../authority-conflict-resolver.js';
import { CashierAdmissionKeeper } from '../cashier-admission-keeper.js';
import { SessionManager, type OperatorSessionRecord } from '../session-manager.js';
import { wireSessionLockAudit } from '../session-lock-audit.js';
import { SessionUnlockHandler } from '../session-unlock-handler.js';
import {
  ADMITTED,
  FAKE_USER_ID,
  fakeCashierAdmission,
} from './__helpers__/fake-cashier-admission.js';

/**
 * RT-309 D9 (RT-113 planning record 10763 D9; owner approval RT-309 c19114) —
 * the reconcile `active_elsewhere` conflict locks the offline-admitted session
 * (`lock_cause: 'authority_conflict'`) instead of latching and ending it. The
 * same cashier resolves it, after a PIN check, with exactly one of two
 * actions: take over here (an online admission with `takeover: true`) or end
 * here (`superseded_by_takeover`). Everything fails closed: the ordinary
 * unlock never clears a conflict lock, and only a live `admitted` reopens the
 * session.
 */

const T_LOCK = '2026-11-27T10:00:00.000Z';
const NOW = new Date('2026-11-27T10:05:00.000Z');

function signInOffline(sessions: SessionManager): OperatorSessionRecord {
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

function conflictLocked(): { sessions: SessionManager; record: OperatorSessionRecord } {
  const sessions = new SessionManager();
  const record = signInOffline(sessions);
  sessions.lockForAuthorityConflict(record.id, T_LOCK);
  return { sessions, record };
}

describe('SessionManager conflict lock', () => {
  it('locks the session in place with lock_cause authority_conflict and notifies', () => {
    const sessions = new SessionManager();
    const record = signInOffline(sessions);
    const seen: Array<string | undefined> = [];
    sessions.onLockStateChanged((r) => seen.push(r.lock_cause));

    expect(sessions.lockForAuthorityConflict(record.id, T_LOCK)).toBe(true);

    const current = sessions.getCurrent();
    expect(current?.id).toBe(record.id);
    expect(current?.lock_state).toBe('locked');
    expect(current?.lock_cause).toBe('authority_conflict');
    expect(seen).toEqual(['authority_conflict']);
  });

  it('upgrades an inactivity lock to a conflict lock and notifies again', () => {
    const sessions = new SessionManager();
    const record = signInOffline(sessions);
    sessions.lock(T_LOCK);
    const seen: Array<string | undefined> = [];
    sessions.onLockStateChanged((r) => seen.push(r.lock_cause));

    sessions.lockForAuthorityConflict(record.id, '2026-11-27T10:01:00.000Z');

    expect(sessions.getCurrent()?.lock_cause).toBe('authority_conflict');
    expect(sessions.getCurrent()?.locked_at).toBe(T_LOCK);
    expect(seen).toEqual(['authority_conflict']);
  });

  it('an inactivity lock never overwrites a conflict lock', () => {
    const { sessions } = conflictLocked();
    sessions.lock('2026-11-27T10:09:00.000Z');
    expect(sessions.getCurrent()?.lock_cause).toBe('authority_conflict');
  });

  it('ignores a session id that is not the current one', () => {
    const sessions = new SessionManager();
    signInOffline(sessions);
    expect(sessions.lockForAuthorityConflict('other', T_LOCK)).toBe(false);
    expect(sessions.isLocked()).toBe(false);
  });

  it('a plain inactivity lock records lock_cause inactivity; unlock clears it', () => {
    const sessions = new SessionManager();
    signInOffline(sessions);
    sessions.lock(T_LOCK);
    expect(sessions.getCurrent()?.lock_cause).toBe('inactivity');
    sessions.unlock('2026-11-27T10:02:00.000Z');
    expect(sessions.getCurrent()?.lock_cause).toBeUndefined();
  });
});

describe('the lock audit records the cause', () => {
  it('operator.session.locked carries lock_cause authority_conflict', () => {
    const sessions = new SessionManager();
    const record = signInOffline(sessions);
    const events: AuditEvent[] = [];
    wireSessionLockAudit({
      sessionManager: sessions,
      auditEmitter: { emit: (e) => events.push(e) },
      resolveTerminalId: () => 'term-1',
      uuid: () => 'evt-1',
    });
    sessions.lockForAuthorityConflict(record.id, T_LOCK);
    expect(events.map((e) => [e.action_category, e.payload])).toEqual([
      ['operator.session.locked', { lock_cause: 'authority_conflict' }],
    ]);
  });
});

describe('the ordinary unlock never clears a conflict lock (fail closed)', () => {
  it('refuses state_invalid BEFORE the PIN is checked', async () => {
    const { sessions } = conflictLocked();
    const verifyCashierPin = vi.fn(() => Promise.resolve(null));
    const unlock = new SessionUnlockHandler({
      sessionManager: sessions,
      verifyCashierPin,
      clerk: { exchange: vi.fn() },
    });

    const res = await unlock.unlock({ method: 'pin', pin: '1234' });

    expect(res).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(verifyCashierPin).not.toHaveBeenCalled();
    expect(sessions.isLocked()).toBe(true);
  });
});

describe('a conflict that lands while an ordinary unlock checks the PIN', () => {
  it('is never cleared by that unlock (refused state_invalid, still conflict-locked)', async () => {
    const sessions = new SessionManager();
    const record = signInOffline(sessions);
    sessions.lock(T_LOCK);
    const unlock = new SessionUnlockHandler({
      sessionManager: sessions,
      verifyCashierPin: () => {
        sessions.lockForAuthorityConflict(record.id, '2026-11-27T10:01:00.000Z');
        return Promise.resolve(null);
      },
      clerk: { exchange: vi.fn() },
    });

    const res = await unlock.unlock({ method: 'pin', pin: '1234' });

    expect(res).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(sessions.getCurrent()?.lock_state).toBe('locked');
    expect(sessions.getCurrent()?.lock_cause).toBe('authority_conflict');
  });

  it('SessionManager.unlock itself refuses to clear a conflict lock without the resolver flag', () => {
    const { sessions } = conflictLocked();
    sessions.unlock('2026-11-27T10:02:00.000Z');
    expect(sessions.getCurrent()?.lock_cause).toBe('authority_conflict');
    sessions.unlock('2026-11-27T10:02:00.000Z', { resolvesAuthorityConflict: true });
    expect(sessions.isLocked()).toBe(false);
  });
});

describe('the keeper: a reconcile active_elsewhere locks, it does not end', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('locks authority_conflict, invalidates the grant, and never ends the session on its own', async () => {
    const sessions = new SessionManager();
    const fake = fakeCashierAdmission();
    fake.setReconcile({ kind: 'active_elsewhere' });
    const ends: Array<string | undefined> = [];
    sessions.onEnded((_r, cause) => ends.push(cause));
    new CashierAdmissionKeeper({
      sessionManager: sessions,
      admission: fake.deps,
      isAtSafePoint: () => true,
    });
    const record = signInOffline(sessions);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600_000);

    expect(fake.invalidated).toEqual([{ reason: 'active_elsewhere', user_id: FAKE_USER_ID }]);
    expect(sessions.getCurrent()?.id).toBe(record.id);
    expect(sessions.getCurrent()?.lock_cause).toBe('authority_conflict');
    expect(sessions.getCurrent()?.authority_latch).toBeUndefined();
    expect(ends).toEqual([]);
    expect(fake.reconcileCalls).toHaveLength(1);
  });

  it('a reconcile 403 still latches and ends account_disabled_mid_session (unchanged)', async () => {
    const sessions = new SessionManager();
    const fake = fakeCashierAdmission();
    fake.setReconcile({ kind: 'refused' });
    const ends: Array<string | undefined> = [];
    sessions.onEnded((_r, cause) => ends.push(cause));
    new CashierAdmissionKeeper({
      sessionManager: sessions,
      admission: fake.deps,
      isAtSafePoint: () => true,
    });
    signInOffline(sessions);
    await vi.advanceTimersByTimeAsync(0);
    expect(ends).toEqual(['account_disabled_mid_session']);
  });
});

interface ResolverHarness {
  sessions: SessionManager;
  record: OperatorSessionRecord;
  fake: ReturnType<typeof fakeCashierAdmission>;
  resolver: AuthorityConflictResolver;
  verifyCashierPin: Mock<(operator_id: string, pin: string) => Promise<OperatorRefusal | null>>;
  takenOver: string[];
  audits: AuditEvent[];
  ends: Array<string | undefined>;
}

function resolverHarness(
  pin: OperatorRefusal | null = null,
  over: { tillClockMs?: () => number; terminal?: string | null } = {},
): ResolverHarness {
  const { sessions, record } = conflictLocked();
  const fake = fakeCashierAdmission();
  const verifyCashierPin = vi.fn<
    (operator_id: string, pin: string) => Promise<OperatorRefusal | null>
  >(() => Promise.resolve(pin));
  const takenOver: string[] = [];
  const audits: AuditEvent[] = [];
  const ends: Array<string | undefined> = [];
  sessions.onEnded((_r, cause) => ends.push(cause));
  const resolver = new AuthorityConflictResolver({
    sessionManager: sessions,
    verifyCashierPin,
    admission: fake.deps,
    onTakenOver: (session_id) => takenOver.push(session_id),
    audit: { emit: (e) => audits.push(e) },
    resolveTerminalId: () => (over.terminal === undefined ? 'term-1' : over.terminal),
    uuid: () => 'evt-conflict',
    now: () => NOW,
    ...(over.tillClockMs === undefined ? {} : { tillClockMs: over.tillClockMs }),
  });
  return { sessions, record, fake, resolver, verifyCashierPin, takenOver, audits, ends };
}

describe('AuthorityConflictResolver — preconditions', () => {
  it('refuses when no session is current', async () => {
    const h = resolverHarness();
    h.sessions.end('signed_out');
    const res = await h.resolver.resolve({ action: 'end_here', pin: '1234' });
    expect(res).toEqual({ kind: 'refused', category: 'not_signed_in' });
  });

  it('refuses an inactivity lock (only a conflict lock is resolved here) without a PIN check', async () => {
    const sessions = new SessionManager();
    signInOffline(sessions);
    sessions.lock(T_LOCK);
    const fake = fakeCashierAdmission();
    const verifyCashierPin = vi.fn(() => Promise.resolve(null));
    const resolver = new AuthorityConflictResolver({
      sessionManager: sessions,
      verifyCashierPin,
      admission: fake.deps,
      onTakenOver: () => undefined,
      audit: { emit: () => undefined },
      resolveTerminalId: () => 'term-1',
    });
    const res = await resolver.resolve({ action: 'take_over_here', pin: '1234' });
    expect(res).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(verifyCashierPin).not.toHaveBeenCalled();
    expect(fake.admitCalls).toHaveLength(0);
  });

  it('a wrong PIN refuses with the PIN check category and changes nothing', async () => {
    const h = resolverHarness({ kind: 'refused', category: 'invalid_input' });
    const res = await h.resolver.resolve({ action: 'take_over_here', pin: '9999' });
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(h.verifyCashierPin).toHaveBeenCalledWith('user_clerk_1', '9999');
    expect(h.fake.admitCalls).toHaveLength(0);
    expect(h.sessions.getCurrent()?.lock_cause).toBe('authority_conflict');
    expect(h.ends).toEqual([]);
  });

  it('a PIN lockout stays the PIN lockout refusal (rate_limited), not the takeover 429', async () => {
    const h = resolverHarness({ kind: 'refused', category: 'rate_limited' });
    const res = await h.resolver.resolve({ action: 'end_here', pin: '1234' });
    expect(res).toEqual({ kind: 'refused', category: 'rate_limited' });
    expect(h.ends).toEqual([]);
  });

  it('one resolution at a time: a concurrent call is refused', async () => {
    const h = resolverHarness();
    let release: (v: null) => void = () => undefined;
    h.verifyCashierPin.mockImplementationOnce(
      () =>
        new Promise<null>((r) => {
          release = r;
        }),
    );
    const first = h.resolver.resolve({ action: 'end_here', pin: '1234' });
    const second = await h.resolver.resolve({ action: 'end_here', pin: '1234' });
    expect(second).toEqual({ kind: 'refused', category: 'rate_limited' });
    release(null);
    await first;
  });
});

describe('AuthorityConflictResolver — end here', () => {
  it('ends the session superseded_by_takeover and audits the decision', async () => {
    const h = resolverHarness();
    const res = await h.resolver.resolve({ action: 'end_here', pin: '1234' });
    expect(res).toEqual({ kind: 'resolved', action: 'end_here' });
    expect(h.ends).toEqual(['superseded_by_takeover']);
    expect(h.sessions.getCurrent()).toBeNull();
    expect(h.fake.admitCalls).toHaveLength(0);
    expect(h.audits).toEqual([
      {
        event_id: 'evt-conflict',
        tenant_id: 't1',
        branch_id: 'b1',
        originating_terminal_id: 'term-1',
        acting_operator_id: 'user_clerk_1',
        session_id: h.record.id,
        shift_id: null,
        action_category: 'operator.session.authority_conflict',
        created_at: NOW.toISOString(),
        approving_supervisor_id: null,
        payload: { resolution: 'end_here' },
      },
    ]);
  });

  it('does not end a session that changed while the PIN was checked', async () => {
    const h = resolverHarness();
    h.verifyCashierPin.mockImplementationOnce(() => {
      h.sessions.end('signed_out');
      signInOffline(h.sessions);
      return Promise.resolve(null);
    });
    const res = await h.resolver.resolve({ action: 'end_here', pin: '1234' });
    expect(res).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(h.ends).toEqual(['signed_out']);
  });
});

describe('AuthorityConflictResolver — take over here', () => {
  it('admits with takeover: true, confirms the SAME session online, unlocks and arms the keeper', async () => {
    const h = resolverHarness();
    const res = await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });

    expect(res).toEqual({ kind: 'resolved', action: 'take_over_here' });
    expect(h.fake.admitCalls).toHaveLength(1);
    expect(h.fake.admitCalls[0]).toMatchObject({
      mode: 'online',
      user_id: FAKE_USER_ID,
      takeover: true,
    });
    const current = h.sessions.getCurrent();
    expect(current?.id).toBe(h.record.id);
    expect(current?.authority).toBe('online_confirmed');
    expect(current?.admission_id).toBe(ADMITTED.admission_id);
    expect(current?.admission_generation).toBe(ADMITTED.admission_generation);
    expect(current?.authority_valid_until_ms).toBeUndefined();
    expect(current?.lock_state).toBe('active');
    expect(current?.lock_cause).toBeUndefined();
    expect(current?.authority_latch).toBeUndefined();
    expect(h.takenOver).toEqual([h.record.id]);
    expect(h.fake.admitted).toHaveLength(1); // the grant is refreshed
    expect(h.audits.map((e) => [e.action_category, e.payload])).toEqual([
      ['operator.session.authority_conflict', { resolution: 'take_over_here' }],
    ]);
    expect(h.ends).toEqual([]);
  });

  it('a server 429 stays locked and answers takeover_rate_limited (its own copy)', async () => {
    const h = resolverHarness();
    h.fake.setAdmit({ kind: 'rate_limited' });
    const res = await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });
    expect(res).toEqual({ kind: 'takeover_rate_limited' });
    expect(h.sessions.getCurrent()?.lock_cause).toBe('authority_conflict');
    expect(h.takenOver).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('no connection stays locked; the retry re-uses the same idempotency key', async () => {
    const h = resolverHarness();
    h.fake.setAdmit({ kind: 'no_connection' });
    const first = await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });
    expect(first).toEqual({ kind: 'refused', category: 'no_connection' });
    expect(h.sessions.getCurrent()?.lock_cause).toBe('authority_conflict');

    h.fake.setAdmit(ADMITTED);
    const second = await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });
    expect(second).toEqual({ kind: 'resolved', action: 'take_over_here' });
    expect(h.fake.admitCalls).toHaveLength(2);
    expect(h.fake.admitCalls[1]?.idempotency_key).toBe(h.fake.admitCalls[0]?.idempotency_key);
  });

  it('a 5xx is answered like no connection', async () => {
    const h = resolverHarness();
    h.fake.setAdmit({ kind: 'unavailable' });
    const res = await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });
    expect(res).toEqual({ kind: 'refused', category: 'no_connection' });
    expect(h.sessions.isLocked()).toBe(true);
  });

  it('a 403 ends the session account_disabled_mid_session and invalidates the grant', async () => {
    const h = resolverHarness();
    h.fake.setAdmit({ kind: 'refused' });
    const res = await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });
    expect(res).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(h.ends).toEqual(['account_disabled_mid_session']);
    expect(h.fake.invalidated).toEqual([{ reason: 'refused', user_id: FAKE_USER_ID }]);
  });

  it.each([
    [{ kind: 'device_unauthorized' as const }],
    [{ kind: 'active_elsewhere' as const }],
    [{ kind: 'no_token' as const }],
    [{ kind: 'rejected' as const }],
  ])('%o stays locked with a generic refusal', async (answer) => {
    const h = resolverHarness();
    h.fake.setAdmit(answer);
    const res = await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });
    expect(res).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(h.sessions.getCurrent()?.lock_cause).toBe('authority_conflict');
    expect(h.takenOver).toEqual([]);
    expect(h.ends).toEqual([]);
  });

  it('an admitted for a session that ended meanwhile is released, never adopted', async () => {
    const h = resolverHarness();
    h.fake.setAdmit(() => {
      h.sessions.end('signed_out');
      return ADMITTED;
    });
    const res = await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });
    await Promise.resolve();
    expect(res).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(h.fake.endRequests).toEqual([
      { admission_id: ADMITTED.admission_id, admission_generation: ADMITTED.admission_generation },
    ]);
    expect(h.takenOver).toEqual([]);
  });

  it('an admitted after a grant invalidation landed in flight is released, never adopted', async () => {
    const h = resolverHarness();
    let seq = 0;
    h.fake.deps.grantSeam = {
      onCashierAdmitted: () => undefined,
      onCashierAdmissionInvalidated: () => undefined,
      invalidationSeq: () => seq,
    };
    h.fake.setAdmit(() => {
      seq += 1;
      return ADMITTED;
    });
    const res = await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });
    await Promise.resolve();
    expect(res).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(h.sessions.getCurrent()?.lock_cause).toBe('authority_conflict');
    expect(h.fake.endRequests).toHaveLength(1);
  });

  it('a skewed till clock refuses clock_skew, releases, publishes no grant; after the fix a new takeover adopts', async () => {
    let till = Date.parse('2026-10-04T12:00:00.000Z'); // 2 h ahead of ADMITTED.server_time
    const h = resolverHarness(null, { tillClockMs: () => till });
    const res = await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });
    await Promise.resolve();
    expect(res).toEqual({ kind: 'refused', category: 'clock_skew' });
    expect(h.sessions.getCurrent()?.lock_cause).toBe('authority_conflict');
    expect(h.fake.endRequests).toHaveLength(1);
    expect(h.fake.admitted).toEqual([]);

    till = Date.parse(ADMITTED.server_time) + 1_000; // the clock is fixed
    const again = await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });
    expect(again).toEqual({ kind: 'resolved', action: 'take_over_here' });
    expect(h.fake.admitCalls[1]?.idempotency_key).not.toBe(h.fake.admitCalls[0]?.idempotency_key);
  });

  it('a malformed server_time is never adopted: released, no grant, still locked', async () => {
    const h = resolverHarness(null, { tillClockMs: () => Date.parse(ADMITTED.server_time) });
    h.fake.setAdmit({ ...ADMITTED, server_time: 'not-a-time' });
    const res = await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });
    await Promise.resolve();
    expect(res).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(h.sessions.getCurrent()?.lock_cause).toBe('authority_conflict');
    expect(h.fake.admitted).toEqual([]);
    expect(h.fake.endRequests).toHaveLength(1);
  });

  it('the grant is published only after adoption, never for an admitted it refuses', async () => {
    const h = resolverHarness();
    let seq = 0;
    h.fake.deps.grantSeam = {
      onCashierAdmitted: (e) => h.fake.admitted.push(e),
      onCashierAdmissionInvalidated: () => undefined,
      invalidationSeq: () => seq,
    };
    h.fake.setAdmit(() => {
      seq += 1;
      return ADMITTED;
    });
    await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });
    expect(h.fake.admitted).toEqual([]);
  });

  it('a replay more than 2 min after the first send on a correct till is adopted; the lease runs from the first send', async () => {
    let till = Date.parse(ADMITTED.server_time) - 1_000;
    let mono = 1_000;
    const h = resolverHarness(null, { tillClockMs: () => till });
    h.fake.deps.monotonicNow = () => mono;
    h.fake.setAdmit({ kind: 'no_connection' });
    expect(await h.resolver.resolve({ action: 'take_over_here', pin: '1234' })).toEqual({
      kind: 'refused',
      category: 'no_connection',
    });
    till += 10 * 60_000; // ten minutes later, the server replays the ORIGINAL issuance
    mono += 10 * 60_000;
    h.fake.setAdmit(ADMITTED);
    const res = await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });
    expect(res).toEqual({ kind: 'resolved', action: 'take_over_here' });
    expect(h.fake.admitCalls[1]?.idempotency_key).toBe(h.fake.admitCalls[0]?.idempotency_key);
    expect(h.sessions.getCurrent()?.admission_requested_at_ms).toBe(1_000);
  });
});

describe('AuthorityConflictResolver — end here after an unanswered takeover (coordinator decision)', () => {
  async function unanswered(): Promise<ResolverHarness> {
    const h = resolverHarness();
    h.fake.setAdmit({ kind: 'no_connection' });
    await h.resolver.resolve({ action: 'take_over_here', pin: '1234' });
    return h;
  }

  it('replays the SAME request; an admitted is released, then the session ends', async () => {
    const h = await unanswered();
    h.fake.setAdmit(ADMITTED);
    const res = await h.resolver.resolve({ action: 'end_here', pin: '1234' });
    await Promise.resolve();
    expect(res).toEqual({ kind: 'resolved', action: 'end_here' });
    expect(h.fake.admitCalls).toHaveLength(2);
    expect(h.fake.admitCalls[1]).toMatchObject({
      takeover: true,
      idempotency_key: h.fake.admitCalls[0]?.idempotency_key,
    });
    expect(h.fake.endRequests).toEqual([
      { admission_id: ADMITTED.admission_id, admission_generation: ADMITTED.admission_generation },
    ]);
    expect(h.fake.admitted).toEqual([]);
    expect(h.ends).toEqual(['superseded_by_takeover']);
  });

  it.each([[{ kind: 'refused' as const }], [{ kind: 'active_elsewhere' as const }]])(
    'a definite %o: nothing to release, the session just ends',
    async (answer) => {
      const h = await unanswered();
      h.fake.setAdmit(answer);
      const res = await h.resolver.resolve({ action: 'end_here', pin: '1234' });
      expect(res).toEqual({ kind: 'resolved', action: 'end_here' });
      expect(h.fake.endRequests).toEqual([]);
      expect(h.ends).toEqual(['superseded_by_takeover']);
    },
  );

  it.each([[{ kind: 'no_connection' as const }], [{ kind: 'unavailable' as const }]])(
    'still unknown (%o): stays locked, no local end, the cashier retries',
    async (answer) => {
      const h = await unanswered();
      h.fake.setAdmit(answer);
      const res = await h.resolver.resolve({ action: 'end_here', pin: '1234' });
      expect(res).toEqual({ kind: 'refused', category: 'no_connection' });
      expect(h.ends).toEqual([]);
      expect(h.sessions.getCurrent()?.lock_cause).toBe('authority_conflict');

      h.fake.setAdmit({ kind: 'refused' });
      expect(await h.resolver.resolve({ action: 'end_here', pin: '1234' })).toEqual({
        kind: 'resolved',
        action: 'end_here',
      });
      expect(h.fake.admitCalls[2]?.idempotency_key).toBe(h.fake.admitCalls[0]?.idempotency_key);
    },
  );

  it('a 429 on the replay keeps the lock and answers takeover_rate_limited', async () => {
    const h = await unanswered();
    h.fake.setAdmit({ kind: 'rate_limited' });
    expect(await h.resolver.resolve({ action: 'end_here', pin: '1234' })).toEqual({
      kind: 'takeover_rate_limited',
    });
    expect(h.ends).toEqual([]);
  });

  it('end here with no pending takeover sends nothing', async () => {
    const h = resolverHarness();
    await h.resolver.resolve({ action: 'end_here', pin: '1234' });
    expect(h.fake.admitCalls).toEqual([]);
  });
});
