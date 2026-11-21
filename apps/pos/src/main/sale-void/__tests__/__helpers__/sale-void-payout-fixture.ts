/**
 * RT-1403 S2 — shared fixtures for the sale-void payout tests: an open shift in the fixture scope,
 * a journaled void in a chosen state, and builders of payout records.
 */
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  handleFor,
  seedSale,
} from '../../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import type { NewPayout } from '../../sale-void-payout-repository.js';
import { createSaleVoidRepository } from '../../sale-void-repository.js';
import {
  APPROVAL_B,
  APPROVER_USER,
  REQUESTER_USER,
  SCOPE,
  newVoidEntry,
} from './sale-void-fixture.js';

export const SHIFT_A = '0192f5a2-3b4c-7d8e-9f01-0000000000a1';
export const PAYOUT_1 = '0192f5a2-3b4c-7d8e-9f01-0000000000b1';
const SHIFT_OPENER = '0192f5a2-3b4c-7d8e-9f01-0000000000c1';

/** Before the fixture void's `requested_at` (2026-06-07T10:06:01Z). */
export const OPENED_BEFORE_VOID = '2026-06-07T08:00:00.000Z';
export const OPENED_AFTER_VOID = '2026-06-07T12:00:00.000Z';
const PAID_AT = '2026-06-07T13:00:00.000Z';

export function openShift(
  db: SqlJsDatabase,
  shiftId = SHIFT_A,
  openedAt = OPENED_BEFORE_VOID,
): void {
  db.run(
    `INSERT INTO shift_cashup_opens (shift_id, tenant_id, branch_id, terminal_id, opening_user_id,
       currency_code, opening_float_minor, opened_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'EGP', 0, ?, ?)`,
    [shiftId, SCOPE.tenantId, SCOPE.branchId, SCOPE.terminalId, SHIFT_OPENER, openedAt, openedAt],
  );
}

export function closeShift(db: SqlJsDatabase, shiftId = SHIFT_A): void {
  db.run(
    `INSERT INTO shift_manager_closures (shift_id, source_fact_kind, recorded_at)
     VALUES (?, 'close', ?)`,
    [shiftId, PAID_AT],
  );
}

export type VoidFixtureState = 'pending' | 'unknown' | 'confirmed' | 'refused';

/** Void `v<n>` of `sale-<n>` (cash 1500 unless overridden), journaled and moved to `state`. */
export function journalVoid(
  db: SqlJsDatabase,
  state: VoidFixtureState,
  n = 1,
  over: { cashMinor?: number; businessDate?: string } = {},
): void {
  const saleId = `sale-${String(n)}`;
  seedSale(db, { sale_id: saleId });
  const repo = createSaleVoidRepository(handleFor(db));
  repo.insert(
    newVoidEntry(n, {
      saleId,
      saleNumber: `SN-${saleId}`,
      approvalId: `0190f5a2-7b3c-7d4e-8f90-0000000000a${String(n)}`,
      ...(over.cashMinor === undefined ? {} : { cashMinor: over.cashMinor }),
      ...(over.businessDate === undefined ? {} : { businessDate: over.businessDate }),
    }),
  );
  const stamp = { voidId: `v${String(n)}`, now: '2026-06-07T10:07:00.000Z' };
  if (state === 'confirmed') {
    repo.markConfirmed({ ...stamp, voidRef: '0190f5a2-7b3c-7d4e-8f90-0000000000d1' });
  } else if (state === 'refused') {
    repo.markRefused({ ...stamp, reason: 'void_self_approval' });
  } else if (state === 'unknown') {
    repo.markUnknown({ ...stamp, category: 'timeout' });
  }
}

/** A `payout` record for void `v1` (a confirmed void, shift A), overridable. */
export function newPayout(over: Partial<NewPayout> = {}): NewPayout {
  return {
    payoutId: PAYOUT_1,
    voidId: 'v1',
    saleId: 'sale-1',
    scope: SCOPE,
    shiftId: SHIFT_A,
    businessDate: '2026-06-07',
    kind: 'payout',
    method: 'drawer',
    amountMinor: 1500,
    currencyCode: 'EGP',
    voidState: 'confirmed',
    mismatchReason: null,
    paidAt: PAID_AT,
    paidBy: { operatorId: 'op-cashier', displayName: 'Cara Cashier', sessionId: 'sess-2' },
    exception: null,
    ...over,
  };
}

/** An `exception` record for a refused void `v1`, flagged `void_refused`. */
export function newException(over: Partial<NewPayout> = {}): NewPayout {
  return newPayout({
    kind: 'exception',
    method: 'manual',
    voidState: 'refused',
    mismatchReason: 'void_refused',
    exception: {
      approvalId: APPROVAL_B,
      approverUserId: APPROVER_USER,
      requesterUserId: REQUESTER_USER,
      policyVersion: 'rt114-2026-10-07',
    },
    ...over,
  });
}
