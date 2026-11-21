/**
 * RT-1403 S2 — the fail-closed cash payout of a sale void (RT-530 c12022, c12028; owner decisions
 * RT-1403 c18143; the claim and the rest: orchestrator decisions c18153), on RT-15's returns pattern
 * (`returns-payout.ts`).
 *
 * ## Order (chosen so that a crash at any step never pays twice)
 *
 *   1. admit   the feature flag, a live unlocked MANAGER or ADMIN session (L3: the same as the
 *              returns payout), not shutting down, and the terminal's one drawer slot (M1: shared
 *              with the returns payout, refused `another_payout_in_progress`, never queued);
 *   2. gate    the void is CONFIRMED, a shift is open, it is the void's business day, that shift was
 *              already open when the void was requested, and the sale has no cash record yet;
 *   3. claim   the durable claim, the kick about to be sent (`sending`) and the `payout_started`
 *              audit, ONE transaction, BEFORE the drawer is kicked;
 *   4. kick    the sale drawer's own port. Its outcome is persisted and audited (a drawer that opened
 *              must be remembered) before anything else; `no_drawer_configured` (RT-531) proves it
 *              never reached the hardware and completes as `no_drawer`;
 *   5. record  the gate is evaluated AGAIN on fresh reads inside one transaction (a shift closed,
 *              midnight passed, a lock, a swapped session, or a stop during the kick all refuse), then
 *              the payout record and its `sale.void.paid_out` audit are written together.
 *
 *   crash before 3     nothing happened; the void is still payable.
 *   crash after 3      the drawer may have opened and cash may be gone: the till never offers a fresh
 *                      payout (`payout_started`); a manager completes it with `retry_drawer` (only after
 *                      a kick that provably never left) or `manual` (an attested payout), once.
 *
 * A payout refused AFTER the kick says so (`drawer_may_be_open`): the cash must not be handed over.
 * The claim counts as drawer activity in flight (the shift cannot close over it). The amount is the
 * void's journaled net cash; the request carries none. The cash of a sale leaves once: a second
 * payout, or one after a cash exception, is refused. The shift cash-up counts the record, never the
 * request, still inside `cashRefundsTotal`.
 *
 * An operation for the same void while one runs is refused `payout_in_progress`; the slot is
 * process-local, given the single-instance lock (RT-203).
 */
import type { ApprovalSubject } from '../operator/manager-approval-service.js';
import type {
  SaleVoidCashExceptionRequest,
  SaleVoidCashExceptionResponse,
  SaleVoidPayOutRequest,
  SaleVoidPayOutResponse,
  SaleVoidPayoutView,
} from '../../shared/sale-void/types.js';
import { createDrawerSlot } from '../drawer/drawer-slot.js';
import type { PayoutActor } from './sale-void-payout-audit.js';
import { createCashException } from './sale-void-cash-exception.js';
import { createPayoutSteps, refuse } from './sale-void-payout-steps.js';
import {
  GateRefused,
  claimActionsOf,
  createPayoutContext,
  type PayoutSession,
  type SaleVoidPayoutDeps,
} from './sale-void-payout-gate.js';
import type { VoidEntry } from './sale-void-repository.js';

export type { DrawerResult, OpenShiftFact, SaleVoidPayoutDeps } from './sale-void-payout-gate.js';

export interface SaleVoidPayoutService {
  payOut(req: SaleVoidPayOutRequest): Promise<SaleVoidPayOutResponse>;
  recordCashException(req: SaleVoidCashExceptionRequest): Promise<SaleVoidCashExceptionResponse>;
  /** The cash of `entry` as the renderer sees it, with the live reason it cannot be paid yet. */
  viewOf(entry: VoidEntry): SaleVoidPayoutView;
  /** The approval subject of a cash exception for void `subjectRef`, or null. */
  cashExceptionSubject(input: { subjectRef: string }): ApprovalSubject | null;
  /**
   * H2: a confirmed void with cash whose payout window passed unpaid is flagged ONCE in the audit
   * (`payout_not_made`; deduped against the audit itself, no stored flag). Best effort: never throws.
   */
  flagUnpaid(entry: VoidEntry, actor: PayoutActor): void;
}

