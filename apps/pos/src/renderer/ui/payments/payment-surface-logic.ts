/**
 * RT-1220 — the pure helpers behind PaymentSurface: Back / cancel / hold
 * derivation, the cashier copy they choose from, and the test-id maps the
 * existing suites assert. Moved verbatim from PaymentSurface.tsx (only the
 * `export` keywords are new) so they can be tested directly; the component
 * imports them and its behaviour is unchanged.
 */

import type { CancelHold, CancelRecovery } from '../../stores/payment-store.js';
import type { TenderKind } from '../../v5/checkout/TenderPicker.js';
import type { BackToSaleEligibility } from '../../sale/useCheckoutBackToSale.js';
import type {
  PaymentsBridgeAPI,
  PreloadBridgeAPI,
  SalesBridgeAPI,
  TenderBridgeAPI,
} from '../../../shared/bridge-api.js';
import type { PaymentAttemptRendererView } from '../../../shared/payments/types.js';

/** Shown when main refuses (or cannot be reached for) a Back. Generic, no reason. */
export const BACK_REFUSED_COPY = 'تعذّر الرجوع إلى البيع. أكمل الدفع أو ألغِه.';

/** What the Back control may do right now (RT-26). Pure; main still decides. */
export interface BackControl {
  /** The control is shown: wired, signed in, an envelope, not settled. */
  readonly offered: boolean;
  /** Tender was seen (projection, a reversing cancel, or main says blocked). */
  readonly tenderBlocked: boolean;
  /** Back / Esc may ask main now. */
  readonly enabled: boolean;
  /** Why Back is not available, as a catalog line (RT-240), or null when it is. */
  readonly reason: BackReason | null;
  /** Show the reason line under the header. */
  readonly showReason: boolean;
  /** `aria-disabled` for the control (mirrors `disabled`). */
  readonly ariaDisabled: 'true' | undefined;
}

interface BackControlInput {
  readonly wired: boolean;
  /** Signed in, an envelope mounted, and the surface is not settled. */
  readonly onOpenCheckout: boolean;
  readonly eligibility: BackToSaleEligibility;
  /** Tender lines in the current projection (any state); undefined = no attempt. */
  readonly projectedTenderLines: number | undefined;
  /** A payments.cancel in this mount reversed tender. */
  readonly tenderTouched: boolean;
  /**
   * That cancel PROVED the reversal (`cancelProvesReversal`): cash lines
   * came back reversed and none are still pending. Only this may say
   * «أُلغي المبلغ المسجَّل» (M-P2).
   */
  readonly tenderReversed: boolean;
  /**
   * RT-256 — a cancel in this Checkout reversed (or left pending) an
   * external-card line. Cancel cannot void the charge on the standalone
   * terminal (`manual_void_required`), so the cashier must void there before
   * any new charge (M-P13). Wins over every other reason, M-P1 included, for
   * the rest of this Checkout.
   */
  readonly cardVoidRequired: boolean;
  /** start / confirm / cancel / back in flight. */
  readonly busy: boolean;
  /**
   * A tender entry panel (cash / card / voucher) is open. Back is never offered
   * from inside it: Esc there closes only the panel, so a card already charged
   * on the standalone terminal cannot be walked away from in one keystroke.
   */
  readonly entryOpen: boolean;
}

/**
 * RT-240 — Back's reason, from the message catalog (15 §5), chosen by state so
 * it never claims more than is known (I-7):
 *   recorded   — money is on this attempt now (M-P1);
 *   reversed   — a cancel in this mount proved the reversal (M-P2, N-13);
 *   blocked    — Back is closed but nothing proves why: main's durable
 *                `blocked` (settled, force-failed, unresolved or refused
 *                tender, mismatched attempt) or a reversal still pending.
 *                Neutral wording: saying the amount was cancelled could
 *                invite a second charge;
 *   entry_open — an amount entry is open; Esc closes it first (M-P3);
 *   card_void  — a cancel in this mount reversed an external-card line locally;
 *                the charge may still stand on the terminal, so the line says
 *                to void it there before any new charge and never suggests
 *                completing or retrying the payment (RT-256, M-P13).
 */
type BackReason = 'recorded' | 'reversed' | 'blocked' | 'entry_open' | 'card_void';

export const BACK_REASON_COPY: Readonly<Record<BackReason, string>> = {
  recorded: 'لا يمكن الرجوع إلى البيع بعد تسجيل مبلغ. أكمل الدفع أو ألغِه.',
  reversed: 'أُلغي المبلغ المسجَّل. اختر طريقة دفع أخرى أو ألغِ البيع.',
  blocked: BACK_REFUSED_COPY,
  entry_open: 'اضغط Esc لإغلاق إدخال المبلغ أولاً.',
  card_void: 'أُلغي الدفع هنا فقط. ألغِ العملية على جهاز البطاقات قبل أي خصم جديد.',
};

