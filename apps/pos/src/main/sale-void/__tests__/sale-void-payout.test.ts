/**
 * RT-1403 S2 — the fail-closed void payout and the manager-attested cash exception, over the full
 * migration stack (sql.js) with the real journal and payout repositories.
 *
 *   • cash leaves only for a void Backend-Core CONFIRMED, inside an open shift, on the void's
 *     business day, in the shift that was already open when the void was requested;
 *   • `pending`, `unknown` and `refused` give no cash, and the drawer is never kicked for them;
 *   • the cash of a sale is recorded once, whichever way it left;
 *   • an exception needs an open shift, a single-use approval of a manager other than the
 *     requester, and carries a mismatch flag when cash and accounting status disagree.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import type {
  ConsumeApprovalInput,
  ConsumeApprovalOutcome,
} from '../../operator/manager-approval-service.js';
import type { SaleVoidMismatchReason } from '../../../shared/sale-void/types.js';
import {
  createSaleVoidPayout,
  type DrawerResult,
  type OpenShiftFact,
  type SaleVoidPayoutService,
} from '../sale-void-payout.js';
import {
  createSaleVoidPayoutRepository,
  type PayoutRecord,
  type SaleVoidPayoutRepository,
} from '../sale-void-payout-repository.js';
import { createSaleVoidRepository } from '../sale-void-repository.js';
import {
  APPROVAL_B,
  APPROVER_USER,
  REQUESTER_USER,
  SCOPE,
} from './__helpers__/sale-void-fixture.js';
import {
  OPENED_AFTER_VOID,
  OPENED_BEFORE_VOID,
  SHIFT_A,
  closeShift,
  journalVoid,
  openShift,
  type VoidFixtureState,
} from './__helpers__/sale-void-payout-fixture.js';

const NOW = '2026-06-07T13:00:00.000Z';
const NEXT_DAY = '2026-06-08T09:00:00.000Z';

interface Harness {
  service: SaleVoidPayoutService;
  payouts: SaleVoidPayoutRepository;
  audit: string[];
  kicks: number;
  consumed: ConsumeApprovalInput[];
  state: {
    now: string;
    enabled: boolean;
    stopped: boolean;
    locked: boolean;
    session: { sessionId: string; userId: string | null } | null;
    terminalId: string;
    kick: () => Promise<DrawerResult>;
    consume: ConsumeApprovalOutcome;
    evidence: { approverUserId: string; requesterUserId: string | null } | null;
    shiftReadFails: boolean;
  };
}

let db: SqlJsDatabase;
let h: Harness;

beforeAll(async () => {
  await initSalesSyncSql();
});

function compose(): Harness {
  const handle = handleFor(db);
  const payouts = createSaleVoidPayoutRepository(handle);
  const voids = createSaleVoidRepository(handle);
  const state: Harness['state'] = {
    now: NOW,
    enabled: true,
    stopped: false,
    locked: false,
    session: { sessionId: 'sess-2', userId: REQUESTER_USER },
    terminalId: SCOPE.terminalId,
    kick: () => Promise.resolve('opened'),
    consume: { kind: 'consumed', approverUserId: APPROVER_USER },
    evidence: { approverUserId: APPROVER_USER, requesterUserId: REQUESTER_USER },
    shiftReadFails: false,
  };
  const out: Harness = {
    service: undefined as unknown as SaleVoidPayoutService,
    payouts,
    audit: [],
    kicks: 0,
    consumed: [],
    state,
  };
  out.service = createSaleVoidPayout({
    isEnabled: () => state.enabled,
    isStopped: () => state.stopped,
    isSessionLocked: () => state.locked,
    getSession: () =>
      state.session === null
        ? null
        : {
            sessionId: state.session.sessionId,
            operatorId: 'op-cashier',
            displayName: 'Cara Cashier',
            userId: state.session.userId,
            scope: { ...SCOPE, terminalId: state.terminalId },
          },
    voids,
    payouts,
    openShift: (scope): OpenShiftFact | null => {
      if (state.shiftReadFails) throw new Error('shift read failed');
      const row = db.exec(
        `SELECT o.shift_id, o.opened_at FROM shift_cashup_opens o
          WHERE o.terminal_id = '${scope.terminalId}'
            AND NOT EXISTS (SELECT 1 FROM shift_manager_closures m WHERE m.shift_id = o.shift_id)`,
      )[0]?.values[0];
      return row === undefined ? null : { shiftId: String(row[0]), openedAt: String(row[1]) };
    },
    approvals: {
      consume: (input) => {
        out.consumed.push(input);
        return state.consume;
      },
      evidence: () =>
        state.evidence === null
          ? null
          : {
              approverUserId: state.evidence.approverUserId,
              requesterUserId: state.evidence.requesterUserId,
              policyVersion: 'rt114-2026-10-07',
              issuedAt: NOW,
            },
    },
    kickDrawer: () => {
      out.kicks += 1;
      return state.kick();
    },
    audit: {
      paidOut: (r) => out.audit.push(`paid_out:${r.voidId}`),
      cashExceptionRecorded: (r) => out.audit.push(`exception:${r.voidId}`),
      cashMismatchFlagged: (r) => out.audit.push(`mismatch:${r.mismatchReason ?? ''}`),
    },
    localDayOf: (iso) => iso.slice(0, 10),
    now: () => state.now,
    newPayoutId: () => '0192f5a2-3b4c-7d8e-9f01-0000000000b1',
  });
  return out;
}

beforeEach(() => {
  db = freshSalesSyncDb();
  h = compose();
});

afterEach(() => {
  db.close();
});

/** A journaled void in `state` and an open shift (before the void unless told otherwise). */
function given(state: VoidFixtureState, opts: { shift?: string | null; cash?: number } = {}): void {
  journalVoid(db, state, 1, opts.cash === undefined ? {} : { cashMinor: opts.cash });
  if (opts.shift !== null) openShift(db, SHIFT_A, opts.shift ?? OPENED_BEFORE_VOID);
}

