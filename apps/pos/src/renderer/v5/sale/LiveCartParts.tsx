import { useId, useRef, useState, type JSX, type MouseEvent } from 'react';
import type { ManualDiscountReasonCode } from '../../../shared/cart/manual-discount';
import type { CartLineItem } from '../../sale/useSaleCartController';
import { formatHumanMoney } from '../../ui/format/human-format';
import { Icon } from '../../icons/Icon';
import { ConfirmDialog } from '../foundation/ConfirmDialog';
import { Dialog } from '../foundation/Dialog';
import { focusScanOwner } from '../../scan/scan-anchor';
import type { RemovalControl } from './useRemovalFocus';
import { SaleProductFlags } from './SaleProductFlags';
import type { LineFlags } from '../../stores/line-flags-store';
import { approvedByLabel, DISCOUNT_COPY, reasonLabel } from './discount/discount-copy';
import { DiscountAmount, DiscountKindLabel } from './discount/DiscountParts';

// Legacy LineNotePopover parity: same length cap, unchanged-save and empty-clear guards.
const NOTE_MAX_LENGTH = 200;

export function money(minor: number): string {
  return formatHumanMoney(minor);
}

/** RT-855 — the manual discount on one line, as the cart shows it. */
export interface LineDiscountView {
  readonly placeholderId: string;
  readonly token: string | null;
  readonly reasonCode: ManualDiscountReasonCode | null;
  readonly approverName: string | null;
  /** The discount amount; null when this renderer cannot compute it (shown as «—»). */
  readonly amountMinor: number | null;
}

interface LineProps {
  line: CartLineItem;
  /** RT-855 — the line's manual discount, if any (OD-28-6: at most one). */
  discount?: LineDiscountView | null | undefined;
  /** RT-855 (OD-1) — the line «خصم» acts on. */
  selected?: boolean;
  /** Focus entered the row: it becomes the selected line. */
  onSelect?: ((line: CartLineItem) => void) | undefined;
  onRemoveDiscount?: ((placeholderId: string) => void) | undefined;
  /** RT-242 (M-S9): the add-time product flags, shown as a badge beside the name. */
  flags?: LineFlags | undefined;
  index: number;
  /** RT-242: the line the last add landed on (marked until the next add). */
  lastAdded?: boolean;
  /** RT-242: the 150 ms acknowledgement flash on that line. */
  flashing?: boolean;
  editable: boolean;
  onIncrement: (line: CartLineItem) => void;
  onDecrement: (line: CartLineItem) => void;
  onRemove: (line: CartLineItem) => void;
  onOpenNote: (line: CartLineItem) => void;
  /** Keyboard removal: tell the cart where focus should land once the row is gone. */
  onPlanRemoval: (line: CartLineItem, control: RemovalControl) => void;
}

/**
 * RT-239 rule 6. A pointer click on a row control returns focus to the scan
 * owner (a pointer user needs no row focus). Keyboard activation keeps row
 * context: `+` and `−` stay on the same button, and a removal (`حذف`, or `−` on a
 * one-unit line) hands focus to the neighbouring row.
 */
function settleRowFocus(event: MouseEvent<HTMLButtonElement>, keyboardPlan?: () => void): void {
  if (event.detail > 0) focusScanOwner();
  else keyboardPlan?.();
}

/**
 * RT-242 (Direction B row): name · quantity · unit price · line total · actions.
 * «حذف» sits in its own column at the far end, never next to the stepper's +.
 * The row itself takes focus for ↑ / ↓ (tabIndex −1: not an extra Tab stop).
 */
