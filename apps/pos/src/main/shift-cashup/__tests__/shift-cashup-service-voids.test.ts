/**
 * RT-530 / RT-1403 S2 — the cash of a voided sale in the shift cash-up, counted like a cash
 * refund, from the PAYOUT RECORD (migration 0069), never from the void request.
 *
 * A request moves no cash (RT-530 c12022). The cash a void paid out (the gated payout of a
 * confirmed void, or a manager-attested exception) reduces the expected drawer cash and is
 * reported in the close's `cashRefundsTotal` (the wire is unchanged: it names no return, so it
 * adds no refund reference), in the window the payout was PAID. A void with no payout counts
 * nothing, whatever its state.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createSaleVoidPayoutRepository } from '../../sale-void/sale-void-payout-repository.js';
import { createShiftCashupSources } from '../shift-cashup-sources.js';
import { createSaleVoidRepository } from '../../sale-void/sale-void-repository.js';
import { newVoidEntry } from '../../sale-void/__tests__/__helpers__/sale-void-fixture.js';
import { seedApproval } from '../../sale-void/__tests__/__helpers__/sale-void-payout-fixture.js';
import { computeCashup } from '../shift-cashup-calculator.js';
import type { ShiftCashupService } from '../shift-cashup-service.js';
import {
  CLOSED_AT,
  OPENED_AT,
  cardLine,
  cashLine,
  seedRefund,
  seedShiftSale,
  serviceHarness,
  storedBody,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';
import { SCOPE } from './__helpers__/shift-sync-fixture.js';

const FLOAT = 50_000;
const REF = '0192f5a2-3b4c-7d8e-9f01-0000000000c1';
const BUSINESS_DATE = '2026-10-05';
const REQUESTED_AT = '2026-10-05T09:00:00.000Z';
const PAID_AT = '2026-10-05T12:00:00.000Z';
const APPROVAL_N = (n: number): string => `0190f5a2-7b3c-7d4e-8f90-0000000000${String(n)}0`;
const PAYOUT_N = (n: number): string => `0192f5a2-3b4c-7d8e-9f01-00000000b0${String(n)}0`;
const EXCEPTION_APPROVAL = (n: number): string => `0190f5a2-7b3c-7d4e-8f90-0000000001${String(n)}0`;
const APPROVER = '0190f5a2-7b3c-7d4e-8f90-0000000000b1';
const REQUESTER = '0190f5a2-7b3c-7d4e-8f90-0000000000b2';

let db: SqlJsDatabase;
let harness: ServiceHarness;
let service: ShiftCashupService;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  harness = serviceHarness(db);
  service = harness.service;
});

afterEach(() => {
  db.close();
});

function openShiftId(): string {
  const id = db.exec('SELECT shift_id FROM shift_cashup_opens')[0]?.values[0]?.[0];
  if (typeof id !== 'string') throw new Error('fixture: no open shift');
  return id;
}

/** Journal void `n` of `saleId` (cash `cash`) and move it to `state`; no cash has left yet. */
function journalVoid(input: {
  n: number;
  saleId: string;
  cash: number;
  state: 'pending' | 'confirmed' | 'refused';
}): void {
  const repo = createSaleVoidRepository(handleFor(db));
  const voidId = `v${String(input.n)}`;
  repo.insert(
    newVoidEntry(input.n, {
      scope: SCOPE,
      saleId: input.saleId,
      approvalId: APPROVAL_N(input.n),
      businessDate: BUSINESS_DATE,
      amountMinor: input.cash,
      cashMinor: input.cash,
      now: REQUESTED_AT,
    }),
  );
  if (input.state === 'confirmed') {
    repo.markConfirmed({ voidId, voidRef: REF, now: REQUESTED_AT });
  } else if (input.state === 'refused') {
    repo.markRefused({ voidId, reason: 'void_self_approval', now: REQUESTED_AT });
  }
}

