/**
 * RT-15 S2 — local audit events for the return flow (AC11).
 *
 * Every attempt, refusal, confirmation and payout-ready writes one
 * `audit_events` row through 004's validating `AuditEmitter` (mandatory FR-025
 * attributes + forbidden-key scan). Operator and terminal are the envelope's
 * `acting_operator_id` / `originating_terminal_id`; the payload carries the
 * sale / return references (`sale_ref`, `return_ref`) and minor-unit amounts.
 */
import type { AuditEvent } from '../../shared/audit/event-shape.js';
import type {
  AuditPayloadMap,
  ConfirmVia,
  SaleReturnClosedNotRecordedPayload,
  SaleReturnLateCommitPayload,
  SaleReturnNeedsSupportPayload,
  SaleReturnRefusedPayload,
  SaleReturnStatusReadPayload,
} from '../../shared/audit/payload-schemas.js';
import type {
  ReturnDrawerFailure,
  ReturnPayoutMethod,
  ReturnUnknownCause,
} from '../../shared/returns/types.js';
import type { JournalEntry, ReturnScope } from './returns-repository.js';

type ReturnAuditCategory = Extract<AuditEvent['action_category'], `sale.return.${string}`>;

export interface ReturnsAuditSink {
  emit(event: AuditEvent): void;
}

/** How a return was sent: the first send, a resolver pass, or a manager's per-row resend. */
export type SendOperation = 'submit' | 'resolve' | 'resend';

/** Who acted, where: the envelope attributes of a return audit event. */
export interface ReturnActor {
  readonly scope: ReturnScope;
  readonly operatorId: string;
  readonly operatorSessionId: string;
}

/**
 * What the drawer kick of a payout did, and what that proves about the drawer.
 * RT-531: `no_drawer_configured` (a terminal with no drawer) is recorded with
 * its kick outcome like any other answer; the payout then completes as `no_drawer`.
 */
export type DrawerAuditOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: ReturnDrawerFailure;
      readonly kickOutcome: 'failed_before_send' | 'unknown';
    };

/** What printing a return slip did; `copy` is a reprint. */
export type SlipAuditOutcome =
  | { readonly copy: boolean; readonly ok: true }
  | { readonly copy: boolean; readonly ok: false; readonly failureReason: string };

export interface ReturnsAudit {
  attempted(entry: JournalEntry): void;
  refused(actor: ReturnActor, payload: SaleReturnRefusedPayload): void;
  /** RT-1498: `via` defaults to `send`; a status read that matched passes `status_read`. */
  confirmed(entry: JournalEntry, replayed: boolean, via?: ConfirmVia): void;
  /** RT-196 S1: one send left the return unknown (cause code, attempt number). */
  attemptUnknown(entry: JournalEntry, cause: ReturnUnknownCause, operation: SendOperation): void;
  /** RT-196 S1: a manager resent this return; attributed to the REQUESTING `actor`. */
  resendRequested(actor: ReturnActor, entry: JournalEntry): void;
  /**
   * RT-1498 S4: the return was handed to support, by a manager's raise (attributed to the REQUESTING
   * `actor`, with the approving manager) or automatically (attributed to the operator who journaled it).
   */
  needsSupport(
    actor: ReturnActor,
    payload: SaleReturnNeedsSupportPayload,
    approvingSupervisorId?: string,
  ): void;
  /**
   * RT-1498 close slice: a manager's status read (or a close's re-read) of the server's verdict,
   * attributed to the REQUESTING `actor`. Ids and closed codes only.
   */
  statusRead(actor: ReturnActor, payload: SaleReturnStatusReadPayload): void;
  /** RT-1498 close slice: the return was closed as "not recorded", with the approving manager. */
  closedNotRecorded(
    actor: ReturnActor,
    payload: SaleReturnClosedNotRecordedPayload,
    approvingSupervisorId: string,
  ): void;
  /** RT-1498 close slice: a return the till CLOSED was later seen as recorded (a mismatch). */
  lateCommit(actor: ReturnActor, payload: SaleReturnLateCommitPayload): void;
  payoutReady(entry: JournalEntry): void;
  // RT-15 S4: attributed to the paying operator (`actor`), for a confirmed return.
  payoutStarted(actor: ReturnActor, entry: JournalEntry): void;
  drawer(actor: ReturnActor, entry: JournalEntry, outcome: DrawerAuditOutcome): void;
  paidOut(actor: ReturnActor, entry: JournalEntry, method: ReturnPayoutMethod): void;
  slip(actor: ReturnActor, entry: JournalEntry, outcome: SlipAuditOutcome): void;
}

/** The ids a refusal may name (each null in the audit when unknown). */
export interface RefusalIds {
  readonly returnId?: string;
  readonly saleId?: string;
  readonly saleRef?: string;
}

/** Audit one refusal of `operation` (AC11): ids and the closed reason only. */
export function auditRefusal(
  audit: Pick<ReturnsAudit, 'refused'>,
  actor: ReturnActor,
  operation: SaleReturnRefusedPayload['operation'],
  reason: string,
  ids: RefusalIds = {},
): void {
  audit.refused(actor, {
    return_id: ids.returnId ?? null,
    sale_id: ids.saleId ?? null,
    sale_ref: ids.saleRef ?? null,
    operation,
    reason,
  });
}

export interface ReturnsAuditDeps {
  readonly sink: ReturnsAuditSink;
  readonly now: () => string;
  readonly newEventId: () => string;
}

function actorOf(entry: JournalEntry): ReturnActor {
  return {
    scope: entry.scope,
    operatorId: entry.operatorId,
    operatorSessionId: entry.operatorSessionId,
  };
}