export function createSaleVoidPayout(deps: SaleVoidPayoutDeps): SaleVoidPayoutService {
  const ctx = createPayoutContext(deps);
  const exception = createCashException(deps, ctx);
  const slot = deps.drawerSlot ?? createDrawerSlot();
  const steps = createPayoutSteps(deps, ctx);
  const { refusalOf, claimAndMark, markRetry, persistKick, commit } = steps;
  const inFlight = new Set<string>();
  /** Steps 3 and 4: claim (or mark the retry), kick, persist what it proved; then the record. */
  async function kickAndComplete(
    session: PayoutSession,
    req: SaleVoidPayOutRequest,
  ): Promise<SaleVoidPayOutResponse> {
    if (req.action === 'start') {
      claimAndMark(session, req.void_id);
    } else {
      const refused = markRetry(session, req.void_id);
      if (refused !== null) return refuse(refused);
    }
    const kicked = await deps.kickDrawer();
    // Stopped during the kick: touch nothing local (the DB closes); the durable `sending` mark
    // remembers the kick, so the next start offers no fresh payout.
    if (deps.isStopped()) return refuse('void_unavailable', true);
    persistKick(session, req.void_id, kicked);
    const mayBeOpen = kicked !== 'no_drawer';
    if (kicked === 'failed') return refuse('payout_drawer_failed', true);
    return commit(session, req.void_id, kicked === 'no_drawer' ? 'no_drawer' : 'drawer', mayBeOpen);
  }

  async function run(
    session: PayoutSession,
    req: SaleVoidPayOutRequest,
  ): Promise<SaleVoidPayOutResponse> {
    try {
      // The cheap refusals first, with no side effect (the claim and manual steps re-check inside).
      const entry = ctx.voidOf(session, req.void_id);
      if (entry === null) return refuse('invalid_input');
      const refusal = refusalOf(entry, req.action, deps.now());
      if (refusal !== null) return refuse(refusal);
      if (req.action === 'manual') return commit(session, req.void_id, 'manual', false);
      return await kickAndComplete(session, req);
    } catch (err) {
      if (err instanceof GateRefused) return refuse(err.reason);
      throw err;
    }
  }

  function viewOf(entry: VoidEntry): SaleVoidPayoutView {
    const none = { paid_at: null, mismatch_reason: null, blocked_reason: null } as const;
    const record = deps.payouts.readByVoid(entry.voidId);
    if (record !== null) {
      return {
        state: record.kind === 'payout' ? 'paid_out' : 'exception',
        claim_actions: [],
        overdue: false,
        paid_at: record.paidAt,
        mismatch_reason: record.mismatchReason,
        blocked_reason: null,
      };
    }
    const now = deps.now();
    const claim = deps.payouts.readClaim(entry.voidId);
    if (claim !== null) {
      return {
        ...none,
        state: 'claimed',
        claim_actions: claimActionsOf(claim, now),
        overdue: false,
      };
    }
    if (entry.state !== 'confirmed' || entry.cashMinor === 0) {
      return { ...none, state: 'none', claim_actions: [], overdue: false };
    }
    const blocked =
      deps.payouts.readBySale(entry.saleId) !== null
        ? 'payout_already_recorded'
        : ctx.blockAt(entry, now, null);
    const overdue = blocked === 'payout_wrong_day' || blocked === 'payout_other_shift';
    return { ...none, state: 'none', claim_actions: [], overdue, blocked_reason: blocked };
  }

  return {
    async payOut(req) {
      const admitted = ctx.admit();
      if (admitted.kind !== 'ok') return admitted;
      // L3: the same as the returns payout: a manager or admin pays out, a cashier never does.
      if (admitted.session.role === 'cashier') return refuse('role_denied');
      if (inFlight.has(req.void_id)) return refuse('payout_in_progress');
      const release = slot.tryAcquire();
      if (release === null) return refuse('another_payout_in_progress');
      inFlight.add(req.void_id);
      try {
        return await run(admitted.session, req);
      } finally {
        inFlight.delete(req.void_id);
        release();
      }
    },
    recordCashException: (req) => exception.record(req),
    viewOf,
    cashExceptionSubject: (input) => exception.subject(input),
    flagUnpaid(entry, actor) {
      try {
        if (!viewOf(entry).overdue || deps.payouts.hasUnpaidFlag(entry.voidId)) return;
        deps.audit.payoutNotMade(actor, entry, ctx.shiftNow(entry.scope)?.shiftId ?? null);
      } catch {
        // Best effort: the list must not fail for a flag; the next read tries again.
      }
    },
  };
}
