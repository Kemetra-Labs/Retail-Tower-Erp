/**
 * RT-1403 S2 — the fail-closed void payout over the full migration stack (sql.js) with the real
 * journal, claim and record repositories and the real audit.
 *
 *   • cash leaves only for a void Backend-Core CONFIRMED, inside an open shift, on the void's
 *     business day, in the shift that was already open when the void was requested;
 *   • a CLAIM (with its audit) is written BEFORE the drawer is kicked; once it exists a fresh payout
 *     is never offered, only a drawer retry (after a kick that provably never left) or a manager's
 *     manual completion, and exactly one record is ever counted (H1);
 *   • a manager or admin pays out, a cashier never does (L3);
 *   • `pending`, `unknown` and `refused` give no cash, and the drawer is never kicked for them.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { SCOPE } from './__helpers__/sale-void-fixture.js';
import {
  AFTER_LEASE,
  NEXT_DAY,
  WITHIN_LEASE,
  createHarness,
  freshState,
  viewOfV1,
  type PayoutHarness,
  type PayoutState,
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

/** A journaled void in `state` and an open shift (before the void unless told otherwise). */
function given(state: VoidFixtureState, opts: { shift?: string | null; cash?: number } = {}): void {
  journalVoid(db, state, 1, opts.cash === undefined ? {} : { cashMinor: opts.cash });
  if (opts.shift !== null) openShift(db, SHIFT_A, opts.shift ?? OPENED_BEFORE_VOID);
}

const start = { void_id: 'v1', action: 'start' } as const;
const retry = { void_id: 'v1', action: 'retry_drawer' } as const;
const manual = { void_id: 'v1', action: 'manual' } as const;

