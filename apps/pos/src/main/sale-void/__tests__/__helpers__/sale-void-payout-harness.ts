/**
 * RT-1403 S2 — the payout service over the full migration stack (sql.js) with the real journal, claim
 * and record repositories and the real audit (written to `audit_events`), and every outside fact
 * (clock, session, drawer, shift read, approval) a knob. A second harness over the same database is a
 * restart.
 */
import type { Database as SqlJsDatabase } from 'sql.js';

import { handleFor } from '../../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import type {
  ConsumeApprovalInput,
  ConsumeApprovalOutcome,
} from '../../../operator/manager-approval-service.js';
import type { AuditEvent } from '../../../../shared/audit/event-shape.js';
import { createDrawerSlot, type DrawerSlot } from '../../../drawer/drawer-slot.js';
import { createSaleVoidAudit } from '../../sale-void-audit.js';
import {
  createSaleVoidPayout,
  type DrawerResult,
  type OpenShiftFact,
  type SaleVoidPayoutDeps,
  type SaleVoidPayoutService,
} from '../../sale-void-payout.js';
import {
  createSaleVoidPayoutRepository,
  type PayoutRecord,
  type SaleVoidPayoutRepository,
} from '../../sale-void-payout-repository.js';
import { createSaleVoidRepository } from '../../sale-void-repository.js';
import { APPROVER_USER, REQUESTER_USER, SCOPE } from './sale-void-fixture.js';
import { seedApproval } from './sale-void-payout-fixture.js';

const NOW = '2026-06-07T13:00:00.000Z';
export const NEXT_DAY = '2026-06-08T09:00:00.000Z';
export const AFTER_LEASE = '2026-06-07T13:00:11.000Z';
export const WITHIN_LEASE = '2026-06-07T13:00:03.000Z';

type Role = 'cashier' | 'manager' | 'admin';

export interface PayoutState {
  now: string;
  enabled: boolean;
  stopped: boolean;
  locked: boolean;
  session: { sessionId: string; userId: string | null; role: Role } | null;
  terminalId: string;
  kick: () => Promise<DrawerResult>;
  consume: ConsumeApprovalOutcome;
  evidence: { approverUserId: string; requesterUserId: string | null } | null;
  shiftReadFails: boolean;
}

export interface PayoutHarness {
  service: SaleVoidPayoutService;
  payouts: SaleVoidPayoutRepository;
  events: AuditEvent[];
  kicks: number;
  consumed: ConsumeApprovalInput[];
  /** What happened, in order: the audit categories and each kick. */
  trail: string[];
  state: PayoutState;
  /** The cash record of void `v1`, if any. */
  record: () => PayoutRecord | null;
}

let ids = 0;

export function freshState(): PayoutState {
  return {
    now: NOW,
    enabled: true,
    stopped: false,
    locked: false,
    session: { sessionId: 'sess-2', userId: REQUESTER_USER, role: 'manager' },
    terminalId: SCOPE.terminalId,
    kick: () => Promise.resolve('opened'),
    consume: { kind: 'consumed', approverUserId: APPROVER_USER },
    evidence: { approverUserId: APPROVER_USER, requesterUserId: REQUESTER_USER },
    shiftReadFails: false,
  };
}

/** A payout service over `db`; a new one over the same database is a restart. */
export function createHarness(
  db: SqlJsDatabase,
  state: PayoutState = freshState(),
  slot: DrawerSlot = createDrawerSlot(),
  /** Replace some dependency of the service (a racing repository, a flaky shift read, ...). */
  tweak: (deps: SaleVoidPayoutDeps) => SaleVoidPayoutDeps = (deps) => deps,
): PayoutHarness {
  const handle = handleFor(db);
  const payouts = createSaleVoidPayoutRepository(handle);
  const voids = createSaleVoidRepository(handle);
  const out: PayoutHarness = {
    service: undefined as unknown as SaleVoidPayoutService,
    payouts,
    events: [],
    kicks: 0,
    consumed: [],
    trail: [],
    state,
    record: () => payouts.readByVoid('v1'),
  };
  const audit = createSaleVoidAudit({
    sink: {
      emit: (e) => {
        out.events.push(e);
        out.trail.push(e.action_category);
        db.run(
          `INSERT INTO audit_events (event_id, tenant_id, branch_id, originating_terminal_id,
             acting_operator_id, session_id, shift_id, action_category, created_at, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            e.event_id,
            e.tenant_id,
            e.branch_id,
            e.originating_terminal_id,
            e.acting_operator_id,
            e.session_id,
            e.shift_id,
            e.action_category,
            e.created_at,
            JSON.stringify(e.payload),
          ],
        );
      },
    },
    now: () => state.now,
    newEventId: () => `evt-${String((ids += 1))}`,
  });
  const deps: SaleVoidPayoutDeps = {
    isEnabled: () => state.enabled,
    isStopped: () => state.stopped,
    isSessionLocked: () => state.locked,
    getSession: () =>
      state.session === null
        ? null
        : {
            sessionId: state.session.sessionId,
            operatorId: 'op-manager',
            displayName: 'Mona Manager',
            role: state.session.role,
            userId: state.session.userId,
            scope: { ...SCOPE, terminalId: state.terminalId },
          },
    voids,
    payouts,
    openShift: (scope): OpenShiftFact | null => {
      if (state.shiftReadFails) throw new Error('shift read failed');
      const row = db.exec(
        `SELECT o.shift_id, o.opened_at FROM shift_cashup_opens o
          WHERE o.terminal_id = '${scope.terminalId}'
            AND NOT EXISTS (SELECT 1 FROM shift_manager_closures m WHERE m.shift_id = o.shift_id)`,
      )[0]?.values[0];
      return row === undefined ? null : { shiftId: String(row[0]), openedAt: String(row[1]) };
    },
    approvals: {
      consume: (input) => {
        out.consumed.push(input);
        if (state.consume.kind === 'consumed') {
          // The real approval service marks the approval spent: the row the 0069 trigger checks.
          seedApproval(db, {
            approvalId: input.approvalId,
            voidId: input.subjectRef,
            approver: state.consume.approverUserId,
          });
        }
        return state.consume;
      },
      evidence: () =>
        state.evidence === null
          ? null
          : {
              approverUserId: state.evidence.approverUserId,
              requesterUserId: state.evidence.requesterUserId,
              policyVersion: 'rt114-2026-10-07',
              issuedAt: NOW,
            },
    },
    kickDrawer: () => {
      out.kicks += 1;
      out.trail.push('kick');
      return state.kick();
    },
    audit,
    localDayOf: (iso) => iso.slice(0, 10),
    now: () => state.now,
    newPayoutId: () => `0192f5a2-3b4c-7d8e-9f01-${String((ids += 1)).padStart(12, '0')}`,
    drawerSlot: slot,
  };
  out.service = createSaleVoidPayout(tweak(deps));
  return out;
}

/** The journaled void `v1` as the payout view reads it. */
export function viewOfV1(db: SqlJsDatabase, service: SaleVoidPayoutService) {
  const entry = createSaleVoidRepository(handleFor(db)).read('v1');
  if (entry === null) throw new Error('void v1 not journaled');
  return service.viewOf(entry);
}
