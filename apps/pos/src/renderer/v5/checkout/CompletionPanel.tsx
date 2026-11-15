import { useEffect, useRef, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { focusVisibly } from '../foundation/focus-visibly';
import { Notice } from '../foundation/Notice';
import { formatHumanMoney } from '../../ui/format/human-format';
import { DISCOUNT_COPY } from '../sale/discount/discount-copy';
import { ProofList, type ProofItem } from './ProofList';
import './completion.css';

/**
 * RT-243 W1-C (freeze 15 S13/S14, VN-S4) — Checkout's completion, on the V5
 * vocabulary. It lists only what the terminal can prove for THIS payment:
 *
 * - the payment was taken (`payments.confirm` returned `settled_at`): success;
 * - the change to hand back, main's `change_due_minor` (M-P5), when non-zero;
 * - the receipt as NOT issued yet (info), or as never issued when sale
 *   finalization is off (warning).
 *
 * RT-1322 (RT-249 N-S2, doc 20 §5.3): when the caller proves the finalized sale
 * is THIS payment's (`sales.readForHandoff`, the exact handoff key confirmed
 * against the attempt), it passes `saleNumber`. The headline then becomes
 * «اكتمل البيع» (M-C1) and the sale number is listed, with the exact number
 * secondary. While the caller is still waiting it passes neither prop and no
 * number line or claim shows; after the bound it passes `saleNumberUnavailable`
 * and the neutral M-N5 line shows. That line never says the sale was saved.
 *
 * Still left out on purpose, not shown as unknown: receipt «sent» (M-C2) and
 * sync. Nothing on the bridge proves either for this attempt.
 */

/** A held or doubled Enter right after focus lands here is not a decision. */
const NEW_SALE_ARM_MS = 400;

/** M-C1 headline, only once the finalized sale is proven to be this payment's. */
const COMPLETED_HEADLINE = 'اكتمل البيع';
/** M-C1 sale number label. */
const SALE_NUMBER_LABEL = 'رقم البيع';
/** M-N5: the number was not ready at the bound. Neutral; never claims the sale was saved. */
const SALE_NUMBER_UNAVAILABLE = 'رقم البيع غير متاح الآن.';

const RECEIPT_COPY = {
  pending: 'لم يصدر إيصال بعد.',
  disabled: 'لن يُسجَّل هذا البيع ولا يوجد إيصال له.',
} as const;

/**
 * Test hooks the caller owns. The V5 tree stays free of legacy names (the
 * clean-room guard), while Checkout keeps the markers its suites already pin.
 */
export interface CompletionTestIds {
  readonly root?: string;
  readonly panel?: string;
  readonly proofs?: string;
  readonly amount?: string;
  readonly change?: string;
  readonly cardVoid?: string;
  readonly newSale?: string;
}

/** The sale number main proved belongs to this payment (`sales.readForHandoff`). */
interface CompletionSaleNumber {
  /** The sequence without leading zeros, or null when main could not parse it. */
  readonly short: string | null;
  /** The stored number as printed on the receipt. */
  readonly exact: string;
}

export interface CompletionPanelProps {
  /** The amount taken, integer minor units (the envelope's amount due; 0 for a zero total). */
  readonly paidMinor: number;
  /** Main's change to hand back over the applied lines; 0 for none. */
  readonly changeDueMinor: number;
  /** False when sale finalization is off: no sale record or receipt will exist. */
  readonly saleFinalization: boolean;
  /**
   * This payment's own sale number, once proven. Absent while the caller is
   * waiting (no line, no claim) and when it gave up (see below).
   */
  readonly saleNumber?: CompletionSaleNumber | undefined;
  /** The bound passed without a number: the neutral M-N5 line, never a claim. */
  readonly saleNumberUnavailable?: boolean | undefined;
  /** M-P13 copy when a card line was cancelled here and the terminal void is unproven. */
  readonly cardVoidCopy: string | null;
  /** The drawer notice slot (D-B1), only inside cash completion. */
  readonly drawerNotice: ReactNode;
  /** Operator identity for the titlebar. */
  readonly operator: ReactNode;
  readonly onNewSale?: (() => void) | undefined;
  readonly testIds?: CompletionTestIds;
}

export function CompletionPanel({
  paidMinor,
  changeDueMinor,
  saleFinalization,
  saleNumber,
  saleNumberUnavailable = false,
  cardVoidCopy,
  drawerNotice,
  operator,
  onNewSale,
  testIds = {},
}: CompletionPanelProps): JSX.Element {
  const newSaleRef = useRef<HTMLButtonElement>(null);
  const focusedAtRef = useRef(0);

  // Freeze 15 §3.2: «بيع جديد» owns focus on Completion. The settle commit that
  // led here has just unmounted, so focus would otherwise fall to the body.
  // RT-840: the confirm is often a pointer click, after which a plain focus()
  // does not match :focus-visible and no ring is drawn; ask for it.
  useEffect(() => {
    focusVisibly(newSaleRef.current);
    focusedAtRef.current = Date.now();
  }, []);

  // RT-847: a printer driver's window can take OS activation after this screen
  // mounts; main gives it back when the print is over. On that re-activation,
  // ask for the ring on «بيع جديد» again when focus is still there or fell to
  // the page. Focus the cashier moved elsewhere stays where it is.
  useEffect(() => {
    const onWindowFocus = (): void => {
      const active = document.activeElement;
      if (active === null || active === document.body || active === newSaleRef.current) {
        focusVisibly(newSaleRef.current);
      }
    };
    window.addEventListener('focus', onWindowFocus);
    return () => {
      window.removeEventListener('focus', onWindowFocus);
    };
  }, []);

  /**
   * The Enter that confirmed the payment can repeat (key held) or be tapped
   * twice. Landing on «بيع جديد» it would clear the change before the cashier
   * read it, so swallow a repeat or an Enter inside the arm window.
   */
  function guardNewSaleKey(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const tooSoon = Date.now() - focusedAtRef.current < NEW_SALE_ARM_MS;
    if (event.repeat || tooSoon) event.preventDefault();
  }

  const items: ProofItem[] = [
    {
      id: 'payment',
      tone: 'success',
      // RT-855 (OZ-1 = Z-A, D1 ZeroCompletion): a zero-total sale took no money,
      // so it never says «تم استلام المبلغ» (and has no change).
      // RT-1322 (M-C1): «اكتمل البيع» only with this sale's own number proven.
      label:
        paidMinor === 0
          ? DISCOUNT_COPY.noAmountDue
          : saleNumber !== undefined
            ? COMPLETED_HEADLINE
            : 'تم استلام المبلغ',
      value: formatHumanMoney(paidMinor),
      // FR-16: the settled amount stays the dominant figure, change or not.
      emphasis: 'hero',
      testId: 'completion-proof-payment',
      valueTestId: testIds.amount,
    },
  ];
  if (saleNumber !== undefined) {
    // A sale number is a reference, not a status: neutral, with no tone glyph.
    // When main could not derive the short form, the exact number is the value.
    items.push({
      id: 'sale-number',
      tone: 'neutral',
      label: SALE_NUMBER_LABEL,
      value: saleNumber.short ?? saleNumber.exact,
      ...(saleNumber.short !== null ? { detail: saleNumber.exact } : {}),
      testId: 'completion-proof-sale-number',
      valueTestId: 'completion-sale-number-value',
      detailTestId: 'completion-sale-number-exact',
    });
  } else if (saleNumberUnavailable) {
    items.push({
      id: 'sale-number-unavailable',
      tone: 'info',
      label: SALE_NUMBER_UNAVAILABLE,
      testId: 'completion-proof-sale-number-unavailable',
    });
  }
  if (Number.isSafeInteger(changeDueMinor) && changeDueMinor > 0) {
    items.push({
      id: 'change',
      tone: 'neutral',
      label: 'الباقي للعميل',
      value: formatHumanMoney(changeDueMinor),
      emphasis: 'strong',
      testId: testIds.change,
    });
  }
  items.push({
    id: 'receipt',
    tone: saleFinalization ? 'info' : 'warning',
    label: saleFinalization ? RECEIPT_COPY.pending : RECEIPT_COPY.disabled,
    testId: 'completion-proof-receipt',
  });

  return (
    <section className="v5-completion" data-testid={testIds.root} aria-label="الدفع">
      <header className="v5-completion__titlebar">
        <h1>الدفع</h1>
        {operator}
      </header>

      <div className="v5-completion__body">
        {cardVoidCopy !== null && (
          <Notice
            tone="danger"
            {...(testIds.cardVoid !== undefined ? { testId: testIds.cardVoid } : {})}
          >
            {cardVoidCopy}
          </Notice>
        )}

        <div className="v5-completion__panel" data-testid={testIds.panel}>
          {/* A truthful terminal state, announced politely; never an alert. */}
          <div role="status" aria-live="polite" data-testid={testIds.proofs}>
            <ProofList items={items} label="حالة البيع" />
          </div>
        </div>

        {drawerNotice}

        <div className="v5-completion__actions">
          <button
            ref={newSaleRef}
            type="button"
            className="v5-completion-btn v5-completion-btn--primary v5-btn v5-btn--primary v5-btn--commit"
            data-testid={testIds.newSale}
            onKeyDown={guardNewSaleKey}
            onClick={() => {
              // Routing and the store reset belong to the route owner; a
              // missing handler is a safe no-op (bare-render tests).
              onNewSale?.();
            }}
          >
            بيع جديد
          </button>
        </div>
      </div>
    </section>
  );
}