/** Record the cash of void `n` as paid out at `paidAt` (a payout, or an exception when not confirmed). */
function payOut(input: { n: number; saleId: string; cash: number; paidAt?: string }): void {
  const voidState = db.exec(
    `SELECT state FROM sale_void_journal WHERE void_id = 'v${String(input.n)}'`,
  )[0]?.values[0]?.[0];
  const confirmed = voidState === 'confirmed';
  const claimed = db.exec(
    `SELECT 1 FROM sale_void_payout_claims WHERE void_id = 'v${String(input.n)}'`,
  )[0];
  // A payout completes its claim (the drawer opened first); an exception cites its spent approval.
  if (confirmed && claimed === undefined) claimPayout(input.n, input.saleId, 'opened');
  if (!confirmed) {
    seedApproval(db, {
      approvalId: EXCEPTION_APPROVAL(input.n),
      voidId: `v${String(input.n)}`,
      approver: APPROVER,
      requester: REQUESTER,
      amount: input.cash,
    });
  }
  createSaleVoidPayoutRepository(handleFor(db)).insertFrom(() => ({
    payoutId: PAYOUT_N(input.n),
    voidId: `v${String(input.n)}`,
    saleId: input.saleId,
    scope: SCOPE,
    shiftId: openShiftId(),
    businessDate: BUSINESS_DATE,
    kind: confirmed ? 'payout' : 'exception',
    method: confirmed ? 'drawer' : 'manual',
    amountMinor: input.cash,
    currencyCode: 'EGP',
    voidState: voidState === 'refused' ? 'refused' : confirmed ? 'confirmed' : 'pending',
    mismatchReason: confirmed
      ? null
      : voidState === 'refused'
        ? 'void_refused'
        : 'void_unconfirmed',
    paidAt: input.paidAt ?? PAID_AT,
    paidBy: { operatorId: 'op-cashier', displayName: 'Cara', sessionId: 'sess-1' },
    exception: confirmed
      ? null
      : {
          approvalId: EXCEPTION_APPROVAL(input.n),
          approverUserId: APPROVER,
          requesterUserId: REQUESTER,
          policyVersion: 'rt114-2026-10-07',
        },
  }));
}

function openAndAdvance(): ShiftCashupService {
  service.openShift({ openingFloatMinor: FLOAT });
  harness.state.clock = CLOSED_AT;
  return service;
}

/** Open the shift, sell cash, journal a void, and leave the clock at the close. */
function openWithSale(saleId: string, cash: number): void {
  service.openShift({ openingFloatMinor: FLOAT });
  seedShiftSale(db, { saleId, finalizedAt: OPENED_AT, lines: [cashLine(cash)] });
}

describe('computeCashup with void payouts', () => {
  const base = {
    currencyCode: 'EGP',
    openingFloatMinor: FLOAT,
    payInTotalMinor: 0,
    payOutTotalMinor: 0,
    refunds: [],
  };
  const sale = (lines: ReadonlyArray<Record<string, unknown>>) => ({
    tenderLinesSummaryJson: JSON.stringify(lines),
  });
  const paid = (amountMinor: number, currencyCode = 'EGP') => ({ amountMinor, currencyCode });

  it('subtracts the paid-out cash, like a cash refund, and names no return', () => {
    const result = computeCashup({
      ...base,
      sales: [sale([cashLine(2_000, 500)])],
      voids: [paid(1_500)],
    });
    expect(result).toEqual({
      cashSalesTotalMinor: 1_500,
      cashRefundsTotalMinor: 1_500,
      expectedCashMinor: FLOAT,
      saleCount: 1,
      cashRefundReturnRefs: [],
    });
  });

  it('adds payouts to the refunds of returns in one total', () => {
    const result = computeCashup({
      ...base,
      sales: [],
      refunds: [{ returnRef: REF, amountMinor: 700, currencyCode: 'EGP' }],
      voids: [paid(300), paid(200)],
    });
    expect(result.cashRefundsTotalMinor).toBe(1_200);
    expect(result.cashRefundReturnRefs).toEqual([REF]);
    expect(result.expectedCashMinor).toBe(FLOAT - 1_200);
  });

  it('counts nothing without payouts', () => {
    expect(computeCashup({ ...base, sales: [] }).cashRefundsTotalMinor).toBe(0);
    expect(computeCashup({ ...base, sales: [], voids: [] }).cashRefundsTotalMinor).toBe(0);
  });

  it.each([
    ['an amount that is not a safe non-negative integer', paid(-1), 'invalid_void_payout'],
    ['a fractional amount', paid(1.5), 'invalid_void_payout'],
    ['another currency than the shift', paid(100, 'USD'), 'void_payout_currency_mismatch'],
  ] as const)('refuses %s', (_name, payout, reason) => {
    expect(() => computeCashup({ ...base, sales: [], voids: [payout] })).toThrow(
      expect.objectContaining({ reason }) as Error,
    );
  });
});

