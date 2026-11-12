import { useState, type JSX, type ReactNode } from 'react';
import type { CartLineItem, DiscountPlaceholderSeed } from '../../sale/useSaleCartController';
import { formatHumanCount } from '../../ui/format/human-format';
import { Icon } from '../../icons/Icon';
import {
  CartLineRow,
  NoteDialog,
  VoidControl,
  money,
  type LineDiscountView,
} from './LiveCartParts';
import { cartDiscountTotals } from './discount/discount-math';
import { DISCOUNT_COPY } from './discount/discount-copy';
import { DiscountAmount } from './discount/DiscountParts';
import { useRemovalFocus } from './useRemovalFocus';
import type { LineFlags } from '../../stores/line-flags-store';
import { moveRowFocus, useNewestRowInView } from './useCartRowFocus';
import type { PromotionFact, PromotionPreview } from '../../../shared/offers/types';
import { OFFER_COPY, promotionViewsByLine } from './offers/offers-ui';

interface Props {
  lines: readonly CartLineItem[];
  /** RT-242 (M-S9): awareness flags of the product each line was added from (display only, I-17). */
  lineFlags?: Readonly<Record<string, LineFlags>>;
  discounts: readonly DiscountPlaceholderSeed[];
  subtotalMinor: number;
  itemCount: number;
  frozenSubtotalMinor: number | null;
  canHandoff: boolean;
  /** RT-1119 (M-S12): an add is still landing, which is why the handoff is unavailable. */
  addInFlight?: boolean;
  handingOff: boolean;
  cancelled: boolean;
  canVoid: boolean;
  canContinue: boolean;
  /** The frozen cart's payment is known settled: a completed sale, never re-offered to payment. */
  paid?: boolean;
  /** The previous sale was just voided; acknowledged until the next line lands. */
  voided?: boolean;
  handoffError: string | null;
  /** RT-242: the line the last add landed on; scrolled into view and flashed. */
  lastAddedLineId?: string | null;
  /** Changes on every add, so a +1 on the same line flashes again. */
  lastAddNonce?: number;
  onIncrement: (line: CartLineItem) => void;
  onDecrement: (line: CartLineItem) => void;
  onRemove: (line: CartLineItem) => void;
  onSaveNote: (line: CartLineItem, note: string | null) => Promise<boolean>;
  onRemoveDiscount: (placeholderId: string) => void;
  onHandoff: () => void;
  onContinue: () => void;
  onVoid: () => Promise<boolean>;
  onNewSale?: () => void;
  /** RT-445: «تعليق البيع», beside «إلغاء البيع» and apart from it (I-2). */
  parkControl?: ReactNode;
  /** RT-855 (OD-1): the «خصم» control, in the cart header. */
  discountControl?: ReactNode;
  /** RT-855: the line «خصم» acts on (the last added, or the row that had focus). */
  selectedLineId?: string | null;
  onSelectLine?: (lineId: string) => void;
  /** RT-855: a discount refusal shown beside the total (D1 SecondRefused, QtyRefused). */
  discountNotice?: string | null;
  /** RT-855: the frozen envelope's `discount_total_minor` (0 when it has none). */
  frozenDiscountMinor?: number;
  /** RT-855: the frozen envelope's amount due (`total_due_minor`); null when unreadable. */
  frozenDueMinor?: number | null;
  /** RT-1339: the automatic offers the editing cart earns now (main evaluates; null: none known). */
  promotions?: PromotionPreview | null;
  /** RT-1339: the frozen envelope's offer facts and their total (none when it has none). */
  frozenPromotions?: readonly PromotionFact[];
  frozenPromotionMinor?: number;
}

/** The offer facts the cart shows: the frozen envelope's once frozen, else the live preview's. */
function shownPromotions(props: Readonly<Props>): readonly PromotionFact[] {
  return props.frozenSubtotalMinor !== null
    ? (props.frozenPromotions ?? [])
    : (props.promotions?.promotions ?? []);
}

function shownPromotionMinor(props: Readonly<Props>): number {
  return props.frozenSubtotalMinor !== null
    ? (props.frozenPromotionMinor ?? 0)
    : (props.promotions?.promotion_total_minor ?? 0);
}

/**
 * RT-855 — each line's discount as the cart shows it, and the cart totals.
 * The totals of a cart with a discount this renderer cannot read are «—»
 * (unknown), never the gross shown as the amount to pay.
 */
