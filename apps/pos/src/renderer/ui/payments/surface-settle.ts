import { usePaymentStore } from '../../stores/payment-store.js';
import type { RefusalReason } from '../../../shared/payments/types.js';
import { confirmRefusalCopy, moneyStillDue } from './payment-read-copy.js';
import type { SurfaceContext } from './payment-surface-state.js';
import { followEndedAttempt, followEndedWithReason } from './surface-follow.js';
import {
  blockOnSessionRefusal,
  isSessionRefusal,
  isStillCurrent,
  readAttemptOutcome,
  readAttemptWithRetry,
} from './surface-reads.js';

/**
 * RT-1226 — the reads after a start or an apply, and the settle, moved out of
 * the PaymentSurface body unchanged. Each takes the render's context.
 */

/**
 * RT-341 — read main after a successful start. Nothing is offered until it
 * answers (the RT-243 F1 rule); a failed or refused read offers the retry,
 * and an attempt main has moved on is followed, as on a remount.
 */
export async function readAfterStart(ctx: SurfaceContext, attemptId: string | null): Promise<void> {
  if (attemptId === null) return;
  const envelopeAtStart = usePaymentStore.getState().envelope;
  ctx.setReadAfter('start');
  ctx.setAfterApply('reading');
  const outcome = await readAttemptOutcome(ctx, attemptId);
  if (!isStillCurrent(attemptId, envelopeAtStart)) return;
  if (blockOnSessionRefusal(ctx, outcome)) return;
  const attempt = outcome?.kind === 'ok' ? outcome.payment_attempt : null;
  if (attempt === null) {
    ctx.setAfterApply('failed');
    return;
  }
  ctx.setAfterApply('idle');
  ctx.setReadAfter('tender');
  if (attempt.state === 'started') {
    usePaymentStore.getState().applyAttemptSnapshot(attempt);
    return;
  }
  followEndedWithReason(ctx, attempt);
}

/**
 * RT-243 F1 — the remount read. Nothing is offered until main answers; a
 * failed read offers the retry (M-P15). Main's answer is followed whatever
 * it says: a settle whose response was lost before the remount comes back as
 * the settled screen, never as another commit (Codex P1 on #618).
 */
export async function rereadOnResume(ctx: SurfaceContext): Promise<void> {
  const { bridge, paymentAttemptId } = ctx;
  if (bridge === null || paymentAttemptId === null) return;
  const attemptId = paymentAttemptId;
  const store = usePaymentStore.getState();
  // RT-340 — a settle whose read-back failed before the remount: resume that
  // reconciliation, so the same copy decision follows (Codex P2 on #626).
  const pending = store.confirmReadPending;
  if (pending?.attemptId === attemptId) {
    await reconcileAfterConfirm(ctx, attemptId, pending.reason);
    return;
  }
  const envelopeAtStart = store.envelope;
  // RT-356 — M-P15 says an amount was recorded: true only once one was sent on
  // this attempt (kept in the store across the remount); otherwise M-P27.
  const moneyMaybeRecorded =
    store.tenderSentAttemptId === attemptId || (store.paymentSlice?.tender_lines.length ?? 0) > 0;
  ctx.setReadAfter(moneyMaybeRecorded ? 'tender' : 'start');
  ctx.setAfterApply('reading');
  const attempt = await readAttemptWithRetry(ctx, attemptId);
  if (!isStillCurrent(attemptId, envelopeAtStart)) return;
  if (attempt === null) {
    ctx.setAfterApply('failed');
    return;
  }
  ctx.setAfterApply('idle');
  if (attempt.state === 'started') {
    usePaymentStore.getState().applyAttemptSnapshot(attempt);
    return;
  }
  followEndedAttempt(ctx, attempt);
}

