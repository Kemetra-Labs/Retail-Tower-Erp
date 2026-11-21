/**
 * RT-997 — every shift Count Attempt is an append-only local fact before the
 * close (migration 0059, [GATED]). Over the real repository on the full
 * migration stack:
 *
 *   • AC1: two counts on one shift, the first refused and the second accepted,
 *     leave two attempt facts, and the close rests on the accepted one — both
 *     with a manager's approval of the same count and with a recount that
 *     needs none;
 *   • a count is an attempt only once the till EVALUATED it: a scanned count
 *     above the cap, a missing shift, drawer cash in flight and an unusable
 *     manager session write nothing;
 *   • a failed manager approval, and an approval gone stale, are refused
 *     attempts of their own;
 *   • a forced close's manager count is an accepted attempt by the manager;
 *   • the cashier is told nothing new (the refusal is the same as before) and
 *     the status shows no attempt: the count stays blind.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  CLOSED_AT,
  MANAGER,
  MANAGER_PIN,
  MANAGER_REF,
  cashLine,
  managerSession,
  seedSettlement,
  seedShiftSale,
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
  harness = serviceHarness(db); // the fixture's policy: any variance needs a manager
});

afterEach(() => {
  db.close();
});

function refusal(reason: string): Error {
  return expect.objectContaining({ name: 'ShiftCashupRefusedError', reason }) as Error;
}

/** Open at `OPENED_AT` with `FLOAT`, then move the clock to `CLOSED_AT`. */
function openShift(): string {
  const { shiftId } = harness.service.openShift({ openingFloatMinor: FLOAT });
  harness.state.clock = CLOSED_AT;
  return shiftId;
}

