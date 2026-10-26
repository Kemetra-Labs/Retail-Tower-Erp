import { useEffect, useId, useRef, useState, type JSX } from 'react';

import type { ManualDiscountReasonCode } from '../../../../shared/cart/manual-discount';
import type {
  ManagerApprovalBridgeAPI,
  ManagerApprover,
} from '../../../../shared/operator/manager-approval';
import { MANAGER_PIN_PATTERN } from '../../../../shared/shift-cashup/types';
import { normalizeDigits } from '../../../ui/forms/normalize-digits';
import { Dialog } from '../../foundation/Dialog';
import { Notice } from '../../foundation/Notice';
import { dismissUnlessBusy } from '../../shift/shift-bridge';
import { DISCOUNT_COPY, reasonLabel } from './discount-copy';
import type { DiscountLine } from './DiscountSheet';
import { DiscountAmount, DiscountKindLabel } from './DiscountParts';

type Approvers =
  | { kind: 'loading' }
  | { kind: 'ready'; approvers: readonly ManagerApprover[] }
  | { kind: 'refused' };

/** The managers enrolled on this terminal who may approve a manual discount. */
function useDiscountApprovers(bridge: ManagerApprovalBridgeAPI | null): Approvers {
  const [state, setState] = useState<Approvers>(() =>
    bridge === null ? { kind: 'refused' } : { kind: 'loading' },
  );
  useEffect(() => {
    if (bridge === null) return;
    let live = true;
    bridge.listApprovers({ action_kind: 'cart.discount.manual' }).then(
      (answer) => {
        if (live) {
          setState(
            answer.kind === 'approvers'
              ? { kind: 'ready', approvers: answer.approvers }
              : { kind: 'refused' },
          );
        }
      },
      () => {
        if (live) setState({ kind: 'refused' });
      },
    );
    return () => {
      live = false;
    };
  }, [bridge]);
  return state;
}

function ManagerChoice(
  props: Readonly<{
    approvers: Approvers;
    selected: string | null;
    onSelect: (ref: string) => void;
  }>,
): JSX.Element {
  const name = useId();
  const { approvers } = props;
  if (approvers.kind === 'loading') {
    return <output className="v5-discount-help">{DISCOUNT_COPY.loadingManagers}</output>;
  }
  if (approvers.kind === 'refused')
    return <Notice tone="danger">{DISCOUNT_COPY.unavailable}</Notice>;
  if (approvers.approvers.length === 0) {
    return <p className="v5-discount-help">{DISCOUNT_COPY.noManagers}</p>;
  }
  return (
    <fieldset className="v5-discount-fieldset">
      <legend>{DISCOUNT_COPY.managerLegend}</legend>
      {approvers.approvers.map((manager) => (
        <label key={manager.approver_ref} className="v5-discount-choice">
          <input
            type="radio"
            name={name}
            checked={props.selected === manager.approver_ref}
            onChange={() => {
              props.onSelect(manager.approver_ref);
            }}
          />
          <bdi>{manager.display_name}</bdi>
        </label>
      ))}
    </fieldset>
  );
}

/** What the manager approves: the line, the discount and the reason (§3.1, §4.1). */
function ApprovalSummary(
  props: Readonly<{
    line: DiscountLine;
    token: string;
    amountMinor: number;
    reason: ManualDiscountReasonCode;
  }>,
): JSX.Element {
  return (
    <dl className="v5-discount-summary">
      <div>
        <dt>{DISCOUNT_COPY.summaryItem}</dt>
        <dd>{props.line.displayName}</dd>
      </div>
      <div>
        <dt>{DISCOUNT_COPY.summaryDiscount}</dt>
        <dd>
          <DiscountKindLabel token={props.token} /> · <DiscountAmount minor={props.amountMinor} />
        </dd>
      </div>
      <div>
        <dt>{DISCOUNT_COPY.summaryReason}</dt>
        <dd>{reasonLabel(props.reason)}</dd>
      </div>
    </dl>
  );
}

