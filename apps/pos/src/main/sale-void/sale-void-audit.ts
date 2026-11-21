/**
 * RT-530 — local audit events of the sale void: requested, confirmed, refused.
 *
 * Every event goes through 004's validating `AuditEmitter` (mandatory FR-025
 * attributes and the forbidden-key scan). Requester, approver, sale, amount,
 * device (`originating_terminal_id`) and `policy_version` are all on the
 * event: the requesting operator is `acting_operator_id`, the approving
 * manager (`users.id`) is `approving_supervisor_id`.
 */
import type { AuditEvent } from '../../shared/audit/event-shape.js';
import type { AuditPayloadMap } from '../../shared/audit/payload-schemas.js';
import type { PayoutRecord } from './sale-void-payout-repository.js';
import type { VoidEntry } from './sale-void-repository.js';

type VoidAuditCategory = Extract<AuditEvent['action_category'], `sale.void.${string}`>;

export interface SaleVoidAuditSink {
  emit(event: AuditEvent): void;
}

export interface SaleVoidAudit {
  /** The void was journaled and its approval consumed (inside that transaction). */
  requested(entry: VoidEntry): void;
  confirmed(entry: VoidEntry, replayed: boolean): void;
  refused(entry: VoidEntry): void;
  /** RT-1403 S2: the gated payout was recorded (inside the record's transaction). */
  paidOut(record: PayoutRecord): void;
  /** RT-1403 S2: a manager-attested cash-out exception was recorded (same transaction). */
  cashExceptionRecorded(record: PayoutRecord): void;
  /** RT-1403 S2: cash and accounting status disagree; emits nothing for an unflagged record. */
  cashMismatchFlagged(record: PayoutRecord): void;
}

export interface SaleVoidAuditDeps {
  readonly sink: SaleVoidAuditSink;
  readonly now: () => string;
  readonly newEventId: () => string;
}

export function createSaleVoidAudit(deps: SaleVoidAuditDeps): SaleVoidAudit {
  function write<C extends VoidAuditCategory>(
    entry: VoidEntry,
    category: C,
    payload: AuditPayloadMap[C],
  ): void {
    deps.sink.emit({
      event_id: deps.newEventId(),
      tenant_id: entry.scope.tenantId,
      branch_id: entry.scope.branchId,
      originating_terminal_id: entry.scope.terminalId,
      acting_operator_id: entry.requesterOperatorId,
      session_id: entry.operatorSessionId,
      shift_id: null,
      action_category: category,
      created_at: deps.now(),
      approving_supervisor_id: entry.approverUserId,
      payload: { ...payload },
    });
  }

  /** A payout event: the paying operator acts in the record's shift, on this device. */
  function writePayout<C extends VoidAuditCategory>(
    record: PayoutRecord,
    category: C,
    payload: AuditPayloadMap[C],
  ): void {
    deps.sink.emit({
      event_id: deps.newEventId(),
      tenant_id: record.scope.tenantId,
      branch_id: record.scope.branchId,
      originating_terminal_id: record.scope.terminalId,
      acting_operator_id: record.paidBy.operatorId,
      session_id: record.paidBy.sessionId,
      shift_id: record.shiftId,
      action_category: category,
      created_at: deps.now(),
      approving_supervisor_id: record.exception?.approverUserId ?? null,
      payload: { ...payload },
    });
  }

  return {
    paidOut(record) {
      writePayout(record, 'sale.void.paid_out', {
        void_id: record.voidId,
        sale_id: record.saleId,
        payout_id: record.payoutId,
        amount_minor: record.amountMinor,
        currency_code: record.currencyCode,
        method: record.method,
        business_date: record.businessDate,
      });
    },
    cashExceptionRecorded(record) {
      writePayout(record, 'sale.void.cash_exception_recorded', {
        void_id: record.voidId,
        sale_id: record.saleId,
        payout_id: record.payoutId,
        amount_minor: record.amountMinor,
        currency_code: record.currencyCode,
        void_state: record.voidState,
        approval_id: record.exception?.approvalId ?? '',
        policy_version: record.exception?.policyVersion ?? '',
        requester_user_id: record.exception?.requesterUserId ?? '',
        mismatch_reason: record.mismatchReason ?? '',
      });
    },
    cashMismatchFlagged(record) {
      if (record.mismatchReason === null) return;
      writePayout(record, 'sale.void.cash_mismatch_flagged', {
        void_id: record.voidId,
        sale_id: record.saleId,
        payout_id: record.payoutId,
        amount_minor: record.amountMinor,
        currency_code: record.currencyCode,
        void_state: record.voidState,
        mismatch_reason: record.mismatchReason,
      });
    },
    requested(entry) {
      write(entry, 'sale.void.requested', {
        void_id: entry.voidId,
        sale_id: entry.saleId,
        amount_minor: entry.amountMinor,
        currency_code: entry.currencyCode,
        business_date: entry.businessDate,
        approval_id: entry.approvalId,
        policy_version: entry.policyVersion,
        approved_at: entry.approvedAt,
        requester_user_id: entry.requesterUserId,
      });
    },
    confirmed(entry, replayed) {
      write(entry, 'sale.void.confirmed', {
        void_id: entry.voidId,
        sale_id: entry.saleId,
        void_ref: entry.voidRef ?? '',
        amount_minor: entry.amountMinor,
        currency_code: entry.currencyCode,
        replayed,
      });
    },
    refused(entry) {
      write(entry, 'sale.void.refused', {
        void_id: entry.voidId,
        sale_id: entry.saleId,
        reason: entry.refusalReason ?? 'unknown',
        amount_minor: entry.amountMinor,
        currency_code: entry.currencyCode,
        approval_id: entry.approvalId,
        policy_version: entry.policyVersion,
      });
    },
  };
}