describe('payOut: start', () => {
  it('claims the payout and audits it BEFORE the drawer is kicked, then records the cash', async () => {
    given('confirmed');
    expect(await h.service.payOut(start)).toEqual({ kind: 'paid_out' });
    expect(h.trail).toEqual([
      'sale.void.payout_started',
      'kick',
      'sale.void.payout_drawer',
      'sale.void.paid_out',
    ]);
    expect(h.payouts.readClaim('v1')).toMatchObject({
      shiftId: SHIFT_A,
      businessDate: '2026-06-07',
      kickOutcome: 'opened',
      kickCount: 1,
    });
    expect(h.record()).toMatchObject({
      kind: 'payout',
      method: 'drawer',
      amountMinor: 1500,
      currencyCode: 'EGP',
      shiftId: SHIFT_A,
      businessDate: '2026-06-07',
      voidState: 'confirmed',
      mismatchReason: null,
      paidAt: '2026-06-07T13:00:00.000Z',
      paidBy: { operatorId: 'op-manager', sessionId: 'sess-2' },
      exception: null,
    });
    expect(h.payouts.countOpenClaims(SCOPE)).toBe(0);
  });

  it('writes the claim durably before the kick: a kick in flight already has its claim', async () => {
    given('confirmed');
    let seen: unknown = null;
    h.state.kick = () => {
      seen = h.payouts.readClaim('v1')?.kickOutcome;
      return Promise.resolve('opened');
    };
    await h.service.payOut(start);
    expect(seen).toBe('sending');
  });

  it('completes as no_drawer when the terminal has no drawer (RT-531)', async () => {
    given('confirmed');
    h.state.kick = () => Promise.resolve('no_drawer');
    expect(await h.service.payOut(start)).toEqual({ kind: 'paid_out' });
    expect(h.record()?.method).toBe('no_drawer');
    expect(h.payouts.readClaim('v1')?.kickOutcome).toBe('failed_before_send');
  });

  it('takes the payment day from the one clock read, and an admin may pay out too', async () => {
    given('confirmed');
    h.state.session = { sessionId: 'sess-2', userId: null, role: 'admin' };
    await h.service.payOut(start);
    expect(h.record()?.businessDate).toBe(h.record()?.paidAt.slice(0, 10));
  });

  it('refuses a cashier (L3): nothing is claimed, kicked or recorded', async () => {
    given('confirmed');
    h.state.session = { sessionId: 'sess-2', userId: null, role: 'cashier' };
    expect(await h.service.payOut(start)).toEqual({ kind: 'refused', reason: 'role_denied' });
    expect(h.kicks).toBe(0);
    expect(h.payouts.readClaim('v1')).toBeNull();
    expect(h.record()).toBeNull();
  });

  it.each([
    ['pending', 'payout_void_not_confirmed'],
    ['unknown', 'payout_void_not_confirmed'],
    ['refused', 'payout_void_refused'],
  ] as const)('gives no cash for a %s void (%s): no claim, no kick', async (state, reason) => {
    given(state);
    expect(await h.service.payOut(start)).toEqual({ kind: 'refused', reason });
    expect(h.kicks).toBe(0);
    expect(h.payouts.readClaim('v1')).toBeNull();
    expect(h.record()).toBeNull();
    expect(h.events).toEqual([]);
  });

  it('refuses with no open shift, before any claim or kick', async () => {
    given('confirmed', { shift: null });
    expect(await h.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expect(h.kicks).toBe(0);
    expect(h.payouts.readClaim('v1')).toBeNull();
  });

  it('refuses when the shift read fails (fail closed)', async () => {
    given('confirmed');
    h.state.shiftReadFails = true;
    expect(await h.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expect(h.payouts.readClaim('v1')).toBeNull();
  });

  it('refuses after midnight, even in a shift that is still open, with no claim', async () => {
    given('confirmed');
    h.state.now = NEXT_DAY;
    expect(await h.service.payOut(start)).toEqual({ kind: 'refused', reason: 'payout_wrong_day' });
    expect(h.kicks).toBe(0);
    expect(h.payouts.readClaim('v1')).toBeNull();
    expect(h.record()).toBeNull();
  });

  it('refuses in a shift opened after the void was requested (not the same shift)', async () => {
    given('confirmed', { shift: OPENED_AFTER_VOID });
    expect(await h.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'payout_other_shift',
    });
    expect(h.payouts.readClaim('v1')).toBeNull();
  });

  it('refuses a void with no cash to hand back (a card sale)', async () => {
    given('confirmed', { cash: 0 });
    expect(await h.service.payOut(start)).toEqual({ kind: 'refused', reason: 'payout_no_cash' });
  });

  it('pays once: a second start is refused and the drawer is not kicked again', async () => {
    given('confirmed');
    await h.service.payOut(start);
    expect(await h.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'payout_already_recorded',
    });
    expect(h.kicks).toBe(1);
  });

  it('refuses a void that does not exist or belongs to another terminal', async () => {
    given('confirmed');
    expect(await h.service.payOut({ void_id: 'ghost', action: 'start' })).toEqual({
      kind: 'refused',
      reason: 'invalid_input',
    });
    h.state.terminalId = 'term-2';
    expect(await h.service.payOut(start)).toEqual({ kind: 'refused', reason: 'invalid_input' });
  });

  it.each<[string, (state: PayoutState) => void]>([
    ['feature_disabled', (s) => (s.enabled = false)],
    ['no_session', (s) => (s.session = null)],
    ['session_locked', (s) => (s.locked = true)],
    ['void_unavailable', (s) => (s.stopped = true)],
  ])('is not admitted: %s', async (reason, arrange) => {
    given('confirmed');
    arrange(h.state);
    expect(await h.service.payOut(start)).toEqual({ kind: 'refused', reason });
    expect(h.kicks).toBe(0);
    expect(h.payouts.readClaim('v1')).toBeNull();
  });
});