describe('closeShift counts the cash a void paid out', () => {
  it('a sale and its paid-out void in the same shift net to the float, the close reports a refund', () => {
    openWithSale('sale-1', 1_500);
    journalVoid({ n: 1, saleId: 'sale-1', cash: 1_500, state: 'confirmed' });
    payOut({ n: 1, saleId: 'sale-1', cash: 1_500 });
    harness.state.clock = CLOSED_AT;
    const closed = service.closeShift({ countedCashMinor: FLOAT });
    expect(closed).toMatchObject({
      cashSalesTotalMinor: 1_500,
      cashRefundsTotalMinor: 1_500,
      expectedCashMinor: FLOAT,
      varianceMinor: 0,
    });
    expect(storedBody(db, 2)).toMatchObject({
      cashSalesTotal: '15.00',
      cashRefundsTotal: '15.00',
      expectedCash: '500.00',
      cashRefundReturnRefs: [],
    });
  });

  it('counts nothing for a void with no payout, whatever its state (a request moves no cash)', () => {
    openWithSale('sale-1', 1_000);
    seedShiftSale(db, { saleId: 'sale-2', finalizedAt: OPENED_AT, lines: [cashLine(2_000)] });
    seedShiftSale(db, { saleId: 'sale-3', finalizedAt: OPENED_AT, lines: [cashLine(4_000)] });
    journalVoid({ n: 1, saleId: 'sale-1', cash: 1_000, state: 'pending' });
    journalVoid({ n: 2, saleId: 'sale-2', cash: 2_000, state: 'confirmed' });
    journalVoid({ n: 3, saleId: 'sale-3', cash: 4_000, state: 'refused' });
    harness.state.clock = CLOSED_AT;
    const closed = service.closeShift({ countedCashMinor: FLOAT + 7_000 });
    expect(closed).toMatchObject({
      cashSalesTotalMinor: 7_000,
      cashRefundsTotalMinor: 0,
      expectedCashMinor: FLOAT + 7_000,
    });
  });

  it('counts a manager-attested exception for a refused void: its cash left the drawer', () => {
    openWithSale('sale-1', 4_000);
    journalVoid({ n: 1, saleId: 'sale-1', cash: 4_000, state: 'refused' });
    payOut({ n: 1, saleId: 'sale-1', cash: 4_000 });
    harness.state.clock = CLOSED_AT;
    const closed = service.closeShift({ countedCashMinor: FLOAT });
    expect(closed).toMatchObject({ cashRefundsTotalMinor: 4_000, expectedCashMinor: FLOAT });
  });

  it('counts a payout in the shift it was paid in, even when an earlier shift sold the sale', () => {
    seedShiftSale(db, {
      saleId: 'sale-0',
      finalizedAt: '2026-10-05T06:00:00.000Z',
      lines: [cashLine(4_000)],
    });
    service.openShift({ openingFloatMinor: FLOAT });
    journalVoid({ n: 1, saleId: 'sale-0', cash: 4_000, state: 'confirmed' });
    payOut({ n: 1, saleId: 'sale-0', cash: 4_000 });
    harness.state.clock = CLOSED_AT;
    const closed = service.closeShift({ countedCashMinor: FLOAT - 4_000 });
    expect(closed).toMatchObject({
      cashSalesTotalMinor: 0,
      cashRefundsTotalMinor: 4_000,
      expectedCashMinor: FLOAT - 4_000,
      varianceMinor: 0,
    });
  });

  it('does not count a payout paid after the close time (outside the window)', () => {
    openWithSale('sale-1', 1_000);
    journalVoid({ n: 1, saleId: 'sale-1', cash: 1_000, state: 'confirmed' });
    payOut({ n: 1, saleId: 'sale-1', cash: 1_000, paidAt: '2026-10-05T20:00:00.000Z' });
    harness.state.clock = CLOSED_AT;
    const closed = service.closeShift({ countedCashMinor: FLOAT + 1_000 });
    expect(closed).toMatchObject({ cashRefundsTotalMinor: 0 });
  });

  it('counts a card-only voided sale as no cash (nothing can be paid out)', () => {
    service.openShift({ openingFloatMinor: FLOAT });
    seedShiftSale(db, { saleId: 'sale-1', finalizedAt: OPENED_AT, lines: [cardLine(9_000)] });
    journalVoid({ n: 1, saleId: 'sale-1', cash: 0, state: 'confirmed' });
    harness.state.clock = CLOSED_AT;
    expect(service.closeShift({ countedCashMinor: FLOAT })).toMatchObject({
      cashRefundsTotalMinor: 0,
    });
  });

  it('a payout and a return refund add up in the close', () => {
    openWithSale('sale-1', 1_000);
    journalVoid({ n: 1, saleId: 'sale-1', cash: 1_000, state: 'confirmed' });
    payOut({ n: 1, saleId: 'sale-1', cash: 1_000 });
    seedRefund(db, { returnId: 'r-1', returnRef: REF, amountMinor: 700, paidAt: CLOSED_AT });
    harness.state.clock = CLOSED_AT;
    const closed = service.closeShift({ countedCashMinor: FLOAT - 700 });
    expect(closed).toMatchObject({ cashRefundsTotalMinor: 1_700, expectedCashMinor: FLOAT - 700 });
    expect(storedBody(db, 2)).toMatchObject({ cashRefundReturnRefs: [REF] });
  });

  it('never counts the same payout in two closes', () => {
    openWithSale('sale-1', 1_000);
    journalVoid({ n: 1, saleId: 'sale-1', cash: 1_000, state: 'confirmed' });
    payOut({ n: 1, saleId: 'sale-1', cash: 1_000 });
    harness.state.clock = CLOSED_AT;
    service.closeShift({ countedCashMinor: FLOAT });
    harness.state.clock = '2026-10-05T18:00:00.000Z';
    service.openShift({ openingFloatMinor: FLOAT });
    harness.state.clock = '2026-10-05T23:00:00.000Z';
    const second = service.closeShift({ countedCashMinor: FLOAT });
    expect(second).toMatchObject({ cashRefundsTotalMinor: 0, expectedCashMinor: FLOAT });
  });
});

