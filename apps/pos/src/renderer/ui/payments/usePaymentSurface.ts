import { useEffect } from 'react';

import { usePaymentStore } from '../../stores/payment-store.js';
import {
  CANCEL_HOLD_COPY,
  deriveBackControl,
  holdFor,
  isEscapePress,
  isOpenCheckout,
  isResumable,
  resumePhase,
  type BackControl,
} from './payment-surface-logic.js';
import {
  usePaymentSurfaceState,
  type PaymentSurfaceProps,
  type SurfaceContext,
} from './payment-surface-state.js';
import { followStoreOutcome } from './surface-follow.js';
import { rereadOnResume } from './surface-settle.js';
import { handleBackToSale } from './surface-start.js';
import { useSettledSaleNumber, type SettledSaleNumber } from './useSettledSaleNumber.js';

/**
 * RT-1226 — PaymentSurface's controller: the state hook, every effect (in the
 * order the unsplit body ran them) and the Back control. The stages render
 * from what it returns.
 */

export interface PaymentSurfaceController {
  readonly ctx: SurfaceContext;
  readonly back: BackControl;
  /** RT-298: a cancel is in flight or its outcome is held. */
  readonly cancelOpen: boolean;
  /** RT-256 — M-P13: a card charge may stand on the terminal for this handoff. */
  readonly cardVoidRequired: boolean;
  /** RT-1322 — the settled screen's own sale number (no call before the settle). */
  readonly settledSaleNumber: SettledSaleNumber;
}

/**
 * Runs `onEscape` for an Esc press while `enabled`, consuming the event
 * (preventDefault) so no other Esc handler acts on it. Re-subscribed every
 * render so the handler always sees current state. Used for the RT-24 layer
 * order: an open entry panel closes first; only then is Esc = Back.
 */
function useEscapeKey(enabled: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isEscapePress(event)) return;
      event.preventDefault();
      onEscape();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  });
}

/**
 * Reset surface state when the envelope or session context changes; otherwise
 * a stale "tender selected" status banner could carry across a new payment
 * attempt.
 */
function resetForHandoff(ctx: SurfaceContext): void {
  const { envelopeHandoffId, sessionState } = ctx;
  ctx.setSelectedTender(null);
  ctx.setBridgeRefusalCopy(null);
  ctx.setIsConfirming(false);
  ctx.setIsCancelling(false);
  ctx.setIsStarting(false);
  ctx.setReversalPending(false);
  ctx.setIsReturning(false);
  ctx.setTenderTouched(false);
  ctx.setTenderReversed(false);
  ctx.setAfterApply('idle');
  ctx.setReadAfter('tender');
  // Resume a same-handoff attempt across a remount (leaving checkout and
  // coming back): a `started` one is still held by main, so forgetting it
  // would re-enable sign-out and make the next tender re-run payments.start,
  // which main refuses; a `settled` one must come back as the settled
  // screen, never as tender selection. A cancel hold comes back too (RT-298):
  // an unconfirmed cancel reopens on its Cancel with its line, and a
  // force-failed attempt with live tender stays held. Anything else (another
  // handoff, no session, or a terminal attempt with nothing to resume) is
  // cleared.
  const store = usePaymentStore.getState();
  const kept = store.paymentSlice?.state;
  const hold = holdFor(
    store.cancelRecovery,
    envelopeHandoffId,
    store.paymentSlice?.payment_attempt_id ?? null,
  );
  const resumable =
    sessionState.kind === 'signedIn' &&
    store.attemptHandoffId === envelopeHandoffId &&
    isResumable(kept, hold);
  if (!resumable) store.clearAttempt();
  ctx.setPhase(resumable ? resumePhase(kept, hold) : 'tender_selection');
  ctx.setBridgeRefusalCopy(resumable ? CANCEL_HOLD_COPY[hold] : null);
  // RT-243 F1 — the stored projection may be stale: a post-apply read that
  // failed before the remount left no trace here (`afterApply` is component
  // state). Read main again before any apply or settle is offered; a failed
  // read keeps them out of reach and offers the retry, as after an apply. A
  // cancel hold owns its own read-back (RT-298), so it is left to that.
  if (resumable && kept === 'started' && hold === 'none') void rereadOnResume(ctx);
}

// RT-298 — a cancel sent before a Checkout remount answers in the old
// surface, which can only update the store. Follow that outcome here so the
// mounted surface never keeps a stale instruction or a dead Cancel (Codex P2,
// #576). This surface's own cancels update the screen themselves, unless the
// store moves their attempt on, or ends it, while they are still in flight
// (RT-305; Codex P1 on #581): a retry sent after a remount may be slow or
// lose its answer, so the screen follows the store now and releases Cancel.
function syncCancelHold(ctx: SurfaceContext): void {
  const { cancelHold, lastHoldRef, ownCancelRef } = ctx;
  const previous = lastHoldRef.current;
  lastHoldRef.current = cancelHold;
  const own = ownCancelRef.current;
  if (own !== null) {
    const slice = usePaymentStore.getState().paymentSlice;
    const stillOpen = slice?.payment_attempt_id === own.attemptId && slice.state === 'started';
    if (own.status !== 'waiting' || stillOpen) return;
    own.status = 'followed';
    ownCancelRef.current = null;
    ctx.setIsCancelling(false);
    followStoreOutcome(ctx, own.attemptId);
    return;
  }
  if (previous === cancelHold) return;
  followStoreOutcome(ctx);
}

