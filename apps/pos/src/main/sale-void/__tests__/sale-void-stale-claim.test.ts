/**
 * RT-1403 S2 follow-up (c18183) — a void payout claim that outlives its shift never deadlocks the
 * till.
 *
 * A claim whose drawer kick never completed counts as drawer cash in flight. When its shift is no
 * longer open (a manager closed it on the server, RT-1442, or it is closed), `retry_drawer` and
 * `manual` can never complete it, and, before this fix, no shift could open while it was unpaid. Now:
 *
 *   • only a claim whose own shift is still open holds the till (the close, a pay-out, and, with no
 *     open shift, nothing); a stale claim never blocks the next shift from OPENING;
 *   • a stale claim is settled ONLY by the four-eyes cash exception in the new open shift (another
 *     manager's single-use approval), flagged `payout_window_closed` and audited; `start`,
 *     `retry_drawer` and `manual` stay refused;
 *   • the closed shift is never changed, and the new shift's cash-up counts the exception.
 *
 * Every test uses the REAL shift cash-up service and repository, the real void payout service and
 * the real migration 0069 triggers on one sql.js database.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  createShiftCashupRepo,
  type ShiftCashupRepo,
} from '../../shift-cashup/shift-cashup-repo.js';
import { createShiftCashupSources } from '../../shift-cashup/shift-cashup-sources.js';
import { ShiftCashupRefusedError } from '../../shift-cashup/shift-cashup-service.js';
import {
  seedRefund,
  seedSettlement,
  serviceHarness,
  type ServiceHarness,
} from '../../shift-cashup/__tests__/__helpers__/shift-cashup-service-fixture.js';
import { APPROVAL_B, SCOPE } from './__helpers__/sale-void-fixture.js';
import { journalVoid } from './__helpers__/sale-void-payout-fixture.js';
import {
  AFTER_LEASE,
  WITHIN_LEASE,
  createHarness,
  freshState,
  viewOfV1,
  type PayoutHarness,
} from './__helpers__/sale-void-payout-harness.js';
import type { DrawerResult } from '../sale-void-payout.js';

const FLOAT = 10_000;
const RETURN_REF = '0192f5a2-3b4c-7d8e-9f01-0000000000c2';
const SHIFT_1_OPENED = '2026-06-07T08:00:00.000Z';
const CLAIMED = '2026-06-07T13:00:00.000Z';
const FORCE_CLOSED = '2026-06-07T13:30:00.000Z';
const SHIFT_2_OPENED = '2026-06-07T14:00:00.000Z';
const LATER = '2026-06-07T15:00:00.000Z';
const NEXT_DAY_SHIFT_OPENED = '2026-06-08T09:00:00.000Z';
const EVENING = '2026-06-07T20:00:00.000Z';

const start = { void_id: 'v1', action: 'start' } as const;
const retry = { void_id: 'v1', action: 'retry_drawer' } as const;
const manual = { void_id: 'v1', action: 'manual' } as const;
const exception = { void_id: 'v1', approval_id: APPROVAL_B };

let db: SqlJsDatabase;
let shifts: ServiceHarness;
let shiftRepo: ShiftCashupRepo;
let h: PayoutHarness;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  shifts = serviceHarness(db, { varianceApprovalThresholdMinor: null });
  shiftRepo = createShiftCashupRepo(handleFor(db));
  h = createHarness(db, freshState(), undefined, (deps) => ({
    ...deps,
    openShift: (scope) => shiftRepo.findOpenShift(scope),
  }));
  journalVoid(db, 'confirmed');
});

afterEach(() => {
  db.close();
});

/** Both clocks (the shift service and the payout service) at `iso`. */
function at(iso: string): void {
  shifts.state.clock = iso;
  h.state.now = iso;
}

function openShift(iso: string): string {
  at(iso);
  return shifts.service.openShift({ openingFloatMinor: FLOAT }).shiftId;
}