/** Claim the payout of void `n` (confirmed), its drawer kicked to `kick`, with no record yet. */
function claimPayout(n: number, saleId: string, kick: 'opened' | 'sending'): void {
  const payouts = createSaleVoidPayoutRepository(handleFor(db));
  const voidId = `v${String(n)}`;
  payouts.startClaim({
    voidId,
    saleId,
    scope: SCOPE,
    shiftId: openShiftId(),
    businessDate: BUSINESS_DATE,
    claimedBy: { operatorId: 'op-manager', displayName: 'Mona', sessionId: 'sess-1' },
    claimedAt: PAID_AT,
  });
  payouts.markSending({ voidId, now: PAID_AT });
  if (kick === 'opened') payouts.recordKick({ voidId, outcome: 'opened' });
}

describe('a claimed void payout holds the drawer (RT-1403 S2: H1, M1)', () => {
  it('counts the claim as drawer activity in flight until its record exists', () => {
    openWithSale('sale-1', 1_000);
    journalVoid({ n: 1, saleId: 'sale-1', cash: 1_000, state: 'confirmed' });
    const sources = createShiftCashupSources(handleFor(db));
    expect(sources.pendingDrawerActivity(SCOPE).voidPayouts).toBe(0);
    claimPayout(1, 'sale-1', 'opened');
    expect(sources.pendingDrawerActivity(SCOPE).voidPayouts).toBe(1);
    expect(sources.pendingDrawerActivity({ ...SCOPE, terminalId: 'term-2' }).voidPayouts).toBe(0);
    payOut({ n: 1, saleId: 'sale-1', cash: 1_000 });
    expect(sources.pendingDrawerActivity(SCOPE).voidPayouts).toBe(0);
  });

  it.each(['opened', 'sending'] as const)(
    'refuses the close while a claim (kick %s) has no record, then closes once it has',
    (kick) => {
      openWithSale('sale-1', 1_000);
      journalVoid({ n: 1, saleId: 'sale-1', cash: 1_000, state: 'confirmed' });
      claimPayout(1, 'sale-1', kick);
      harness.state.clock = CLOSED_AT;
      expect(() => service.closeShift({ countedCashMinor: FLOAT + 1_000 })).toThrow(
        expect.objectContaining({ reason: 'drawer_activity_pending' }) as Error,
      );
      // The kick resolves (it opened), then the record completes the claim.
      createSaleVoidPayoutRepository(handleFor(db)).recordKick({ voidId: 'v1', outcome: 'opened' });
      payOut({ n: 1, saleId: 'sale-1', cash: 1_000 });
      expect(service.closeShift({ countedCashMinor: FLOAT })).toMatchObject({
        cashRefundsTotalMinor: 1_000,
      });
    },
  );
});

describe('openAndAdvance', () => {
  it('opens a shift and moves the clock to the close (fixture sanity)', () => {
    const svc = openAndAdvance();
    expect(typeof svc.closeShift).toBe('function');
    expect(harness.state.clock).toBe(CLOSED_AT);
  });
});
