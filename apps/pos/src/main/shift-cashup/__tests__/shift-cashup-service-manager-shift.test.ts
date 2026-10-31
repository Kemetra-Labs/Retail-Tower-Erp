/**
 * RT-1004 (owner decision 2026-10-31) — a manager alone on a terminal opens a
 * shift, takes cash in it and closes it with the same blind count. The
 * manager's own `users.id` (from an online sign-in) owns the shift. Backend-Core's
 * device path admits cashiers only, so the manager's open and close are queued
 * as manager-envelope rows: no `operatorUserId`, the opening / closing user is
 * the manager, and the envelope operator is the recorded actor.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { ShiftCashupStateError } from '../shift-cashup-repo.js';
import { ShiftCashupRefusedError } from '../shift-cashup-service.js';
import {
  cashierSession,
  cashLine,
  CLOSED_AT,
  factCounts,
  managerSession,
  MANAGER,
  OPENED_AT,
  onlineManager,
  seedShiftSale,
  serviceHarness,
  storedBody,
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
  harness = serviceHarness(db, { varianceApprovalThresholdMinor: null });
});

afterEach(() => {
  db.close();
});

function signInManager(): void {
  harness.state.session = managerSession();
  harness.state.manager = onlineManager();
}

function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ShiftCashupRefusedError || error instanceof ShiftCashupStateError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

function outboxRow(seq: number): unknown[] | undefined {
  return db.exec(
    `SELECT auth_path, fact_kind, idempotency_key FROM shift_sync_outbox WHERE seq = ${String(seq)}`,
  )[0]?.values[0];
}

function rows(sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

describe('a manager opens a shift', () => {
  it('records the open with the manager as the opening user', () => {
    signInManager();

    const opened = harness.service.openShift({ openingFloatMinor: FLOAT });

    expect(opened.openedAt).toBe(OPENED_AT);
    expect(
      rows('SELECT shift_id, opening_user_id, opening_float_minor FROM shift_cashup_opens'),
    ).toEqual([[opened.shiftId, MANAGER, FLOAT]]);
  });

  it('queues ONE envelope-path open row: openingUserId = the manager, no operatorUserId claim', () => {
    signInManager();

    const { shiftId } = harness.service.openShift({ openingFloatMinor: FLOAT });

    expect(outboxRow(1)).toEqual(['envelope', 'open', `pos-pulse-shift-open:${shiftId}`]);
    const body = storedBody(db, 1);
    expect(body).toMatchObject({ shiftId, openingUserId: MANAGER, openingFloat: '500.00' });
    expect(body).not.toHaveProperty('operatorUserId');
    expect(harness.state.envelopeFacts).toBe(1);
  });

  it('works for an admin signed in online too', () => {
    harness.state.session = managerSession();
    harness.state.manager = { ...onlineManager(), role: 'admin' };

    harness.service.openShift({ openingFloatMinor: FLOAT });

    expect(outboxRow(1)?.[0]).toBe('envelope');
  });

  it('is refused (no_cashier_identity) for a manager signed in offline: no users.id, nothing written', () => {
    harness.state.session = managerSession();
    harness.state.manager = {
      operatorSessionId: managerSession().operator_session_id,
      role: 'manager',
    };

    expect(reasonOf(() => harness.service.openShift({ openingFloatMinor: FLOAT }))).toBe(
      'no_cashier_identity',
    );
    expect(factCounts(db)).toMatchObject({ shift_cashup_opens: 0, shift_sync_outbox: 0 });
    expect(harness.state.envelopeFacts).toBe(0);
  });

  it('is refused when the manager identity is another session’s (never borrowed)', () => {
    harness.state.session = managerSession();
    harness.state.manager = { ...onlineManager(), operatorSessionId: 'sess-other' };

    expect(reasonOf(() => harness.service.openShift({ openingFloatMinor: FLOAT }))).toBe(
      'no_cashier_identity',
    );
    expect(factCounts(db)).toMatchObject({ shift_cashup_opens: 0 });
  });

  it('a cashier session is never a manager: a cashier’s open stays on the device path', () => {
    harness.state.manager = {
      ...onlineManager(),
      operatorSessionId: cashierSession().operator_session_id,
      role: 'cashier',
    };

    const { shiftId } = harness.service.openShift({ openingFloatMinor: FLOAT });

    expect(outboxRow(1)).toEqual(['device', 'open', `pos-pulse-shift-open:${shiftId}`]);
    expect(storedBody(db, 1)).toMatchObject({ openingUserId: USER, operatorUserId: USER });
    expect(harness.state.envelopeFacts).toBe(0);
  });

  it('a manager still records no pay-in or pay-out (cashier only, unchanged)', () => {
    signInManager();
    harness.service.openShift({ openingFloatMinor: FLOAT });

    expect(
      reasonOf(() =>
        harness.service.recordCashMovement({
          kind: 'pay_in',
          amountMinor: 1_000,
          reasonCode: 'other',
        }),
      ),
    ).toBe('no_cashier_identity');
  });
});

describe('a manager closes the shift they opened', () => {
  let shiftId: string;

  beforeEach(() => {
    signInManager();
    shiftId = harness.service.openShift({ openingFloatMinor: FLOAT }).shiftId;
    seedShiftSale(db, {
      saleId: 'sale-1',
      finalizedAt: '2026-10-05T10:00:00.000Z',
      lines: [cashLine(10_000)],
    });
    harness.state.clock = CLOSED_AT;
  });

  it('the cash sale lands in the shift’s expected cash; the closing user is the manager', () => {
    const closed = harness.service.closeShift({ countedCashMinor: 60_000 });

    expect(closed).toMatchObject({
      shiftId,
      cashSalesTotalMinor: 10_000,
      expectedCashMinor: 60_000,
      varianceMinor: 0,
      saleCount: 1,
    });
    expect(rows('SELECT close_kind, closing_user_id FROM shift_cashup_closes')).toEqual([
      ['normal', MANAGER],
    ]);
  });

  it('queues an envelope-path NORMAL close with no operatorUserId', () => {
    harness.service.closeShift({ countedCashMinor: 59_000 });

    expect(outboxRow(2)).toEqual(['envelope', 'close', `pos-pulse-shift-close:${shiftId}`]);
    const body = storedBody(db, 2);
    expect(body).toMatchObject({
      closeKind: 'normal',
      closingUserId: MANAGER,
      countedCash: '590.00',
    });
    expect(body).not.toHaveProperty('operatorUserId');
    expect(harness.state.envelopeFacts).toBe(2);
  });

  it('records the accepted count attempt by the manager (RT-997)', () => {
    harness.service.closeShift({ countedCashMinor: 59_000 });

    expect(
      rows('SELECT counted_cash_minor, outcome, actor_user_id FROM shift_count_attempts'),
    ).toEqual([[59_000, 'accepted', MANAGER]]);
  });
});

describe('a manager’s normal close is of their own shift only', () => {
  it('a shift a cashier opened is refused (not_shift_opener), before any count is evaluated', () => {
    harness.service.openShift({ openingFloatMinor: FLOAT });
    signInManager();
    harness.state.clock = CLOSED_AT;

    expect(reasonOf(() => harness.service.closeShift({ countedCashMinor: FLOAT }))).toBe(
      'not_shift_opener',
    );
    expect(factCounts(db)).toMatchObject({ shift_cashup_closes: 0 });
    expect(rows('SELECT COUNT(*) FROM shift_count_attempts')).toEqual([[0]]);
  });

  it('nor is its manager approval asked for', async () => {
    harness.service.openShift({ openingFloatMinor: FLOAT });
    signInManager();
    harness.state.clock = CLOSED_AT;

    await expect(
      harness.service.verifyApprover({
        countedCashMinor: 1,
        managerRef: 'x',
        managerPin: '246810',
      }),
    ).rejects.toMatchObject({ reason: 'not_shift_opener' });
    expect(harness.state.verifyCalls).toEqual([]);
  });

  it('with no open shift the close says so (shift_not_open), as for a cashier', () => {
    signInManager();

    expect(reasonOf(() => harness.service.closeShift({ countedCashMinor: FLOAT }))).toBe(
      'shift_not_open',
    );
  });
});

describe('a cashier admitted later on the same terminal', () => {
  beforeEach(() => {
    signInManager();
    harness.service.openShift({ openingFloatMinor: FLOAT });
    harness.state.session = cashierSession();
    harness.state.manager = null;
  });

  it('opens no second shift: the manager’s shift stays open', () => {
    expect(reasonOf(() => harness.service.openShift({ openingFloatMinor: FLOAT }))).toBe(
      'shift_already_open',
    );
  });

  it('closes the manager’s shift on the device path, with the sales of both', () => {
    seedShiftSale(db, {
      saleId: 'sale-1',
      finalizedAt: '2026-10-05T10:00:00.000Z',
      lines: [cashLine(10_000)],
    });
    harness.state.clock = CLOSED_AT;

    const closed = harness.service.closeShift({ countedCashMinor: 60_000 });

    expect(closed).toMatchObject({ expectedCashMinor: 60_000, varianceMinor: 0 });
    expect(outboxRow(2)?.[0]).toBe('device');
    expect(storedBody(db, 2)).toMatchObject({ closingUserId: USER, operatorUserId: USER });
  });
});