export async function handleLineApplied(ctx: SurfaceContext): Promise<void> {
  const { bridge, paymentAttemptId, envelope } = ctx;
  if (bridge === null || paymentAttemptId === null || envelope === null) {
    return;
  }
  const attemptId = paymentAttemptId;
  const envelopeAtStart = usePaymentStore.getState().envelope;
  ctx.setAfterApply('reading');
  const outcome = await readAttemptOutcome(ctx, attemptId);
  if (!isStillCurrent(attemptId, envelopeAtStart)) return;
  if (blockOnSessionRefusal(ctx, outcome)) return;
  const attempt = outcome?.kind === 'ok' ? outcome.payment_attempt : null;
  if (attempt === null) {
    // The apply succeeded in main but its state could not be read. Keep the
    // apply out of reach and offer a retry instead.
    ctx.setAfterApply('failed');
    return;
  }
  ctx.setAfterApply('idle');
  // RT-340 — this read is also the retry after a lost settle: an attempt main
  // has moved past `started` is followed (settled → Completion), never
  // offered another commit.
  if (attempt.state !== 'started') {
    followEndedWithReason(ctx, attempt);
    return;
  }
  usePaymentStore.getState().applyAttemptSnapshot(attempt);
  // Split-tender (T154): if the running sum is still below the subtotal,
  // return to tender selection so the cashier may add another line. When
  // the sum equals the subtotal, the surface stays put and the confirm
  // button becomes visible. The settlement invariant itself is enforced
  // on the main process at payments.confirm time.
  // CR-11: guard every accumulator step with Number.isSafeInteger
  // (Constitution §II). A malformed minor value silently produces a
  // float-tainted running sum without this check.
  let sumApplied = 0;
  for (const line of attempt.tender_lines) {
    if (line.state !== 'applied') continue;
    if (!Number.isSafeInteger(line.amount_applied_minor)) continue;
    sumApplied += line.amount_applied_minor;
    if (!Number.isSafeInteger(sumApplied)) {
      // Running sum overflowed — bail out without changing the phase.
      return;
    }
  }
  if (sumApplied < ctx.dueMinor) {
    ctx.setSelectedTender(null);
    ctx.setPhase('tender_selection');
  }
}

/**
 * RT-238: the settle commit is blocked while the projection says money is
 * owed. If that projection is stale (a failed read after a successful apply),
 * the cashier must not be stuck: a click on the blocked commit re-reads the
 * attempt from main, and an up-to-date projection unblocks it.
 */
export async function rereadAttempt(ctx: SurfaceContext): Promise<void> {
  const { bridge, paymentAttemptId } = ctx;
  if (bridge === null || paymentAttemptId === null) return;
  const attemptId = paymentAttemptId;
  const envelopeAtStart = usePaymentStore.getState().envelope;
  try {
    const readResponse = await bridge.payments.read({ payment_attempt_id: attemptId });
    if (!isStillCurrent(attemptId, envelopeAtStart)) return;
    if (readResponse.kind === 'ok') {
      usePaymentStore.getState().applyAttemptSnapshot(readResponse.payment_attempt);
    }
  } catch {
    // Keep the current projection; the next click retries.
  }
}

// 023 V5 sale lifecycle — the settled phase is component state and dies with
// this surface, so the payment projection must carry the settle for a Sale
// screen reopened later to recognise the sale as paid.
// The confirm `ok` is main's authoritative settle: record it at once so a
// failed follow-up read can never leave the sale payable again. The re-read
// then only refines the projection, and is discarded if the payment context
// moved on (New sale / another envelope) while it was in flight.
function recordSettledFromConfirm(attemptId: string, settledAt: string): void {
  const store = usePaymentStore.getState();
  const slice = store.paymentSlice;
  if (slice?.payment_attempt_id !== attemptId) return;
  store.applyAttemptSnapshot({ ...slice, state: 'settled', settled_at: settledAt });
}