export function CartLineRow(props: Readonly<LineProps>): JSX.Element {
  const { line } = props;
  const qtyNoteId = useId();
  const discount = props.discount ?? null;
  return (
    <li
      className="v5-sale-cart-line"
      data-fit-row
      data-line-id={line.lineId}
      data-last-added={props.lastAdded === true ? 'true' : undefined}
      data-selected={props.selected === true ? 'true' : undefined}
      data-flash={props.flashing === true ? 'true' : undefined}
      tabIndex={-1}
      onFocus={() => {
        props.onSelect?.(line);
      }}
    >
      <span className="v5-sale-line-index" dir="ltr">
        {props.index + 1}
      </span>
      <div className="v5-sale-line-product">
        <strong>{line.displayName}</strong>
        {props.flags && <SaleProductFlags product={props.flags} />}
        {line.note && <span className="v5-sale-line-meta">ملاحظة: {line.note}</span>}
      </div>
      <QuantityControl
        {...props}
        frozenBy={discount !== null && props.editable ? qtyNoteId : null}
      />
      <span className="v5-sale-line-unit" dir="ltr">
        {money(line.unitPriceMinor)}
      </span>
      <strong className="v5-sale-line-total" dir="ltr">
        {money(line.lineSubtotalMinor)}
      </strong>
      <div className="v5-live-line-actions">
        {props.editable && (
          <>
            <button
              type="button"
              data-row-action="note"
              onClick={() => {
                props.onOpenNote(line);
              }}
            >
              ملاحظة
            </button>
            <button
              type="button"
              data-row-action="remove"
              onClick={(event) => {
                settleRowFocus(event, () => {
                  props.onPlanRemoval(line, 'remove');
                });
                props.onRemove(line);
              }}
            >
              حذف
            </button>
          </>
        )}
      </div>
      {discount !== null && (
        <LineDiscountRow
          discount={discount}
          editable={props.editable}
          onRemove={props.onRemoveDiscount}
        />
      )}
      {discount !== null && props.editable && (
        <p id={qtyNoteId} className="v5-discount-qty-note">
          {DISCOUNT_COPY.qtyDisabled}
        </p>
      )}
    </li>
  );
}

/**
 * RT-855 (D1 Discounted, OD-28-11) — the row under a discounted line: «خصم
 * 10%» (or «خصم» for an amount), the reason, «بموافقة: …», the amount in the
 * line-total column and «إزالة الخصم» (any role, D4). The line's own total
 * stays its gross.
 */
