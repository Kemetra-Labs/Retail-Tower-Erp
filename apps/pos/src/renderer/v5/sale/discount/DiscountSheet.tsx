import { useId, useRef, type JSX, type RefObject } from 'react';

import type {
  ManualDiscountKind,
  ManualDiscountReasonCode,
} from '../../../../shared/cart/manual-discount';
import { formatHumanMoney } from '../../../ui/format/human-format';
import { Dialog } from '../../foundation/Dialog';
import { Notice } from '../../foundation/Notice';
import { dismissUnlessBusy } from '../../shift/shift-bridge';
import { amountHelp, DISCOUNT_COPY, DISCOUNT_REASONS } from './discount-copy';
import type { DiscountEntry } from './discount-math';
import { DiscountAmount } from './DiscountParts';

/** What the cashier or manager has chosen in the sheet so far. */
export interface DiscountDraft {
  readonly kind: ManualDiscountKind;
  readonly raw: string;
  readonly reason: ManualDiscountReasonCode | null;
}

export const EMPTY_DRAFT: DiscountDraft = { kind: 'percent', raw: '', reason: null };

/** The line the sheet acts on, as the cart shows it. */
export interface DiscountLine {
  readonly lineId: string;
  readonly displayName: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly lineSubtotalMinor: number;
}

interface Props {
  readonly line: DiscountLine;
  /** Cashier: the commit asks for approval; manager or admin: it applies directly (D2). */
  readonly needsApproval: boolean;
  readonly draft: DiscountDraft;
  readonly entry: DiscountEntry;
  readonly busy: boolean;
  /** A refusal main returned for this sheet (OD-6 «المبلغ أكبر…», or the generic line). */
  readonly error: string | null;
  readonly onChange: (draft: DiscountDraft) => void;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
}

function Choice(
  props: Readonly<{
    name: string;
    label: string;
    checked: boolean;
    onSelect: () => void;
  }>,
): JSX.Element {
  return (
    <label className="v5-discount-choice">
      <input type="radio" name={props.name} checked={props.checked} onChange={props.onSelect} />
      {props.label}
    </label>
  );
}

function KindChoice(
  props: Readonly<{ draft: DiscountDraft; onChange: (draft: DiscountDraft) => void }>,
): JSX.Element {
  const name = useId();
  const choose = (kind: ManualDiscountKind) => () => {
    // A value typed for one kind means nothing for the other.
    if (kind !== props.draft.kind) props.onChange({ ...props.draft, kind, raw: '' });
  };
  return (
    <fieldset className="v5-discount-fieldset v5-discount-kinds">
      <legend>{DISCOUNT_COPY.kindLegend}</legend>
      <Choice
        name={name}
        label={DISCOUNT_COPY.percent}
        checked={props.draft.kind === 'percent'}
        onSelect={choose('percent')}
      />
      <Choice
        name={name}
        label={DISCOUNT_COPY.amount}
        checked={props.draft.kind === 'amount'}
        onSelect={choose('amount')}
      />
    </fieldset>
  );
}

function ValueField(
  props: Readonly<{
    line: DiscountLine;
    draft: DiscountDraft;
    entry: DiscountEntry;
    error: string | null;
    inputRef: RefObject<HTMLInputElement | null>;
    onChange: (draft: DiscountDraft) => void;
  }>,
): JSX.Element {
  const id = useId();
  const percent = props.draft.kind === 'percent';
  const help = percent
    ? DISCOUNT_COPY.percentHelp
    : amountHelp(formatHumanMoney(props.line.lineSubtotalMinor));
  // OD-6: refused in the sheet before any call; main's own refusal reads the same.
  const fieldError = props.entry.kind === 'over_gross' ? DISCOUNT_COPY.overGross : props.error;
  return (
    <div className="v5-discount-field">
      <label htmlFor={id}>{DISCOUNT_COPY.valueLabel}</label>
      <div className="v5-discount-value-row">
        <input
          ref={props.inputRef}
          id={id}
          className="v5-discount-input"
          dir="ltr"
          inputMode={percent ? 'numeric' : 'decimal'}
          autoComplete="off"
          aria-describedby={`${id}-help${fieldError === null ? '' : ` ${id}-error`}`}
          aria-invalid={fieldError === null ? undefined : 'true'}
          value={props.draft.raw}
          onChange={(event) => {
            props.onChange({ ...props.draft, raw: event.target.value });
          }}
        />
        <span className="v5-discount-unit" dir="ltr" aria-hidden="true">
          {percent ? '%' : 'EGP'}
        </span>
      </div>
      <p id={`${id}-help`} className="v5-discount-help">
        {help}
      </p>
      {fieldError !== null && (
        <p id={`${id}-error`} className="v5-discount-error" role="alert">
          {fieldError}
        </p>
      )}
    </div>
  );
}

