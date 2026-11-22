/**
 * RT-530 — the main-process sale-void domain behind the `saleVoid.*` bridge.
 *
 * `lookup` finds a finalized sale of this terminal by its receipt number and
 * says whether it can be voided now. `request` spends a manager approval on
 * that sale: in ONE transaction it consumes the single-use RT-114 approval
 * (bound to the sale, its total and the requester), reads back the approval's
 * evidence and journals the void with an audit event. Nothing is sent here:
 * the send engine posts it later under the requester's own envelope.
 *
 * Eligibility (owner decisions, Jira RT-530 comment 11988): the sale's
 * business day is today's (the store business day, RT-552), it has no live
 * void and no return. The approval is four-eyes (the approval service refuses the
 * requester and the sale's selling operator as approver; Backend-Core checks
 * both again). A session that could never send the void is refused up front: a
 * cashier needs an operator envelope, a manager or admin signs in with one.
 *
 * Every call passes the same admission gate: the feature flag, an operator
 * session on a paired terminal, not locked. Shutdown (RT-198): once stopped
 * every call answers `void_unavailable` before touching the database.
 *
 * RT-1403 S2: a request moves NO cash. The cash of a void is handed out only through `payOut` once
 * Backend-Core confirmed the void, in an open shift, on the void's day and shift, or recorded once as a
 * manager-attested `recordCashException` (`sale-void-payout.ts`); each journal view carries the cash
 * and its payout state, and the shift cash-up counts the payout record.
 *
 * RT-741: `lookup` then runs the shared RT-546 sale access gate
 * (`sale-access-policy.ts`), because it answers the sale's total, cash and
 * seller: a cashier finds only their own sale, a manager or admin any sale of
 * this terminal. Another operator's sale refuses as `role_denied`, audited as
 * `sale.access.refused`.
 */
import type {
  ApprovalEvidence,
  ApprovalSubject,
  ManagerApprovalService,
} from '../operator/manager-approval-service.js';
import type { SaleRow, SalesRepository } from '../sales/repositories/sales.repository.js';
import { SALE_OWNERSHIP_REFUSAL, type SaleAccessPolicy } from '../sales/sale-access-policy.js';
import { saleNetCashMinor } from '../shift-cashup/shift-cashup-calculator.js';
import type {
  LocalVoidRefusal,
  SaleVoidAcknowledgeRequest,
  SaleVoidAcknowledgeResponse,
  SaleVoidBridgeAPI,
  SaleVoidCashExceptionRequest,
  SaleVoidCashExceptionResponse,
  SaleVoidJournalView,
  SaleVoidListResponse,
  SaleVoidLookupRequest,
  SaleVoidLookupResponse,
  SaleVoidPayOutRequest,
  SaleVoidPayOutResponse,
  SaleVoidRequest,
  SaleVoidRequestResponse,
  SaleVoidSaleView,
  SaleVoidWaitingFor,
} from '../../shared/sale-void/types.js';
import type { SaleVoidAudit } from './sale-void-audit.js';
import type { SaleVoidPayoutService } from './sale-void-payout.js';
import type { SaleVoidRepository, VoidEntry, VoidScope } from './sale-void-repository.js';
import { admitVoidCall } from './sale-void-session.js';
import type { VoidSender } from './sale-void-sync.js';

/** How many journal rows `saleVoid.list` shows. */
export const SALE_VOID_LIST_LIMIT = 50;

/** The `action_kind` of the approval a void spends. */
export const SALE_VOID_ACTION_KIND = 'sale.void' as const;

/** The live operator session on the paired terminal, as the void domain reads it. */
export interface VoidSession {
  readonly sessionId: string;
  readonly operatorId: string;
  readonly displayName: string;
  readonly role: 'cashier' | 'manager' | 'admin';
  readonly scope: VoidScope;
  /** The operator's provider-neutral `users.id`, lower-case; null when unknown. */
  readonly userId: string | null;
  /** True when the session holds a non-empty operator envelope right now. */
  readonly hasEnvelope: boolean;
}

