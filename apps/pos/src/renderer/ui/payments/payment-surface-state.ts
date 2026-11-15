import { useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';

import { useOperatorSessionStore } from '../../stores/operator-session-store.js';
import { usePaymentStore, type CancelHold } from '../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store.js';
import type { TenderKind } from '../../v5/checkout/TenderPicker.js';
import { envelopeAmountDue } from '../../../shared/cart/handoff-envelope.js';
import { holdFor, resolveBridge, type OwnCancel, type Phase } from './payment-surface-logic.js';
import type { BackToSaleEligibility } from '../../sale/useCheckoutBackToSale.js';
import type {
  PaymentsBridgeAPI,
  SalesBridgeAPI,
  TenderBridgeAPI,
} from '../../../shared/bridge-api.js';

/**
 * RT-1226 — the one place PaymentSurface's state lives. Every stage component
 * receives what it shows as props; the payment flows (`surface-*.ts`) receive
 * this render's context, exactly the values their closures captured when they
 * were nested functions of the 1720-line body. No new global state.
 */

export interface PaymentSurfaceProps {
  /**
   * Test seam: injects payments + tender (+ optional sales) bridge in place of
   * `window.api`. The same injected-bridge pattern the Sale controllers use
   * (renderer/sale). When omitted in production, the surface reads from
   * `window.api.payments` + `window.api.tender` (+ `window.api.sales`) — the
   * typed preload bridge.
   */
  _testBridge?: {
    payments: PaymentsBridgeAPI;
    tender: TenderBridgeAPI;
    sales?: SalesBridgeAPI;
  };
  /**
   * Invoked when the cashier clicks "New sale" on the settled/completed
   * surface. The route owner (CheckoutRoute) wires this to reset the payment +
   * cart stores and navigate back to /app/cart — keeping PaymentSurface
   * Router-agnostic (mirrors the Sale screen's onContinue seam, so the
   * bare-render unit tests need no Router ancestor). Optional + guarded: when
   * omitted (tests / Slice-1), the button still renders and is a safe no-op.
   */
  onNewSale?: () => void;
  /**
   * RT-26 — Checkout Back / Esc to the same sale. Resolves `true` once main
   * returned the cart to the Sale (the route then leaves this surface), `false`
   * when main refused or the call failed (the cashier stays here). Optional:
   * without it no Back control renders and Esc does nothing (Slice-1 / bare
   * renders). The surface only DISABLES Back while it can see tender activity
   * or an operation in flight — main is the authority either way.
   */
  onBackToSale?: () => Promise<boolean>;
  /**
   * RT-26 — main's durable eligibility for this handoff
   * (`cart.returnToSaleEligibility`). Back is enabled only on `returnable`;
   * `unknown` (the default: not asked yet, or no answer) keeps it disabled, and
   * `blocked` shows the reason. Survives remounts, unlike component state.
   */
  backToSaleEligibility?: BackToSaleEligibility;
  /**
   * RT-998 — a cashier's way to open the shift when main refused a cash tender
   * with no open shift. The route owner navigates (this surface is
   * Router-agnostic); without it the refusal shows with no way on.
   */
  onOpenShift?: () => void;
}

type Setter<T> = Dispatch<SetStateAction<T>>;

/** What a post-apply / post-start / post-confirm read is doing (RT-238 / Codex P1). */
export type AfterApply = 'idle' | 'reading' | 'failed' | 'blocked';
/** What the pending or failed read follows (RT-341 / RT-340). */
export type ReadAfter = 'start' | 'tender' | 'confirm';

export interface SurfaceContext {
  readonly bridge: ReturnType<typeof resolveBridge>;
  readonly sessionState: ReturnType<typeof useOperatorSessionStore.getState>['state'];
  readonly envelope: ReturnType<typeof usePaymentStore.getState>['envelope'];
  readonly paymentSlice: ReturnType<typeof usePaymentStore.getState>['paymentSlice'];
  readonly paymentAttemptId: string | null;
  readonly envelopeHandoffId: string | null;
  readonly cancelHold: CancelHold;
  readonly cardSafety: ReturnType<typeof usePaymentStore.getState>['cardSafety'];
  readonly saleFinalizationFlag: boolean;
  readonly voucherTenderFlag: boolean;
  readonly cardTenderFlag: boolean;
  /** RT-854 / RT-855 — what the payment must cover (0 with no envelope: nothing renders then). */
  readonly dueMinor: number;
  readonly props: PaymentSurfaceProps;

  readonly selectedTender: TenderKind | null;
  readonly setSelectedTender: Setter<TenderKind | null>;
  readonly cashDraftMinor: number | null;
  readonly setCashDraftMinor: Setter<number | null>;
  readonly phase: Phase;
  readonly setPhase: Setter<Phase>;
  readonly arriving: boolean;
  readonly setArriving: Setter<boolean>;
  readonly primarySlot: HTMLElement | null;
  readonly setPrimarySlot: Setter<HTMLElement | null>;
  readonly afterApply: AfterApply;
  readonly setAfterApply: Setter<AfterApply>;
  readonly readAfter: ReadAfter;
  readonly setReadAfter: Setter<ReadAfter>;
  readonly bridgeRefusalCopy: string | null;
  readonly setBridgeRefusalCopy: Setter<string | null>;
  readonly isConfirming: boolean;
  readonly setIsConfirming: Setter<boolean>;
  readonly isCancelling: boolean;
  readonly setIsCancelling: Setter<boolean>;
  readonly isStarting: boolean;
  readonly setIsStarting: Setter<boolean>;
  readonly reversalPending: boolean;
  readonly setReversalPending: Setter<boolean>;
  readonly confirmCardCancel: boolean;
  readonly setConfirmCardCancel: Setter<boolean>;
  readonly isReturning: boolean;
  readonly setIsReturning: Setter<boolean>;
  readonly tenderTouched: boolean;
  readonly setTenderTouched: Setter<boolean>;
  readonly tenderReversed: boolean;
  readonly setTenderReversed: Setter<boolean>;

  readonly commitFocusedAtRef: RefObject<number>;
  readonly tileFocusedAtRef: RefObject<number>;
  readonly ownCancelRef: RefObject<OwnCancel | null>;
  readonly lastHoldRef: RefObject<CancelHold>;
}

export function usePaymentSurfaceState(props: PaymentSurfaceProps): SurfaceContext {
  const sessionState = useOperatorSessionStore((s) => s.state);
  const envelope = usePaymentStore((s) => s.envelope);
  const paymentSlice = usePaymentStore((s) => s.paymentSlice);

  const [selectedTender, setSelectedTender] = useState<TenderKind | null>(null);
  // RT-243 W1-C — the cash typed but not yet applied, for the ledger's preview.
  const [cashDraftMinor, setCashDraftMinor] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('tender_selection');
  // RT-761: true for the first commit only, so arrival focus is not re-applied when
  // the cashier later returns to the method tiles (Esc from an entry keeps its own rules).
  // It is judged on that first commit alone: a stale attempt that the mount effect
  // clears afterwards leaves focus on <body>, as before (no normal flow does this).
  const [arriving, setArriving] = useState(true);
  // RT-238: the pinned primary slot the entry components render their apply-commit into.
  const [primarySlot, setPrimarySlot] = useState<HTMLElement | null>(null);
  // RT-238 / I-9: when focus is moved onto the settle commit, a held or doubled
  // Enter from the apply that preceded it must not settle on its own.
  const commitFocusedAtRef = useRef(0);
  // RT-761/RT-763: when focus last landed on the first method tile, on arrival or after a
  // partial apply (see `guardTileKey`).
  const tileFocusedAtRef = useRef(0);
  // RT-298 — the cancel this surface sent and has not finished (its own outcome
  // code updates the screen; see the hold-sync effect).
  const ownCancelRef = useRef<OwnCancel | null>(null);
  const lastHoldRef = useRef<CancelHold>('none');
  // RT-238 / Codex P1: after a successful apply the projection must be re-read
  // before anything else is offered. Until it is, the apply is not offered again
  // (a second press would record the whole amount a second time, as change).
  // `blocked`: main's session gate refused the read, so no retry from this
  // session can succeed; nothing is offered and the refusal line says why.
  const [afterApply, setAfterApply] = useState<AfterApply>('idle');
  // RT-341 — what the pending or failed read follows: a fresh start has no money
  // on it yet, so its retry line must not say an amount was recorded (M-P15).
  // RT-340: a failed read-back after a refused settle retries through the same
  // copy decision; the confirm's reason is kept in the store
  // (`confirmReadPending`), so a remount keeps it too.
  const [readAfter, setReadAfter] = useState<ReadAfter>('tender');
  const [bridgeRefusalCopy, setBridgeRefusalCopy] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState<boolean>(false);
  const [isCancelling, setIsCancelling] = useState<boolean>(false);
  // RT-298 — the cancel key and any hold live in the payment store, so a
  // Checkout remount keeps both (Codex P2, #576). See `cancelHold` below.
  const cancelRecovery = usePaymentStore((s) => s.cancelRecovery);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [reversalPending, setReversalPending] = useState<boolean>(false);
  // RT-243 W1-C (M-P7, RT-116 §3) — the cancel confirm shown when a card charge
  // may stand on the terminal.
  const [confirmCardCancel, setConfirmCardCancel] = useState<boolean>(false);
  // RT-26 — a Back is in flight, and whether this handoff ever had tender
  // (a payments.cancel that reversed lines clears the projection, but main
  // still refuses Back for that cart, so the control stays disabled).
  const [isReturning, setIsReturning] = useState<boolean>(false);
  const [tenderTouched, setTenderTouched] = useState<boolean>(false);
  const [tenderReversed, setTenderReversed] = useState<boolean>(false);
  // RT-256 — card facts for this handoff live in the payment store, so they
  // survive a Checkout remount and the attempt clear on cancel (Codex P1, #572).
  const cardSafety = usePaymentStore((s) => s.cardSafety);
  // 022 US4a (T011) — the sale id is NOT retained, and neither is `settled_at`:
  // the `recent` row cannot be tied to THIS payment, so an id or a time taken
  // from it could belong to a prior sale. Both return together with a
  // correlating identifier, not before (see SettledStage).
  // 008's finalize listener is gated on this flag. With it off no receipt is
  // ever written, so the completion surface must say so rather than imply a
  // document is on its way.
  const saleFinalizationFlag = useFeatureFlagsStore((s) => s.saleFinalization);
  // RT-103: vouchers are excluded from the pilot (RT-10 D2). Off (the default)
  // disables the voucher tile and refuses a voucher selection here as well.
  const voucherTenderFlag = useFeatureFlagsStore((s) => s.voucherTender);
  // RT-700: card is out of the pilot (RT-536 D4). Off (the default) hides the
  // card tile and refuses a card selection here; main refuses the apply too.
  const cardTenderFlag = useFeatureFlagsStore((s) => s.cardTender);

  // paymentAttemptId is the source-of-truth from the paymentSlice projection
  // (set by payments.start → payments.read flow, or seeded by tests via
  // applyAttemptSnapshot). Keeping a single source avoids drift.
  const paymentAttemptId = paymentSlice?.payment_attempt_id ?? null;
  const envelopeHandoffId = envelope?.handoff_action_id ?? null;
  // RT-298 — payment actions held closed after a cancel:
  //   unconfirmed  — main could not confirm the outcome (response and read both
  //                  lost); Cancel again resolves it, replaying the same key.
  //   live_tender  — the attempt was force-failed with live tender; main refuses
  //                  any new payment for this cart, so only a manager can move on.
  const cancelHold = holdFor(cancelRecovery, envelopeHandoffId, paymentAttemptId);
  // RT-854 / RT-855 — what the payment must cover: the envelope's net
  // `total_due_minor` (Σ gross on an envelope frozen before RT-854). An
  // unreadable value falls back to the gross, which main then refuses.
  const dueMinor = envelope === null ? 0 : (envelopeAmountDue(envelope) ?? envelope.subtotal_minor);

  return {
    bridge: resolveBridge(props._testBridge),
    sessionState,
    envelope,
    paymentSlice,
    paymentAttemptId,
    envelopeHandoffId,
    cancelHold,
    cardSafety,
    saleFinalizationFlag,
    voucherTenderFlag,
    cardTenderFlag,
    dueMinor,
    props,
    selectedTender,
    setSelectedTender,
    cashDraftMinor,
    setCashDraftMinor,
    phase,
    setPhase,
    arriving,
    setArriving,
    primarySlot,
    setPrimarySlot,
    afterApply,
    setAfterApply,
    readAfter,
    setReadAfter,
    bridgeRefusalCopy,
    setBridgeRefusalCopy,
    isConfirming,
    setIsConfirming,
    isCancelling,
    setIsCancelling,
    isStarting,
    setIsStarting,
    reversalPending,
    setReversalPending,
    confirmCardCancel,
    setConfirmCardCancel,
    isReturning,
    setIsReturning,
    tenderTouched,
    setTenderTouched,
    tenderReversed,
    setTenderReversed,
    commitFocusedAtRef,
    tileFocusedAtRef,
    ownCancelRef,
    lastHoldRef,
  };
}
