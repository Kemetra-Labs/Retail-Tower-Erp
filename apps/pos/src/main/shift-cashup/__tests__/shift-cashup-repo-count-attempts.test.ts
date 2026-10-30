/**
 * RT-997 — the repository's Count Attempt facts (migration 0059, [GATED]):
 *
 *   • a close recorded with an attempt stamp writes the ACCEPTED attempt, the
 *     close and the close's link in one transaction, in that order; the
 *     attempt's count is the close's own count;
 *   • a close that rolls back leaves no attempt behind;
 *   • a close without a stamp (a shift recorded before 0059) has no attempt and
 *     no link, and still closes;
 *   • a forced close rests on the manager's accepted attempt the same way;
 *   • a refused count is appended as its own fact on the open shift, any number
 *     of times, and never on a shift that is not open;
 *   • none of it reaches the sync outbox.
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
  ShiftCashupStateError,
  type ShiftCashupRepo,
} from '../shift-cashup-repo.js';
import { ShiftFactInvalidError } from '../shift-wire.js';
import { CLOSE, NOW, OPEN, PAY_IN, S1, SCOPE, USER } from './__helpers__/shift-sync-fixture.js';

const MANAGER = '0190f5a2-3b4c-7d8e-9f01-23456789abce';
const A1 = '0192f5a2-3b4c-7d8e-9f01-0000000000c1';
const A2 = '0192f5a2-3b4c-7d8e-9f01-0000000000c2';
const AT = '2026-10-05T15:59:00.000Z';
const STAMP = { attemptId: A1, actorUserId: USER, attemptedAt: AT };

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

function openWithPayIn(): void {
  repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
  repo.recordMovement({ scope: SCOPE, fact: PAY_IN, now: NOW });
}

function all(sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

const attempts = (): unknown[][] =>
  all(
    `SELECT attempt_id, shift_id, actor_user_id, counted_cash_minor, outcome, attempted_at
       FROM shift_count_attempts ORDER BY rowid`,
  );
const links = (): unknown[][] => all('SELECT shift_id, attempt_id FROM shift_close_count_attempts');
const outboxKinds = (): unknown[] =>
  all('SELECT fact_kind FROM shift_sync_outbox ORDER BY seq').map((r) => r[0]);

describe('recordClose with a Count Attempt stamp', () => {
  it('writes the accepted attempt, the close and the link together', () => {
    openWithPayIn();
    repo.recordClose({ scope: SCOPE, fact: CLOSE, now: NOW, countAttempt: STAMP });

    expect(attempts()).toEqual([[A1, S1, USER, CLOSE.countedCashMinor, 'accepted', AT]]);
    expect(links()).toEqual([[S1, A1]]);
    expect(all('SELECT COUNT(*) FROM shift_cashup_closes')[0]?.[0]).toBe(1);
  });

  it('leaves no attempt behind when the close is refused and rolls back', () => {
    openWithPayIn();
    const wrongTotals = { ...CLOSE, payInTotalMinor: CLOSE.payInTotalMinor + 1 };
    expect(() => {
      repo.recordClose({ scope: SCOPE, fact: wrongTotals, now: NOW, countAttempt: STAMP });
    }).toThrow(ShiftFactInvalidError);

    expect(attempts()).toEqual([]);
    expect(links()).toEqual([]);
    expect(all('SELECT COUNT(*) FROM shift_cashup_closes')[0]?.[0]).toBe(0);
  });

  it('still closes without a stamp, leaving no attempt and no link', () => {
    openWithPayIn();
    repo.recordClose({ scope: SCOPE, fact: CLOSE, now: NOW });

    expect(attempts()).toEqual([]);
    expect(links()).toEqual([]);
    expect(all('SELECT COUNT(*) FROM shift_cashup_closes')[0]?.[0]).toBe(1);
  });

  it('keeps an earlier refused attempt, and the accepted one is the close’s link', () => {
    openWithPayIn();
    repo.recordRefusedCount({
      scope: SCOPE,
      attempt: {
        attemptId: A1,
        shiftId: S1,
        actorUserId: USER,
        countedCashMinor: 60_000,
        attemptedAt: AT,
      },
      now: NOW,
    });
    repo.recordClose({
      scope: SCOPE,
      fact: CLOSE,
      now: NOW,
      countAttempt: { ...STAMP, attemptId: A2 },
    });

    expect(attempts()).toEqual([
      [A1, S1, USER, 60_000, 'refused', AT],
      [A2, S1, USER, CLOSE.countedCashMinor, 'accepted', AT],
    ]);
    expect(links()).toEqual([[S1, A2]]);
  });
});

describe('recordForcedClose with a Count Attempt stamp', () => {
  it('rests on the manager’s accepted attempt', () => {
    openWithPayIn();
    repo.recordForcedClose({
      scope: SCOPE,
      fact: { ...CLOSE, closingUserId: MANAGER },
      forcedReason: 'cashier_no_show',
      now: NOW,
      countAttempt: { ...STAMP, actorUserId: MANAGER },
    });

    expect(attempts()).toEqual([[A1, S1, MANAGER, CLOSE.countedCashMinor, 'accepted', AT]]);
    expect(links()).toEqual([[S1, A1]]);
  });
});

describe('recordRefusedCount', () => {
  function refused(over: { attemptId?: string; countedCashMinor?: number } = {}): void {
    repo.recordRefusedCount({
      scope: SCOPE,
      attempt: {
        attemptId: over.attemptId ?? A1,
        shiftId: S1,
        actorUserId: USER,
        countedCashMinor: over.countedCashMinor ?? 60_000,
        attemptedAt: AT,
      },
      now: NOW,
    });
  }

  it('appends a refused attempt for the open shift, each recount as another row', () => {
    openWithPayIn();
    refused({ attemptId: A1, countedCashMinor: 60_000 });
    refused({ attemptId: A2, countedCashMinor: 60_500 });

    expect(attempts()).toEqual([
      [A1, S1, USER, 60_000, 'refused', AT],
      [A2, S1, USER, 60_500, 'refused', AT],
    ]);
    expect(links()).toEqual([]);
  });

  it('is refused for a shift the terminal does not hold open', () => {
    expect(() => {
      refused();
    }).toThrow(ShiftCashupStateError);
    openWithPayIn();
    repo.recordClose({ scope: SCOPE, fact: CLOSE, now: NOW });
    expect(() => {
      refused();
    }).toThrow(ShiftCashupStateError);
    expect(attempts()).toEqual([]);
  });

  it('never reaches the sync outbox', () => {
    openWithPayIn();
    refused();
    repo.recordClose({
      scope: SCOPE,
      fact: CLOSE,
      now: NOW,
      countAttempt: { ...STAMP, attemptId: A2 },
    });
    expect(outboxKinds()).toEqual(['open', 'movement', 'close']);
  });

  it('lets a later write of the same attempt id fail instead of replacing it', () => {
    openWithPayIn();
    refused({ attemptId: A1, countedCashMinor: 60_000 });
    expect(() => {
      refused({ attemptId: A1, countedCashMinor: 1 });
    }).toThrow(/UNIQUE|PRIMARY/);
    expect(attempts()).toEqual([[A1, S1, USER, 60_000, 'refused', AT]]);
  });
});