async function refineSettledAttempt(ctx: SurfaceContext, attemptId: string): Promise<void> {
  const { bridge } = ctx;
  if (bridge === null) return;
  const envelopeAtConfirm = usePaymentStore.getState().envelope;
  try {
    const readResponse = await bridge.payments.read({ payment_attempt_id: attemptId });
    const store = usePaymentStore.getState();
    const sameContext =
      store.envelope === envelopeAtConfirm && store.paymentSlice?.payment_attempt_id === attemptId;
    if (
      readResponse.kind === 'ok' &&
      sameContext &&
      readResponse.payment_attempt.payment_attempt_id === attemptId
    ) {
      store.applyAttemptSnapshot(readResponse.payment_attempt);
    }
  } catch {
    // Keep the settle already recorded from the confirm response.
  }
}

export async function handleConfirm(ctx: SurfaceContext, startedAttemptId?: string): Promise<void> {
  const { bridge } = ctx;
  const attemptId = startedAttemptId ?? ctx.paymentAttemptId;
  if (bridge === null || attemptId === null) {
    return;
  }
  ctx.setBridgeRefusalCopy(null);
  ctx.setIsConfirming(true);
  try {
    const response = await bridge.payments
      .confirm({ payment_attempt_id: attemptId, idempotency_key: crypto.randomUUID() })
      .catch(() => null);
    if (response?.kind === 'ok') {
      ctx.setPhase('settled');
      recordSettledFromConfirm(attemptId, response.settled_at);
      void refineSettledAttempt(ctx, attemptId);
      return;
    }
    await reconcileAfterConfirm(ctx, attemptId, response?.reason ?? null);
  } finally {
    ctx.setIsConfirming(false);
  }
}

/**
 * RT-340 — the settle was refused or its answer lost, but main may have
 * settled it (a confirm whose response was lost comes back as
 * `attempt_terminal`). Read main and follow it rather than inviting a retry
 * that cannot succeed. `reason` is null when the confirm itself failed.
 */
async function reconcileAfterConfirm(
  ctx: SurfaceContext,
  attemptId: string,
  reason: RefusalReason | null,
): Promise<void> {
  if (reason !== null && blockOnSessionRefusal(ctx, { kind: 'refused', reason })) return;
  const store = usePaymentStore.getState();
  const envelopeAtStart = store.envelope;
  store.setConfirmReadPending({ attemptId, reason });
  ctx.setReadAfter('confirm');
  ctx.setAfterApply('reading');
  const outcome = await readAttemptOutcome(ctx, attemptId);
  if (!isStillCurrent(attemptId, envelopeAtStart)) return;
  const attempt = outcome?.kind === 'ok' ? outcome.payment_attempt : null;
  if (attempt === null && !isSessionRefusal(outcome)) {
    // The outcome is unknown: offer the read retry (M-P15), never the commit.
    // The retry, here or after a remount, comes back here with this reason
    // (Codex P2 on #626). Set again: a reconcile of the same attempt that
    // answered meanwhile may have cleared it.
    usePaymentStore.getState().setConfirmReadPending({ attemptId, reason });
    ctx.setAfterApply('failed');
    return;
  }
  usePaymentStore.getState().setConfirmReadPending(null);
  if (blockOnSessionRefusal(ctx, outcome) || attempt === null) return;
  ctx.setAfterApply('idle');
  ctx.setReadAfter('tender');
  if (attempt.state === 'started') {
    usePaymentStore.getState().applyAttemptSnapshot(attempt);
    ctx.setBridgeRefusalCopy(confirmRefusalCopy(reason, moneyStillDue(attempt)));
    return;
  }
  followEndedWithReason(ctx, attempt);
}

/** Retry the post-apply / post-start read that failed, through the same copy decision as before. */
export function retryFailedRead(ctx: SurfaceContext): void {
  const { paymentAttemptId } = ctx;
  if (ctx.readAfter === 'start') {
    void readAfterStart(ctx, paymentAttemptId);
  } else if (ctx.readAfter === 'confirm' && paymentAttemptId !== null) {
    const pending = usePaymentStore.getState().confirmReadPending;
    const reason = pending?.attemptId === paymentAttemptId ? pending.reason : null;
    void reconcileAfterConfirm(ctx, paymentAttemptId, reason);
  } else {
    void handleLineApplied(ctx);
  }
}