/** The server told the till a manager closed the shift: the shift's open fact (seq 1) was answered. */
function forceClose(shiftId: string, now = FORCE_CLOSED): void {
  expect(shiftRepo.recordManagerClosure({ seq: 1, now, shiftId, factKind: 'open' })).toBe(true);
  expect(shiftRepo.findOpenShift(SCOPE)).toBeNull();
}

function openRefusal(iso: string): string | null {
  at(iso);
  try {
    shifts.service.openShift({ openingFloatMinor: FLOAT });
    return null;
  } catch (error) {
    if (error instanceof ShiftCashupRefusedError) return error.reason;
    throw error;
  }
}

function pending(): { refundPayouts: number; voidPayouts: number; unfinalizedSales: number } {
  return createShiftCashupSources(handleFor(db)).pendingDrawerActivity(SCOPE);
}

/** Shift 1 opens, the payout of v1 is claimed and its kick answers `kick`; returns shift 1's id. */
async function claimedInShift1(kick: DrawerResult = 'failed'): Promise<string> {
  const shiftId = openShift(SHIFT_1_OPENED);
  at(CLAIMED);
  h.state.kick = () => Promise.resolve(kick);
  const answer = await h.service.payOut(start);
  expect(answer).toMatchObject({ kind: 'refused', reason: 'payout_drawer_failed' });
  expect(h.payouts.readClaim('v1')).toMatchObject({ shiftId, kickOutcome: 'unknown' });
  return shiftId;
}

/** Shift 1 holds a claim whose kick provably never left (`failed_before_send`), so retry is offered. */
async function claimedNeverKicked(): Promise<string> {
  const shiftId = openShift(SHIFT_1_OPENED);
  at(CLAIMED);
  h.state.kick = () => {
    // The till locks between the kick's answer and the commit: the claim stays, nothing is paid.
    h.state.locked = true;
    return Promise.resolve('no_drawer');
  };
  expect(await h.service.payOut(start)).toMatchObject({ kind: 'refused' });
  h.state.locked = false;
  expect(h.payouts.readClaim('v1')).toMatchObject({ shiftId, kickOutcome: 'failed_before_send' });
  return shiftId;
}