function discountViews(props: Readonly<Props>): {
  byLine: ReadonlyMap<string, LineDiscountView>;
  discountTotalMinor: number | null;
  netMinor: number | null;
} {
  const totals = cartDiscountTotals(props.lines, props.discounts, props.subtotalMinor);
  const byLine = new Map<string, LineDiscountView>();
  for (const seed of props.discounts) {
    const lineId = seed.lineId ?? null;
    if (lineId === null || !totals.byLine.has(lineId)) continue;
    byLine.set(lineId, {
      placeholderId: seed.placeholderId,
      token: seed.token ?? null,
      reasonCode: seed.reasonCode ?? null,
      approverName: seed.approverName ?? null,
      amountMinor: totals.byLine.get(lineId) ?? null,
    });
  }
  return { byLine, discountTotalMinor: totals.discountTotalMinor, netMinor: totals.netMinor };
}

/**
 * RT-242 (VNext W1-B, Direction B): the cart takes the workspace and the money
 * column sits on the inline end — totals, the one primary action and, apart
 * from it, the void. Two sibling regions so the workspace grid can give the
 * money column the full height: the total and the commit are never scrolled
 * away, however long the cart.
 */
export function LiveSaleCart(props: Readonly<Props>): JSX.Element {
  return (
    <>
      <CartRegion {...props} />
      <MoneyColumn {...props} />
    </>
  );
}

function CartRegion(props: Readonly<Props>): JSX.Element {
  const [noteLineId, setNoteLineId] = useState<string | null>(null);
  const editingLine = props.lines.find((item) => item.lineId === noteLineId) ?? null;
  const editable = props.frozenSubtotalMinor === null && !props.cancelled;
  return (
    <section className="v5-sale-cart" aria-labelledby="v5-live-cart-title">
      <div className="v5-sale-cart-heading">
        <h2 id="v5-live-cart-title">سلة المشتريات</h2>
        <CartStateLabel {...props} />
        <span className="v5-sale-count">
          {`الأصناف: ${formatHumanCount(props.lines.length)} · الوحدات: ${formatHumanCount(props.itemCount)}`}
        </span>
        {props.discountControl}
      </div>
      {/* Focusable so a frozen cart, which has no line controls, still scrolls by keyboard; ↓ enters the rows. */}
      <div
        className="v5-sale-cart-table"
        role="region"
        aria-label="بنود السلة"
        tabIndex={0}
        data-fit-rows="4"
        onKeyDown={moveRowFocus}
      >
        <div className="v5-sale-cart-columns" aria-hidden="true" data-fit-exclude>
          <span>#</span>
          <span>الصنف</span>
          <span>الكمية</span>
          <span>سعر الوحدة</span>
          <span>الإجمالي</span>
          <span />
        </div>
        <CartLines
          {...props}
          editable={editable}
          onOpenNote={(line) => {
            setNoteLineId(line.lineId);
          }}
        />
      </div>
      {editingLine !== null && (
        <NoteDialog
          key={editingLine.lineId}
          line={editingLine}
          onSave={props.onSaveNote}
          onClose={() => {
            setNoteLineId(null);
          }}
        />
      )}
    </section>
  );
}

/** The inline-end money column: totals and the commit at the foot, the void apart below them. */
function MoneyColumn(props: Readonly<Props>): JSX.Element {
  return (
    // A labelled region, not <aside>: a complementary landmark may not nest inside <main>.
    <section className="v5-sale-money" aria-labelledby="v5-live-money-title">
      <h2 id="v5-live-money-title" className="v5-sale-money-title">
        ملخص العملية
      </h2>
      <dl className="v5-sale-money-counts">
        <div>
          <dt>الأصناف</dt>
          <dd dir="ltr">{formatHumanCount(props.lines.length)}</dd>
        </div>
        <div>
          <dt>الوحدات</dt>
          <dd dir="ltr">{formatHumanCount(props.itemCount)}</dd>
        </div>
      </dl>
      <div className="v5-sale-money-commit" data-fit="pinned">
        <CartTotals {...props} />
        <CartActions {...props} />
      </div>
      {(props.canVoid || props.parkControl) && (
        <div className="v5-sale-money-secondary" data-fit="pinned">
          {props.parkControl}
          {props.parkControl && props.canVoid && (
            <span className="v5-park-sep" aria-hidden="true" />
          )}
          {props.canVoid && <VoidControl onVoid={props.onVoid} />}
        </div>
      )}
    </section>
  );
}

