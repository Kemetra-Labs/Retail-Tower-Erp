/**
 * RT-530 — the void's audit events carry requester, approver, sale, amount,
 * device and policy, and a row read before its answer is stored still yields a
 * well-formed event (no ref yet: empty; no stored reason: `unknown`).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import { createSaleVoidAudit, type SaleVoidAudit } from '../sale-void-audit.js';
import {
  createSaleVoidRepository,
  type SaleVoidRepository,
  type VoidEntry,
} from '../sale-void-repository.js';
import {
  APPROVAL_A,
  APPROVAL_B,
  APPROVER_USER,
  newVoidEntry,
  REQUESTER_USER,
  SCOPE,
} from './__helpers__/sale-void-fixture.js';
import {
  PAYOUT_1,
  SHIFT_A,
  newException,
  newPayout,
} from './__helpers__/sale-void-payout-fixture.js';

const NOW = '2026-06-07T10:10:00.000Z';

let db: SqlJsDatabase;
let repo: SaleVoidRepository;
let events: AuditEvent[];
let audit: SaleVoidAudit;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  seedSale(db, { sale_id: 'sale-1' });
  repo = createSaleVoidRepository(handleFor(db));
  repo.insert(newVoidEntry(1));
  events = [];
  let n = 0;
  audit = createSaleVoidAudit({
    sink: { emit: (e) => events.push(e) },
    now: () => NOW,
    newEventId: () => {
      n += 1;
      return `evt-${String(n)}`;
    },
  });
});

afterEach(() => {
  db.close();
});

function row(): VoidEntry {
  const entry = repo.read('v1');
  if (entry === null) throw new Error('void v1 not journaled');
  return entry;
}

describe('sale void audit events', () => {
  it('requested: the requester acts, the approver approves, on this device, with the policy', () => {
    audit.requested(row());
    expect(events).toEqual([
      {
        event_id: 'evt-1',
        tenant_id: SCOPE.tenantId,
        branch_id: SCOPE.branchId,
        originating_terminal_id: SCOPE.terminalId,
        acting_operator_id: 'op-requester',
        session_id: 'sess-1',
        shift_id: null,
        action_category: 'sale.void.requested',
        created_at: NOW,
        approving_supervisor_id: APPROVER_USER,
        payload: {
          void_id: 'v1',
          sale_id: 'sale-1',
          amount_minor: 1500,
          currency_code: 'EGP',
          business_date: '2026-06-07',
          approval_id: APPROVAL_A,
          policy_version: 'rt114-2026-10-07',
          approved_at: '2026-06-07T10:05:00.000Z',
          requester_user_id: REQUESTER_USER,
        },
      },
    ]);
  });

  it('confirmed: carries the stored void ref and whether the answer was a replay', () => {
    repo.markConfirmed({ voidId: 'v1', voidRef: 'ref-1', now: NOW });
    audit.confirmed(row(), true);
    expect(events[0]).toMatchObject({
      action_category: 'sale.void.confirmed',
      payload: { void_id: 'v1', void_ref: 'ref-1', amount_minor: 1500, replayed: true },
    });
  });

  it('confirmed: a row read before its ref is stored records an empty ref', () => {
    audit.confirmed(row(), false);
    expect(events[0]?.payload).toMatchObject({ void_ref: '', replayed: false });
  });

  it('refused: carries the stored server reason, approval and policy', () => {
    repo.markRefused({ voidId: 'v1', reason: 'void_self_approval', now: NOW });
    audit.refused(row());
    expect(events[0]).toMatchObject({
      action_category: 'sale.void.refused',
      payload: {
        reason: 'void_self_approval',
        approval_id: APPROVAL_A,
        policy_version: 'rt114-2026-10-07',
      },
    });
  });

  it('refused: a row read before its reason is stored records `unknown`', () => {
    audit.refused(row());
    expect(events[0]?.payload).toMatchObject({ reason: 'unknown' });
  });
});

describe('sale void payout audit events (RT-1403 S2)', () => {
  it('paid_out: the paying operator acts in the shift, with the cash and the method', () => {
    audit.paidOut(newPayout({ method: 'no_drawer' }));
    expect(events).toEqual([
      {
        event_id: 'evt-1',
        tenant_id: SCOPE.tenantId,
        branch_id: SCOPE.branchId,
        originating_terminal_id: SCOPE.terminalId,
        acting_operator_id: 'op-cashier',
        session_id: 'sess-2',
        shift_id: SHIFT_A,
        action_category: 'sale.void.paid_out',
        created_at: NOW,
        approving_supervisor_id: null,
        payload: {
          void_id: 'v1',
          sale_id: 'sale-1',
          payout_id: PAYOUT_1,
          amount_minor: 1500,
          currency_code: 'EGP',
          method: 'no_drawer',
          business_date: '2026-06-07',
        },
      },
    ]);
  });

  it('cash_exception_recorded: the approving manager is the supervisor, the approval is cited', () => {
    audit.cashExceptionRecorded(newException());
    expect(events[0]).toMatchObject({
      action_category: 'sale.void.cash_exception_recorded',
      acting_operator_id: 'op-cashier',
      shift_id: SHIFT_A,
      approving_supervisor_id: APPROVER_USER,
      payload: {
        void_id: 'v1',
        payout_id: PAYOUT_1,
        amount_minor: 1500,
        void_state: 'refused',
        approval_id: APPROVAL_B,
        policy_version: 'rt114-2026-10-07',
        requester_user_id: REQUESTER_USER,
        mismatch_reason: 'void_refused',
      },
    });
  });

  it('cash_exception_recorded: an unflagged exception records an empty mismatch reason', () => {
    audit.cashExceptionRecorded(newException({ voidState: 'confirmed', mismatchReason: null }));
    expect(events[0]?.payload).toMatchObject({ void_state: 'confirmed', mismatch_reason: '' });
  });

  it('cash_mismatch_flagged: names the reason for manager reconciliation', () => {
    audit.cashMismatchFlagged(newException({ mismatchReason: 'void_refused' }));
    expect(events[0]).toMatchObject({
      action_category: 'sale.void.cash_mismatch_flagged',
      payload: {
        void_id: 'v1',
        sale_id: 'sale-1',
        payout_id: PAYOUT_1,
        amount_minor: 1500,
        void_state: 'refused',
        mismatch_reason: 'void_refused',
      },
    });
  });

  it('cash_mismatch_flagged: a record without a flag emits nothing', () => {
    audit.cashMismatchFlagged(newException({ mismatchReason: null, voidState: 'confirmed' }));
    expect(events).toEqual([]);
  });
});
