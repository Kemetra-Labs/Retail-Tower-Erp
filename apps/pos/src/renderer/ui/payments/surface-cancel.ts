import { usePaymentStore } from '../../stores/payment-store.js';
import {
  CANCEL_FAILED_COPY,
  CANCEL_NOT_OPEN_COPY,
  CANCEL_UNKNOWN_COPY,
  cancelOutcomeFromRead,
  holdFor,
  type OwnCancel,
} from './payment-surface-logic.js';
import type { SurfaceContext } from './payment-surface-state.js';
import { applyCancelOutcome, followEndedAttempt, followStoreOutcome } from './surface-follow.js';
import { isCancelStillCurrent, readAttemptWithRetry } from './surface-reads.js';

/**
 * RT-1226 — PaymentSurface's cancel (RT-298 holds, M-P7 card confirm), moved
 * out of the surface body unchanged. Each takes the render's context.
 */

/**
 * RT-1409 — the store already holds this attempt force-failed with live tender
 * (main refuses any payment on it). A cancel read-back that was taken before
 * that, or that failed, knows less than the store: it must not replace the
 * snapshot or the hold, or the cashier is offered tender actions main refuses.
 */
function isHeldForceFailed(cancel: {
  readonly attemptId: string;
  readonly handoffId: string;
}): boolean {
  const { attemptId, handoffId } = cancel;
  const { paymentSlice, cancelRecovery } = usePaymentStore.getState();
  return (
    paymentSlice?.payment_attempt_id === attemptId &&
    paymentSlice.state === 'force_failed' &&
    holdFor(cancelRecovery, handoffId, attemptId) === 'live_tender'
  );
}

/**
 * RT-298 — the cancel threw or was refused, but main may still have committed
 * it (the FSM commits before the audits, so a late failure loses the
 * response). Read the attempt before re-opening any payment action, and act
 * on main's durable state rather than on the lost answer.
 */
async function reconcileAfterCancel(
  ctx: SurfaceContext,
  attemptId: string,
  handoffId: string,
  own: OwnCancel,
): Promise<void> {
  const attempt = await readAttemptWithRetry(ctx, attemptId);
  // RT-305 — the screen already followed the store; this read changes nothing.
  if (own.status === 'followed') return;
  own.status = 'answered';
  if (!isCancelStillCurrent(attemptId, handoffId)) {
    followStoreOutcome(ctx, attemptId);
    return;
  }
  // RT-1409 — a newer read already stored force_failed with live tender. Neither a
  // started snapshot read before it nor a failed read may replace it or its hold:
  // show what the store says.
  if (isHeldForceFailed({ attemptId, handoffId })) {
    followStoreOutcome(ctx, attemptId);
    return;
  }
  if (attempt === null) {
    usePaymentStore.getState().setCancelHold('unconfirmed');
    ctx.setBridgeRefusalCopy(CANCEL_UNKNOWN_COPY);
    return;
  }
  if (attempt.state === 'cancelled') {
    applyCancelOutcome(ctx, cancelOutcomeFromRead(attempt), attempt.tender_lines);
    return;
  }
  usePaymentStore.getState().setCancelHold('none');
  if (attempt.state === 'started') {
    usePaymentStore.getState().applyAttemptSnapshot(attempt);
    ctx.setBridgeRefusalCopy(CANCEL_FAILED_COPY);
    return;
  }
  ctx.setBridgeRefusalCopy(CANCEL_NOT_OPEN_COPY);
  followEndedAttempt(ctx, attempt);
}

export async function handleCancel(ctx: SurfaceContext): Promise<void> {
  const { bridge, paymentAttemptId, envelope } = ctx;
  if (bridge === null || paymentAttemptId === null || envelope === null) {
    return;
  }
  const attemptId = paymentAttemptId;
  const handoffId = envelope.handoff_action_id;
  ctx.setBridgeRefusalCopy(null);
  ctx.setIsCancelling(true);
  const own: OwnCancel = { attemptId, status: 'waiting' };
  ctx.ownCancelRef.current = own;
  const store = usePaymentStore.getState();
  const key = store.cancelKeyFor(attemptId);
  // Held from the moment it is sent: leaving and re-entering Checkout before
  // main answers must not reopen payment actions (Codex P2, #576).
  store.setCancelHold('in_flight');
  try {
    const response = await bridge.payments
      .cancel({ payment_attempt_id: attemptId, idempotency_key: key })
      .catch(() => null);
    // RT-305 — the screen already followed the store's outcome for this
    // attempt; a late answer must not apply one of its own.
    if (own.status === 'followed') return;
    // A late answer (a retry after a remount already settled this cancel,
    // and another attempt may have begun) must not touch that newer attempt
    // (Codex P1, #576). Whatever settled it, this surface shows the store's
    // outcome rather than keeping its own stale line (Codex P2, #576).
    if (!isCancelStillCurrent(attemptId, handoffId)) {
      followStoreOutcome(ctx, attemptId);
      return;
    }
    if (response?.kind === 'ok') {
      const linesAtCancel = usePaymentStore.getState().paymentSlice?.tender_lines ?? [];
      applyCancelOutcome(ctx, response, linesAtCancel);
    } else {
      await reconcileAfterCancel(ctx, attemptId, handoffId, own);
    }
  } finally {
    // Hand the hold back to the sync effect at the value this cancel left,
    // so it never re-applies this surface's own outcome. A followed cancel
    // (RT-305) already handed the screen over, and a newer cancel may own it.
    if (ctx.ownCancelRef.current === own) {
      const after = usePaymentStore.getState();
      ctx.lastHoldRef.current = holdFor(
        after.cancelRecovery,
        handoffId,
        after.paymentSlice?.payment_attempt_id ?? null,
      );
      ctx.ownCancelRef.current = null;
      ctx.setIsCancelling(false);
    }
  }
}

/**
 * M-P7 (RT-116 §3) — a cancel here does not void a charge on the standalone
 * terminal. When one may stand (a card line is recorded, or a card apply was
 * sent for this sale, even one whose answer was lost: the RT-256 facts), the
 * cashier confirms first, with «رجوع» focused. A retry of a cancel already
 * sent (a hold stands) replays the same key and is not asked again.
 */
export function requestCancel(ctx: SurfaceContext): void {
  const store = usePaymentStore.getState();
  const safety = store.cardSafety;
  const cardForThisSale =
    safety !== null &&
    safety.handoffId === ctx.envelopeHandoffId &&
    (safety.cardApplyAttempted || safety.appliedCardLineIds.length > 0);
  const cardRecorded = (store.paymentSlice?.tender_lines ?? []).some(
    (l) => l.tender_type === 'external_card_terminal' && l.state === 'applied',
  );
  if (ctx.cancelHold === 'none' && (cardForThisSale || cardRecorded)) {
    ctx.setConfirmCardCancel(true);
    return;
  }
  void handleCancel(ctx);
}