/**
 * A cancel proves the money went back only when every reversed line is cash and
 * nothing is still pending. Cancel reverses lines locally only: a card cannot
 * be voided on the terminal (`manual_void_required`), and a voucher's authority
 * reservation is not released (only tender.reverse calls vouchers.reverse). So
 * cash is the one tender whose reversal the cancel response actually confirms.
 */
const CANCEL_CONFIRMED_TENDERS: ReadonlySet<string> = new Set(['cash']);

export function cancelProvesReversal(
  response: {
    readonly reversed_tender_line_ids: readonly string[];
    readonly reversal_pending_tender_line_ids: readonly string[];
  },
  lines: PaymentAttemptRendererView['tender_lines'],
): boolean {
  const reversed = response.reversed_tender_line_ids;
  if (reversed.length === 0 || response.reversal_pending_tender_line_ids.length > 0) return false;
  const typeById = new Map(lines.map((l) => [l.tender_line_id, l.tender_type]));
  return reversed.every((id) => CANCEL_CONFIRMED_TENDERS.has(typeById.get(id) ?? ''));
}

/**
 * RT-256 — the cancel touched an external-card line, which main cannot void on
 * the terminal. Card lines come from the projection AND from the card applies
 * seen in this Checkout: after a failed post-apply read the projection has no
 * card line yet, but the apply did happen in main (Codex P1 on #572).
 */
export function cancelTouchedCard(
  response: {
    readonly reversed_tender_line_ids: readonly string[];
    readonly reversal_pending_tender_line_ids: readonly string[];
  },
  lines: PaymentAttemptRendererView['tender_lines'],
  appliedCardLineIds: ReadonlySet<string>,
): boolean {
  const cardIds = new Set(appliedCardLineIds);
  for (const l of lines) {
    if (l.tender_type === 'external_card_terminal') cardIds.add(l.tender_line_id);
  }
  const touched = [
    ...response.reversed_tender_line_ids,
    ...response.reversal_pending_tender_line_ids,
  ];
  return touched.some((id) => cardIds.has(id));
}

/**
 * RT-256 — a successful cancel needs the terminal-void warning when it touched
 * a card line, OR when a card apply was ATTEMPTED in this Checkout at all. The
 * terminal is standalone: the customer is charged there before the POS records
 * anything, so a card apply whose outcome never reached the renderer (lost
 * response, or a rejection before main persisted a line, leaving the cancel
 * with zero lines) may still stand as a charge (Codex P1 rounds on #572).
 */
export function cancelNeedsTerminalVoid(
  response: Parameters<typeof cancelTouchedCard>[0],
  lines: PaymentAttemptRendererView['tender_lines'],
  card: { readonly appliedLineIds: ReadonlySet<string>; readonly attempted: boolean },
): boolean {
  return card.attempted || cancelTouchedCard(response, lines, card.appliedLineIds);
}

/** The reversal outcome of a cancel: main's response, or rebuilt from a read. */
export interface CancelOutcome {
  readonly reversed_tender_line_ids: readonly string[];
  readonly reversal_pending_tender_line_ids: readonly string[];
}

/**
 * RT-298 — a cancelled attempt read back from main carries the same outcome the
 * lost cancel response would have: the lines it reversed (or left pending), LIFO
 * like the cancel handler's own replay.
 */
export function cancelOutcomeFromRead(attempt: PaymentAttemptRendererView): CancelOutcome {
  const lifo = [...attempt.tender_lines].sort((a, b) => b.apply_order - a.apply_order);
  return {
    reversed_tender_line_ids: lifo
      .filter((l) => l.state === 'reversed')
      .map((l) => l.tender_line_id),
    reversal_pending_tender_line_ids: lifo
      .filter((l) => l.state === 'reversal_pending')
      .map((l) => l.tender_line_id),
  };
}

/**
 * RT-298 — cancel copy after an ambiguous outcome (UX-07: name the retry, and
 * never offer a retry that cannot succeed).
 *   failed     — main still holds the attempt open: Cancel again can work.
 *   unknown    — main could not be read: the cancel may have happened, so no new
 *                amount until Cancel again settles it (it replays the same key).
 *   not_open   — the attempt ended some other way: nothing left to cancel.
 *   live_tender — force-failed with live tender: no payment here, a manager
 *                reviews it.
 */