function CartLines(
  props: Props & { editable: boolean; onOpenNote: (line: CartLineItem) => void },
): JSX.Element {
  const planRemoval = useRemovalFocus(props.lines);
  const flashing = useNewestRowInView(props.lastAddedLineId ?? null, props.lastAddNonce ?? 0);
  if (props.lines.length === 0)
    return <p className="v5-live-message">لا توجد أصناف في السلة بعد.</p>;
  const { byLine } = discountViews(props);
  const offersByLine = promotionViewsByLine(shownPromotions(props));
  return (
    <ol className="v5-sale-cart-lines" aria-label="أصناف السلة">
      {props.lines.map((line, index) => (
        <CartLineRow
          key={line.lineId}
          line={line}
          flags={props.lineFlags?.[line.lineId]}
          index={index}
          lastAdded={line.lineId === props.lastAddedLineId}
          flashing={flashing && line.lineId === props.lastAddedLineId}
          discount={byLine.get(line.lineId) ?? null}
          promotion={offersByLine.get(line.lineId) ?? null}
          selected={props.editable && line.lineId === props.selectedLineId}
          onSelect={(selected) => props.onSelectLine?.(selected.lineId)}
          onRemoveDiscount={props.onRemoveDiscount}
          editable={props.editable}
          onIncrement={props.onIncrement}
          onDecrement={props.onDecrement}
          onRemove={props.onRemove}
          onOpenNote={props.onOpenNote}
          onPlanRemoval={planRemoval}
        />
      ))}
    </ol>
  );
}

type StateTone = 'info' | 'success' | 'neutral';

/**
 * Where the transaction stands, derived only from props the cart already
 * receives. Editing needs no label: the editable lines say it. Not a live
 * region: the actions area announces the change itself.
 */
function cartState(props: Props): { label: string; tone: StateTone } | null {
  if (props.paid === true) return { label: 'مدفوعة', tone: 'success' };
  if (props.cancelled) return { label: 'ملغاة', tone: 'neutral' };
  if (props.frozenSubtotalMinor !== null) return { label: 'مُسلّمة للدفع', tone: 'info' };
  return null;
}

function CartStateLabel(props: Readonly<Props>): JSX.Element | null {
  const state = cartState(props);
  if (state === null) return null;
  return (
    <span className="v5-live-cart-state" data-tone={state.tone}>
      {state.label}
    </span>
  );
}

interface ShownTotals {
  readonly subtotal: string;
  /** `'none'` when no line is discounted (the row is not drawn); null when unknown («—»). */
  readonly discountMinor: number | null | 'none';
  /** RT-1339: «خصم العروض», `'none'` when no offer applies (the row is not drawn). */
  readonly promotionMinor: number | 'none';
  readonly net: string;
}

/**
 * The totals as shown: the gross subtotal, «إجمالي الخصم» when a line is
 * discounted (OD-3), and «الإجمالي الحالي» as the net. A frozen cart shows its
 * envelope's own figures.
 */
function shownTotals(props: Readonly<Props>): ShownTotals {
  if (props.frozenSubtotalMinor !== null) {
    const discount = props.frozenDiscountMinor ?? 0;
    const due =
      props.frozenDueMinor === undefined ? props.frozenSubtotalMinor : props.frozenDueMinor;
    const promo = shownPromotionMinor(props);
    return {
      subtotal: money(props.frozenSubtotalMinor),
      discountMinor: discount > 0 ? discount : 'none',
      promotionMinor: promo > 0 ? promo : 'none',
      net: due === null ? '—' : money(due),
    };
  }
  // Before any line exists the total is a placeholder, never a fabricated 0.00.
  if (props.lines.length === 0) {
    return { subtotal: '—', discountMinor: 'none', promotionMinor: 'none', net: '—' };
  }
  const promo = shownPromotionMinor(props);
  const promotionMinor = promo > 0 ? promo : 'none';
  const views = discountViews(props);
  if (views.byLine.size === 0) {
    return {
      subtotal: money(props.subtotalMinor),
      discountMinor: 'none',
      promotionMinor,
      net: money(props.subtotalMinor - promo),
    };
  }
  return {
    subtotal: money(props.subtotalMinor),
    discountMinor: views.discountTotalMinor,
    promotionMinor,
    net: views.netMinor === null ? '—' : money(views.netMinor - promo),
  };
}