export interface SaleVoidServiceDeps {
  readonly isEnabled: () => boolean;
  readonly getSession: () => VoidSession | null;
  readonly isSessionLocked: () => boolean;
  /** RT-741: the shared RT-546 sale access gate, run by `lookup`. */
  readonly access: Pick<SaleAccessPolicy, 'admitSession' | 'admitSale'>;
  readonly sales: Pick<SalesRepository, 'findByNumber' | 'readById'>;
  readonly repo: SaleVoidRepository;
  /** RT-1403 S2: the gated cash payout, the cash exception and the cash view of a journal row. */
  readonly payout: SaleVoidPayoutService;
  /** True when the sale has a return that is not refused (any other state counts). */
  readonly hasLiveReturn: (saleId: string) => boolean;
  /**
   * RT-1553: before a void of a sale is quoted (`lookup`), a status read of each return of that sale
   * the till closed as not recorded, so a late commit makes the return live again (`has_return`).
   * Best effort: it runs only for a signed-in manager or admin (the read needs their envelope) and
   * never rejects; a cashier's lookup relies on the returns' background sweep. Absent: no check.
   */
  readonly checkLateReturns?: (saleId: string) => Promise<void>;
  readonly approvals: Pick<ManagerApprovalService, 'consume' | 'evidence'>;
  /** The sale's selling operator as a lower-case `users.id`, when provable. */
  readonly sellerUserIdOf: (sale: SaleRow) => string | undefined;
  /** The sale's stored Backend-Core reference, or null while it has not synced. */
  readonly saleRef: (scope: VoidScope, saleId: string) => string | null;
  /** The live eligible sender, to say what a queued void is waiting for. */
  readonly currentSender: () => VoidSender | null;
  readonly audit: Pick<SaleVoidAudit, 'requested'>;
  readonly now: () => string;
  readonly newVoidId: () => string;
  /** `pos-pulse-void:<uuid>`. */
  readonly newExternalId: () => string;
  /**
   * The store business day (`YYYY-MM-DD`) of an ISO instant (RT-552). The
   * same-day check and the `businessDate` sent both use it, so they agree.
   */
  readonly localDayOf: (iso: string) => string;
  readonly captureCurrencyCode: string;
  readonly isStopped: () => boolean;
}

export interface SaleVoidService extends SaleVoidBridgeAPI {
  /** The approval subject of `sale.void` for `subjectRef` (the local sale id), or null. */
  approvalSubject(input: {
    subjectRef: string;
    session: { tenant_id: string; branch_id: string };
  }): ApprovalSubject | null;
  /** RT-1403 S2: the approval subject of `sale.void_cash_exception` for void `subjectRef`, or null. */
  cashExceptionApprovalSubject(input: { subjectRef: string }): ApprovalSubject | null;
}

type Refusal = { kind: 'refused'; reason: LocalVoidRefusal };
const refuse = (reason: LocalVoidRefusal): Refusal => ({ kind: 'refused', reason });

/** A consumed approval that did not hold: thrown to roll the request back. */
class ApprovalRefused extends Error {
  constructor(readonly reason: LocalVoidRefusal) {
    super(reason);
  }
}

type Ineligible = SaleVoidSaleView['ineligible'];

/** Net cash of the sale, or null when its tender summary cannot be read faithfully. */
function cashOf(sale: SaleRow): number | null {
  try {
    return saleNetCashMinor(sale.tender_lines_summary_json);
  } catch {
    return null;
  }
}

/**
 * A session that could never send the void is refused before an approval is spent: one with no
 * `users.id`. Since RT-1403 (RT-530 c12029) a cashier sends over the device path and no longer
 * needs an operator envelope; a manager or admin may request offline and send once online.
 */
function canEverSend(session: VoidSession): boolean {
  return session.userId !== null;
}