export const CANCEL_FAILED_COPY = 'تعذّر إلغاء عملية الدفع. اضغط «إلغاء» للمحاولة مرة أخرى.';
export const CANCEL_UNKNOWN_COPY =
  'تعذّر التأكد من إلغاء عملية الدفع. لا تسجّل أي مبلغ. اضغط «إلغاء» مرة أخرى للتحقق.';
export const CANCEL_NOT_OPEN_COPY = 'لم تعد عملية الدفع هذه مفتوحة، فلا يمكن إلغاؤها.';
export const CANCEL_LIVE_TENDER_COPY =
  'أوقف المدير عملية الدفع هذه وفيها مبالغ مسجّلة، فلا يمكن الدفع لهذا البيع الآن. اطلب من المدير مراجعتها.';

/** RT-298 — the line a cancel hold shows; it comes back with the hold on a remount. */
export const CANCEL_HOLD_COPY: Readonly<Record<CancelHold, string | null>> = {
  none: null,
  // Seen only after a remount: this view never learns how that cancel ended.
  in_flight: CANCEL_UNKNOWN_COPY,
  unconfirmed: CANCEL_UNKNOWN_COPY,
  live_tender: CANCEL_LIVE_TENDER_COPY,
};

/** A kept attempt a remounted Checkout resumes instead of clearing. */
export function isResumable(kept: string | undefined, hold: CancelHold): boolean {
  if (kept === 'started' || kept === 'settled') return true;
  return kept === 'force_failed' && hold === 'live_tender';
}

/** The phase a resumed attempt comes back in: an unconfirmed cancel reopens on its Cancel. */
export function resumePhase(kept: string | undefined, hold: CancelHold): Phase {
  if (kept === 'settled') return 'settled';
  return hold === 'unconfirmed' || hold === 'in_flight' ? 'entry' : 'tender_selection';
}

/** RT-298 — the hold recorded for this handoff's current attempt, if any. */
export function holdFor(
  recovery: CancelRecovery | null,
  handoffId: string | null,
  attemptId: string | null,
): CancelHold {
  if (recovery === null) return 'none';
  const current = recovery.handoffId === handoffId && recovery.attemptId === attemptId;
  return current ? recovery.hold : 'none';
}

/**
 * RT-305 — a cancel this surface sent. `waiting` on main; `answered` once its
 * read-back is in and this surface applies it (the hold-sync effect may run
 * before the handback in `finally`); `followed` once the store moved the attempt
 * on first (another surface's cancel answered), after which nothing is applied.
 */
export interface OwnCancel {
  readonly attemptId: string;
  status: 'waiting' | 'answered' | 'followed';
}

/** Tender main still counts as live on a force-failed attempt (cart-payment-eligibility). */
export const LIVE_TENDER_STATES: ReadonlySet<string> = new Set([
  'applying',
  'applied',
  'reversal_pending',
]);

export function backReason(input: BackControlInput, tenderBlocked: boolean): BackReason | null {
  // M-P13 first: a new recorded tender must not replace the terminal-void
  // warning with «أكمل الدفع أو ألغِه» (Codex P1 on #572).
  if (input.cardVoidRequired) return 'card_void';
  if ((input.projectedTenderLines ?? 0) > 0) return 'recorded';
  if (input.tenderReversed) return 'reversed';
  if (tenderBlocked) return 'blocked';
  return input.entryOpen ? 'entry_open' : null;
}

/** Any sign of tender for this handoff: projected lines, a reversing cancel, or main. */
export function isTenderBlocked(input: BackControlInput): boolean {
  if ((input.projectedTenderLines ?? 0) > 0 || input.tenderTouched) return true;
  return input.eligibility === 'blocked';
}

export function deriveBackControl(input: BackControlInput): BackControl {
  const offered = input.wired && input.onOpenCheckout;
  const tenderBlocked = isTenderBlocked(input);
  const ready = input.eligibility === 'returnable' && !tenderBlocked;
  const enabled = offered && ready && !(input.busy || input.entryOpen);
  const reason = offered ? backReason(input, tenderBlocked) : null;
  return {
    offered,
    tenderBlocked,
    enabled,
    reason,
    showReason: reason !== null,
    ariaDisabled: enabled ? undefined : 'true',
  };
}

/** Checkout is open on a live envelope (signed in, envelope mounted, not settled). */
export function isOpenCheckout(sessionKind: string, hasEnvelope: boolean, phase: Phase): boolean {
  if (sessionKind !== 'signedIn') return false;
  return hasEnvelope && phase !== 'settled';
}

/** A fresh Esc press no inner layer has already handled. */
export function isEscapePress(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape') return false;
  return !event.defaultPrevented && !event.repeat;
}