function CartTotals(props: Readonly<Props>): JSX.Element {
  const shown = shownTotals(props);
  return (
    <div className="v5-sale-totals" aria-label="ملخص المبالغ">
      <div className="v5-sale-total-row">
        <span>المجموع الفرعي</span>
        <span dir="ltr">{shown.subtotal}</span>
      </div>
      {shown.discountMinor !== 'none' && (
        <div className="v5-sale-total-row v5-sale-discount-total">
          <span>{DISCOUNT_COPY.totalDiscount}</span>
          <DiscountAmount minor={shown.discountMinor} />
        </div>
      )}
      {shown.promotionMinor !== 'none' && (
        <div className="v5-sale-total-row v5-sale-discount-total" data-testid="promotion-total">
          <span>{OFFER_COPY.totalOffers}</span>
          <DiscountAmount minor={shown.promotionMinor} />
        </div>
      )}
      <div className="v5-sale-total-row v5-sale-tax-row">
        <span>الضريبة</span>
        <span>قيد الإضافة · لا تُحسب هنا</span>
      </div>
      <div className="v5-sale-grand-total">
        <span>الإجمالي الحالي</span>
        <strong dir="ltr">{shown.net}</strong>
      </div>
    </div>
  );
}

function CartActions(props: Readonly<Props>): JSX.Element {
  return (
    <div className="v5-sale-actions">
      {props.handoffError && (
        <p role="alert" className="v5-live-notice v5-live-notice--danger">
          {props.handoffError}
        </p>
      )}
      {props.discountNotice != null && (
        <p role="alert" className="v5-live-notice v5-live-notice--danger">
          {props.discountNotice}
        </p>
      )}
      {props.voided === true && <output className="v5-live-notice">تم إلغاء البيع.</output>}
      {props.frozenSubtotalMinor === null && props.promotions?.unavailable_offline === true && (
        <output className="v5-live-notice" data-testid="offer-unavailable-offline">
          {OFFER_COPY.unavailableOffline}
        </output>
      )}
      <PrimaryAction {...props} />
    </div>
  );
}

function PrimaryAction(props: Readonly<Props>): JSX.Element {
  if (props.paid === true)
    return (
      <>
        <output className="v5-live-notice v5-live-notice--success">تم الدفع لهذه السلة.</output>
        <button
          type="button"
          className="v5-sale-checkout v5-btn v5-btn--primary v5-btn--commit"
          onClick={props.onNewSale}
        >
          بيع جديد
        </button>
      </>
    );
  if (props.frozenSubtotalMinor !== null)
    return (
      <button
        type="button"
        className="v5-sale-checkout v5-btn v5-btn--primary v5-btn--commit"
        disabled={!props.canContinue}
        onClick={props.onContinue}
      >
        <span>المتابعة إلى الدفع</span>
        <Icon name="forward" size="lg" />
      </button>
    );
  if (props.cancelled) return <p className="v5-live-notice">تم إلغاء البيع.</p>;
  return <HandoffAction {...props} />;
}

/** The editing cart's commit: «تسليم السلة للدفع», with the reason it is unavailable under it. */
function HandoffAction(props: Readonly<Props>): JSX.Element {
  const reason = props.handingOff ? null : handoffReasonCopy(props);
  return (
    <>
      <button
        type="button"
        className="v5-sale-checkout v5-btn v5-btn--primary v5-btn--commit"
        disabled={!props.canHandoff || props.handingOff}
        aria-describedby={reason === null ? undefined : HANDOFF_REASON_ID}
        onClick={props.onHandoff}
      >
        <span>{props.handingOff ? 'جارٍ تسليم السلة…' : 'تسليم السلة للدفع'}</span>
        {!props.handingOff && <Icon name="forward" size="lg" />}
      </button>
      {reason !== null && (
        <p id={HANDOFF_REASON_ID} className="v5-sale-checkout-reason">
          {reason}
        </p>
      )}
    </>
  );
}

const HANDOFF_REASON_ID = 'sale-handoff-reason';

/** M-S11 (empty cart) and M-S12 (an add still landing): why the handoff is not yet offered. */
function handoffReasonCopy(props: Readonly<Props>): string | null {
  if (props.canHandoff) return null;
  // The first add leaves the cart empty until it lands: say it is landing, not that it is empty.
  if (props.addInFlight === true) return 'جارٍ إضافة الصنف…';
  return props.lines.length === 0 ? 'أضف صنفًا لتسليم السلة للدفع' : null;
}
