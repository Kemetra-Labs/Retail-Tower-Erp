import { usePaymentStore } from '../../stores/payment-store.js';
import type { PaymentsReadResponse } from '../../../shared/bridge-api.js';
import type { PaymentAttemptRendererView, PaymentRefusal } from '../../../shared/payments/types.js';
import { confirmNeedsReadBack, confirmRefusalCopy } from './payment-read-copy.js';
import type { SurfaceContext } from './payment-surface-state.js';

/**
 * RT-1226 — PaymentSurface's reads of main, moved out of the surface body
 * unchanged. Each takes the render's `SurfaceContext` its closure used to see.
 */

/** A read is idempotent: a transient IPC failure is retried before giving up. */
const READ_ATTEMPTS = 3;

/**
 * Codex P2 on #626 — main's session gate refused (no session, role, owner or
 * tenant). Every retry from this session is refused the same way, so offer
 * nothing and say who can act (M-P28 / M-P26) instead of a dead retry.
 */
export function isSessionRefusal(outcome: PaymentsReadResponse | PaymentRefusal | null): boolean {
  return outcome?.kind === 'refused' && !confirmNeedsReadBack(outcome.reason);
}

export function blockOnSessionRefusal(
  ctx: SurfaceContext,
  outcome: PaymentsReadResponse | PaymentRefusal | null,
): boolean {
  if (outcome?.kind !== 'refused' || !isSessionRefusal(outcome)) return false;
  ctx.setAfterApply('blocked');
  ctx.setReadAfter('tender');
  ctx.setBridgeRefusalCopy(confirmRefusalCopy(outcome.reason, false));
  return true;
}

export async function readAttemptWithRetry(
  ctx: SurfaceContext,
  attemptId: string,
): Promise<PaymentAttemptRendererView | null> {
  const outcome = await readAttemptOutcome(ctx, attemptId);
  return outcome?.kind === 'ok' ? outcome.payment_attempt : null;
}

/**
 * The read with main's answer kept: the attempt, main's refusal (whose reason
 * can say a retry is pointless, Codex P2 on #626), or null when it could not
 * be reached at all.
 */
export async function readAttemptOutcome(
  ctx: SurfaceContext,
  attemptId: string,
): Promise<PaymentsReadResponse | null> {
  const { bridge } = ctx;
  if (bridge === null) return null;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    try {
      return await bridge.payments.read({ payment_attempt_id: attemptId });
    } catch {
      // Retry: the line itself was applied in main; only the read failed.
    }
  }
  return null;
}

/**
 * The payment context a read was started for is still the current one. A
 * cancel (or a new sale) can clear it while the read is in flight; main then
 * answers with the now-terminal attempt, which must not be written back.
 */
export function isStillCurrent(attemptId: string, envelopeAtStart: unknown): boolean {
  const store = usePaymentStore.getState();
  return store.envelope === envelopeAtStart && store.paymentSlice?.payment_attempt_id === attemptId;
}

/**
 * RT-298 — the attempt a cancel was sent for is still this sale's current
 * one. Keyed on ids, not the envelope object, so the answer of a cancel sent
 * before a Checkout remount still lands on the same attempt.
 */
export function isCancelStillCurrent(attemptId: string, handoffId: string): boolean {
  const store = usePaymentStore.getState();
  return (
    store.envelope?.handoff_action_id === handoffId &&
    store.paymentSlice?.payment_attempt_id === attemptId
  );
}
