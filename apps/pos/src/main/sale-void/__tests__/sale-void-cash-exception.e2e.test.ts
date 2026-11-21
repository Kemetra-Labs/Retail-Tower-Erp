/**
 * RT-1403 S2 — the cash-out exception end to end over the full migration stack (sql.js): the real
 * manager PIN store (real Argon2id), the real approval service (action `sale.void_cash_exception`)
 * and the real payout service and records.
 *
 *   • four-eyes: the approver is a manager other than the requester (the same rule as the void);
 *   • the approval is bound to THIS void and its cash, and is single use;
 *   • a refused approval records nothing and spends nothing.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  aeadSafeStorage,
  freshGrantDb,
  handleFor,
  initGrantSql,
} from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';
import { createManagerPinStore, type ManagerPinStore } from '../../operator/manager-pin-store.js';
import {
  createManagerApprovalService,
  type ManagerApprovalService,
} from '../../operator/manager-approval-service.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import { seedSale } from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createSaleVoidPayout, type SaleVoidPayoutService } from '../sale-void-payout.js';
import { createSaleVoidPayoutRepository } from '../sale-void-payout-repository.js';
import { createSaleVoidRepository } from '../sale-void-repository.js';
import { newVoidEntry } from './__helpers__/sale-void-fixture.js';

const TERMINAL = 'term-1';
const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: TERMINAL };
const MONA = {
  userId: '0190f5a2-3b4c-7d8e-9f01-00000000000a',
  pin: '246810',
  name: 'Mona Manager',
};
const OMAR = {
  userId: '0190f5a2-3b4c-7d8e-9f01-00000000000b',
  pin: '135790',
  name: 'Omar Manager',
};
const SHIFT = '0192f5a2-3b4c-7d8e-9f01-0000000000a1';
const T0 = '2026-06-07T10:30:00.000Z';

function session(id: string, managerUserId: string): OperatorSessionRecord {
  return {
    id,
    operator_id: `op-${id}`,
    display_name: `Operator ${id}`,
    role: 'manager',
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    started_at: T0,
    backend_session_id: `b-${id}`,
    last_activity_at: T0,
    lock_state: 'active',
    locked_at: null,
    manager_user_id: managerUserId,
  };
}

let raw: SqlJsDatabase;
let pins: ManagerPinStore;
let approvals: ManagerApprovalService;
let payout: SaleVoidPayoutService;
let current: OperatorSessionRecord;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(async () => {
  raw = freshGrantDb();
  const db = handleFor(raw);
  current = session('mona', MONA.userId);
  pins = createManagerPinStore({ db, safeStorage: aeadSafeStorage() });
  for (const m of [MONA, OMAR]) {
    await pins.enrol({
      scope: SCOPE,
      userId: m.userId,
      displayName: m.name,
      sealed: await pins.seal(m.pin),
      now: T0,
      onlineAt: T0,
      guard: () => undefined,
    });
  }
  seedSale(raw, { sale_id: 'sale-1' });
  const voids = createSaleVoidRepository(db);
  voids.insert(newVoidEntry(1));
  voids.markRefused({ voidId: 'v1', reason: 'void_self_approval', now: T0 });
  raw.run(
    `INSERT INTO shift_cashup_opens (shift_id, tenant_id, branch_id, terminal_id, opening_user_id,
       currency_code, opening_float_minor, opened_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'EGP', 0, '2026-06-07T08:00:00.000Z', '2026-06-07T08:00:00.000Z')`,
    [SHIFT, SCOPE.tenantId, SCOPE.branchId, SCOPE.terminalId, MONA.userId],
  );
  const ref: { service: SaleVoidPayoutService | null } = { service: null };
  approvals = createManagerApprovalService({
    db,
    getSession: () => current,
    isSessionLocked: () => false,
    currentTerminalId: () => TERMINAL,
    managerPins: pins,
    resolvers: {
      'sale.void_cash_exception': (input) =>
        ref.service?.cashExceptionSubject({ subjectRef: input.subjectRef }) ?? null,
    },
    now: () => T0,
  });
  payout = createSaleVoidPayout({
    isEnabled: () => true,
    isStopped: () => false,
    isSessionLocked: () => false,
    getSession: () => ({
      sessionId: current.id,
      operatorId: current.operator_id,
      displayName: current.display_name,
      userId: current.manager_user_id ?? null,
      scope: SCOPE,
    }),
    voids,
    payouts: createSaleVoidPayoutRepository(db),
    openShift: () => ({ shiftId: SHIFT, openedAt: '2026-06-07T08:00:00.000Z' }),
    approvals,
    kickDrawer: () => Promise.resolve('opened'),
    audit: {
      paidOut: () => undefined,
      cashExceptionRecorded: () => undefined,
      cashMismatchFlagged: () => undefined,
    },
    localDayOf: (iso) => iso.slice(0, 10),
    now: () => T0,
    newPayoutId: () => '0192f5a2-3b4c-7d8e-9f01-0000000000b1',
  });
  ref.service = payout;
});

afterEach(() => {
  raw.close();
});

function managerRef(name: 'Mona' | 'Omar'): string {
  return (
    pins.list({ scope: SCOPE, now: T0 }).find((m) => m.displayName.includes(name))?.managerRef ?? ''
  );
}

function grant(approver: { pin: string }, name: 'Mona' | 'Omar', subjectRef = 'v1') {
  return approvals.request({
    action_kind: 'sale.void_cash_exception',
    subject_ref: subjectRef,
    reason_code: 'cash_exception',
    approver_ref: managerRef(name),
    pin: approver.pin,
  });
}

async function approvedId(): Promise<string> {
  const outcome = await grant(OMAR, 'Omar');
  if (outcome.kind !== 'approved') throw new Error(`not approved: ${outcome.reason}`);
  return outcome.approvalId;
}

function consumed(id: string): boolean {
  return (
    raw.exec('SELECT consumed_at FROM manager_approvals WHERE approval_id = ?', [id])[0]
      ?.values[0]?.[0] !== null
  );
}

describe('cash exception approval', () => {
  it('a manager other than the requester approves: the exception is recorded and the approval spent', async () => {
    const id = await approvedId();
    await expect(payout.recordCashException({ void_id: 'v1', approval_id: id })).resolves.toEqual({
      kind: 'exception_recorded',
      mismatch_reason: 'void_refused',
    });
    expect(consumed(id)).toBe(true);
    const row = createSaleVoidPayoutRepository(handleFor(raw)).readByVoid('v1');
    expect(row?.exception).toMatchObject({
      approvalId: id,
      approverUserId: OMAR.userId,
      requesterUserId: MONA.userId,
    });
  });

  it('the requester cannot approve their own exception (approver == requester is refused)', async () => {
    await expect(grant(MONA, 'Mona')).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_unavailable',
    });
  });

  it('is single use: a second exception for the same void is refused and spends nothing', async () => {
    const first = await approvedId();
    await payout.recordCashException({ void_id: 'v1', approval_id: first });
    // No new approval can be granted for a void that already has its record.
    await expect(grant(OMAR, 'Omar')).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    await expect(
      payout.recordCashException({ void_id: 'v1', approval_id: first }),
    ).resolves.toEqual({ kind: 'refused', reason: 'payout_already_recorded' });
  });

  it('an approval for another void cannot be spent here, and stays unspent', async () => {
    const id = await approvedId();
    await expect(
      payout.recordCashException({ void_id: 'ghost', approval_id: id }),
    ).resolves.toEqual({ kind: 'refused', reason: 'invalid_input' });
    expect(consumed(id)).toBe(false);
  });

  it('a cash exception needs no envelope: a cashier may ask a manager to approve', async () => {
    current = { ...session('rana', MONA.userId), role: 'cashier', user_id: MONA.userId };
    delete (current as { manager_user_id?: string }).manager_user_id;
    await expect(grant(OMAR, 'Omar')).resolves.toMatchObject({ kind: 'approved' });
  });
});
