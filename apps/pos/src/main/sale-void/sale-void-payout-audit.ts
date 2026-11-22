/**
 * RT-1403 S2 - local audit events of the void's CASH: the payout claim (written before the drawer is
 * kicked), each kick's outcome, the paid-out record, the manager-attested exception and the mismatch
 * flags (a flagged exception, and `payout_not_made` for a confirmed void never paid out). Every event
 * goes through the validating `AuditEmitter` like the void's own; ids, minor units and closed codes only.
 */
import type { AuditEvent } from '../../shared/audit/event-shape.js';
import type { AuditPayloadMap } from '../../shared/audit/payload-schemas.js';
import type { SaleVoidAuditDeps } from './sale-void-audit.js';
import type { KickResult, PayoutClaim, PayoutRecord } from './sale-void-payout-repository.js';
import type { VoidEntry } from './sale-void-repository.js';

type PayoutAuditCategory = Extract<AuditEvent['action_category'], `sale.void.${string}`>;

/** The operator session that did the step (the one who claimed, kicked or listed). */
export interface PayoutActor {
  readonly operatorId: string;
  readonly sessionId: string;
}

/** The cash of a payout, for its claim's audit. */
interface PayoutCash {
  readonly amountMinor: number;
  readonly currencyCode: string;
}

export interface PayoutAudit {
  /** RT-1403 S2 (H1): the payout was CLAIMED, before the drawer is kicked (same transaction). */
  payoutStarted(actor: PayoutActor, claim: PayoutClaim, cash: PayoutCash): void;
  /** RT-1403 S2 (L5): a drawer retry of the claimed payout is about to kick again (same transaction). */
  payoutRetried(actor: PayoutActor, claim: PayoutClaim): void;
  /** RT-1403 S2 (H1): what a drawer kick of the claimed payout proved. */
  payoutDrawer(actor: PayoutActor, claim: PayoutClaim, outcome: KickResult): void;
  /**
   * RT-1403 S2 (H2): a confirmed void with cash was never paid out and its window passed. The
   * caller emits it once per void (it dedupes against the audit); no record exists.
   */
  payoutNotMade(actor: PayoutActor, entry: VoidEntry, shiftId: string | null): void;
  /** RT-1403 S2: the gated payout was recorded (inside the record's transaction). */
  paidOut(record: PayoutRecord): void;
  /** RT-1403 S2: a manager-attested cash-out exception was recorded (same transaction). */
  cashExceptionRecorded(record: PayoutRecord): void;
  /** RT-1403 S2: cash and accounting status disagree; emits nothing for an unflagged record. */
  cashMismatchFlagged(record: PayoutRecord): void;
}

export function createPayoutAudit(deps: SaleVoidAuditDeps): PayoutAudit {
  /** A payout event: the paying operator acts in the record's shift, on this device. */
  function writePayout<C extends PayoutAuditCategory>(
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

  /** A claim-step event: the acting session, the claim's shift, this device. */
  function writeClaim<C extends PayoutAuditCategory>(
    actor: PayoutActor,
    claim: PayoutClaim,
    category: C,
    payload: AuditPayloadMap[C],
  ): void {
    deps.sink.emit({
      event_id: deps.newEventId(),
      tenant_id: claim.scope.tenantId,
      branch_id: claim.scope.branchId,
      originating_terminal_id: claim.scope.terminalId,
      acting_operator_id: actor.operatorId,
      session_id: actor.sessionId,
      shift_id: claim.shiftId,
      action_category: category,
      created_at: deps.now(),
      approving_supervisor_id: null,
      payload: { ...payload },
    });
  }

  return {
    payoutStarted(actor, claim, cash) {
      writeClaim(actor, claim, 'sale.void.payout_started', {
        void_id: claim.voidId,
        sale_id: claim.saleId,
        amount_minor: cash.amountMinor,
        currency_code: cash.currencyCode,
        business_date: claim.businessDate,
      });
    },
    payoutRetried(actor, claim) {
      writeClaim(actor, claim, 'sale.void.payout_retry_started', {
        void_id: claim.voidId,
        sale_id: claim.saleId,
        kick_count: claim.kickCount,
      });
    },
    payoutDrawer(actor, claim, outcome) {
      writeClaim(actor, claim, 'sale.void.payout_drawer', {
        void_id: claim.voidId,
        sale_id: claim.saleId,
        outcome,
        kick_count: claim.kickCount,
      });
    },
    payoutNotMade(actor, entry, shiftId) {
      deps.sink.emit({
        event_id: deps.newEventId(),
        tenant_id: entry.scope.tenantId,
        branch_id: entry.scope.branchId,
        originating_terminal_id: entry.scope.terminalId,
        acting_operator_id: actor.operatorId,
        session_id: actor.sessionId,
        shift_id: shiftId,
        action_category: 'sale.void.cash_mismatch_flagged',
        created_at: deps.now(),
        approving_supervisor_id: null,
        payload: {
          void_id: entry.voidId,
          sale_id: entry.saleId,
          payout_id: '',
          amount_minor: entry.cashMinor,
          currency_code: entry.currencyCode,
          void_state: entry.state,
          mismatch_reason: 'payout_not_made',
        },
      });
    },
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
  };
}