function LineDiscountRow(
  props: Readonly<{
    discount: LineDiscountView;
    editable: boolean;
    onRemove: ((placeholderId: string) => void) | undefined;
  }>,
): JSX.Element {
  const { discount } = props;
  return (
    <div className="v5-discount-row">
      <span className="v5-discount-what">
        <DiscountKindLabel token={discount.token} />
        {discount.reasonCode !== null && (
          <span className="v5-discount-meta">{reasonLabel(discount.reasonCode)}</span>
        )}
        {discount.approverName !== null && (
          <span className="v5-discount-meta">
            <bdi>{approvedByLabel(discount.approverName)}</bdi>
          </span>
        )}
      </span>
      <DiscountAmount minor={discount.amountMinor} className="v5-discount-amount" />
      <div className="v5-live-line-actions">
        {props.editable && (
          <button
            type="button"
            data-row-action="remove-discount"
            onClick={(event) => {
              // Keyboard: the button goes with the discount, so the row keeps focus.
              const row = event.currentTarget.closest<HTMLElement>('li');
              settleRowFocus(event, () => row?.focus());
              props.onRemove?.(discount.placeholderId);
            }}
          >
            {DISCOUNT_COPY.removeDiscount}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * OD-28-7 / D1 OD-4 (QtyDisabled): a discounted line's quantity cannot change,
 * so its stepper is disabled and names why (`frozenBy` is the note's id).
 * «حذف» still removes the line.
 */
function QuantityControl(props: Readonly<LineProps & { frozenBy: string | null }>): JSX.Element {
  const { line } = props;
  const frozen = props.frozenBy !== null;
  const describedBy = props.frozenBy ?? undefined;
  // Legacy stepper parity: at one, a note-less line is removed; a noted line decrements.
  function decrement(event: MouseEvent<HTMLButtonElement>): void {
    if (line.quantity <= 1 && line.note === null) {
      settleRowFocus(event, () => {
        props.onPlanRemoval(line, 'decrement');
      });
      props.onRemove(line);
    } else {
      settleRowFocus(event);
      props.onDecrement(line);
    }
  }
  return (
    <div className="v5-sale-quantity" aria-label={`الكمية ${String(line.quantity)}`}>
      {props.editable && (
        <button
          type="button"
          data-row-action="decrement"
          aria-label={`إنقاص كمية ${line.displayName}`}
          aria-describedby={describedBy}
          disabled={frozen}
          onClick={decrement}
        >
          <Icon name="remove" />
        </button>
      )}
      <strong dir="ltr">{line.quantity}</strong>
      {props.editable && (
        <button
          type="button"
          data-row-action="increment"
          aria-label={`زيادة كمية ${line.displayName}`}
          aria-describedby={describedBy}
          disabled={frozen}
          onClick={(event) => {
            settleRowFocus(event);
            props.onIncrement(line);
          }}
        >
          <Icon name="add" />
        </button>
      )}
    </div>
  );
}

/** Void entry point + its confirmation; a refused void keeps the dialog open (legacy parity). */
export function VoidControl({ onVoid }: Readonly<{ onVoid: () => Promise<boolean> }>): JSX.Element {
  const [open, setOpen] = useState(false);
  const close = (): void => {
    setOpen(false);
  };
  return (
    <>
      <button
        type="button"
        className="v5-live-void v5-btn v5-btn--danger-quiet"
        onClick={() => {
          setOpen(true);
        }}
      >
        إلغاء البيع
      </button>
      {open && (
        <ConfirmDialog
          label="تأكيد إلغاء البيع"
          title="إلغاء البيع؟"
          body="سيتم إلغاء السلة الحالية."
          cancelLabel="العودة"
          confirmLabel="تأكيد الإلغاء"
          tone="danger"
          onCancel={close}
          onConfirm={() => {
            void onVoid().then((ok) => {
              if (ok) close();
            });
          }}
        />
      )}
    </>
  );
}

export function NoteDialog(
  props: Readonly<{
    line: CartLineItem;
    onClose: () => void;
    onSave: (line: CartLineItem, note: string | null) => Promise<boolean>;
  }>,
): JSX.Element {
  const { line } = props;
  const [text, setText] = useState(line.note ?? '');
  const [failed, setFailed] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  function save(note: string | null): void {
    void props.onSave(line, note).then((ok) => {
      if (ok) props.onClose();
      else setFailed(true);
    });
  }
  return (
    <Dialog label="ملاحظة الصنف" onCancel={props.onClose} initialFocusRef={fieldRef}>
      <label htmlFor="v5-live-note" className="v5-live-dialog-title">
        ملاحظة الصنف
      </label>
      <textarea
        ref={fieldRef}
        id="v5-live-note"
        data-scan-target="note"
        maxLength={NOTE_MAX_LENGTH}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      {failed && (
        <p role="alert" className="v5-live-notice v5-live-notice--danger">
          تعذّر حفظ الملاحظة.
        </p>
      )}
      <div>
        <button type="button" className="v5-live-btn v5-btn" onClick={props.onClose}>
          إلغاء
        </button>
        <button
          type="button"
          className="v5-live-btn v5-btn"
          disabled={line.note === null}
          onClick={() => {
            save(null);
          }}
        >
          مسح الملاحظة
        </button>
        <button
          type="button"
          className="v5-live-btn v5-live-btn--primary v5-btn v5-btn--primary"
          disabled={text.trim() === (line.note ?? '')}
          onClick={() => {
            save(text.trim() || null);
          }}
        >
          حفظ
        </button>
      </div>
    </Dialog>
  );
}