describe('payOut: the claim survives anything after the kick (H1)', () => {
  it('a drawer that failed leaves the claim: told it may be open, and only the manual completion remains', async () => {
    given('confirmed');
    h.state.kick = () => Promise.resolve('failed');
    expect(await h.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'payout_drawer_failed',
      drawer_may_be_open: true,
    });
    expect(h.record()).toBeNull();
    expect(h.payouts.readClaim('v1')?.kickOutcome).toBe('unknown');
    // No fresh payout; an unknown kick is never retried; the manager attests it by hand.
    expect(await h.service.payOut(start)).toEqual({ kind: 'refused', reason: 'payout_started' });
    expect(await h.service.payOut(retry)).toEqual({
      kind: 'refused',
      reason: 'payout_drawer_retry_unsafe',
    });
    expect(h.kicks).toBe(1);
    expect(await h.service.payOut(manual)).toEqual({ kind: 'paid_out' });
    expect(h.record()).toMatchObject({ kind: 'payout', method: 'manual' });
    expect(h.payouts.countOpenClaims(SCOPE)).toBe(0);
  });

  it('a shift closed during the kick records nothing, says the drawer may be open, keeps the claim', async () => {
    given('confirmed');
    h.state.kick = () => {
      closeShift(db);
      return Promise.resolve('opened');
    };
    expect(await h.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'payout_no_open_shift',
      drawer_may_be_open: true,
    });
    expect(h.record()).toBeNull();
    expect(h.payouts.readClaim('v1')?.kickOutcome).toBe('opened');
    expect(h.trail).not.toContain('sale.void.paid_out');
    expect(h.payouts.countOpenClaims(SCOPE)).toBe(1);
  });

  it('midnight passing during the kick records nothing and keeps the claim', async () => {
    given('confirmed');
    h.state.kick = () => {
      h.state.now = NEXT_DAY;
      return Promise.resolve('opened');
    };
    expect(await h.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'payout_wrong_day',
      drawer_may_be_open: true,
    });
    expect(h.record()).toBeNull();
    expect(h.payouts.countOpenClaims(SCOPE)).toBe(1);
    // The window has passed for a manual completion too: only an exception can settle it.
    expect(await h.service.payOut(manual)).toEqual({ kind: 'refused', reason: 'payout_wrong_day' });
  });

  it('a lock during the kick records nothing and keeps the claim; no fresh payout follows', async () => {
    given('confirmed');
    h.state.kick = () => {
      h.state.locked = true;
      return Promise.resolve('opened');
    };
    expect(await h.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'session_locked',
      drawer_may_be_open: true,
    });
    h.state.locked = false;
    expect(await h.service.payOut(start)).toEqual({ kind: 'refused', reason: 'payout_started' });
    expect(h.record()).toBeNull();
  });

  it('a session swapped during the kick refuses the commit, and the next manager completes it by hand', async () => {
    given('confirmed');
    h.state.kick = () => {
      h.state.session = { sessionId: 'sess-other', userId: null, role: 'manager' };
      return Promise.resolve('opened');
    };
    expect(await h.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'no_session',
      drawer_may_be_open: true,
    });
    expect(h.record()).toBeNull();
    expect(await h.service.payOut(manual)).toEqual({ kind: 'paid_out' });
    expect(h.record()?.paidBy.sessionId).toBe('sess-other');
  });

  it('a stop during the kick writes nothing more and leaves the durable sending mark', async () => {
    given('confirmed');
    h.state.kick = () => {
      h.state.stopped = true;
      return Promise.resolve('opened');
    };
    expect(await h.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'void_unavailable',
      drawer_may_be_open: true,
    });
    expect(h.record()).toBeNull();
    expect(h.payouts.readClaim('v1')?.kickOutcome).toBe('sending');
    expect(h.events.map((e) => e.action_category)).toEqual(['sale.void.payout_started']);
  });

  it('crash between kick and commit, then restart: no fresh payout, retry unsafe, ONE manual record', async () => {
    given('confirmed');
    h.state.kick = () => {
      // The process "dies" with the kick sent: nothing more is written (the DB is closing).
      h.state.stopped = true;
      return Promise.resolve('opened');
    };
    await h.service.payOut(start);
    expect(h.payouts.countOpenClaims(SCOPE)).toBe(1);

    // Restart: a new service over the same database, after the kick's lease has run out.
    const restarted = createHarness(db, { ...freshState(), now: AFTER_LEASE });
    expect(viewOfV1(db, restarted.service)).toMatchObject({
      state: 'claimed',
      claim_actions: ['manual'],
    });
    expect(await restarted.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'payout_started',
    });
    expect(await restarted.service.payOut(retry)).toEqual({
      kind: 'refused',
      reason: 'payout_drawer_retry_unsafe',
    });
    expect(restarted.kicks).toBe(0);
    expect(await restarted.service.payOut(manual)).toEqual({ kind: 'paid_out' });
    expect(Number(db.exec('SELECT COUNT(*) FROM sale_void_payouts')[0]?.values[0]?.[0])).toBe(1);
    expect(restarted.payouts.countOpenClaims(SCOPE)).toBe(0);
    expect(await restarted.service.payOut(manual)).toEqual({
      kind: 'refused',
      reason: 'payout_already_recorded',
    });
  });

  it('a restart inside the kick lease waits: the manual completion is refused while the kick may be in flight', async () => {
    given('confirmed');
    h.state.kick = () => {
      h.state.stopped = true;
      return Promise.resolve('opened');
    };
    await h.service.payOut(start);
    const restarted = createHarness(db, { ...freshState(), now: WITHIN_LEASE });
    expect(viewOfV1(db, restarted.service)).toMatchObject({ state: 'claimed', claim_actions: [] });
    expect(await restarted.service.payOut(manual)).toEqual({
      kind: 'refused',
      reason: 'payout_drawer_in_progress',
    });
    expect(restarted.payouts.countOpenClaims(SCOPE)).toBe(1);
  });
});

