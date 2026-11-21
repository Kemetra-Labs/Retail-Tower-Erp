/**
 * RT-1403 S2 — the fail-closed cash payout of a sale void (RT-530 c12022, c12028; owner decisions
 * RT-1403 c18143).
 *
 * ## Order (so that a crash or a refusal at any step never pays out of the books)
 *
 *   1. admit   the feature flag, a live unlocked operator session, not shutting down;
 *   2. gate    the void is CONFIRMED, a shift is open, it is the void's business day, and that
 *              shift was already open when the void was requested (`sale-void-payout-gate.ts`);
 *   3. kick    the sale drawer's own port. A failed kick records nothing (`payout_drawer_failed`)
 *              and may be tried again; `no_drawer_configured` (RT-531) completes as `no_drawer`;
 *   4. commit  the gate is evaluated AGAIN on fresh reads inside one transaction (a shift closed,
 *              midnight passed, a session locked or swapped, or a stop during the kick all refuse),
 *              then the payout record and its `sale.void.paid_out` audit are written together.
 *
 * The amount is the void's journaled net cash; the request carries none. The cash of a sale
 * leaves once: a second payout, or a payout after a cash exception, is refused. The shift cash-up
 * counts the record (never the request), still inside `cashRefundsTotal`.
 *
 * A repeat for the same void while one runs is refused `payout_in_progress` (one drawer, one
 * kick); the slot is process-local, given the single-instance lock (RT-203).
 */
import type { ApprovalSubject } from '../operator/manager-approval-service.js';
import type {
  SaleVoidCashExceptionRequest,
  SaleVoidCashExceptionResponse,
  SaleVoidPayOutRequest,
  SaleVoidPayOutResponse,
  SaleVoidPayoutView,
} from '../../shared/sale-void/types.js';
import { createCashException } from './sale-void-cash-exception.js';
import {
  GateRefused,
  createPayoutContext,
  payOutRefusal,
  payoutBlockOf,
  refuse,
  type PayoutSession,
  type SaleVoidPayoutDeps,
} from './sale-void-payout-gate.js';
import type { NewPayout } from './sale-void-payout-repository.js';
import type { VoidEntry } from './sale-void-repository.js';

export type { DrawerResult, OpenShiftFact, SaleVoidPayoutDeps } from './sale-void-payout-gate.js';

export interface SaleVoidPayoutService {
  payOut(req: SaleVoidPayOutRequest): Promise<SaleVoidPayOutResponse>;
  recordCashException(req: SaleVoidCashExceptionRequest): Promise<SaleVoidCashExceptionResponse>;
  /** The cash of `entry` as the renderer sees it, with the live reason it cannot be paid yet. */
  viewOf(entry: VoidEntry): SaleVoidPayoutView;
  /** The approval subject of a cash exception for void `subjectRef`, or null. */
  cashExceptionSubject(input: { subjectRef: string }): ApprovalSubject | null;
}

export function createSaleVoidPayout(deps: SaleVoidPayoutDeps): SaleVoidPayoutService {
  const ctx = createPayoutContext(deps);
  const exception = createCashException(deps, ctx);
  const inFlight = new Set<string>();

  /** The gate on fresh reads; throws a `GateRefused` when cash may not leave. */
  function gate(session: PayoutSession, voidId: string): VoidEntry {
    const entry = ctx.voidOf(session, voidId);
    if (entry === null) throw new GateRefused('invalid_input');
    const refusal = payOutRefusal({
      entry,
      existing: ctx.existingFor(entry),
      block: ctx.blockNow(entry),
    });
    if (refusal !== null) throw new GateRefused(refusal);
    return entry;
  }

  /** The record of the gated payout, built INSIDE the commit transaction. */
  function build(
    session: PayoutSession,
    voidId: string,
    method: 'drawer' | 'no_drawer',
  ): NewPayout {
    const entry = gate(session, voidId);
    const shift = ctx.shiftNow(entry.scope);
    if (shift === null) throw new GateRefused('payout_no_open_shift');
    return {
      payoutId: deps.newPayoutId(),
      voidId: entry.voidId,
      saleId: entry.saleId,
      scope: entry.scope,
      shiftId: shift.shiftId,
      businessDate: entry.businessDate,
      kind: 'payout',
      method,
      amountMinor: entry.cashMinor,
      currencyCode: entry.currencyCode,
      voidState: 'confirmed',
      mismatchReason: null,
      paidAt: deps.now(),
      paidBy: {
        operatorId: session.operatorId,
        displayName: session.displayName,
        sessionId: session.sessionId,
      },
      exception: null,
    };
  }

  /** After the kick: the same admitted session must still hold, then commit. */
  function commit(
    session: PayoutSession,
    voidId: string,
    method: 'drawer' | 'no_drawer',
  ): SaleVoidPayOutResponse {
    const again = ctx.admit();
    if (again.kind !== 'ok') return again;
    if (again.session.sessionId !== session.sessionId) return refuse('no_session');
    try {
      deps.payouts.insertFrom(
        () => build(session, voidId, method),
        (inserted) => {
          deps.audit.paidOut(inserted);
        },
      );
    } catch (err) {
      if (err instanceof GateRefused) return refuse(err.reason);
      throw err;
    }
    return { kind: 'paid_out' };
  }

  async function payOutAdmitted(
    session: PayoutSession,
    req: SaleVoidPayOutRequest,
  ): Promise<SaleVoidPayOutResponse> {
    try {
      gate(session, req.void_id);
    } catch (err) {
      if (err instanceof GateRefused) return refuse(err.reason);
      throw err;
    }
    const kicked = await deps.kickDrawer();
    if (deps.isStopped()) return refuse('void_unavailable');
    if (kicked === 'failed') return refuse('payout_drawer_failed');
    return commit(session, req.void_id, kicked === 'no_drawer' ? 'no_drawer' : 'drawer');
  }

  function viewOf(entry: VoidEntry): SaleVoidPayoutView {
    const record = deps.payouts.readByVoid(entry.voidId);
    if (record !== null) {
      return {
        state: record.kind === 'payout' ? 'paid_out' : 'exception',
        paid_at: record.paidAt,
        mismatch_reason: record.mismatchReason,
        blocked_reason: null,
      };
    }
    return {
      state: 'none',
      paid_at: null,
      mismatch_reason: null,
      blocked_reason: blockedOf(entry),
    };
  }

  /** Why a confirmed void with cash cannot be paid out now; null when it can, or is not due. */
  function blockedOf(entry: VoidEntry): SaleVoidPayoutView['blocked_reason'] {
    if (entry.state !== 'confirmed' || entry.cashMinor === 0) return null;
    if (deps.payouts.readBySale(entry.saleId) !== null) return 'payout_already_recorded';
    return payoutBlockOf({
      entry,
      shift: ctx.shiftNow(entry.scope),
      today: deps.localDayOf(deps.now()),
    });
  }

  return {
    async payOut(req) {
      const admitted = ctx.admit();
      if (admitted.kind !== 'ok') return admitted;
      if (inFlight.has(req.void_id)) return refuse('payout_in_progress');
      inFlight.add(req.void_id);
      try {
        return await payOutAdmitted(admitted.session, req);
      } finally {
        inFlight.delete(req.void_id);
      }
    },
    recordCashException: (req) => exception.record(req),
    viewOf,
    cashExceptionSubject: (input) => exception.subject(input),
  };
}
