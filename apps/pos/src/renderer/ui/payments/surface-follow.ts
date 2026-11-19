import { usePaymentStore } from '../../stores/payment-store.js';
import type { PaymentAttemptRendererView, RefusalReason } from '../../../shared/payments/types.js';
import { confirmEndedCopy } from './payment-read-copy.js';
import {
  CANCEL_FAILED_COPY,
  CANCEL_HOLD_COPY,
  CANCEL_LIVE_TENDER_COPY,
  LIVE_TENDER_STATES,
  cancelNeedsTerminalVoid,
  cancelProvesReversal,
  holdFor,
  type CancelOutcome,
} from './payment-surface-logic.js';
import type { SurfaceContext } from './payment-surface-state.js';

/**
 * RT-1226 — how PaymentSurface follows an attempt main moved on (cancelled,
 * settled, failed, force-failed), moved out of the surface body unchanged.
 */

type TenderLines = PaymentAttemptRendererView['tender_lines'];

/**
 * RT-298 — show what the store says about this sale's cancel when another
 * surface (a cancel sent before a remount) moved it on. `forAttemptId`: a
 * cancel of ours whose answer came after that; a different attempt now in
 * the store is a new payment, so only our stale line is cleared.
 */
export function followStoreOutcome(ctx: SurfaceContext, forAttemptId?: string): void {
  const store = usePaymentStore.getState();
  const slice = store.paymentSlice;
  if (slice === null) {
    ctx.setSelectedTender(null);
    ctx.setAfterApply('idle');
    ctx.setPhase('tender_selection');
    ctx.setBridgeRefusalCopy(null);
    return;
  }
  if (forAttemptId !== undefined && slice.payment_attempt_id !== forAttemptId) {
    ctx.setBridgeRefusalCopy(null);
    return;
  }
  if (slice.state === 'settled') {
    ctx.setPhase('settled');
    return;
  }
  const hold = holdFor(store.cancelRecovery, ctx.envelopeHandoffId, slice.payment_attempt_id);
  const retryable = hold === 'none' && slice.state === 'started';
  ctx.setBridgeRefusalCopy(retryable ? CANCEL_FAILED_COPY : CANCEL_HOLD_COPY[hold]);
  if (hold === 'live_tender') {
    ctx.setSelectedTender(null);
    ctx.setPhase('tender_selection');
  }
}

/** M-P13 when a card line was touched or a card apply was attempted. Sticky for this handoff. */
function flagTerminalVoid(outcome: CancelOutcome, lines: TenderLines): void {
  const store = usePaymentStore.getState();
  const card = {
    appliedLineIds: new Set(store.cardSafety?.appliedCardLineIds ?? []),
    attempted: store.cardSafety?.cardApplyAttempted ?? false,
  };
  if (cancelNeedsTerminalVoid(outcome, lines, card)) store.markCardVoidRequired();
}

/**
 * Main cancelled the attempt. `lines` classify the reversed ids: the
 * projection for a cancel response, main's own lines for a read-back.
 */
export function applyCancelOutcome(
  ctx: SurfaceContext,
  outcome: CancelOutcome,
  lines: TenderLines,
): void {
  ctx.setReversalPending(outcome.reversal_pending_tender_line_ids.length > 0);
  if (
    outcome.reversed_tender_line_ids.length > 0 ||
    outcome.reversal_pending_tender_line_ids.length > 0
  ) {
    ctx.setTenderTouched(true);
  }
  ctx.setTenderReversed(cancelProvesReversal(outcome, lines));
  flagTerminalVoid(outcome, lines);
  usePaymentStore.getState().clearCancelRecovery();
  ctx.setSelectedTender(null);
  ctx.setPhase('tender_selection');
  // The attempt is gone, and with it any pending or failed post-apply read.
  ctx.setAfterApply('idle');
  usePaymentStore.getState().clearAttempt();
}

/**
 * An attempt main has moved past `started`, as on a remount of the same
 * handoff: settled comes back as the settled screen; any other ended attempt
 * is dropped, so the next tender starts anew.
 */
export function followEndedAttempt(ctx: SurfaceContext, attempt: PaymentAttemptRendererView): void {
  if (attempt.state === 'settled') {
    usePaymentStore.getState().applyAttemptSnapshot(attempt);
    ctx.setPhase('settled');
    return;
  }
  const live = attempt.tender_lines.filter((l) => LIVE_TENDER_STATES.has(l.state));
  if (attempt.state === 'force_failed' && live.length > 0) {
    holdForceFailedLiveTender(ctx, attempt, live);
    return;
  }
  leaveEndedAttempt(ctx, attempt);
}

/**
 * Codex P1 on #576 — force-fail does not reverse tender, and main refuses any
 * new payments.start for a cart whose force-failed attempt still holds live
 * tender. Keep the attempt visible and every payment action closed rather than
 * offering a start main will refuse; a card among the live lines may still
 * stand on the terminal (M-P13).
 */
function holdForceFailedLiveTender(
  ctx: SurfaceContext,
  attempt: PaymentAttemptRendererView,
  live: TenderLines,
): void {
  flagTerminalVoid(
    {
      reversed_tender_line_ids: live.map((l) => l.tender_line_id),
      reversal_pending_tender_line_ids: [],
    },
    attempt.tender_lines,
  );
  const store = usePaymentStore.getState();
  store.applyAttemptSnapshot(attempt);
  // The hold lives on the attempt's cancel record. A confirm or remount read
  // reaches here without one, and setting a hold on no record is a no-op
  // (Codex P2 on #626): make sure the record exists first.
  store.cancelKeyFor(attempt.payment_attempt_id);
  store.setCancelHold('live_tender');
  ctx.setBridgeRefusalCopy(CANCEL_LIVE_TENDER_COPY);
  ctx.setSelectedTender(null);
  ctx.setPhase('tender_selection');
}

/**
 * The attempt ended without this cancel (failed / force-failed). Nothing was
 * reversed here, so a card the customer may have been charged for still
 * needs the terminal void before any new charge (M-P13).
 */
function leaveEndedAttempt(ctx: SurfaceContext, attempt: PaymentAttemptRendererView): void {
  const lineIds = attempt.tender_lines.map((l) => l.tender_line_id);
  flagTerminalVoid(
    { reversed_tender_line_ids: lineIds, reversal_pending_tender_line_ids: [] },
    attempt.tender_lines,
  );
  // Main refuses Back for a cart with any tender history; the projection that
  // showed it is cleared here, so keep the fact (Codex P2 on #626).
  if (attempt.tender_lines.length > 0) ctx.setTenderTouched(true);
  usePaymentStore.getState().clearCancelRecovery();
  ctx.setSelectedTender(null);
  ctx.setPhase('tender_selection');
  ctx.setAfterApply('idle');
  usePaymentStore.getState().clearAttempt();
}

/**
 * RT-340 — follow an attempt main ended after this surface sent a payment
 * action, saying why it is gone (M-P25) unless it settled. The line is set
 * first: a force-failed attempt with live tender replaces it with M-P20.
 */
export function followEndedWithReason(
  ctx: SurfaceContext,
  attempt: PaymentAttemptRendererView,
  /**
   * RT-1331: why the settle was refused, when its answer said (a V-A voucher refusal names
   * itself). Required, not defaulted: a caller after a confirm that forgot it would silently
   * lose the voucher fact. Pass `null` where no confirm answer is involved.
   */
  reason: RefusalReason | null,
): void {
  ctx.setBridgeRefusalCopy(attempt.state === 'settled' ? null : confirmEndedCopy(reason));
  followEndedAttempt(ctx, attempt);
}