export function createSaleVoidService(deps: SaleVoidServiceDeps): SaleVoidService {
  /** The admission gate: flag, live unlocked session, not shutting down. */
  const admit = (): { kind: 'ok'; session: VoidSession } | Refusal => admitVoidCall(deps);

  const inScope = (sale: SaleRow, scope: VoidScope): boolean =>
    sale.tenant_id === scope.tenantId &&
    sale.branch_id === scope.branchId &&
    sale.terminal_id === scope.terminalId;

  /** Why the sale cannot be voided now, or null. */
  function ineligibleReason(sale: SaleRow): Ineligible {
    if (deps.localDayOf(sale.finalized_at) !== deps.localDayOf(deps.now())) return 'not_same_day';
    if (deps.repo.liveForSale(sale.sale_id) !== null) return 'already_voided';
    if (deps.hasLiveReturn(sale.sale_id)) return 'has_return';
    return null;
  }

  function saleView(sale: SaleRow): SaleVoidSaleView {
    return {
      sale_id: sale.sale_id,
      sale_number: sale.sale_number,
      finalized_at: sale.finalized_at,
      total_minor: sale.subtotal_minor,
      cash_minor: cashOf(sale) ?? 0,
      selling_operator_display_name: sale.selling_operator_display_name,
      ineligible: ineligibleReason(sale),
    };
  }

  function waitingFor(entry: VoidEntry): SaleVoidWaitingFor | null {
    if (entry.state !== 'pending' && entry.state !== 'unknown') return null;
    if (deps.saleRef(entry.scope, entry.saleId) === null) return 'sale_sync';
    const sender = deps.currentSender();
    const mine =
      sender !== null &&
      sender.operatorUserId.toLowerCase() === entry.requesterUserId.toLowerCase();
    return mine ? null : 'requester_sign_in';
  }

  function journalView(entry: VoidEntry): SaleVoidJournalView {
    const payout = deps.payout.viewOf(entry);
    // Staff look at a refusal nobody acknowledged, a payout left claimed (the drawer may be open) and
    // a confirmed void whose cash was never paid out before its window passed (RT-1403 S2: H1, H2).
    const attention =
      (entry.state === 'refused' && entry.acknowledgedAt === null) ||
      payout.state === 'claimed' ||
      payout.overdue;
    return {
      void_id: entry.voidId,
      sale_number: entry.saleNumber,
      total_minor: entry.amountMinor,
      requested_at: entry.requestedAt,
      state: entry.state,
      requester_display_name: entry.requesterDisplayName,
      waiting_for: waitingFor(entry),
      refusal_reason: entry.refusalReason,
      needs_attention: attention,
      confirmed_at: entry.confirmedAt,
      cash_minor: entry.cashMinor,
      payout,
    };
  }

  /** The approval subject: this sale, its total, and (when provable) its seller. */
  function subjectOf(sale: SaleRow): ApprovalSubject {
    const sellerUserId = deps.sellerUserIdOf(sale);
    return {
      version: `sale-void:${sale.sale_id}`,
      amountMinor: sale.subtotal_minor,
      ...(sellerUserId === undefined ? {} : { sellerUserId }),
    };
  }

  function approvalSubject(input: {
    subjectRef: string;
    session: { tenant_id: string; branch_id: string };
  }): ApprovalSubject | null {
    const sale = deps.sales.readById(input.subjectRef);
    if (sale === null) return null;
    if (sale.tenant_id !== input.session.tenant_id || sale.branch_id !== input.session.branch_id) {
      return null;
    }
    return ineligibleReason(sale) === null ? subjectOf(sale) : null;
  }

  /**
   * The journal write, ONE transaction (the repository's): spend the approval,
   * read its evidence, insert the row, audit. Any refusal or failure rolls the
   * whole thing back, so a refused or failed request never spends the approval.
   */
  function journal(input: {
    sale: SaleRow;
    session: VoidSession;
    approvalId: string;
    cashMinor: number;
    userId: string;
  }): VoidEntry {
    const { sale, session, approvalId } = input;
    const voidId = deps.newVoidId();
    deps.repo.insertFrom(
      () => {
        const evidence = spendApproval(input);
        return {
          voidId,
          scope: session.scope,
          saleId: sale.sale_id,
          saleNumber: sale.sale_number,
          externalId: deps.newExternalId(),
          approvalId,
          approverUserId: evidence.approverUserId,
          requesterUserId: input.userId,
          requesterOperatorId: session.operatorId,
          requesterDisplayName: session.displayName,
          operatorSessionId: session.sessionId,
          policyVersion: evidence.policyVersion,
          approvedAt: evidence.issuedAt,
          businessDate: deps.localDayOf(sale.finalized_at),
          amountMinor: sale.subtotal_minor,
          cashMinor: input.cashMinor,
          currencyCode: deps.captureCurrencyCode,
          now: deps.now(),
        };
      },
      (inserted) => {
        deps.audit.requested(inserted);
      },
    );
    const entry = deps.repo.read(voidId);
    if (entry === null) throw new Error('sale-void: journaled row vanished');
    return entry;
  }

  /** Consume the approval against this sale and read back what it proved. */
  function spendApproval(input: {
    sale: SaleRow;
    session: VoidSession;
    approvalId: string;
    userId: string;
  }): ApprovalEvidence {
    const { sale, session, approvalId } = input;
    const consumed = deps.approvals.consume({
      approvalId,
      actionKind: SALE_VOID_ACTION_KIND,
      subjectRef: sale.sale_id,
      subject: subjectOf(sale),
      session: {
        operator_id: session.operatorId,
        tenant_id: session.scope.tenantId,
        branch_id: session.scope.branchId,
      },
    });
    if (consumed.kind === 'refused') throw new ApprovalRefused(consumed.reason);
    const evidence = deps.approvals.evidence(approvalId);
    // The approval must have been granted to THIS requester (their users.id).
    if (evidence === null || evidence.requesterUserId !== input.userId) {
      throw new ApprovalRefused('approval_invalid');
    }
    return evidence;
  }

  /** The requester's own retry of an approval already journaled: the same void. */
  function replayOf(
    approvalId: string,
    sale: SaleRow,
    userId: string,
  ): SaleVoidRequestResponse | null {
    const existing = deps.repo.readByApproval(approvalId);
    if (existing === null) return null;
    const same = existing.saleId === sale.sale_id && existing.requesterUserId === userId;
    return same ? { kind: 'requested', void: journalView(existing) } : refuse('approval_invalid');
  }

  /** The sale of this terminal a request names, or why there is none. */
  function saleOf(session: VoidSession, saleId: string): SaleRow | Refusal {
    const sale = deps.sales.readById(saleId);
    return sale !== null && inScope(sale, session.scope) ? sale : refuse('sale_not_found');
  }

  /** Journal the void: spend the approval, or answer why it did not hold. */
  function journalRequested(input: {
    sale: SaleRow;
    session: VoidSession;
    approvalId: string;
    userId: string;
  }): SaleVoidRequestResponse {
    const cashMinor = cashOf(input.sale);
    if (cashMinor === null) return refuse('void_unavailable');
    try {
      const entry = journal({ ...input, cashMinor });
      return { kind: 'requested', void: journalView(entry) };
    } catch (err) {
      if (err instanceof ApprovalRefused) return refuse(err.reason);
      throw err;
    }
  }

  function requestAdmitted(session: VoidSession, req: SaleVoidRequest): SaleVoidRequestResponse {
    const userId = session.userId;
    if (userId === null || !canEverSend(session)) return refuse('no_operator_envelope');
    const sale = saleOf(session, req.sale_id);
    if ('kind' in sale) return sale;
    const replay = replayOf(req.approval_id, sale, userId);
    if (replay !== null) return replay;
    const ineligible = ineligibleReason(sale);
    if (ineligible !== null) return refuse(ineligible);
    return journalRequested({ sale, session, approvalId: req.approval_id, userId });
  }

  /* The bridge methods are async so an unexpected throw is a rejected promise, never a sync throw. */
  return {
    approvalSubject,
    cashExceptionApprovalSubject: (input) => deps.payout.cashExceptionSubject(input),

    async lookup(req: SaleVoidLookupRequest): Promise<SaleVoidLookupResponse> {
      const admitted = admit();
      if (admitted.kind !== 'ok') return admitted;
      const gate = deps.access.admitSession('saleVoid.lookup');
      if (!gate.ok) return refuse(gate.reason);
      const sale = deps.sales.findByNumber(req.sale_number, {
        tenant_id: admitted.session.scope.tenantId,
        branch_id: admitted.session.scope.branchId,
        terminal_id: admitted.session.scope.terminalId,
      });
      if (sale === null) return refuse('sale_not_found');
      // OD-534-1: the view carries the total, cash and seller name.
      if (!deps.access.admitSale('saleVoid.lookup', gate.session, sale)) {
        return refuse(SALE_OWNERSHIP_REFUSAL);
      }
      if (deps.checkLateReturns !== undefined) {
        await deps.checkLateReturns(sale.sale_id);
        // After the await: the gate again (a sign-out, lock or stop meanwhile wins).
        const again = admit();
        if (again.kind !== 'ok') return again;
      }
      return { kind: 'sale', sale: saleView(sale) };
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async request(req: SaleVoidRequest): Promise<SaleVoidRequestResponse> {
      const admitted = admit();
      if (admitted.kind !== 'ok') return admitted;
      return requestAdmitted(admitted.session, req);
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async list(): Promise<SaleVoidListResponse> {
      const admitted = admit();
      if (admitted.kind !== 'ok') return admitted;
      const scope = admitted.session.scope;
      const recent = deps.repo.listRecent(scope, SALE_VOID_LIST_LIMIT);
      // H2: a confirmed void never paid out is flagged once in the audit as the list shows it.
      const actor = {
        operatorId: admitted.session.operatorId,
        sessionId: admitted.session.sessionId,
      };
      for (const row of recent) deps.payout.flagUnpaid(row, actor);
      // A refusal stays visible until acknowledged, and a payout claim with no record until it is
      // settled (drawer cash in flight, or a stale claim only a manager exception settles),
      // however many newer voids exist (RT-1403 c18188 M1).
      const listed = new Set(recent.map((row) => row.voidId));
      const older = [
        ...deps.repo.listUnacknowledgedRefused(scope),
        ...deps.repo.listWithUnsettledClaim(scope),
      ].filter((row) => {
        if (listed.has(row.voidId)) return false;
        listed.add(row.voidId);
        return true;
      });
      return { kind: 'list', voids: [...recent, ...older].map(journalView) };
    },

    payOut: (req: SaleVoidPayOutRequest): Promise<SaleVoidPayOutResponse> =>
      deps.payout.payOut(req),

    recordCashException: (
      req: SaleVoidCashExceptionRequest,
    ): Promise<SaleVoidCashExceptionResponse> => deps.payout.recordCashException(req),

    // eslint-disable-next-line @typescript-eslint/require-await
    async acknowledge(req: SaleVoidAcknowledgeRequest): Promise<SaleVoidAcknowledgeResponse> {
      const admitted = admit();
      if (admitted.kind !== 'ok') return admitted;
      const row = deps.repo.read(req.void_id);
      const own =
        row !== null &&
        row.scope.tenantId === admitted.session.scope.tenantId &&
        row.scope.branchId === admitted.session.scope.branchId &&
        row.scope.terminalId === admitted.session.scope.terminalId;
      if (!own || !deps.repo.acknowledge({ voidId: req.void_id, now: deps.now() })) {
        return refuse('invalid_input');
      }
      return { kind: 'acknowledged' };
    },
  };
}