export function usePaymentSurface(props: PaymentSurfaceProps): PaymentSurfaceController {
  const ctx = usePaymentSurfaceState(props);
  const { phase, cancelHold, setArriving, setConfirmCardCancel } = ctx;
  useEffect(() => {
    setArriving(false);
  }, [setArriving]);

  // RT-238: the entry opens below the method tiles, inside the scrolling panes;
  // bring it into view so the cashier never has to hunt for the amount field.
  useEffect(() => {
    if (phase !== 'entry') return;
    const entry = document.querySelector('.v5-checkout__entry');
    // jsdom has no layout and no scrollIntoView; the real window always does.
    if (entry !== null && 'scrollIntoView' in entry) entry.scrollIntoView({ block: 'nearest' });
  }, [phase]);

  // RT-1322 — the settled screen's own sale number. `paymentAttemptId` comes
  // from `paymentSlice`, which a settle leaves in place (a settled attempt is
  // resumed as the settled screen) until a new sale resets it, so both ids of
  // the key stay available until Completion unmounts (doc 20 §5.3). With the
  // flag off, or before the settle, the hook makes no call.
  const salesBridge = ctx.bridge?.sales;
  const settledSaleNumber = useSettledSaleNumber({
    enabled: phase === 'settled' && ctx.saleFinalizationFlag,
    // A bridge built before RT-1322 (a test double) may lack the method: no call.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    read: salesBridge?.readForHandoff?.bind(salesBridge) ?? null,
    handoffActionId: ctx.envelopeHandoffId,
    paymentAttemptId: ctx.paymentAttemptId,
  });

  useEffect(() => {
    resetForHandoff(ctx);
    // rereadOnResume reads the store and this render's attempt; the reset
    // must only run when the session or the handoff changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.sessionState.kind, ctx.envelopeHandoffId]);

  useEffect(() => {
    syncCancelHold(ctx);
    // Only a hold change triggers this (moving the attempt on, or ending it,
    // always changes the hold of a cancel in flight); followStoreOutcome reads
    // the store itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelHold]);

  // History: external review P1 (round 3) removed the earlier recent-sale poll,
  // which matched on `finalized_at >= settled_at` and so could adopt a prior
  // sale as this one's number. RT-1322 replaces it with
  // `useSettledSaleNumber` (above), which reads the exact UNIQUE handoff key
  // confirmed against this attempt, so it cannot return another sale.

  // RT-256 — M-P13 for this handoff: sticky for the rest of the Checkout,
  // including Completion after another tender settles (Codex P1, #572).
  const cardVoidRequired =
    ctx.cardSafety !== null &&
    ctx.cardSafety.voidRequired &&
    ctx.cardSafety.handoffId === ctx.envelopeHandoffId;

  // RT-26 — Back is offered before any tender (see deriveBackControl).
  const back = deriveBackControl({
    wired: props.onBackToSale !== undefined,
    onOpenCheckout: isOpenCheckout(ctx.sessionState.kind, ctx.envelope !== null, phase),
    eligibility: props.backToSaleEligibility ?? 'unknown',
    projectedTenderLines: ctx.paymentSlice?.tender_lines.length,
    tenderTouched: ctx.tenderTouched,
    cardVoidRequired,
    tenderReversed: ctx.tenderReversed,
    busy: [
      ctx.isStarting,
      ctx.isConfirming,
      ctx.isCancelling,
      cancelHold !== 'none',
      ctx.isReturning,
    ].some(Boolean),
    entryOpen: phase === 'entry',
  });

  // Esc closes an open entry panel (only the panel: the attempt and any
  // recorded tender are untouched, and Back stays a separate, second action).
  // RT-298: nothing new is recorded or settled while a cancel is in flight or
  // its outcome is unconfirmed; main is read first. Esc must not close the
  // panel either: Cancel lives there and is the named way out (Codex P2, #576).
  const cancelOpen = ctx.isCancelling || cancelHold !== 'none';
  // M-P7: the confirm belongs to the Cancel press that opened it. If the dialog's
  // guard fails while it is up (the phase moves on, or a hold from another
  // surface's cancel appears), drop the request, so it never reopens by itself
  // when the guard holds again (CodeRabbit on #615).
  useEffect(() => {
    if (phase !== 'entry' || cancelOpen) setConfirmCardCancel(false);
  }, [phase, cancelOpen, setConfirmCardCancel]);
  useEscapeKey(phase === 'entry' && !cancelOpen, () => {
    ctx.setSelectedTender(null);
    ctx.setPhase('tender_selection');
  });
  useEscapeKey(back.enabled, () => {
    void handleBackToSale(ctx, back);
  });

  return { ctx, back, cancelOpen, cardVoidRequired, settledSaleNumber };
}
