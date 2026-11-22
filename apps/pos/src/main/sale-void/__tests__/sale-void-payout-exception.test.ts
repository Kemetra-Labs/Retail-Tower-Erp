/**
 * RT-1403 S2 — the one drawer (M1), the manager-attested cash exception, the payout view and the
 * once-only unpaid flag (H2), over the full migration stack (sql.js).
 *
 *   • one drawer for the terminal: refused while another payout holds it, never queued;
 *   • an exception needs an open shift, a single-use approval of a manager other than the
 *     requester, may settle a claim whose window passed, and carries a mismatch flag;
 *   • a confirmed void whose window passed unpaid shows needs-attention data and is flagged ONCE.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createDrawerSlot } from '../../drawer/drawer-slot.js';
import type { DrawerResult } from '../sale-void-payout.js';
import { createSaleVoidRepository } from '../sale-void-repository.js';
import {
  APPROVAL_B,
  APPROVER_USER,
  REQUESTER_USER,
  SCOPE,
  newVoidEntry,
} from './__helpers__/sale-void-fixture.js';
import {
  NEXT_DAY,
  WITHIN_LEASE,
  createHarness,
  freshState,
  viewOfV1,
  type PayoutHarness,
} from './__helpers__/sale-void-payout-harness.js';
import {
  OPENED_AFTER_VOID,
  OPENED_BEFORE_VOID,
  SHIFT_A,
  closeShift,
  journalVoid,
  openShift,
  type VoidFixtureState,
} from './__helpers__/sale-void-payout-fixture.js';

let db: SqlJsDatabase;
let h: PayoutHarness;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  h = createHarness(db);
});

afterEach(() => {
  db.close();
});

function given(state: VoidFixtureState, opts: { shift?: string | null; cash?: number } = {}): void {
  journalVoid(db, state, 1, opts.cash === undefined ? {} : { cashMinor: opts.cash });
  if (opts.shift !== null) openShift(db, SHIFT_A, opts.shift ?? OPENED_BEFORE_VOID);
}

const start = { void_id: 'v1', action: 'start' } as const;
const manual = { void_id: 'v1', action: 'manual' } as const;
const request = { void_id: 'v1', approval_id: APPROVAL_B };

describe('payOut: one drawer for the terminal (M1)', () => {
  it('refuses another operation for the same void while one runs, one record results', async () => {
    given('confirmed');
    let release: () => void = () => undefined;
    h.state.kick = () =>
      new Promise<DrawerResult>((resolve) => {
        release = () => {
          resolve('opened');
        };
      });
    const first = h.service.payOut(start);
    expect(await h.service.payOut(manual)).toEqual({
      kind: 'refused',
      reason: 'payout_in_progress',
    });
    release();
    expect(await first).toEqual({ kind: 'paid_out' });
    expect(h.kicks).toBe(1);
  });

  it('refuses while a return payout holds the drawer, claims nothing, and works once it is free', async () => {
    given('confirmed');
    const slot = createDrawerSlot();
    h = createHarness(db, freshState(), slot);
    const releaseReturn = slot.tryAcquire();
    expect(await h.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'another_payout_in_progress',
    });
    expect(h.kicks).toBe(0);
    expect(h.payouts.readClaim('v1')).toBeNull();
    releaseReturn?.();
    expect(await h.service.payOut(start)).toEqual({ kind: 'paid_out' });
    expect(slot.busy()).toBe(false);
  });

  it('holds the slot while it runs, so a return payout is refused meanwhile', async () => {
    given('confirmed');
    const slot = createDrawerSlot();
    h = createHarness(db, freshState(), slot);
    let release: () => void = () => undefined;
    h.state.kick = () =>
      new Promise<DrawerResult>((resolve) => {
        release = () => {
          resolve('opened');
        };
      });
    const running = h.service.payOut(start);
    expect(slot.busy()).toBe(true);
    expect(slot.tryAcquire()).toBeNull();
    release();
    await running;
    expect(slot.busy()).toBe(false);
  });
});

describe('recordCashException', () => {
  it.each([
    ['refused', 'void_refused'],
    ['unknown', 'void_unconfirmed'],
    ['pending', 'void_unconfirmed'],
  ] as const)(
    'records cash that left for a %s void, flagged %s, spending the approval',
    async (state, flag) => {
      given(state);
      expect(await h.service.recordCashException(request)).toEqual({
        kind: 'exception_recorded',
        mismatch_reason: flag,
      });
      expect(h.record()).toMatchObject({
        kind: 'exception',
        method: 'manual',
        voidState: state,
        mismatchReason: flag,
        amountMinor: 1500,
        shiftId: SHIFT_A,
        exception: {
          approvalId: APPROVAL_B,
          approverUserId: APPROVER_USER,
          requesterUserId: REQUESTER_USER,
          policyVersion: 'rt114-2026-10-07',
        },
      });
      expect(h.trail).toEqual([
        'sale.void.cash_exception_recorded',
        'sale.void.cash_mismatch_flagged',
      ]);
      expect(h.kicks).toBe(0);
    },
  );

  it('spends the approval bound to this void, this operator and this scope', async () => {
    given('refused');
    await h.service.recordCashException(request);
    expect(h.consumed).toHaveLength(1);
    expect(h.consumed[0]).toMatchObject({
      approvalId: APPROVAL_B,
      actionKind: 'sale.void_cash_exception',
      subjectRef: 'v1',
      subject: { version: 'sale-void-cash-exception:v1', amountMinor: 1500 },
      session: {
        operator_id: 'op-manager',
        tenant_id: SCOPE.tenantId,
        branch_id: SCOPE.branchId,
      },
    });
  });

  it('records an unflagged exception for a confirmed void inside its window', async () => {
    given('confirmed');
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'exception_recorded',
      mismatch_reason: null,
    });
    expect(h.trail).toEqual(['sale.void.cash_exception_recorded']);
  });

  it('flags a confirmed void paid outside its day window, with the day of the payment', async () => {
    given('confirmed');
    h.state.now = NEXT_DAY;
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'exception_recorded',
      mismatch_reason: 'payout_window_closed',
    });
    expect(h.record()?.businessDate).toBe('2026-06-08');
  });

  it('flags a confirmed void paid in a shift opened after the request', async () => {
    given('confirmed', { shift: OPENED_AFTER_VOID });
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'exception_recorded',
      mismatch_reason: 'payout_window_closed',
    });
  });

  it('settles a claim whose window passed during the kick: the way out, flagged', async () => {
    given('confirmed');
    h.state.kick = () => {
      h.state.now = NEXT_DAY;
      return Promise.resolve('failed');
    };
    await h.service.payOut(start);
    expect(h.payouts.countOpenClaims(SCOPE)).toBe(1);
    // The unknown kick is no longer in flight once its lease runs out (same clock, next day).
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'exception_recorded',
      mismatch_reason: 'payout_window_closed',
    });
    expect(h.payouts.countOpenClaims(SCOPE)).toBe(0);
  });

  it('does not settle a claim whose kick is still in flight, and spends no approval', async () => {
    given('confirmed');
    h.state.kick = () => {
      h.state.stopped = true;
      return Promise.resolve('opened');
    };
    await h.service.payOut(start);
    const restarted = createHarness(db, { ...freshState(), now: WITHIN_LEASE });
    expect(await restarted.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'payout_drawer_in_progress',
    });
    expect(restarted.consumed).toEqual([]);
  });

  it('needs an open shift and spends no approval without one (a closed shift is never changed)', async () => {
    given('refused', { shift: null });
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expect(h.consumed).toEqual([]);
    expect(h.record()).toBeNull();
  });

  it('records nothing and spends nothing when the shift read fails', async () => {
    given('refused');
    h.state.shiftReadFails = true;
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expect(h.consumed).toEqual([]);
  });

  it.each(['approval_invalid', 'approval_stale'] as const)(
    'records nothing when the approval is refused (%s)',
    async (reason) => {
      given('refused');
      h.state.consume = { kind: 'refused', reason };
      expect(await h.service.recordCashException(request)).toEqual({ kind: 'refused', reason });
      expect(h.record()).toBeNull();
      expect(h.events).toEqual([]);
    },
  );

  it('refuses an approver who is the requester (four-eyes), and writes nothing', async () => {
    given('refused');
    h.state.evidence = { approverUserId: REQUESTER_USER, requesterUserId: REQUESTER_USER };
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expect(h.record()).toBeNull();
  });

  it('refuses an approval granted to another requester, or none at all', async () => {
    given('refused');
    h.state.evidence = { approverUserId: APPROVER_USER, requesterUserId: APPROVER_USER };
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    h.state.evidence = null;
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expect(h.record()).toBeNull();
  });

  it('refuses a session with no users.id before any approval is spent', async () => {
    given('refused');
    h.state.session = { sessionId: 'sess-2', userId: null, role: 'manager' };
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expect(h.consumed).toEqual([]);
  });

  it('may be requested by a cashier (the manager approves), and is single use', async () => {
    given('refused');
    h.state.session = { sessionId: 'sess-2', userId: REQUESTER_USER, role: 'cashier' };
    await h.service.recordCashException(request);
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'payout_already_recorded',
    });
    expect(h.consumed).toHaveLength(1);
  });

  it('is refused after a payout, and a payout after an exception', async () => {
    given('confirmed');
    await h.service.payOut(start);
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'payout_already_recorded',
    });
    db.close();
    db = freshSalesSyncDb();
    h = createHarness(db);
    given('confirmed');
    await h.service.recordCashException(request);
    expect(await h.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'payout_already_recorded',
    });
  });

  it('refuses a void with no cash, an unknown void, and a session that is not admitted', async () => {
    given('refused', { cash: 0 });
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'payout_no_cash',
    });
    expect(await h.service.recordCashException({ ...request, void_id: 'ghost' })).toEqual({
      kind: 'refused',
      reason: 'invalid_input',
    });
    h.state.locked = true;
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'session_locked',
    });
  });
});

describe('viewOf', () => {
  it('is payable now for a confirmed void in an open shift', () => {
    given('confirmed');
    expect(viewOfV1(db, h.service)).toEqual({
      state: 'none',
      claim_actions: [],
      overdue: false,
      paid_at: null,
      mismatch_reason: null,
      blocked_reason: null,
    });
  });

  it('a payable void with no shift open is blocked but not overdue (a shift may still open)', () => {
    given('confirmed');
    closeShift(db);
    expect(viewOfV1(db, h.service)).toMatchObject({
      blocked_reason: 'payout_no_open_shift',
      overdue: false,
    });
  });

  it('after midnight the void is blocked AND overdue, whatever shift is open', () => {
    given('confirmed');
    h.state.now = NEXT_DAY;
    expect(viewOfV1(db, h.service)).toMatchObject({
      blocked_reason: 'payout_wrong_day',
      overdue: true,
    });
    closeShift(db);
    expect(viewOfV1(db, h.service)).toMatchObject({
      blocked_reason: 'payout_wrong_day',
      overdue: true,
    });
  });

  it('in a shift opened after the request the void is blocked and overdue', () => {
    given('confirmed', { shift: OPENED_AFTER_VOID });
    expect(viewOfV1(db, h.service)).toMatchObject({
      blocked_reason: 'payout_other_shift',
      overdue: true,
    });
  });

  it.each(['pending', 'unknown', 'refused'] as const)(
    'a %s void has no payout to block and is never overdue',
    (state) => {
      given(state);
      h.state.now = NEXT_DAY;
      expect(viewOfV1(db, h.service)).toMatchObject({ blocked_reason: null, overdue: false });
    },
  );

  it('a void with no cash is never blocked or overdue', () => {
    given('confirmed', { cash: 0 });
    h.state.now = NEXT_DAY;
    expect(viewOfV1(db, h.service)).toMatchObject({ blocked_reason: null, overdue: false });
  });

  it('a claimed payout shows its actions by what its kick proved', async () => {
    given('confirmed');
    h.state.kick = () => Promise.resolve('failed');
    await h.service.payOut(start);
    expect(viewOfV1(db, h.service)).toMatchObject({
      state: 'claimed',
      claim_actions: ['manual'],
      overdue: false,
    });
  });

  it('shows a paid-out record and an exception with its flag', async () => {
    given('confirmed');
    await h.service.payOut(start);
    expect(viewOfV1(db, h.service)).toEqual({
      state: 'paid_out',
      claim_actions: [],
      overdue: false,
      paid_at: '2026-06-07T13:00:00.000Z',
      mismatch_reason: null,
      blocked_reason: null,
    });
    db.close();
    db = freshSalesSyncDb();
    h = createHarness(db);
    given('refused');
    await h.service.recordCashException(request);
    expect(viewOfV1(db, h.service)).toMatchObject({
      state: 'exception',
      mismatch_reason: 'void_refused',
    });
  });

  it('a late exception clears the overdue flag of the void; the payout_not_made audit already written stays', async () => {
    given('confirmed');
    h.state.now = NEXT_DAY;
    const entry = createSaleVoidRepository(handleFor(db)).read('v1');
    if (entry === null) throw new Error('void v1 not journaled');
    h.service.flagUnpaid(entry, { operatorId: 'op-manager', sessionId: 'sess-2' });
    expect(viewOfV1(db, h.service).overdue).toBe(true);
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'exception_recorded',
      mismatch_reason: 'payout_window_closed',
    });
    expect(viewOfV1(db, h.service)).toMatchObject({ state: 'exception', overdue: false });
    h.service.flagUnpaid(entry, { operatorId: 'op-manager', sessionId: 'sess-2' });
    const flagged = db
      .exec(
        `SELECT json_extract(payload, '$.mismatch_reason') FROM audit_events
        WHERE action_category = 'sale.void.cash_mismatch_flagged' ORDER BY created_at`,
      )[0]
      ?.values.map((r) => String(r[0]));
    expect(flagged).toEqual(['payout_not_made', 'payout_window_closed']);
  });

  it('says the sale already has its cash when another void of it was recorded', async () => {
    given('refused');
    await h.service.recordCashException(request);
    const repo = createSaleVoidRepository(handleFor(db));
    repo.insert(
      newVoidEntry(2, {
        saleId: 'sale-1',
        approvalId: '0190f5a2-7b3c-7d4e-8f90-0000000000a9',
        now: '2026-06-07T10:20:00.000Z',
      }),
    );
    repo.markConfirmed({
      voidId: 'v2',
      voidRef: '0190f5a2-7b3c-7d4e-8f90-0000000000d2',
      now: '2026-06-07T10:21:00.000Z',
    });
    const second = repo.read('v2');
    if (second === null) throw new Error('void v2 not journaled');
    expect(h.service.viewOf(second)).toMatchObject({
      state: 'none',
      blocked_reason: 'payout_already_recorded',
      overdue: false,
    });
  });
});

describe('flagUnpaid (H2)', () => {
  const actor = { operatorId: 'op-manager', sessionId: 'sess-2' };
  const entry = () => {
    const found = createSaleVoidRepository(handleFor(db)).read('v1');
    if (found === null) throw new Error('void v1 not journaled');
    return found;
  };
  const flags = () =>
    h.events.filter(
      (e) =>
        e.action_category === 'sale.void.cash_mismatch_flagged' &&
        (e.payload as { mismatch_reason?: string }).mismatch_reason === 'payout_not_made',
    );

  it('flags a confirmed void whose day passed unpaid, exactly once', () => {
    given('confirmed');
    h.state.now = NEXT_DAY;
    h.service.flagUnpaid(entry(), actor);
    h.service.flagUnpaid(entry(), actor);
    // A restart reads the same audit: still once.
    createHarness(db, { ...freshState(), now: NEXT_DAY }).service.flagUnpaid(entry(), actor);
    expect(flags()).toHaveLength(1);
    expect(flags()[0]).toMatchObject({
      acting_operator_id: 'op-manager',
      session_id: 'sess-2',
      payload: {
        void_id: 'v1',
        sale_id: 'sale-1',
        payout_id: '',
        amount_minor: 1500,
        void_state: 'confirmed',
        mismatch_reason: 'payout_not_made',
      },
    });
    const total = db.exec(
      `SELECT COUNT(*) FROM audit_events WHERE action_category = 'sale.void.cash_mismatch_flagged'`,
    )[0]?.values[0]?.[0];
    expect(Number(total)).toBe(1);
  });

  it('flags a confirmed void left unpaid into a shift opened after its request', () => {
    given('confirmed', { shift: OPENED_AFTER_VOID });
    h.service.flagUnpaid(entry(), actor);
    expect(flags()).toHaveLength(1);
    expect(flags()[0]?.shift_id).toBe(SHIFT_A);
  });

  it.each(['pending', 'unknown', 'refused'] as const)('does not flag a %s void', (state) => {
    given(state);
    h.state.now = NEXT_DAY;
    h.service.flagUnpaid(entry(), actor);
    expect(flags()).toHaveLength(0);
  });

  it('does not flag a void still payable, or one already paid out', async () => {
    given('confirmed');
    h.service.flagUnpaid(entry(), actor);
    await h.service.payOut(start);
    h.state.now = NEXT_DAY;
    h.service.flagUnpaid(entry(), actor);
    expect(flags()).toHaveLength(0);
  });

  it('asks the audit once per void: later reads use the in-process set', () => {
    given('confirmed');
    h.state.now = NEXT_DAY;
    let asked = 0;
    h = createHarness(db, h.state, undefined, (deps) => ({
      ...deps,
      payouts: new Proxy(deps.payouts, {
        get(target, prop) {
          if (prop === 'hasUnpaidFlag') {
            return (voidId: string) => {
              asked += 1;
              return target.hasUnpaidFlag(voidId);
            };
          }
          const value: unknown = Reflect.get(target, prop);
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      }),
    }));
    h.service.flagUnpaid(entry(), actor);
    h.service.flagUnpaid(entry(), actor);
    h.service.flagUnpaid(entry(), actor);
    expect(asked).toBe(1);
    expect(flags()).toHaveLength(1);
  });

  it('knows a void flagged by an earlier process from the audit, and never flags it again', () => {
    given('confirmed');
    h.state.now = NEXT_DAY;
    h.service.flagUnpaid(entry(), actor);
    const restarted = createHarness(db, { ...freshState(), now: NEXT_DAY });
    restarted.service.flagUnpaid(entry(), actor);
    restarted.service.flagUnpaid(entry(), actor);
    expect(restarted.events).toEqual([]);
  });

  it('never throws when the audit fails, and tries again on the next read', () => {
    given('confirmed');
    h.state.now = NEXT_DAY;
    db.run(
      `CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'full'); END`,
    );
    expect(() => {
      h.service.flagUnpaid(entry(), actor);
    }).not.toThrow();
    db.run('DROP TRIGGER fail_audit');
    h.service.flagUnpaid(entry(), actor);
    expect(
      Number(
        db.exec(
          `SELECT COUNT(*) FROM audit_events WHERE action_category = 'sale.void.cash_mismatch_flagged'`,
        )[0]?.values[0]?.[0],
      ),
    ).toBe(1);
  });
});

describe('cashExceptionSubject', () => {
  it('binds the approval to the void and its cash', () => {
    given('refused');
    expect(h.service.cashExceptionSubject({ subjectRef: 'v1' })).toEqual({
      version: 'sale-void-cash-exception:v1',
      amountMinor: 1500,
    });
  });

  it('is null for a void with a record, no cash, no such void, or no admitted session', async () => {
    given('refused');
    await h.service.recordCashException(request);
    expect(h.service.cashExceptionSubject({ subjectRef: 'v1' })).toBeNull();
    expect(h.service.cashExceptionSubject({ subjectRef: 'ghost' })).toBeNull();
    h.state.session = null;
    expect(h.service.cashExceptionSubject({ subjectRef: 'v1' })).toBeNull();
  });

  it('is null for a void with no cash', () => {
    given('refused', { cash: 0 });
    expect(h.service.cashExceptionSubject({ subjectRef: 'v1' })).toBeNull();
  });
});