function record(): PayoutRecord | null {
  return h.payouts.readByVoid('v1');
}

describe('payOut', () => {
  it('records the cash of a confirmed void in the open shift, through the drawer', async () => {
    given('confirmed');
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({ kind: 'paid_out' });
    expect(record()).toMatchObject({
      kind: 'payout',
      method: 'drawer',
      amountMinor: 1500,
      currencyCode: 'EGP',
      shiftId: SHIFT_A,
      businessDate: '2026-06-07',
      voidState: 'confirmed',
      mismatchReason: null,
      paidAt: NOW,
      paidBy: { operatorId: 'op-cashier', sessionId: 'sess-2' },
      exception: null,
    });
    expect(h.kicks).toBe(1);
    expect(h.audit).toEqual(['paid_out:v1']);
  });

  it('completes as no_drawer when the terminal has no drawer (RT-531)', async () => {
    given('confirmed');
    h.state.kick = () => Promise.resolve('no_drawer');
    await h.service.payOut({ void_id: 'v1' });
    expect(record()?.method).toBe('no_drawer');
  });

  it.each([
    ['pending', 'payout_void_not_confirmed'],
    ['unknown', 'payout_void_not_confirmed'],
    ['refused', 'payout_void_refused'],
  ] as const)('gives no cash for a %s void (%s)', async (state, reason) => {
    given(state);
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({ kind: 'refused', reason });
    expect(h.kicks).toBe(0);
    expect(record()).toBeNull();
    expect(h.audit).toEqual([]);
  });

  it('refuses with no open shift, before the drawer', async () => {
    given('confirmed', { shift: null });
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expect(h.kicks).toBe(0);
  });

  it('refuses when the shift read fails (fail closed)', async () => {
    given('confirmed');
    h.state.shiftReadFails = true;
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expect(record()).toBeNull();
  });

  it('refuses after midnight, even in a shift that is still open', async () => {
    given('confirmed');
    h.state.now = NEXT_DAY;
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
      kind: 'refused',
      reason: 'payout_wrong_day',
    });
    expect(h.kicks).toBe(0);
    expect(record()).toBeNull();
  });

  it('refuses in a shift opened after the void was requested (not the same shift)', async () => {
    given('confirmed', { shift: OPENED_AFTER_VOID });
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
      kind: 'refused',
      reason: 'payout_other_shift',
    });
    expect(record()).toBeNull();
  });

  it('refuses a void with no cash to hand back (a card sale)', async () => {
    given('confirmed', { cash: 0 });
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
      kind: 'refused',
      reason: 'payout_no_cash',
    });
  });

  it('pays once: a second payout is refused and the drawer is not kicked again', async () => {
    given('confirmed');
    await h.service.payOut({ void_id: 'v1' });
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
      kind: 'refused',
      reason: 'payout_already_recorded',
    });
    expect(h.kicks).toBe(1);
  });

  it('records nothing when the drawer does not open, and may be tried again', async () => {
    given('confirmed');
    h.state.kick = () => Promise.resolve('failed');
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
      kind: 'refused',
      reason: 'payout_drawer_failed',
    });
    expect(record()).toBeNull();
    h.state.kick = () => Promise.resolve('opened');
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({ kind: 'paid_out' });
  });

  it('re-checks the gate at the commit: a shift closed during the kick records nothing', async () => {
    given('confirmed');
    h.state.kick = () => {
      closeShift(db);
      return Promise.resolve('opened');
    };
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expect(record()).toBeNull();
    expect(h.audit).toEqual([]);
  });

  it('re-checks the day at the commit: midnight passing during the kick records nothing', async () => {
    given('confirmed');
    h.state.kick = () => {
      h.state.now = NEXT_DAY;
      return Promise.resolve('opened');
    };
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
      kind: 'refused',
      reason: 'payout_wrong_day',
    });
    expect(record()).toBeNull();
  });

  it('records nothing when the session locks or changes during the kick', async () => {
    given('confirmed');
    h.state.kick = () => {
      h.state.locked = true;
      return Promise.resolve('opened');
    };
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
      kind: 'refused',
      reason: 'session_locked',
    });
    h.state.locked = false;
    h.state.kick = () => {
      h.state.session = { sessionId: 'sess-other', userId: REQUESTER_USER };
      return Promise.resolve('opened');
    };
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
    expect(record()).toBeNull();
  });

  it('records nothing when the domain stops during the kick', async () => {
    given('confirmed');
    h.state.kick = () => {
      h.state.stopped = true;
      return Promise.resolve('opened');
    };
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
      kind: 'refused',
      reason: 'void_unavailable',
    });
    expect(record()).toBeNull();
  });

  it('shares one payout per void: a repeat while one runs is refused, one record results', async () => {
    given('confirmed');
    let release: () => void = () => undefined;
    h.state.kick = () =>
      new Promise<DrawerResult>((resolve) => {
        release = () => {
          resolve('opened');
        };
      });
    const first = h.service.payOut({ void_id: 'v1' });
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
      kind: 'refused',
      reason: 'payout_in_progress',
    });
    release();
    expect(await first).toEqual({ kind: 'paid_out' });
    expect(h.kicks).toBe(1);
  });

  it.each<[string, () => void]>([
    [
      'feature_disabled',
      () => {
        h.state.enabled = false;
      },
    ],
    [
      'no_session',
      () => {
        h.state.session = null;
      },
    ],
    [
      'session_locked',
      () => {
        h.state.locked = true;
      },
    ],
    [
      'void_unavailable',
      () => {
        h.state.stopped = true;
      },
    ],
  ])('is not admitted: %s', async (reason, arrange) => {
    given('confirmed');
    arrange();
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({ kind: 'refused', reason });
    expect(h.kicks).toBe(0);
  });

  it('refuses a void that does not exist or belongs to another terminal', async () => {
    given('confirmed');
    expect(await h.service.payOut({ void_id: 'ghost' })).toEqual({
      kind: 'refused',
      reason: 'invalid_input',
    });
    h.state.terminalId = 'term-2';
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
      kind: 'refused',
      reason: 'invalid_input',
    });
  });
});