/** A refusal shown in the prompt; `stale` (approval_stale) turns the commit into «رجوع إلى الخصم». */
export interface ApprovalError {
  readonly message: string;
  readonly stale: boolean;
}

export interface DiscountApprovalProps {
  readonly line: DiscountLine;
  readonly token: string;
  readonly amountMinor: number;
  readonly reason: ManualDiscountReasonCode;
  readonly bridge: ManagerApprovalBridgeAPI | null;
  readonly busy: boolean;
  readonly error: ApprovalError | null;
  readonly onCancel: () => void;
  /** Back to the sheet to review the discount (D1 ApprovalStale). */
  readonly onBack: () => void;
  readonly onApprove: (approver: ManagerApprover, pin: string) => void;
}

/**
 * RT-855 (D1 Approval*) — the cashier's path on the RT-114 Manager Approval
 * PIN, drawn as G2-CloseApproval: the manager picks their name (an opaque
 * handle) and types their PIN, which is cleared on every press and never
 * stored. A summary names what is being approved. A refused approval clears
 * the PIN and keeps the dialog; a stale one sends the cashier back to the sheet.
 * Focus opens on «إلغاء», the safe control.
 */
export function DiscountApprovalDialog(props: Readonly<DiscountApprovalProps>): JSX.Element {
  const pinId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const approvers = useDiscountApprovers(props.bridge);
  const [selected, setSelected] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const approver =
    approvers.kind === 'ready'
      ? (approvers.approvers.find((a) => a.approver_ref === selected) ?? null)
      : null;
  const stale = props.error?.stale === true;
  const ready = approver !== null && MANAGER_PIN_PATTERN.test(normalizeDigits(pin)) && !props.busy;

  // RT-656 OD-4: a refused PIN is cleared, so the next try starts in the PIN field.
  // A stale approval cannot be retried here: focus goes to «رجوع إلى الخصم».
  useEffect(() => {
    if (props.error === null || props.busy) return;
    (props.error.stale ? backRef : pinRef).current?.focus();
  }, [props.error, props.busy]);

  const press = (): void => {
    if (approver === null) return;
    const managerPin = normalizeDigits(pin);
    setPin('');
    props.onApprove(approver, managerPin);
  };

  return (
    <Dialog
      label={DISCOUNT_COPY.approvalTitle}
      onCancel={dismissUnlessBusy(props.busy, props.onCancel)}
      initialFocusRef={cancelRef}
    >
      <h2 className="v5-live-dialog-title">{DISCOUNT_COPY.approvalTitle}</h2>
      <p className="v5-discount-help">{DISCOUNT_COPY.approvalBody}</p>
      <ApprovalSummary
        line={props.line}
        token={props.token}
        amountMinor={props.amountMinor}
        reason={props.reason}
      />
      <div className="v5-discount-approval-form">
        <ManagerChoice approvers={approvers} selected={selected} onSelect={setSelected} />
        <div className="v5-discount-field">
          <label htmlFor={pinId}>{DISCOUNT_COPY.pinLabel}</label>
          <input
            ref={pinRef}
            id={pinId}
            className="v5-discount-input v5-discount-pin"
            dir="ltr"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={pin}
            onChange={(event) => {
              setPin(event.target.value);
            }}
          />
        </div>
      </div>
      <div className="v5-discount-slot">
        {props.error !== null && <Notice tone="danger">{props.error.message}</Notice>}
      </div>
      <div className="v5-discount-actions">
        <button
          ref={cancelRef}
          type="button"
          className="v5-live-btn v5-btn"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          {DISCOUNT_COPY.cancel}
        </button>
        {stale ? (
          <button
            ref={backRef}
            type="button"
            className="v5-live-btn v5-live-btn--primary v5-btn v5-btn--primary"
            onClick={props.onBack}
          >
            {DISCOUNT_COPY.backToSheet}
          </button>
        ) : (
          <button
            type="button"
            className="v5-live-btn v5-live-btn--primary v5-btn v5-btn--primary"
            disabled={!ready}
            onClick={press}
          >
            {DISCOUNT_COPY.approve}
          </button>
        )}
      </div>
    </Dialog>
  );
}
