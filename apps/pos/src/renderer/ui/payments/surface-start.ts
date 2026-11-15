import { usePaymentStore } from '../../stores/payment-store.js';
import type { TenderKind } from '../../v5/checkout/TenderPicker.js';
import type { TenderApplyRequest, TenderBridgeAPI } from '../../../shared/bridge-api.js';
import { BACK_REFUSED_COPY, type BackControl } from './payment-surface-logic.js';
import type { SurfaceContext } from './payment-surface-state.js';
import { handleConfirm, readAfterStart } from './surface-settle.js';

/**
 * RT-1226 — starting a payment, applying tender and Back to the sale, moved
 * out of the PaymentSurface body unchanged. Each takes the render's context.
 */

const START_REFUSED_COPY = 'تعذّر بدء عملية الدفع. يرجى المحاولة مرة أخرى.';

export async function handleBackToSale(ctx: SurfaceContext, back: BackControl): Promise<void> {
  const { onBackToSale } = ctx.props;
  if (!back.enabled || onBackToSale === undefined) return;
  ctx.setBridgeRefusalCopy(null);
  ctx.setIsReturning(true);
  const returned = await onBackToSale().catch(() => false);
  // On success the route leaves this surface; only a refusal stays here.
  if (!returned) {
    ctx.setIsReturning(false);
    ctx.setBridgeRefusalCopy(BACK_REFUSED_COPY);
  }
}

export async function handleTenderSelect(ctx: SurfaceContext, tender: TenderKind): Promise<void> {
  // Defence in depth behind the disabled tile: never start or select a
  // voucher payment while the pilot restriction is active.
  if (tender === 'internal_voucher' && !ctx.voucherTenderFlag) return;
  if (tender === 'external_card_terminal' && !ctx.cardTenderFlag) return;
  // RT-298: no tender while a cancel hold stands (outcome unknown, or main
  // refuses every payment for this cart until a manager acts). Its line stays.
  if (ctx.cancelHold !== 'none') return;
  ctx.setSelectedTender(tender);
  ctx.setBridgeRefusalCopy(null);

  if (ctx.bridge === null || ctx.envelope === null) {
    // Slice-1 behaviour: status banner only.
    return;
  }

  // Split-tender path: an attempt is already started (paymentSlice holds the
  // attempt id from a prior payments.start). Calling payments.start again
  // would be refused with `attempt_already_started_on_terminal`. Skip
  // straight to mounting the new entry component for the remaining balance.
  if (ctx.paymentAttemptId !== null) {
    ctx.setPhase('entry');
    return;
  }

  // CR-9 guard: rapid-double clicks before the first start/read cycle
  // completes would otherwise fire payments.start multiple times in
  // parallel. paymentAttemptId only updates after the read response lands.
  if (ctx.isStarting) {
    return;
  }

  const startedAttemptId = await startAttempt(ctx);
  if (startedAttemptId === null) return;
  ctx.setPhase('entry');
  // The start succeeded, so a failure from here on is a read failure, never
  // «could not start» (RT-341).
  await readAfterStart(ctx, startedAttemptId);
}

/**
 * `payments.start` for this envelope, on the amount due (RT-854: the net).
 * Resolves to the started attempt's id, or null after showing the refusal.
 */
async function startAttempt(ctx: SurfaceContext): Promise<string | null> {
  const { bridge, envelope, dueMinor } = ctx;
  if (bridge === null || envelope === null) return null;
  ctx.setIsStarting(true);
  try {
    const startResponse = await bridge.payments.start({
      envelope_handoff_action_id: envelope.handoff_action_id,
      envelope_cart_id: envelope.cart_id,
      envelope_subtotal_minor: dueMinor,
      envelope_version: 'v1',
      idempotency_key: crypto.randomUUID(),
    });

    if (startResponse.kind === 'refused') {
      ctx.setBridgeRefusalCopy(START_REFUSED_COPY);
      return null;
    }

    // Main now holds a started attempt: record it at once, so an open
    // payment is known (and V5 sign-out blocked) even if the read below is
    // slow or fails. The read then replaces this with main's snapshot.
    usePaymentStore.getState().applyAttemptSnapshot({
      payment_attempt_id: startResponse.payment_attempt_id,
      state: 'started',
      envelope_subtotal_minor: dueMinor,
      started_at: new Date().toISOString(),
      tender_lines: [],
    });
    return startResponse.payment_attempt_id;
  } catch {
    // Bridge rejection (network / IPC layer error). Treat as a generic
    // refusal — no structured reason crosses into the DOM (FR-005 / FR-017).
    ctx.setBridgeRefusalCopy(START_REFUSED_COPY);
    return null;
  } finally {
    ctx.setIsStarting(false);
  }
}

/**
 * RT-855 (OZ-1 = Z-A, D1 ZeroCheckout) — «إتمام البيع» at 0 due: start the
 * attempt on 0 (unless one is already open) and confirm it with no tender
 * line; main settles on Σ = 0. A refused or lost confirm reads main back as
 * any other settle does (RT-340).
 */
export async function handleCompleteZero(ctx: SurfaceContext): Promise<void> {
  if (ctx.bridge === null || ctx.isStarting || ctx.isConfirming || ctx.cancelHold !== 'none') {
    return;
  }
  ctx.setBridgeRefusalCopy(null);
  const attemptId = ctx.paymentAttemptId ?? (await startAttempt(ctx));
  if (attemptId === null) return;
  await handleConfirm(ctx, attemptId);
}

/**
 * Every tender apply goes through here: the attempt it was sent on is kept in
 * the store before the call, so a remount knows money may be recorded even if
 * the answer or the follow-up read is lost (RT-356).
 */
export function sendTenderApply(
  ctx: SurfaceContext,
  req: TenderApplyRequest,
): ReturnType<TenderBridgeAPI['apply']> {
  const { bridge } = ctx;
  if (bridge === null) return Promise.reject(new Error('no payment bridge'));
  usePaymentStore.getState().recordTenderApplySent(req.payment_attempt_id);
  return bridge.tender.apply(req);
}