describe('recordCashException', () => {
  const request = { void_id: 'v1', approval_id: APPROVAL_B };

  it.each([
    ['refused', 'void_refused'],
    ['unknown', 'void_unconfirmed'],
    ['pending', 'void_unconfirmed'],
  ] as const)(
    'records cash that left for a %s void, flagged %s, spending the approval',
    async (state, flag: SaleVoidMismatchReason) => {
      given(state);
      expect(await h.service.recordCashException(request)).toEqual({
        kind: 'exception_recorded',
        mismatch_reason: flag,
      });
      expect(record()).toMatchObject({
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
      expect(h.audit).toEqual([`exception:v1`, `mismatch:${flag}`]);
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
        operator_id: 'op-cashier',
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
    expect(h.audit).toEqual(['exception:v1']);
  });

  it('flags a confirmed void paid outside its day window', async () => {
    given('confirmed');
    h.state.now = NEXT_DAY;
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'exception_recorded',
      mismatch_reason: 'payout_window_closed',
    });
    expect(record()?.businessDate).toBe('2026-06-08');
  });

  it('flags a confirmed void paid in a shift opened after the request', async () => {
    given('confirmed', { shift: OPENED_AFTER_VOID });
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'exception_recorded',
      mismatch_reason: 'payout_window_closed',
    });
  });

  it('needs an open shift and spends no approval without one (a closed shift is never changed)', async () => {
    given('refused', { shift: null });
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expect(h.consumed).toEqual([]);
    expect(record()).toBeNull();
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
      expect(record()).toBeNull();
      expect(h.audit).toEqual([]);
    },
  );

  it('refuses an approver who is the requester (four-eyes)', async () => {
    given('refused');
    h.state.evidence = { approverUserId: REQUESTER_USER, requesterUserId: REQUESTER_USER };
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expect(record()).toBeNull();
  });

  it('refuses an approval granted to another requester', async () => {
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
    expect(record()).toBeNull();
  });

  it('refuses a session with no users.id before any approval is spent', async () => {
    given('refused');
    h.state.session = { sessionId: 'sess-2', userId: null };
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expect(h.consumed).toEqual([]);
  });

  it('is single use: the cash of a void is recorded once, a repeat spends nothing', async () => {
    given('refused');
    await h.service.recordCashException(request);
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'payout_already_recorded',
    });
    expect(h.consumed).toHaveLength(1);
  });

  it('is refused after a payout, and a payout after an exception', async () => {
    given('confirmed');
    await h.service.payOut({ void_id: 'v1' });
    expect(await h.service.recordCashException(request)).toEqual({
      kind: 'refused',
      reason: 'payout_already_recorded',
    });
    db.close();
    db = freshSalesSyncDb();
    h = compose();
    given('confirmed');
    await h.service.recordCashException(request);
    expect(await h.service.payOut({ void_id: 'v1' })).toEqual({
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
  function view() {
    const entry = createSaleVoidRepository(handleFor(db)).read('v1');
    if (entry === null) throw new Error('void v1 not journaled');
    return h.service.viewOf(entry);
  }

  it('is payable now for a confirmed void in an open shift', () => {
    given('confirmed');
    expect(view()).toEqual({
      state: 'none',
      paid_at: null,
      mismatch_reason: null,
      blocked_reason: null,
    });
  });

  it.each<[string, () => void]>([
    [
      'payout_no_open_shift',
      () => {
        closeShift(db);
      },
    ],
    [
      'payout_wrong_day',
      () => {
        h.state.now = NEXT_DAY;
      },
    ],
  ])('says why a confirmed void cannot be paid now: %s', (reason, arrange) => {
    given('confirmed');
    arrange();
    expect(view().blocked_reason).toBe(reason);
  });

  it('has no blocked reason for a void that is not confirmed or has no cash', () => {
    given('refused');
    closeShift(db);
    expect(view().blocked_reason).toBeNull();
  });

  it('shows a paid-out record and an exception with its flag', async () => {
    given('confirmed');
    await h.service.payOut({ void_id: 'v1' });
    expect(view()).toEqual({
      state: 'paid_out',
      paid_at: NOW,
      mismatch_reason: null,
      blocked_reason: null,
    });
    db.close();
    db = freshSalesSyncDb();
    h = compose();
    given('refused');
    await h.service.recordCashException({ void_id: 'v1', approval_id: APPROVAL_B });
    expect(view()).toEqual({
      state: 'exception',
      paid_at: NOW,
      mismatch_reason: 'void_refused',
      blocked_reason: null,
    });
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
    await h.service.recordCashException({ void_id: 'v1', approval_id: APPROVAL_B });
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