type ConfirmedCategory = 'sale.return.confirmed' | 'sale.return.payout_ready';
type SharedConfirmedKey = 'return_id' | 'sale_ref' | 'return_ref' | 'currency_code';

interface ConfirmedFacts {
  readonly returnRef: string;
  readonly totalMinor: number;
}

/** The journaled return's confirmed facts; a programming error if absent. */
function confirmedFacts(entry: JournalEntry): ConfirmedFacts {
  if (entry.returnRef === null || entry.returnTotalMinor === null) {
    throw new Error('returns-audit: entry is not confirmed');
  }
  return { returnRef: entry.returnRef, totalMinor: entry.returnTotalMinor };
}

export function createReturnsAudit(deps: ReturnsAuditDeps): ReturnsAudit {
  function write<C extends ReturnAuditCategory>(
    actor: ReturnActor,
    category: C,
    payload: AuditPayloadMap[C],
    approvingSupervisorId: string | null = null,
  ): void {
    deps.sink.emit({
      event_id: deps.newEventId(),
      tenant_id: actor.scope.tenantId,
      branch_id: actor.scope.branchId,
      originating_terminal_id: actor.scope.terminalId,
      acting_operator_id: actor.operatorId,
      session_id: actor.operatorSessionId,
      shift_id: null,
      action_category: category,
      created_at: deps.now(),
      approving_supervisor_id: approvingSupervisorId,
      payload: { ...payload },
    });
  }

  /**
   * One builder for the two events that need a confirmed return: resolves the
   * server facts once and stamps the shared fields; `extra` adds the rest.
   */
  function writeConfirmedEvent<C extends ConfirmedCategory>(
    entry: JournalEntry,
    category: C,
    extra: (facts: ConfirmedFacts) => Omit<AuditPayloadMap[C], SharedConfirmedKey>,
  ): void {
    const facts = confirmedFacts(entry);
    const shared = {
      return_id: entry.returnId,
      sale_ref: entry.serverSaleRef,
      return_ref: facts.returnRef,
      currency_code: entry.currencyCode,
    };
    write(actorOf(entry), category, { ...shared, ...extra(facts) } as AuditPayloadMap[C]);
  }

  function slipEvent(actor: ReturnActor, entry: JournalEntry, outcome: SlipAuditOutcome): void {
    if (!outcome.ok) {
      const failure_reason = outcome.failureReason;
      write(actor, 'sale.return.slip_print_failed', {
        ...refs(entry),
        copy: outcome.copy,
        failure_reason,
      });
      return;
    }
    const category = outcome.copy ? 'sale.return.slip_reprinted' : 'sale.return.slip_printed';
    write(actor, category, refs(entry));
  }

  return {
    attempted(entry) {
      write(actorOf(entry), 'sale.return.attempted', {
        return_id: entry.returnId,
        sale_id: entry.saleId,
        sale_ref: entry.serverSaleRef,
        quoted_total_minor: entry.quotedTotalMinor,
        currency_code: entry.currencyCode,
        line_count: entry.lines.length,
      });
    },
    refused(actor, payload) {
      write(actor, 'sale.return.refused', payload);
    },
    confirmed(entry, replayed, via = 'send') {
      writeConfirmedEvent(entry, 'sale.return.confirmed', (facts) => ({
        sale_id: entry.saleId,
        return_total_minor: facts.totalMinor,
        replayed,
        via,
      }));
    },
    attemptUnknown(entry, cause, operation) {
      write(actorOf(entry), 'sale.return.attempt_unknown', {
        return_id: entry.returnId,
        sale_id: entry.saleId,
        attempt_no: entry.attemptCount,
        cause,
        operation,
      });
    },
    resendRequested(actor, entry) {
      write(actor, 'sale.return.resend_requested', { return_id: entry.returnId });
    },
    needsSupport(actor, payload, approvingSupervisorId) {
      write(actor, 'sale.return.needs_support', payload, approvingSupervisorId ?? null);
    },
    statusRead(actor, payload) {
      write(actor, 'sale.return.status_read', payload);
    },
    closedNotRecorded(actor, payload, approvingSupervisorId) {
      write(actor, 'sale.return.closed_not_recorded', payload, approvingSupervisorId);
    },
    lateCommit(actor, payload) {
      write(actor, 'sale.return.late_commit_after_close', payload);
    },
    payoutReady(entry) {
      writeConfirmedEvent(entry, 'sale.return.payout_ready', (facts) => ({
        payout_minor: facts.totalMinor,
        method: 'cash' as const,
      }));
    },
    payoutStarted(actor, entry) {
      write(actor, 'sale.return.payout_started', {
        ...refs(entry),
        sale_ref: entry.serverSaleRef,
        payout_minor: confirmedFacts(entry).totalMinor,
        currency_code: entry.currencyCode,
      });
    },
    drawer(actor, entry, outcome) {
      if (outcome.ok) {
        write(actor, 'sale.return.drawer_opened', { ...refs(entry), kick_outcome: 'opened' });
        return;
      }
      write(actor, 'sale.return.drawer_failed', {
        ...refs(entry),
        failure_reason: outcome.reason,
        kick_outcome: outcome.kickOutcome,
      });
    },
    paidOut(actor, entry, method) {
      write(actor, 'sale.return.paid_out', {
        ...refs(entry),
        sale_id: entry.saleId,
        sale_ref: entry.serverSaleRef,
        payout_minor: confirmedFacts(entry).totalMinor,
        currency_code: entry.currencyCode,
        method,
        tender: 'cash',
      });
    },
    slip: slipEvent,
  };
}

/** The references every payout event carries. */
function refs(entry: JournalEntry) {
  return { return_id: entry.returnId, return_ref: confirmedFacts(entry).returnRef };
}
