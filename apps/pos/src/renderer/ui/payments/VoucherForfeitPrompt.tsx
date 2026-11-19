import { useEffect, useId, useRef, type JSX } from 'react';

import { touchTarget } from '../tokens/touch.js';
import { formatCheckoutMoney } from './format-checkout-money.js';

/**
 * RT-1331 (RT-1098 decision 1A) — the forfeit confirmation inside <VoucherEntry>.
 *
 * A voucher redemption consumes the whole voucher, so a voucher worth more than the
 * amount applied forfeits the rest. Main refuses to apply the line until the cashier
 * has confirmed that amount; this is the prompt that collects it.
 *
 * Inline, not a modal: the smallest safe commitment surface (UX-05.3). The safe option
 * (cancel) takes focus, sits at the inline-start, and the commit at the inline-end (POS
 * action slots). The amount is LTR-isolated machine data inside an Arabic sentence.
 *
 * Owner decision (chat, 2026-11-19): forfeiting the unused balance is allowed, so decision
 * 1A stands and this prompt is the cashier's confirmation of it. The wording below is
 * proposed copy for the owner to review (no governing page defines it). Shape follows UX-12:
 * what, safety, action. The consequence is stated as a fact and never as "cannot be undone":
 * reversing the sale restores the voucher whole.
 *
 * SECURITY (V-A contract, RT-1098 c16402): the forfeited amount is the one voucher value
 * allowed on the wire, for this prompt only. It is rendered here and never logged.
 */
const FORFEIT_PROMPT_COPY =
  'قيمة القسيمة أكبر من المبلغ المطبّق. سيسقط الباقي ولا يُحتفظ به كرصيد.';

export interface VoucherForfeitPromptProps {
  /** The part of the voucher's value that applying it would forfeit, in minor units. */
  forfeitedMinor: number;
  /** A confirmed request is in flight: both actions wait. */
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function VoucherForfeitPrompt({
  forfeitedMinor,
  busy,
  onConfirm,
  onCancel,
}: Readonly<VoucherForfeitPromptProps>): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Both actions are described by the consequence and the amount, so a screen-reader user
  // hears what confirming forfeits (focus lands on cancel, which would otherwise be silent
  // about it); the amount is a polite status so a changed amount is announced.
  const copyId = useId();
  const amountId = useId();
  const described = `${copyId} ${amountId}`;

  // The safe option owns focus whenever the prompt is waiting on the cashier (UX-11): on
  // open, and again after a confirmed call that came back asking about a different amount.
  // `autoFocus` only runs on mount, and clicking confirm disables both buttons (focus drops
  // to <body>) while this component stays mounted, so focus is placed by this effect.
  useEffect(() => {
    if (!busy) {
      cancelRef.current?.focus();
    }
  }, [busy, forfeitedMinor]);

  return (
    <section
      className="voucher-entry__forfeit"
      data-testid="voucher-entry-forfeit"
      aria-label="تأكيد إسقاط باقي القسيمة"
    >
      <p id={copyId}>{FORFEIT_PROMPT_COPY}</p>
      <p>
        <output id={amountId}>
          الباقي الذي سيسقط: <bdi dir="ltr">{formatCheckoutMoney(forfeitedMinor)}</bdi>
        </output>
      </p>
      <div className="voucher-entry__forfeit-actions">
        <button
          type="button"
          className="v5-btn"
          data-testid="voucher-entry-forfeit-cancel"
          style={{ minHeight: touchTarget.commit }}
          ref={cancelRef}
          aria-describedby={described}
          disabled={busy}
          onClick={onCancel}
        >
          إلغاء
        </button>
        <button
          type="button"
          className="v5-btn v5-btn--primary v5-btn--commit"
          data-testid="voucher-entry-forfeit-confirm"
          style={{ minHeight: touchTarget.commit }}
          aria-describedby={described}
          disabled={busy}
          onClick={onConfirm}
        >
          تأكيد وتطبيق القسيمة
        </button>
      </div>
    </section>
  );
}
