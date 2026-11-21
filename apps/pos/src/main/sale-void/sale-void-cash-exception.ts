/**
 * RT-1403 S2 — the manager-attested cash-out exception (RT-530 c12022 item 4; owner decisions
 * RT-1403 c18143): cash that physically left the drawer although the payout gate did not release
 * it (the void was refused or unanswered, the window had passed, the drawer failed).
 *
 * POS-local: the record on the till (migration 0069) and the existing local audit trail only; no
 * Backend-Core endpoint and no new central audit category.
 *
 *   • one exception per sale, ever (the record is UNIQUE on the sale and on the approval id);
 *   • the approval is a single-use RT-114 approval of a manager OTHER than the requester (the
 *     same four-eyes rule as the void), bound to this void and its cash, spent inside the same
 *     transaction as the record;
 *   • it needs an open shift: a closed shift is never changed retroactively, and no approval is
 *     spent when there is none;
 *   • the record carries a mismatch flag whenever cash and accounting status disagree, audited
 *     for manager reconciliation.
 */
import type { ApprovalSubject } from '../operator/manager-approval-service.js';
import type {
  SaleVoidCashExceptionRequest,
  SaleVoidCashExceptionResponse,
} from '../../shared/sale-void/types.js';
import {
  GateRefused,
  SALE_VOID_CASH_EXCEPTION_ACTION_KIND,
  cashExceptionSubjectOf,
  mismatchOf,
  refuse,
  type PayoutContext,
  type PayoutSession,
  type SaleVoidPayoutDeps,
} from './sale-void-payout-gate.js';
import type { NewPayout } from './sale-void-payout-repository.js';
import type { VoidEntry } from './sale-void-repository.js';

export interface CashException {
  record(req: SaleVoidCashExceptionRequest): Promise<SaleVoidCashExceptionResponse>;
  /** The approval subject of a cash exception for void `subjectRef`, or null. */
  subject(input: { subjectRef: string }): ApprovalSubject | null;
}

const sameUser = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function createCashException(deps: SaleVoidPayoutDeps, ctx: PayoutContext): CashException {
  /** Why no exception can be recorded for `entry` now, or null (before any approval is spent). */
  function preRefusal(entry: VoidEntry): GateRefused | null {
    if (ctx.existingFor(entry) !== null) return new GateRefused('payout_already_recorded');
    if (entry.cashMinor === 0) return new GateRefused('payout_no_cash');
    if (ctx.shiftNow(entry.scope) === null) return new GateRefused('payout_no_open_shift');
    return null;
  }

  /** Spend the approval and read what it proved; refuses a self-approval or another requester. */
  function spendApproval(
    session: PayoutSession,
    userId: string,
    entry: VoidEntry,
    approvalId: string,
  ): { approverUserId: string; policyVersion: string } {
    const consumed = deps.approvals.consume({
      approvalId,
      actionKind: SALE_VOID_CASH_EXCEPTION_ACTION_KIND,
      subjectRef: entry.voidId,
      subject: cashExceptionSubjectOf(entry),
      session: {
        operator_id: session.operatorId,
        tenant_id: session.scope.tenantId,
        branch_id: session.scope.branchId,
      },
    });
    if (consumed.kind === 'refused') throw new GateRefused(consumed.reason);
    const evidence = deps.approvals.evidence(approvalId);
    // The approval must have been granted to THIS requester, by a manager who is not them.
    const granted =
      evidence !== null &&
      evidence.requesterUserId !== null &&
      sameUser(evidence.requesterUserId, userId) &&
      !sameUser(evidence.approverUserId, userId);
    if (!granted) throw new GateRefused('approval_invalid');
    return { approverUserId: evidence.approverUserId, policyVersion: evidence.policyVersion };
  }

  /** The record, built INSIDE the transaction from fresh reads; throws a `GateRefused`. */
  function build(
    session: PayoutSession,
    userId: string,
    req: SaleVoidCashExceptionRequest,
  ): NewPayout {
    const entry = ctx.voidOf(session, req.void_id);
    if (entry === null) throw new GateRefused('invalid_input');
    const refusal = preRefusal(entry);
    if (refusal !== null) throw refusal;
    const shift = ctx.shiftNow(entry.scope);
    if (shift === null) throw new GateRefused('payout_no_open_shift');
    const approval = spendApproval(session, userId, entry, req.approval_id);
    const paidAt = deps.now();
    return {
      payoutId: deps.newPayoutId(),
      voidId: entry.voidId,
      saleId: entry.saleId,
      scope: entry.scope,
      shiftId: shift.shiftId,
      businessDate: deps.localDayOf(paidAt),
      kind: 'exception',
      method: 'manual',
      amountMinor: entry.cashMinor,
      currencyCode: entry.currencyCode,
      voidState: entry.state,
      mismatchReason: mismatchOf(entry, ctx.blockNow(entry)),
      paidAt,
      paidBy: {
        operatorId: session.operatorId,
        displayName: session.displayName,
        sessionId: session.sessionId,
      },
      exception: {
        approvalId: req.approval_id,
        approverUserId: approval.approverUserId,
        requesterUserId: userId,
        policyVersion: approval.policyVersion,
      },
    };
  }

  function commit(
    session: PayoutSession,
    userId: string,
    req: SaleVoidCashExceptionRequest,
  ): SaleVoidCashExceptionResponse {
    let flag = null as NewPayout['mismatchReason'];
    try {
      deps.payouts.insertFrom(
        () => {
          const record = build(session, userId, req);
          flag = record.mismatchReason;
          return record;
        },
        (inserted) => {
          deps.audit.cashExceptionRecorded(inserted);
          if (inserted.mismatchReason !== null) deps.audit.cashMismatchFlagged(inserted);
        },
      );
    } catch (err) {
      if (err instanceof GateRefused) return refuse(err.reason);
      throw err;
    }
    return { kind: 'exception_recorded', mismatch_reason: flag };
  }

  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async record(req) {
      const admitted = ctx.admit();
      if (admitted.kind !== 'ok') return admitted;
      const { session } = admitted;
      // The approval is granted to the requester's `users.id`; without one nothing can be bound.
      if (session.userId === null) return refuse('approval_invalid');
      return commit(session, session.userId, req);
    },

    subject({ subjectRef }) {
      const admitted = ctx.admit();
      if (admitted.kind !== 'ok') return null;
      const entry = ctx.voidOf(admitted.session, subjectRef);
      if (entry === null || entry.cashMinor === 0) return null;
      return ctx.existingFor(entry) === null ? cashExceptionSubjectOf(entry) : null;
    },
  };
}
