import type { JSX } from 'react';

import { useOperatorSessionStore } from '../../stores/operator-session-store.js';
import { usePaymentStore } from '../../stores/payment-store.js';
import { OperatorBadge } from '../operator/OperatorBadge.js';
import { OrderSummary } from '../../v5/checkout/OrderSummary.js';
import { PaymentLedger } from '../../v5/checkout/PaymentLedger.js';
import { RecoveryPanel } from '../../v5/checkout/RecoveryPanel.js';
import '../../v5/checkout/checkout.css';
import { PrimarySlotContext } from './CheckoutActionBar.js';
import { FitGuard } from '../../v5/foundation/FitGuard.js';
import {
  CANCEL_UNKNOWN_COPY,
  LEDGER_TEST_IDS,
  RECOVERY_TEST_IDS,
  TENDER_SELECTED_COPY,
} from './payment-surface-logic.js';
import { BackBlockedReason, BackToSaleButton, CardCancelConfirm } from './checkout-parts.js';
import { guardCommitKey, guardTileKey } from './checkout-key-guards.js';
import { CheckoutFocusRules } from './CheckoutFocusRules.js';
import { PaymentActionBar } from './PaymentActionBar.js';
import { SettledStage } from './SettledStage.js';
import { TenderEntryStage } from './TenderEntryStage.js';
import { handleCancel, requestCancel } from './surface-cancel.js';
import {
  handleConfirm,
  handleLineApplied,
  rereadAttempt,
  retryFailedRead,
} from './surface-settle.js';
import {
  handleBackToSale,
  handleCompleteZero,
  handleTenderSelect,
  sendTenderApply,
} from './surface-start.js';
import { deriveSurfaceView, type SurfaceView } from './surface-view.js';
import type { PaymentSurfaceProps, SurfaceContext } from './payment-surface-state.js';
import { usePaymentSurface } from './usePaymentSurface.js';

/**
 * 006-payments-tender S1 + S3d T152 — PaymentSurface.
 *
 * Route guard: returns null unless both a signed-in operator session and a
 * non-null payment envelope exist. This prevents the surface from mounting
 * in an inconsistent state.
 *
 * Modes:
 *   • Slice-1 (no bridge): renders TenderSelection + PaymentCartSummary +
 *     a "tender selected" status banner. No bridge calls. Backwards
 *     compatible with existing tests + Slice-1/Slice-2 callers.
 *   • S3d (bridge wired): when `_testBridge` (tests) or `window.api`
 *     (production) provides `payments` + `tender`, picking a tender
 *     triggers `payments.start`, mounts the entry component with the T151
 *     bridge wiring, and surfaces a "Confirm payment" button when at
 *     least one tender line is applied. Confirm click → `payments.confirm`.
 *     On settled, transitions to a placeholder per FR-031.
 *
 * RT-1226 — the body is split by stage: `TenderEntryStage` (method tiles and
 * the entry), `PaymentActionBar` (commit, cancel and the RT-298 hold lines),
 * `SettledStage` (completion). State lives in `usePaymentSurfaceState`, the
 * effects in `usePaymentSurface`, the flows in `surface-*.ts`.
 *
 * SECURITY:
 *   - No sensitive IDs in DOM (FR-035).
 *   - No card data (PAN, CVV, cardholder name) of any kind.
 *   - No raw bridge reason strings displayed to cashier. Refusal copy is
 *     generic per FR-005 / FR-006B.
 *   - Manager identity never in cashier-visible UI.
 */

export type { PaymentSurfaceProps } from './payment-surface-state.js';

/**
 * RT-412 (RT-312 D2) — covered by the in-surface fit notice, never shown
 * clipped, when the amount due, the recorded change, the commit or the cancel
 * would not fit (stacked banners in the 600–767px band). The ledger marks them;
 * completion marks nothing, so only the payment in progress can be covered.
 */
export function PaymentSurface(props: PaymentSurfaceProps = {}): JSX.Element | null {
  const signedIn = useOperatorSessionStore((s) => s.state.kind === 'signedIn');
  const hasEnvelope = usePaymentStore((s) => s.envelope !== null);
  // The body's own gate, kept here too so "nothing to pay" still renders nothing at all.
  if (!signedIn || !hasEnvelope) return null;
  return (
    <FitGuard surface="checkout">
      <PaymentSurfaceBody {...props} />
    </FitGuard>
  );
}

