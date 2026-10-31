/**
 * RT-1003 — the repository's `abandoned` Count Attempt (RT-997 follow-up, no
 * new migration: 0059 already allows the outcome):
 *
 *   • an abandoned count is appended as its own fact on the open shift, beside
 *     the refused and accepted ones, and an earlier row is never edited;
 *   • never on a shift the terminal does not hold open;
 *   • no link row and nothing in the sync outbox.
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
import { CLOSE, NOW, OPEN, PAY_IN, S1, SCOPE, USER } from './__helpers__/shift-sync-fixture.js';

const A1 = '0193f5a2-3b4c-7d8e-9f01-0000000000d1';
const A2 = '0193f5a2-3b4c-7d8e-9f01-0000000000d2';
const A3 = '0193f5a2-3b4c-7d8e-9f01-0000000000d3';
const AT = '2026-10-05T15:59:00.000Z';

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

function attempt(attemptId: string, countedCashMinor: number) {
  return { attemptId, shiftId: S1, actorUserId: USER, countedCashMinor, attemptedAt: AT };
}

function abandoned(attemptId = A1, countedCashMinor = 60_000): void {
  repo.recordAbandonedCount({
    scope: SCOPE,
    attempt: attempt(attemptId, countedCashMinor),
    now: NOW,
  });
}

describe('recordAbandonedCount', () => {
  it('appends an abandoned attempt for the open shift', () => {
    openWithPayIn();
    abandoned(A1, 60_000);

    expect(attempts()).toEqual([[A1, S1, USER, 60_000, 'abandoned', AT]]);
  });

  it('sits beside a refused attempt of the same count and the accepted one, unedited', () => {
    openWithPayIn();
    repo.recordRefusedCount({ scope: SCOPE, attempt: attempt(A1, 60_000), now: NOW });
    abandoned(A2, 60_000);
    repo.recordClose({
      scope: SCOPE,
      fact: CLOSE,
      now: NOW,
      countAttempt: { attemptId: A3, actorUserId: USER, attemptedAt: AT },
    });

    expect(attempts()).toEqual([
      [A1, S1, USER, 60_000, 'refused', AT],
      [A2, S1, USER, 60_000, 'abandoned', AT],
      [A3, S1, USER, CLOSE.countedCashMinor, 'accepted', AT],
    ]);
    expect(all('SELECT attempt_id FROM shift_close_count_attempts')).toEqual([[A3]]);
  });

  it('is refused for a shift the terminal does not hold open', () => {
    expect(() => {
      abandoned();
    }).toThrow(ShiftCashupStateError);
    openWithPayIn();
    repo.recordClose({ scope: SCOPE, fact: CLOSE, now: NOW });
    expect(() => {
      abandoned();
    }).toThrow(ShiftCashupStateError);
    expect(attempts()).toEqual([]);
  });

  it('writes no link and nothing to the sync outbox', () => {
    openWithPayIn();
    abandoned();

    expect(all('SELECT COUNT(*) FROM shift_close_count_attempts')).toEqual([[0]]);
    expect(all('SELECT fact_kind FROM shift_sync_outbox ORDER BY seq').map((r) => r[0])).toEqual([
      'open',
      'movement',
    ]);
  });
});