describe('a void claim that outlives its shift (a manager force-close on the server)', () => {
  it('the claim holds its own open shift, but a new shift can open once that shift is closed', async () => {
    const shift1 = await claimedInShift1();
    expect(pending().voidPayouts).toBe(1);
    // While shift 1 is open the claim holds the till: it cannot be closed over it.
    at(LATER);
    expect(() => shifts.service.closeShift({ countedCashMinor: FLOAT })).toThrow(
      expect.objectContaining({ reason: 'drawer_activity_pending' }) as Error,
    );

    forceClose(shift1);
    // The deadlock c18183 describes: before the fix this was `drawer_activity_pending`.
    expect(pending().voidPayouts).toBe(0);
    expect(openRefusal(SHIFT_2_OPENED)).toBeNull();
    expect(shiftRepo.findOpenShift(SCOPE)).not.toBeNull();
  });

  it('retry_drawer, manual and start stay refused in the new shift, with no kick and no record', async () => {
    const shift1 = await claimedNeverKicked();
    forceClose(shift1);
    openShift(SHIFT_2_OPENED);
    const kicksBefore = h.kicks;

    expect(await h.service.payOut(retry)).toEqual({
      kind: 'refused',
      reason: 'payout_other_shift',
    });
    expect(await h.service.payOut(manual)).toEqual({
      kind: 'refused',
      reason: 'payout_other_shift',
    });
    expect(await h.service.payOut(start)).toEqual({ kind: 'refused', reason: 'payout_started' });
    expect(h.kicks).toBe(kicksBefore);
    expect(h.record()).toBeNull();
  });

  it('manual and retry_drawer are refused after a kick that never completed (unknown), too', async () => {
    const shift1 = await claimedInShift1();
    forceClose(shift1);
    openShift(SHIFT_2_OPENED);
    expect(await h.service.payOut(retry)).toEqual({
      kind: 'refused',
      reason: 'payout_drawer_retry_unsafe',
    });
    expect(await h.service.payOut(manual)).toEqual({
      kind: 'refused',
      reason: 'payout_other_shift',
    });
    expect(h.record()).toBeNull();
  });

  it('between shifts (no open shift) every step is refused: payout_no_open_shift', async () => {
    const shift1 = await claimedNeverKicked();
    forceClose(shift1);
    at(LATER);
    expect(await h.service.payOut(retry)).toEqual({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expect(await h.service.payOut(manual)).toEqual({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expect(await h.service.recordCashException(exception)).toEqual({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expect(h.consumed).toEqual([]);
  });

  it('the four-eyes cash exception in the new shift settles it, flagged payout_window_closed', async () => {
    const shift1 = await claimedInShift1();
    forceClose(shift1);
    const shift2 = openShift(SHIFT_2_OPENED);
    at(LATER);

    expect(await h.service.recordCashException(exception)).toEqual({
      kind: 'exception_recorded',
      mismatch_reason: 'payout_window_closed',
    });
    expect(h.record()).toMatchObject({
      kind: 'exception',
      method: 'manual',
      shiftId: shift2,
      amountMinor: 1500,
      voidState: 'confirmed',
      mismatchReason: 'payout_window_closed',
      exception: { approvalId: APPROVAL_B.toLowerCase() },
    });
    // The claim keeps its own (closed) shift: nothing of shift 1 is rewritten.
    expect(h.payouts.readClaim('v1')).toMatchObject({ shiftId: shift1, kickOutcome: 'unknown' });
    expect(h.trail).toEqual(
      expect.arrayContaining([
        'sale.void.payout_started',
        'sale.void.cash_exception_recorded',
        'sale.void.cash_mismatch_flagged',
      ]),
    );
    expect(viewOfV1(db, h.service)).toMatchObject({
      state: 'exception',
      claim_actions: [],
      mismatch_reason: 'payout_window_closed',
    });
  });

  it('refuses a self-approval and a missing approval, and records and spends nothing', async () => {
    const shift1 = await claimedInShift1();
    forceClose(shift1);
    openShift(SHIFT_2_OPENED);
    at(LATER);

    h.state.evidence = { approverUserId: 'same', requesterUserId: 'same' };
    expect(await h.service.recordCashException(exception)).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expect(h.record()).toBeNull();

    h.state.evidence = null;
    expect(await h.service.recordCashException(exception)).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expect(h.record()).toBeNull();
    expect(pendingClaimRows()).toBe(1);
    // The approval was asked for twice, and both attempts rolled back with the record.
    expect(h.consumed).toHaveLength(2);
    expect(rowsOf('manager_approvals')).toBe(0);
  });

  it('a second exception, or a payout, for the settled cash is refused', async () => {
    const shift1 = await claimedInShift1();
    forceClose(shift1);
    openShift(SHIFT_2_OPENED);
    at(LATER);
    await h.service.recordCashException(exception);
    expect(await h.service.recordCashException(exception)).toEqual({
      kind: 'refused',
      reason: 'payout_already_recorded',
    });
    expect(await h.service.payOut(manual)).toEqual({
      kind: 'refused',
      reason: 'payout_already_recorded',
    });
  });

  it('the exception also settles a claim from an earlier DAY (next-day shift)', async () => {
    const shift1 = await claimedInShift1();
    forceClose(shift1);
    const shift2 = openShift(NEXT_DAY_SHIFT_OPENED);
    expect(await h.service.recordCashException(exception)).toEqual({
      kind: 'exception_recorded',
      mismatch_reason: 'payout_window_closed',
    });
    expect(h.record()).toMatchObject({ shiftId: shift2, businessDate: '2026-06-08' });
  });

  it('a claim whose kick is still mid-flight (sending) is not settled, and no approval is spent', async () => {
    openShift(SHIFT_1_OPENED);
    at(CLAIMED);
    let release: () => void = () => undefined;
    h.state.kick = () =>
      new Promise<DrawerResult>((resolve) => {
        release = () => {
          resolve('opened');
        };
      });
    const running = h.service.payOut(start);
    // The kick may still open the drawer: the exception must wait for its answer (or its lease).
    expect(await h.service.recordCashException(exception)).toEqual({
      kind: 'refused',
      reason: 'payout_drawer_in_progress',
    });
    expect(h.consumed).toEqual([]);
    release();
    await running;
  });

  it('the new shift cash-up counts the exception once, and the closed shift is untouched', async () => {
    const shift1 = await claimedInShift1();
    const closedBefore = rowsOf('shift_cashup_closes');
    forceClose(shift1);
    const shift2 = openShift(SHIFT_2_OPENED);
    at(LATER);
    await h.service.recordCashException(exception);
    expect(pending().voidPayouts).toBe(0);

    at(EVENING);
    const closed = shifts.service.closeShift({ countedCashMinor: FLOAT - 1500 });
    expect(closed).toMatchObject({
      cashRefundsTotalMinor: 1500,
      expectedCashMinor: FLOAT - 1500,
      varianceMinor: 0,
    });
    // Nothing of shift 1 changed: no close row, the open fact and the claim as they were.
    expect(rowsOf('shift_cashup_closes')).toBe(closedBefore + 1);
    expect(
      db.exec(`SELECT shift_id FROM shift_cashup_closes`)[0]?.values.map((row) => row[0]),
    ).toEqual([shift2]);
    expect(h.payouts.readClaim('v1')?.shiftId).toBe(shift1);
  });
});

describe('a claim of the CURRENT open shift still holds the till', () => {
  it('refuses the close and a cash pay-out while its shift is open, then lets them go when it settles', async () => {
    await claimedInShift1();
    at(LATER);
    expect(() => shifts.service.closeShift({ countedCashMinor: FLOAT })).toThrow(
      expect.objectContaining({ reason: 'drawer_activity_pending' }) as Error,
    );
    expect(() =>
      shifts.service.recordCashMovement({ kind: 'pay_out', amountMinor: 100, reasonCode: 'other' }),
    ).toThrow(expect.objectContaining({ reason: 'drawer_activity_pending' }) as Error);
    expect(pending().voidPayouts).toBe(1);

    // The exception settles it in the same (current) shift; then the close goes through.
    expect(await h.service.recordCashException(exception)).toMatchObject({
      kind: 'exception_recorded',
    });
    expect(pending().voidPayouts).toBe(0);
    expect(shifts.service.closeShift({ countedCashMinor: FLOAT - 1500 })).toMatchObject({
      cashRefundsTotalMinor: 1500,
    });
  });

  it('a stale claim of an earlier shift does not hold the NEW shift (close and pay-out work)', async () => {
    const shift1 = await claimedInShift1();
    forceClose(shift1);
    openShift(SHIFT_2_OPENED);
    at(LATER);
    expect(
      shifts.service.recordCashMovement({ kind: 'pay_in', amountMinor: 500, reasonCode: 'other' }),
    ).toBeDefined();
    expect(
      shifts.service.recordCashMovement({ kind: 'pay_out', amountMinor: 100, reasonCode: 'other' }),
    ).toBeDefined();
    expect(shifts.service.closeShift({ countedCashMinor: FLOAT + 400 })).toMatchObject({
      cashRefundsTotalMinor: 0,
    });
    // The claim is still unsettled: it stays visible to the manager.
    expect(h.payouts.readClaim('v1')).not.toBeNull();
    expect(h.record()).toBeNull();
  });

  it('a claim whose shift was closed locally (a close row) is stale as well', async () => {
    const shift1 = await claimedInShift1();
    // The till refuses a close over an open claim, so record the close straight through the repo.
    shiftRepo.recordClose({
      scope: SCOPE,
      fact: {
        shiftId: shift1,
        closedAt: FORCE_CLOSED,
        closingUserId: '0192f5a2-3b4c-7d8e-9f01-0000000000c1',
        openingFloatMinor: FLOAT,
        cashSalesTotalMinor: 0,
        cashRefundsTotalMinor: 0,
        payInTotalMinor: 0,
        payOutTotalMinor: 0,
        expectedCashMinor: FLOAT,
        countedCashMinor: FLOAT,
        varianceMinor: 0,
        saleCount: 0,
        cashRefundReturnRefs: [],
      },
      now: FORCE_CLOSED,
    });
    expect(shiftRepo.findOpenShift(SCOPE)).toBeNull();
    expect(pending().voidPayouts).toBe(0);
  });
});

describe('a stale claim whose kick is still in flight keeps holding the till (c18188 L1)', () => {
  it('refuses the next open during the 10 s kick lease and opens after it', async () => {
    const shift1 = openShift(SHIFT_1_OPENED);
    at(CLAIMED);
    let release: () => void = () => undefined;
    h.state.kick = () =>
      new Promise<DrawerResult>((resolve) => {
        release = () => {
          resolve('opened');
        };
      });
    const running = h.service.payOut(start);
    expect(h.payouts.readClaim('v1')).toMatchObject({ shiftId: shift1, kickOutcome: 'sending' });
    forceClose(shift1, CLAIMED);

    expect(openRefusal(WITHIN_LEASE)).toBe('drawer_activity_pending');
    expect(openRefusal(AFTER_LEASE)).toBeNull();
    release();
    await running;
  });

  it('measures the lease as the kick does: held up to 10 s on either side of the kick, never after', () => {
    const shift1 = openShift(SHIFT_1_OPENED);
    at(CLAIMED);
    h.state.kick = () => new Promise<DrawerResult>(() => undefined);
    void h.service.payOut(start);
    forceClose(shift1, CLAIMED);
    const sources = createShiftCashupSources(handleFor(db));
    const held = (now?: string): number => sources.pendingDrawerActivity(SCOPE, now).voidPayouts;
    expect(held('2026-06-07T13:00:09.999Z')).toBe(1);
    expect(held('2026-06-07T13:00:10.000Z')).toBe(0);
    // A clock that stepped back bounds the lease, it never extends it.
    expect(held('2026-06-07T12:59:50.000Z')).toBe(1);
    expect(held('2026-06-07T12:59:49.999Z')).toBe(0);
    // No clock given: a kick still `sending` counts (conservative, as the kick rule does).
    expect(held()).toBe(1);
  });

  it('a kick that resolved (unknown) no longer holds a stale claim', async () => {
    const shift1 = await claimedInShift1();
    forceClose(shift1);
    const sources = createShiftCashupSources(handleFor(db));
    expect(sources.pendingDrawerActivity(SCOPE, LATER).voidPayouts).toBe(0);
    expect(sources.pendingDrawerActivity(SCOPE).voidPayouts).toBe(0);
  });
});

describe('the business day passes inside the same shift', () => {
  it('the claim still holds the shift, the exception settles it, then the shift closes', async () => {
    const shift1 = await claimedInShift1();
    const nextDay = '2026-06-08T00:30:00.000Z';
    at(nextDay);
    // Still the claim's own shift: it holds the close, and retry or manual cannot complete it.
    expect(() => shifts.service.closeShift({ countedCashMinor: FLOAT })).toThrow(
      expect.objectContaining({ reason: 'drawer_activity_pending' }) as Error,
    );
    expect(await h.service.payOut(manual)).toEqual({
      kind: 'refused',
      reason: 'payout_wrong_day',
    });

    expect(await h.service.recordCashException(exception)).toEqual({
      kind: 'exception_recorded',
      mismatch_reason: 'payout_window_closed',
    });
    expect(h.record()).toMatchObject({ shiftId: shift1, businessDate: '2026-06-08' });
    expect(pending().voidPayouts).toBe(0);

    at('2026-06-08T01:00:00.000Z');
    expect(shifts.service.closeShift({ countedCashMinor: FLOAT - 1500 })).toMatchObject({
      cashRefundsTotalMinor: 1500,
      expectedCashMinor: FLOAT - 1500,
      varianceMinor: 0,
    });
  });
});

describe('the rest of the drawer hold is unchanged', () => {
  it('an unpaid refund payout still blocks the next shift from opening, a stale void claim does not', async () => {
    const shift1 = await claimedInShift1();
    forceClose(shift1);
    seedRefund(db, { returnId: 'r-1', returnRef: RETURN_REF, amountMinor: 700, paidAt: null });
    expect(pending()).toEqual({ refundPayouts: 1, voidPayouts: 0, unfinalizedSales: 0 });
    expect(openRefusal(SHIFT_2_OPENED)).toBe('drawer_activity_pending');
  });

  it('a settled payment that is not a sale yet still blocks the next shift from opening', async () => {
    const shift1 = await claimedInShift1();
    forceClose(shift1);
    seedSettlement(db, { saleId: 'sale-in-flight' });
    expect(pending()).toEqual({ refundPayouts: 0, voidPayouts: 0, unfinalizedSales: 1 });
    expect(openRefusal(SHIFT_2_OPENED)).toBe('drawer_activity_pending');
  });
});

describe('the payout view says a stale claim needs a manager exception', () => {
  it('flags a claim whose shift is gone (no open shift, or another one), and not one of the open shift', async () => {
    const shift1 = await claimedNeverKicked();
    at(LATER);
    // The claim's own shift is open: the steps are offered, the window is not closed.
    const live = viewOfV1(db, h.service);
    expect(live).toMatchObject({ state: 'claimed', claim_actions: ['retry_drawer', 'manual'] });
    expect(live.claim_window_closed).toBeUndefined();

    forceClose(shift1);
    expect(viewOfV1(db, h.service)).toMatchObject({
      state: 'claimed',
      claim_actions: [],
      claim_window_closed: true,
    });
    openShift(SHIFT_2_OPENED);
    expect(viewOfV1(db, h.service)).toMatchObject({
      state: 'claimed',
      claim_actions: [],
      claim_window_closed: true,
    });
  });

  it('carries the claim kick state and date on a stale claim only: unknown, then opened', async () => {
    const shift1 = await claimedInShift1();
    at(LATER);
    const live = viewOfV1(db, h.service);
    expect(live.claim_window_closed).toBeUndefined();
    expect(live.claim_kick_state).toBeUndefined();
    expect(live.claimed_at).toBeUndefined();

    forceClose(shift1);
    expect(viewOfV1(db, h.service)).toMatchObject({
      claim_window_closed: true,
      claim_kick_state: 'unknown',
      claimed_at: CLAIMED,
    });
  });

  it('says the drawer opened when the kick opened but the record never followed', async () => {
    const shift1 = openShift(SHIFT_1_OPENED);
    at(CLAIMED);
    h.state.kick = () => {
      // The kick opened the drawer, then the till locked before the record: claimed, kick opened.
      h.state.locked = true;
      return Promise.resolve('opened');
    };
    expect(await h.service.payOut(start)).toMatchObject({ kind: 'refused' });
    h.state.locked = false;
    forceClose(shift1);
    at(LATER);
    expect(viewOfV1(db, h.service)).toMatchObject({
      claim_window_closed: true,
      claim_kick_state: 'opened',
      claimed_at: CLAIMED,
    });
  });

  it('flags a claim of the open shift once the void day has passed (midnight during the claim)', async () => {
    await claimedNeverKicked();
    at('2026-06-08T00:30:00.000Z');
    expect(viewOfV1(db, h.service)).toMatchObject({
      state: 'claimed',
      claim_actions: [],
      claim_window_closed: true,
    });
  });
});

function rowsOf(table: string): number {
  return Number(db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0]);
}

function pendingClaimRows(): number {
  return Number(
    db.exec(
      `SELECT COUNT(*) FROM sale_void_payout_claims c
        WHERE NOT EXISTS (SELECT 1 FROM sale_void_payouts p WHERE p.void_id = c.void_id)`,
    )[0]?.values[0]?.[0],
  );
}