function PaymentSurfaceBody(props: PaymentSurfaceProps = {}): JSX.Element | null {
  const { ctx, back, cancelOpen, cardVoidRequired, settledSaleNumber } = usePaymentSurface(props);
  const { sessionState, envelope, bridge, phase } = ctx;

  if (sessionState.kind !== 'signedIn' || envelope === null) {
    return null;
  }

  const { display_name, role } = sessionState.session;
  const view = deriveSurfaceView(ctx, cancelOpen, cardVoidRequired);

  if (phase === 'settled') {
    return (
      <SettledStage
        paidMinor={ctx.dueMinor}
        changeDueMinor={view.appliedChangeDueMinor}
        saleFinalization={ctx.saleFinalizationFlag}
        settledSaleNumber={settledSaleNumber}
        cardVoidRequired={cardVoidRequired}
        hasAppliedCash={view.hasAppliedCash}
        displayName={display_name}
        role={role}
        onNewSale={props.onNewSale}
      />
    );
  }

  // Refusals and hints stay next to the commit, in the pinned bar. With no bridge
  // (Slice-1 mode) there is no bar, so they render in the surface as before.
  // RT-243 W1-C: they are the V5 RecoveryPanel; the copy is unchanged.
  const notices = (
    <RecoveryPanel
      refusal={ctx.bridgeRefusalCopy}
      refusalIsUnknownOutcome={ctx.bridgeRefusalCopy === CANCEL_UNKNOWN_COPY}
      reversalPending={ctx.reversalPending}
      testIds={RECOVERY_TEST_IDS}
    />
  );

  const actionBar = bridge === null ? undefined : actionBarFor(ctx, view, cancelOpen, notices);

  return (
    <PrimarySlotContext.Provider
      value={{ node: ctx.primarySlot, entryOwnsPrimary: view.entryOwnsPrimary }}
    >
      <section className="v5-checkout" data-testid="payment-surface" aria-label="الدفع">
        <header className="v5-checkout__titlebar">
          <h1>الدفع</h1>
          {/* RT-26 — Back to the same sale (Esc). Disabled, with the reason
            below, once tender exists; main refuses it in that case too. */}
          <BackToSaleButton
            back={back}
            onBack={() => {
              void handleBackToSale(ctx, back);
            }}
          />
          <div className="v5-checkout__operator">
            <OperatorBadge display_name={display_name} role={role} />
          </div>
        </header>

        <BackBlockedReason back={back} />

        {ctx.confirmCardCancel && phase === 'entry' && !cancelOpen && (
          <CardCancelConfirm
            onDismiss={() => {
              ctx.setConfirmCardCancel(false);
            }}
            onConfirm={() => {
              ctx.setConfirmCardCancel(false);
              void handleCancel(ctx);
            }}
          />
        )}

        {/*
        RT-243 W1-C — Direction B (DESIGN.md; freeze 15 §4): order summary ·
        tender panel · money column, the money column in the Sale's place.

        DOM ORDER IS SUMMARY → TENDER → MONEY, the RTL visual order (FR-23): Tab
        runs tiles → entry → the ledger's commit (freeze 15 §3.3). The 1024
        reflow (summary strip on top) is a container query in checkout.css, NOT
        a `useViewportTier` branch: the hook debounces tier changes by 100ms
        while CSS applies instantly (#450/#451).
      */}
        <div className="v5-checkout__body" data-testid="payment-surface-body">
          <OrderSummary envelope={envelope} />

          <TenderEntryStage
            envelope={envelope}
            zeroDue={view.zeroDue}
            selectedTender={ctx.selectedTender}
            voucherEnabled={ctx.voucherTenderFlag}
            cardEnabled={ctx.cardTenderFlag}
            onTileKeyDown={(event) => {
              guardTileKey(event, ctx.tileFocusedAtRef);
            }}
            onTenderSelect={(tender) => {
              void handleTenderSelect(ctx, tender);
            }}
            entryOpen={view.entryOpen}
            remainingBalanceMinor={view.remainingBalanceMinor}
            paymentAttemptId={ctx.paymentAttemptId}
            sendTenderApply={(req) => sendTenderApply(ctx, req)}
            onDraftChange={ctx.setCashDraftMinor}
            onLineApplied={() => {
              void handleLineApplied(ctx);
            }}
            onOpenShift={props.onOpenShift}
          />

          {/* RT-243 F1 — recorded money stays in view whether or not an entry
              is open (Esc, or a remount after a resize below 1024). */}
          <PaymentLedger
            dueMinor={view.remainingBalanceMinor}
            lines={view.appliedLines}
            changeDueMinor={view.appliedChangeDueMinor}
            draft={view.ledgerDraft}
            testIds={LEDGER_TEST_IDS}
            actions={actionBar}
          />
        </div>

        {/* Slice-1 mode: status banner only (no bridge wiring). */}
        {bridge === null && ctx.selectedTender !== null && (
          <div data-testid="payment-surface-tender-selected" role="status" aria-live="polite">
            {TENDER_SELECTED_COPY[ctx.selectedTender]}
          </div>
        )}

        {bridge === null && notices}
        <CheckoutFocusRules
          arriving={ctx.arriving}
          onTenderSelection={phase === 'tender_selection'}
          hasAppliedLine={view.hasAppliedLine}
          fullyTendered={view.fullyTendered}
          zeroDue={view.zeroDue}
          noCancelHold={ctx.cancelHold === 'none'}
          commitFocusedAtRef={ctx.commitFocusedAtRef}
          tileFocusedAtRef={ctx.tileFocusedAtRef}
        />
      </section>
    </PrimarySlotContext.Provider>
  );
}

/** RT-238 — the pinned action bar, wired to this render's flows. */
function actionBarFor(
  ctx: SurfaceContext,
  view: SurfaceView,
  cancelOpen: boolean,
  notices: JSX.Element,
): JSX.Element {
  return (
    <PaymentActionBar
      endSlotRef={ctx.setPrimarySlot}
      entryPhase={ctx.phase === 'entry'}
      isCancelling={ctx.isCancelling}
      onCancel={() => {
        requestCancel(ctx);
      }}
      cancelOpen={cancelOpen}
      afterApply={ctx.afterApply}
      readAfter={ctx.readAfter}
      onRetryRead={() => {
        retryFailedRead(ctx);
      }}
      zeroDue={view.zeroDue}
      isStarting={ctx.isStarting}
      isConfirming={ctx.isConfirming}
      onCompleteZero={() => {
        void handleCompleteZero(ctx);
      }}
      awaitingTender={view.awaitingTender}
      showSettle={view.showSettle}
      fullyTendered={view.fullyTendered}
      onCommitKeyDown={(event) => {
        guardCommitKey(event, ctx.commitFocusedAtRef);
      }}
      onCommit={() => {
        if (view.fullyTendered) void handleConfirm(ctx);
        else void rereadAttempt(ctx);
      }}
      notices={notices}
    />
  );
}
