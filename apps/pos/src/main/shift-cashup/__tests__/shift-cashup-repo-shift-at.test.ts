/**
 * RT-1543 follow-up — `findShiftAt`: the shift that was open on a terminal at an instant, from the
 * local open / close / manager-closure records. A return payout claimed while a shift was open
 * reports its refund execution with that shift even when the shift is gone by the time the payout
 * completes (a manager force-closed it on the server).
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  createShiftCashupRepo,
  type ShiftCashupRepo,
  type ShiftScope,
} from '../shift-cashup-repo.js';
import type { ShiftCloseFact, ShiftOpenFact } from '../shift-wire.js';

const SCOPE: ShiftScope = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' };
const OTHER_TERMINAL: ShiftScope = { ...SCOPE, terminalId: 'term-2' };
const S1 = '0192f5a2-3b4c-7d8e-9f01-000000000001';
const S2 = '0192f5a2-3b4c-7d8e-9f01-000000000002';
const USER = '0190f5a2-3b4c-7d8e-9f01-23456789abcd';

const at = (hhmm: string): string => `2026-10-05T${hhmm}:00.000Z`;

function openFact(shiftId: string, openedAt: string): ShiftOpenFact {
  return {
    shiftId,
    openedAt,
    openingUserId: USER,
    currencyCode: 'EGP',
    openingFloatMinor: 50_000,
  };
}

function closeFact(shiftId: string, closedAt: string): ShiftCloseFact {
  return {
    shiftId,
    closedAt,
    closingUserId: USER,
    openingFloatMinor: 50_000,
    cashSalesTotalMinor: 0,
    cashRefundsTotalMinor: 0,
    payInTotalMinor: 0,
    payOutTotalMinor: 0,
    expectedCashMinor: 50_000,
    countedCashMinor: 50_000,
    varianceMinor: 0,
    saleCount: 0,
    cashRefundReturnRefs: [],
  };
}

let db: SqlJsDatabase;
let repo: ShiftCashupRepo;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  repo = createShiftCashupRepo(handleFor(db));
});

afterEach(() => {
  db.close();
});

function open(shiftId: string, openedAt: string): number {
  return repo.recordOpen({ scope: SCOPE, fact: openFact(shiftId, openedAt), now: openedAt }).seq;
}

describe('findShiftAt', () => {
  it('is null for a terminal that never opened a shift, and for an unreadable instant', () => {
    expect(repo.findShiftAt(SCOPE, at('10:00'))).toBeNull();
    open(S1, at('08:00'));
    expect(repo.findShiftAt(SCOPE, 'not-a-date')).toBeNull();
  });

  it('is the shift that was open at the instant', () => {
    open(S1, at('08:00'));
    expect(repo.findShiftAt(SCOPE, at('10:00'))).toBe(S1);
    expect(repo.findShiftAt(SCOPE, at('08:00'))).toBe(S1);
  });

  it('is null before the shift opened', () => {
    open(S1, at('08:00'));
    expect(repo.findShiftAt(SCOPE, at('07:59'))).toBeNull();
  });

  it('is null for another terminal', () => {
    open(S1, at('08:00'));
    expect(repo.findShiftAt(OTHER_TERMINAL, at('10:00'))).toBeNull();
  });

  it('still names the shift after a manager closed it later (the closure came after the instant)', () => {
    const seq = open(S1, at('08:00'));
    repo.recordManagerClosure({ seq, now: at('10:30'), shiftId: S1, factKind: 'open' });
    expect(repo.findOpenShift(SCOPE)).toBeNull();
    expect(repo.findShiftAt(SCOPE, at('10:00'))).toBe(S1);
  });

  it('is null at an instant the till already knew of the manager closure', () => {
    const seq = open(S1, at('08:00'));
    repo.recordManagerClosure({ seq, now: at('09:00'), shiftId: S1, factKind: 'open' });
    expect(repo.findShiftAt(SCOPE, at('10:00'))).toBeNull();
    expect(repo.findShiftAt(SCOPE, at('08:30'))).toBe(S1);
  });

  it('follows a normal close: open before it, not after', () => {
    open(S1, at('08:00'));
    repo.recordClose({ scope: SCOPE, fact: closeFact(S1, at('16:00')), now: at('16:00') });
    expect(repo.findShiftAt(SCOPE, at('15:59'))).toBe(S1);
    expect(repo.findShiftAt(SCOPE, at('16:00'))).toBeNull();
    expect(repo.findShiftAt(SCOPE, at('17:00'))).toBeNull();
  });

  it('picks the shift of each period among several', () => {
    open(S1, at('08:00'));
    repo.recordClose({ scope: SCOPE, fact: closeFact(S1, at('12:00')), now: at('12:00') });
    open(S2, at('13:00'));
    expect(repo.findShiftAt(SCOPE, at('09:00'))).toBe(S1);
    expect(repo.findShiftAt(SCOPE, at('12:30'))).toBeNull();
    expect(repo.findShiftAt(SCOPE, at('14:00'))).toBe(S2);
    expect(repo.findOpenShift(SCOPE)?.shiftId).toBe(S2);
  });
});
