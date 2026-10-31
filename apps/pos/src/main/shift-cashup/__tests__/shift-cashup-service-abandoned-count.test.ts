/**
 * RT-1003 — the cashier walked away from a blind count they had entered (the
 * renderer's `abandonCount`). Over the real repository on the full migration
 * stack:
 *
 *   • the count is appended as an `abandoned` attempt of the admitted cashier
 *     on the terminal's open shift, at the till's own instant; a walk-away
 *     after a refused count adds a row and never edits the refused one;
 *   • main derives the actor, the shift, the id and the time: the request
 *     carries the amount only;
 *   • nothing is evaluated: no cash-up, no probe tally, no refusal for drawer
 *     cash in flight, and nothing reaches the status (the count stays blind);
 *   • refused, writing nothing, without a usable cashier session, without an
 *     open shift, or for an implausible amount.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  CLOSED_AT,
  managerSession,
  seedSettlement,
  serviceHarness,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';
import { USER } from './__helpers__/shift-sync-fixture.js';

const FLOAT = 50_000;

let db: SqlJsDatabase;
let harness: ServiceHarness;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  harness = serviceHarness(db);
});

afterEach(() => {
  db.close();
});

function refusal(reason: string): Error {
  return expect.objectContaining({ reason }) as Error;
}

function openShift(): string {
  const { shiftId } = harness.service.openShift({ openingFloatMinor: FLOAT });
  harness.state.clock = CLOSED_AT;
  return shiftId;
}

function rows(sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

/** (shift, actor, counted, outcome, attempted_at) of every attempt, in order. */
function attempts(): unknown[][] {
  return rows(
    `SELECT shift_id, actor_user_id, counted_cash_minor, outcome, attempted_at
       FROM shift_count_attempts ORDER BY rowid`,
  );
}

describe('recordAbandonedCount', () => {
  it('appends the abandoned count of the admitted cashier on the open shift', () => {
    const shiftId = openShift();
    harness.service.recordAbandonedCount({ countedCashMinor: FLOAT - 250 });

    expect(attempts()).toEqual([[shiftId, USER, FLOAT - 250, 'abandoned', CLOSED_AT]]);
  });

  it('adds a row after a refused count of the same amount, which stays as it was', () => {
    const shiftId = openShift();
    expect(() => harness.service.closeShift({ countedCashMinor: FLOAT - 500 })).toThrow(
      refusal('variance_approval_required'),
    );
    harness.service.recordAbandonedCount({ countedCashMinor: FLOAT - 500 });

    expect(attempts()).toEqual([
      [shiftId, USER, FLOAT - 500, 'refused', CLOSED_AT],
      [shiftId, USER, FLOAT - 500, 'abandoned', CLOSED_AT],
    ]);
  });

  it('evaluates nothing: drawer cash in flight does not refuse it and no probe is tallied', async () => {
    openShift();
    seedSettlement(db, { saleId: 'in-flight' });
    harness.service.recordAbandonedCount({ countedCashMinor: FLOAT - 500 });

    expect(attempts()).toHaveLength(1);
    const status = await harness.service.readStatus();
    expect(status.probeRefusals).toEqual({ payOut: 0, varianceClose: 0, approverFailure: 0 });
    expect(JSON.stringify(status)).not.toMatch(/attempt|abandon/i);
  });

  it('lets the shift close afterwards on the accepted count', () => {
    openShift();
    harness.service.recordAbandonedCount({ countedCashMinor: FLOAT - 1 });
    harness.service.closeShift({ countedCashMinor: FLOAT });

    expect(attempts().map((r) => r[3])).toEqual(['abandoned', 'accepted']);
  });
});

describe('recordAbandonedCount writes nothing when refused', () => {
  it('without an open shift', () => {
    expect(() => {
      harness.service.recordAbandonedCount({ countedCashMinor: FLOAT });
    }).toThrow(refusal('shift_not_open'));
    expect(attempts()).toEqual([]);
  });

  it('for an amount above the plausibility cap', () => {
    openShift();
    expect(() => {
      harness.service.recordAbandonedCount({ countedCashMinor: 9_999_999_999 });
    }).toThrow(refusal('amount_out_of_range'));
    expect(attempts()).toEqual([]);
  });

  it('with the flag off, the session locked, signed out or without a cashier identity', () => {
    openShift();
    const tryIt = (): void => {
      harness.service.recordAbandonedCount({ countedCashMinor: FLOAT });
    };

    harness.state.enabled = false;
    expect(tryIt).toThrow(refusal('feature_disabled'));
    harness.state.enabled = true;
    harness.state.locked = true;
    expect(tryIt).toThrow(refusal('session_locked'));
    harness.state.locked = false;
    const cashier = harness.state.session;
    harness.state.session = null;
    expect(tryIt).toThrow(refusal('no_session'));
    harness.state.session = managerSession(); // a session with no users.id
    expect(tryIt).toThrow(refusal('no_cashier_identity'));
    harness.state.session = cashier;

    expect(attempts()).toEqual([]);
  });
});
