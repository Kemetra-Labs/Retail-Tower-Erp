import type { JSX } from 'react';

import { useScanOwner } from '../../scan/ScanGuardHost.js';
import { SCAN_SALE_COMPLETE_MESSAGE } from '../../scan/scan-messages.js';
import { useScanNoticeStore } from '../../scan/scan-notice-store.js';
import { ConfirmDialog } from '../../v5/foundation/ConfirmDialog.js';
import { ToneIcon } from '../../v5/foundation/ToneIcon.js';
import { Icon } from '../../icons/Icon.js';
import { Notice } from '../../v5/foundation/Notice.js';
import { DISCOUNT_COPY } from '../../v5/sale/discount/discount-copy.js';
import {
  BACK_REASON_COPY,
  CARD_CANCEL_BODY,
  CARD_CANCEL_TITLE,
  backReasonTone,
  type BackControl,
} from './payment-surface-logic.js';

/**
 * RT-1226 — the small presentational pieces of PaymentSurface, moved out of
 * the surface file unchanged.
 */

/** RT-26 — Back to the same sale (Esc). Rendered only while offered. */
export function BackToSaleButton(
  props: Readonly<{ back: BackControl; onBack: () => void }>,
): JSX.Element | null {
  if (!props.back.offered) return null;
  return (
    <button
      type="button"
      className="v5-checkout-back v5-btn"
      data-testid="payment-surface-back"
      disabled={!props.back.enabled}
      aria-disabled={props.back.ariaDisabled}
      aria-keyshortcuts="Escape"
      onClick={props.onBack}
    >
      رجوع إلى البيع
      <kbd dir="ltr">Esc</kbd>
    </button>
  );
}

/**
 * RT-1025: before any tender the commit is present but unavailable (dashed,
 * `foundation/buttons.css`), so the money column is never blank; its reason
 * sits under it. It never settles, so it is natively disabled.
 */
export function UnavailableCommit(): JSX.Element {
  return (
    <button
      type="button"
      className="v5-btn v5-btn--primary v5-btn--commit"
      data-testid="payment-surface-commit-unavailable"
      disabled
      aria-describedby="payment-commit-reason"
    >
      تأكيد الدفع
    </button>
  );
}

/** Why Back is disabled: money recorded, money reversed, or an entry is open. */
export function BackBlockedReason(props: Readonly<{ back: BackControl }>): JSX.Element | null {
  if (!props.back.showReason || props.back.reason === null) return null;
  const tone = backReasonTone(props.back.reason);
  // RT-243 W1-C: the V5 Notice treatment (tone border, tint, tone icon), so the
  // M-P13 danger reads as danger by shape too, never by colour alone.
  return (
    <output
      className="v5-checkout__back-reason"
      data-testid="payment-surface-back-blocked"
      data-tone={tone}
    >
      {tone === 'neutral' ? (
        <span className="v5-tone-icon" data-icon="neutral">
          <Icon name="status.neutral" />
        </span>
      ) : (
        <ToneIcon tone={tone} />
      )}
      <span>{BACK_REASON_COPY[props.back.reason]}</span>
    </output>
  );
}

/**
 * RT-855 (OZ-1 = Z-A, D1 ZeroCheckout) — the tender panel at 0 due: no method
 * tiles, only why none is needed. «إتمام البيع» is the money column's commit.
 */
export function ZeroDueTender(): JSX.Element {
  return (
    <section
      className="v5-tender-picker"
      data-testid="tender-zero-due"
      aria-labelledby="v5-tender-picker-title"
    >
      <h2 className="v5-checkout-heading" id="v5-tender-picker-title">
        طريقة الدفع
      </h2>
      <Notice tone="info">{DISCOUNT_COPY.zeroDue}</Notice>
    </section>
  );
}

/** RT-239 (M-S7): a scan on a completed sale starts nothing; it says what to do. */
function notifySaleComplete(): void {
  useScanNoticeStore.getState().show(SCAN_SALE_COMPLETE_MESSAGE);
}

/** Mounted only while the settled screen is on, so it owns scans exactly then. */
export function SettledScanOwner(): null {
  useScanOwner(notifySaleComplete);
  return null;
}

/**
 * M-P7 (RT-116 §3) — the cancel confirm shown when a card charge may stand on
 * the terminal; «رجوع» keeps the entry, «تأكيد الإلغاء» sends the cancel.
 */
export function CardCancelConfirm(
  props: Readonly<{ onDismiss: () => void; onConfirm: () => void }>,
): JSX.Element {
  return (
    <ConfirmDialog
      label={CARD_CANCEL_TITLE}
      title={CARD_CANCEL_TITLE}
      body={CARD_CANCEL_BODY}
      cancelLabel="رجوع"
      confirmLabel="تأكيد الإلغاء"
      tone="danger"
      onCancel={props.onDismiss}
      onConfirm={props.onConfirm}
    />
  );
}