/** M-P catalogue (freeze 15): the reason under the unavailable commit before any tender (RT-1025). */
const NO_TENDER_REASON_COPY = 'اختر طريقة الدفع';

/** Why settle is not offered yet: no method chosen (M-P30), or money still owed. */
export function commitReasonCopy(awaitingTender: boolean, owed: boolean): string | null {
  if (awaitingTender) return NO_TENDER_REASON_COPY;
  return owed ? 'المبلغ أقل من المستحق' : null;
}

/** Freeze 15 tones: M-P13 danger, M-P3 neutral (RT-1025), M-P1/M-P2 info. */
export function backReasonTone(reason: BackReason): 'danger' | 'neutral' | 'info' {
  if (reason === 'card_void') return 'danger';
  return reason === 'entry_open' ? 'neutral' : 'info';
}

export type Phase = 'tender_selection' | 'entry' | 'settled';

/** RT-243 W1-C — the amount-due markers existing suites assert, kept out of the V5 tree. */
export const LEDGER_TEST_IDS = {
  dueLabel: 'payment-surface-amount-label',
  due: 'payment-surface-amount-due',
} as const;

/**
 * RT-243 — the settled-phase markers existing suites assert (006 FR-031,
 * invariant 14's never-stuck check, the cart→checkout walk), handed to the V5
 * completion panel so its own tree stays free of legacy names.
 */
export const COMPLETION_TEST_IDS = {
  root: 'payment-surface',
  panel: 'payment-surface-settled',
  proofs: 'payment-surface-settled-pending',
  amount: 'payment-surface-settled-amount',
  change: 'payment-surface-settled-change',
  cardVoid: 'payment-surface-settled-card-void',
  newSale: 'payment-surface-new-sale',
} as const;

/** RT-243 W1-C — the recovery-line markers existing suites assert, kept out of the V5 tree. */
export const RECOVERY_TEST_IDS = {
  refusal: 'payment-surface-bridge-refusal',
  reversalPending: 'payment-surface-reversal-pending-hint',
} as const;

/**
 * Freeze 15 §3.2 (Checkout default focus): the first enabled method tile. Focus
 * lands there on arrival (RT-761) and again after a partial apply (RT-763); both
 * are covered by `guardTileKey`.
 */
export const FIRST_ENABLED_TENDER_TILE =
  '[data-testid="tender-selection"] [role="radio"]:not([disabled])';

/** M-P7 — the catalogue copy, split at its sentence break into title and body. */
export const CARD_CANCEL_TITLE = 'إلغاء الدفع هنا لا يلغي الخصم على جهاز البطاقات.';
export const CARD_CANCEL_BODY = 'ألغِ العملية على الجهاز أولاً، ثم أكّد.';

interface ResolvedBridge {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
  /**
   * The read-only sales bridge, used after settlement to poll the terminal's
   * most-recently-finalized sale (`subscribe({ topic: 'recent' })`) so the
   * completed surface can show the cashier-quotable sale number. Optional: the
   * surface degrades gracefully (completed state + New sale, no sale number)
   * when sales is absent — `payments.confirm` carries no sale id/number, and
   * the sale finalizes asynchronously in the main process.
   */
  sales?: SalesBridgeAPI;
}

/**
 * Resolve the payments + tender (+ sales) bridge. In tests the bridge is
 * supplied via the `_testBridge` prop; in production we read it from the typed
 * preload `window.api`. Returns null only when payments OR tender is absent
 * (e.g. happy-dom with no prop injection — Slice-1 fall-back) so the surface
 * can degrade gracefully. `sales` is optional and never gates resolution.
 */
export function resolveBridge(testBridge: ResolvedBridge | undefined): ResolvedBridge | null {
  if (testBridge !== undefined) {
    return testBridge;
  }
  /* v8 ignore next 9 — only reachable in Electron; jsdom never sets window.api */
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  if (api === undefined || api.payments === undefined || api.tender === undefined) {
    return null;
  }
  // Spread `sales` only when present — `exactOptionalPropertyTypes` forbids
  // assigning an explicit `undefined` to the optional `sales?` property.
  return {
    payments: api.payments,
    tender: api.tender,
    ...(api.sales !== undefined ? { sales: api.sales } : {}),
  };
}

/** The status line shown for a tender selection when no payment bridge is wired (Slice 1). */
export const TENDER_SELECTED_COPY: Record<TenderKind, string> = {
  cash: 'تم اختيار النقد',
  external_card_terminal: 'تم اختيار جهاز الشبكة',
  internal_voucher: 'تم اختيار القسيمة',
};