describe('payOut: retry_drawer and manual', () => {
  it('retries the drawer after a kick that provably never left, and completes in the same shift', async () => {
    given('confirmed');
    let first = true;
    h.state.kick = () => {
      if (first) {
        first = false;
        h.state.locked = true; // refuses the first commit; the kick never left
      }
      return Promise.resolve('no_drawer');
    };
    expect(await h.service.payOut(start)).toMatchObject({
      kind: 'refused',
      reason: 'session_locked',
    });
    h.state.locked = false;
    expect(viewOfV1(db, h.service).claim_actions).toEqual(['retry_drawer', 'manual']);
    expect(await h.service.payOut(retry)).toEqual({ kind: 'paid_out' });
    expect(h.kicks).toBe(2);
    expect(h.payouts.readClaim('v1')).toMatchObject({
      kickCount: 2,
      kickOutcome: 'failed_before_send',
    });
    expect(h.record()).toMatchObject({ kind: 'payout', method: 'no_drawer' });
  });

  it('refuses a retry or a manual completion with no claim', async () => {
    given('confirmed');
    expect(await h.service.payOut(retry)).toEqual({
      kind: 'refused',
      reason: 'payout_not_started',
    });
    expect(await h.service.payOut(manual)).toEqual({
      kind: 'refused',
      reason: 'payout_not_started',
    });
    expect(h.kicks).toBe(0);
  });

  it('refuses a retry when the shift is gone, before kicking again', async () => {
    given('confirmed');
    h.state.kick = () => {
      closeShift(db);
      return Promise.resolve('no_drawer');
    };
    await h.service.payOut(start);
    expect(await h.service.payOut(retry)).toEqual({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expect(h.kicks).toBe(1);
  });

  it('a cashier may not complete a claimed payout either', async () => {
    given('confirmed');
    h.state.kick = () => Promise.resolve('failed');
    await h.service.payOut(start);
    h.state.session = { sessionId: 'sess-2', userId: null, role: 'cashier' };
    expect(await h.service.payOut(manual)).toEqual({ kind: 'refused', reason: 'role_denied' });
    expect(h.record()).toBeNull();
  });
});
