import type { JSX, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

import { DISCOUNT_COPY } from '../../v5/sale/discount/discount-copy.js';
import { CheckoutActionBar } from './CheckoutActionBar.js';
import { UnavailableCommit } from './checkout-parts.js';
import { START_READ_FAILED_COPY, TENDER_READ_FAILED_COPY } from './payment-read-copy.js';
import { commitReasonCopy } from './payment-surface-logic.js';
import type { AfterApply, ReadAfter } from './payment-surface-state.js';

/**
 * RT-1226 — the cancel / commit stage of PaymentSurface: the pinned action bar
 * (RT-238, 15 §4 A2). Cancel lives in the start slot, the primary/commit in the
 * end slot, and neither slot is ever filled by an action of the opposite
 * consequence. RT-243 W1-C mounts it at the foot of the money column, outside
 * its scrolling middle, so the commit cannot scroll out of view; refusals and
 * the RT-298 hold lines stay with it. Moved out of the surface body unchanged;
 * it holds no state of its own.
 */
export interface PaymentActionBarProps {
  readonly endSlotRef: (node: HTMLElement | null) => void;
  /** Cancel is offered only while an entry is open. */
  readonly entryPhase: boolean;
  readonly isCancelling: boolean;
  readonly onCancel: () => void;
  /** RT-298: a cancel is in flight or its outcome is held. */
  readonly cancelOpen: boolean;
  readonly afterApply: AfterApply;
  readonly readAfter: ReadAfter;
  readonly onRetryRead: () => void;
  readonly zeroDue: boolean;
  readonly isStarting: boolean;
  readonly isConfirming: boolean;
  readonly onCompleteZero: () => void;
  readonly awaitingTender: boolean;
  readonly showSettle: boolean;
  readonly fullyTendered: boolean;
  readonly onCommitKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  /** Settle when fully tendered; otherwise re-read main (the projection may be stale). */
  readonly onCommit: () => void;
  readonly notices: ReactNode;
}

const COMMIT_CLASS = 'v5-btn v5-btn--primary v5-btn--commit';

/** The settle commit at 0 due: nothing is offered while main is being read back. */
function completeZeroControl(props: Readonly<PaymentActionBarProps>): JSX.Element | null {
  if (props.afterApply !== 'idle') return null;
  return (
    <button
      type="button"
      className={COMMIT_CLASS}
      data-testid="payment-surface-complete-zero"
      disabled={props.isStarting || props.isConfirming}
      onKeyDown={props.onCommitKeyDown}
      onClick={props.onCompleteZero}
    >
      {DISCOUNT_COPY.completeSale}
    </button>
  );
}

/**
 * The action bar's primary slot. RT-298: while a cancel is open nothing here
 * may move the attempt on, the post-apply read retry included (Codex P2, #576).
 */
function commitControl(props: Readonly<PaymentActionBarProps>): JSX.Element | null {
  if (props.cancelOpen) return null;
  if (props.afterApply === 'failed') {
    return (
      <button
        type="button"
        className={COMMIT_CLASS}
        data-testid="payment-surface-reread"
        onClick={props.onRetryRead}
      >
        إعادة المحاولة
      </button>
    );
  }
  if (props.zeroDue) return completeZeroControl(props);
  if (props.awaitingTender) return <UnavailableCommit />;
  if (!props.showSettle) return null;
  const { isConfirming, fullyTendered } = props;
  return (
    <button
      type="button"
      className={COMMIT_CLASS}
      data-testid="payment-surface-confirm"
      disabled={isConfirming}
      aria-disabled={isConfirming || !fullyTendered ? 'true' : undefined}
      aria-describedby={fullyTendered ? undefined : 'payment-commit-reason'}
      onKeyDown={props.onCommitKeyDown}
      onClick={props.onCommit}
    >
      تأكيد الدفع
    </button>
  );
}

/** The line under the primary action: why a re-read is offered, or why settle is not yet. */
function commitReason(props: Readonly<PaymentActionBarProps>): JSX.Element | null {
  if (props.cancelOpen) return null;
  if (props.afterApply === 'failed') {
    return (
      <output className="v5-checkout-actions__reason" data-testid="payment-surface-reread-notice">
        {props.readAfter === 'start' ? START_READ_FAILED_COPY : TENDER_READ_FAILED_COPY}
      </output>
    );
  }
  const reason = commitReasonCopy(props.awaitingTender, props.showSettle && !props.fullyTendered);
  if (reason === null) return null;
  return (
    <p
      id="payment-commit-reason"
      className="v5-checkout-actions__reason"
      data-testid="payment-surface-commit-reason"
      data-tone={props.awaitingTender ? 'neutral' : undefined}
    >
      {reason}
    </p>
  );
}

export function PaymentActionBar(props: Readonly<PaymentActionBarProps>): JSX.Element {
  return (
    <CheckoutActionBar
      endSlotRef={props.endSlotRef}
      cancel={
        props.entryPhase ? (
          <button
            type="button"
            className="v5-btn v5-btn--danger-quiet"
            data-testid="payment-surface-cancel"
            disabled={props.isCancelling}
            aria-disabled={props.isCancelling ? 'true' : undefined}
            onClick={props.onCancel}
          >
            إلغاء
          </button>
        ) : null
      }
      // RT-298: while a cancel is open nothing here may move the attempt
      // on, the post-apply read retry included (Codex P2, #576).
      commit={commitControl(props)}
      reason={commitReason(props)}
      notices={props.notices}
    />
  );
}