/** §4.1 step 2: the line gross, the discount and the net — presentation only. */
function Preview(props: Readonly<{ line: DiscountLine; entry: DiscountEntry }>): JSX.Element {
  const ok = props.entry.kind === 'ok' ? props.entry : null;
  return (
    <div className="v5-discount-preview-block">
      <dl className="v5-discount-preview">
        <div>
          <dt>{DISCOUNT_COPY.previewGross}</dt>
          <dd>
            <bdi dir="ltr">{formatHumanMoney(props.line.lineSubtotalMinor)}</bdi>
          </dd>
        </div>
        <div>
          <dt>{DISCOUNT_COPY.previewDiscount}</dt>
          <dd>
            <DiscountAmount minor={ok?.amountMinor ?? null} />
          </dd>
        </div>
        <div className="v5-discount-preview-net">
          <dt>{DISCOUNT_COPY.previewNet}</dt>
          <dd>
            <bdi dir="ltr">{ok === null ? '—' : formatHumanMoney(ok.netMinor)}</bdi>
          </dd>
        </div>
      </dl>
      <p className="v5-discount-help">{DISCOUNT_COPY.previewNote}</p>
    </div>
  );
}

function ReasonChoice(
  props: Readonly<{ draft: DiscountDraft; onChange: (draft: DiscountDraft) => void }>,
): JSX.Element {
  const name = useId();
  return (
    <fieldset className="v5-discount-fieldset v5-discount-reasons">
      <legend>
        {DISCOUNT_COPY.reasonLegend}{' '}
        <span className="v5-discount-required">{DISCOUNT_COPY.required}</span>
      </legend>
      {DISCOUNT_REASONS.map(([code, label]) => (
        <Choice
          key={code}
          name={name}
          label={label}
          checked={props.draft.reason === code}
          onSelect={() => {
            props.onChange({ ...props.draft, reason: code });
          }}
        />
      ))}
      {props.draft.reason === null && (
        <p className="v5-discount-help">{DISCOUNT_COPY.reasonMissing}</p>
      )}
    </fieldset>
  );
}

/**
 * RT-855 (D1 Sheet*) — the «خصم» sheet for one line: kind, value, the reason
 * (required on both paths, OD-28-9) and a live preview from the shared math.
 * The commit stays disabled until the value is one main accepts and a reason
 * is chosen. Focus opens on the value field; Esc cancels.
 */
export function DiscountSheet(props: Readonly<Props>): JSX.Element {
  const titleId = useId();
  const valueRef = useRef<HTMLInputElement>(null);
  const ready = props.entry.kind === 'ok' && props.draft.reason !== null && !props.busy;
  const { line } = props;
  // A refusal that belongs to the value field is drawn there; any other one above the actions.
  const valueError = props.error === DISCOUNT_COPY.overGross ? props.error : null;
  const otherError = valueError === null ? props.error : null;
  return (
    <Dialog
      label={DISCOUNT_COPY.sheetTitle}
      onCancel={dismissUnlessBusy(props.busy, props.onCancel)}
      initialFocusRef={valueRef}
      describedBy={titleId}
    >
      <div className="v5-discount-sheet">
        <div className="v5-discount-sheet-head">
          <h2 className="v5-live-dialog-title">{DISCOUNT_COPY.sheetTitle}</h2>
          <p className="v5-discount-sheet-line" id={titleId}>
            <strong>{line.displayName}</strong>
            <bdi dir="ltr">{`${String(line.quantity)} × ${formatHumanMoney(line.unitPriceMinor)}`}</bdi>
          </p>
          {props.needsApproval && <p className="v5-discount-help">{DISCOUNT_COPY.cashierHint}</p>}
        </div>
        <div className="v5-discount-sheet-body">
          <div className="v5-discount-column">
            <KindChoice draft={props.draft} onChange={props.onChange} />
            <ValueField
              line={line}
              draft={props.draft}
              entry={props.entry}
              error={valueError}
              inputRef={valueRef}
              onChange={props.onChange}
            />
            <Preview line={line} entry={props.entry} />
          </div>
          <div className="v5-discount-column">
            <ReasonChoice draft={props.draft} onChange={props.onChange} />
          </div>
        </div>
      </div>
      <div className="v5-discount-slot">
        {otherError !== null && <Notice tone="danger">{otherError}</Notice>}
      </div>
      <div className="v5-discount-actions">
        <button
          type="button"
          className="v5-live-btn v5-btn"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          {DISCOUNT_COPY.cancel}
        </button>
        <button
          type="button"
          className="v5-live-btn v5-live-btn--primary v5-btn v5-btn--primary"
          disabled={!ready}
          onClick={props.onSubmit}
        >
          {props.needsApproval ? DISCOUNT_COPY.requestApproval : DISCOUNT_COPY.apply}
        </button>
      </div>
    </Dialog>
  );
}