function rows(sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

/** (counted, outcome, actor) of every attempt, in the order recorded. */
function attempts(): unknown[][] {
  return rows(
    `SELECT counted_cash_minor, outcome, actor_user_id FROM shift_count_attempts ORDER BY rowid`,
  );
}

function links(): unknown[][] {
  return rows(
    `SELECT l.shift_id, a.counted_cash_minor, a.outcome
       FROM shift_close_count_attempts l JOIN shift_count_attempts a ON a.attempt_id = l.attempt_id`,
  );
}

describe('AC1: a refused count, then an accepted one, on one shift', () => {
  it('records both attempts when the second is the same count with a manager’s approval', async () => {
    const shiftId = openShift();
    expect(() => harness.service.closeShift({ countedCashMinor: FLOAT - 500 })).toThrow(
      refusal('variance_approval_required'),
    );
    expect(attempts()).toEqual([[FLOAT - 500, 'refused', USER]]);
    expect(links()).toEqual([]);

    const approver = await harness.service.verifyApprover({
      countedCashMinor: FLOAT - 500,
      managerRef: MANAGER_REF,
      managerPin: MANAGER_PIN,
    });
    harness.service.closeShift({ countedCashMinor: FLOAT - 500, ...(approver && { approver }) });

    expect(attempts()).toEqual([
      [FLOAT - 500, 'refused', USER],
      [FLOAT - 500, 'accepted', USER],
    ]);
    expect(links()).toEqual([[shiftId, FLOAT - 500, 'accepted']]);
  });

  it('records both attempts when the second is a recount that needs no manager', () => {
    const shiftId = openShift();
    expect(() => harness.service.closeShift({ countedCashMinor: FLOAT - 500 })).toThrow(
      refusal('variance_approval_required'),
    );
    harness.service.closeShift({ countedCashMinor: FLOAT });

    expect(attempts()).toEqual([
      [FLOAT - 500, 'refused', USER],
      [FLOAT, 'accepted', USER],
    ]);
    expect(links()).toEqual([[shiftId, FLOAT, 'accepted']]);
  });

  it('keeps every refused recount, and the earlier rows are never edited', () => {
    openShift();
    for (const counted of [FLOAT - 100, FLOAT - 200, FLOAT + 300]) {
      expect(() => harness.service.closeShift({ countedCashMinor: counted })).toThrow(
        refusal('variance_approval_required'),
      );
    }
    harness.service.closeShift({ countedCashMinor: FLOAT });

    expect(attempts()).toEqual([
      [FLOAT - 100, 'refused', USER],
      [FLOAT - 200, 'refused', USER],
      [FLOAT + 300, 'refused', USER],
      [FLOAT, 'accepted', USER],
    ]);
  });

  it('stamps each attempt with the instant the count was evaluated', () => {
    openShift();
    expect(() => harness.service.closeShift({ countedCashMinor: FLOAT - 1 })).toThrow();
    harness.state.clock = '2026-10-05T16:05:00.000Z';
    harness.service.closeShift({ countedCashMinor: FLOAT });

    expect(rows('SELECT attempted_at FROM shift_count_attempts ORDER BY rowid')).toEqual([
      [CLOSED_AT],
      ['2026-10-05T16:05:00.000Z'],
    ]);
  });
});

describe('a count is an attempt only once the till evaluated it', () => {
  it('writes nothing for a count above the plausibility cap (a scanned barcode)', () => {
    openShift();
    expect(() => harness.service.closeShift({ countedCashMinor: 9_999_999_999 })).toThrow(
      refusal('amount_out_of_range'),
    );
    expect(attempts()).toEqual([]);
  });

  it('writes nothing when there is no open shift', () => {
    expect(() => harness.service.closeShift({ countedCashMinor: FLOAT })).toThrow(
      expect.objectContaining({ reason: 'shift_not_open' }) as Error,
    );
    expect(attempts()).toEqual([]);
  });

  it('writes nothing while drawer cash is in flight', () => {
    openShift();
    seedSettlement(db, { saleId: 'in-flight' });
    expect(() => harness.service.closeShift({ countedCashMinor: FLOAT })).toThrow(
      refusal('drawer_activity_pending'),
    );
    expect(attempts()).toEqual([]);
  });

  it('writes nothing when the session is locked or the flag is off', () => {
    openShift();
    harness.state.locked = true;
    expect(() => harness.service.closeShift({ countedCashMinor: FLOAT })).toThrow(
      refusal('session_locked'),
    );
    harness.state.locked = false;
    harness.state.enabled = false;
    expect(() => harness.service.closeShift({ countedCashMinor: FLOAT })).toThrow(
      refusal('feature_disabled'),
    );
    expect(attempts()).toEqual([]);
  });

  it('writes nothing for a zero-variance verifyApprover (no approver is asked)', async () => {
    openShift();
    await harness.service.verifyApprover({
      countedCashMinor: FLOAT,
      managerRef: MANAGER_REF,
      managerPin: MANAGER_PIN,
    });
    expect(attempts()).toEqual([]);
  });
});

describe('a manager approval that fails, or goes stale, is a refused attempt', () => {
  it('records a wrong PIN as a refused attempt of that count', async () => {
    openShift();
    harness.state.verdict = { kind: 'invalid' };
    await expect(
      harness.service.verifyApprover({
        countedCashMinor: FLOAT - 500,
        managerRef: MANAGER_REF,
        managerPin: MANAGER_PIN,
      }),
    ).rejects.toThrow(refusal('approver_invalid'));
    expect(attempts()).toEqual([[FLOAT - 500, 'refused', USER]]);
    expect(links()).toEqual([]);
  });

  it('records an approval that went stale (the drawer moved) as a refused attempt', async () => {
    openShift();
    const approver = await harness.service.verifyApprover({
      countedCashMinor: FLOAT - 500,
      managerRef: MANAGER_REF,
      managerPin: MANAGER_PIN,
    });
    seedShiftSale(db, { saleId: 's-1', finalizedAt: CLOSED_AT, lines: [cashLine(40)] });
    expect(() =>
      harness.service.closeShift({
        countedCashMinor: FLOAT - 500,
        ...(approver && { approver }),
      }),
    ).toThrow(refusal('approval_stale'));

    expect(attempts()).toEqual([[FLOAT - 500, 'refused', USER]]);
    expect(rows('SELECT COUNT(*) FROM shift_cashup_closes')).toEqual([[0]]);
  });
});

describe('a forced close', () => {
  const forced = (shiftId: string) => ({
    shiftId,
    countedCashMinor: FLOAT - 700,
    forcedReason: 'cashier_no_show',
    managerUserId: MANAGER,
    operatorSessionId: managerSession().operator_session_id,
  });

  it('rests on the manager’s accepted attempt', () => {
    harness = serviceHarness(db, { varianceApprovalThresholdMinor: null });
    const shiftId = openShift();
    harness.state.session = managerSession();
    harness.service.forceCloseShift(forced(shiftId));

    expect(attempts()).toEqual([[FLOAT - 700, 'accepted', MANAGER]]);
    expect(links()).toEqual([[shiftId, FLOAT - 700, 'accepted']]);
  });

  it('records a count the variance policy refused as the manager’s refused attempt', () => {
    const shiftId = openShift();
    harness.state.session = managerSession();
    expect(() => harness.service.forceCloseShift(forced(shiftId))).toThrow(
      refusal('variance_approval_required'),
    );

    expect(attempts()).toEqual([[FLOAT - 700, 'refused', MANAGER]]);
    expect(links()).toEqual([]);
  });
});

describe('the count stays blind', () => {
  it('shows the cashier the same refusal and no attempt in the status', async () => {
    openShift();
    expect(() => harness.service.closeShift({ countedCashMinor: FLOAT - 500 })).toThrow(
      refusal('variance_approval_required'),
    );
    const status = await harness.service.readStatus();
    expect(JSON.stringify(status)).not.toMatch(/attempt/i);
  });
});
