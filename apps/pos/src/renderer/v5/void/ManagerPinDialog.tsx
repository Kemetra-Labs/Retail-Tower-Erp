import { useEffect, useId, useRef, useState, type JSX } from 'react';

import type { ManagerActionKind } from '../../../shared/operator/manager-action-kinds';
import type { ManagerApprover } from '../../../shared/operator/manager-approval';
import { MANAGER_PIN_PATTERN } from '../../../shared/shift-cashup/types';
import { Dialog } from '../foundation/Dialog';
import { dismissUnlessBusy, useSingleFlight } from '../shift/shift-bridge';
import { normalizeDigits } from '../shift/shift-format';
import { VOID_COPY, voidRefusalMessage } from './void-copy';
import type { ApprovalBridges } from './void-bridges';
import { ManagerChoice, useApprovers } from './void-approver';
import { VoidAlert, VoidCode, VoidMoney } from './void-parts';
import './void.css';

/**
 * The one flow both void dialogs share (the void itself, RT-530; the cash exception, RT-1403 S2):
 * ask main for a single-use approval bound to the subject with another manager's PIN, then spend it
 * through `spend`. A refused approval never reaches `spend`, and the PIN is cleared on the press
 * (never stored, never logged). `spend` answers an error message, or null when it succeeded.
 */
export function useApprovalSubmit(input: {
  bridges: ApprovalBridges;
  kind: ManagerActionKind;
  subjectRef: string;
  reasonCode: string;
  spend: (approvalId: string) => Promise<string | null>;
  /** The message of a refused approval; defaults to the void copy's. */
  approvalRefusal?: (reason: string) => string;
}): {
  busy: boolean;
  error: string | null;
  submit: (approver: ManagerApprover, pin: string) => void;
} {
  const { busy, run } = useSingleFlight();
  const [error, setError] = useState<string | null>(null);
  const submit = (approver: ManagerApprover, pin: string): void => {
    setError(null);
    run(async () => {
      try {
        const granted = await input.bridges.approval.request({
          action_kind: input.kind,
          subject_ref: input.subjectRef,
          reason_code: input.reasonCode,
          approver_ref: approver.approver_ref,
          pin,
        });
        if (granted.kind !== 'approved') {
          setError((input.approvalRefusal ?? voidRefusalMessage)(granted.reason));
          return;
        }
        setError(await input.spend(granted.approval_id));
      } catch {
        setError(VOID_COPY.unavailable);
      }
    });
  };
  return { busy, error, submit };
}

interface Props {
  readonly bridges: ApprovalBridges;
  readonly actionKind: ManagerActionKind;
  readonly title: string;
  readonly body: string;
  readonly approveLabel: string;
  /** The summary band: a sale or void number and an amount, two LTR runs. */
  readonly code: string;
  readonly amountMinor: number;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onDismiss: () => void;
  readonly onSubmit: (approver: ManagerApprover, pin: string) => void;
}

/**
 * RT-654 — on the V5 Dialog as drawn in VD-Void: the subject as a summary band, 44px manager lines,
 * the refusal in an always-mounted slot, and the danger commit (OD-2). The manager picks their name
 * from the terminal's enrolled managers (opaque handles) and types a masked PIN. Focus opens on
 * «رجوع», the safe control.
 */
export function ManagerPinDialog(props: Props): JSX.Element {
  const pinId = useId();
  const groupName = useId();
  const backRef = useRef<HTMLButtonElement>(null);
  const approvers = useApprovers(props.bridges, props.actionKind);
  const { busy, error } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const dismiss = dismissUnlessBusy(busy, props.onDismiss);
  const approver =
    approvers.kind === 'ready'
      ? (approvers.approvers.find((a) => a.approver_ref === selected) ?? null)
      : null;
  const ready = approver !== null && MANAGER_PIN_PATTERN.test(normalizeDigits(pin));

  // After a refusal the commit is disabled (empty PIN), so focus would fall out of
  // the dialog: it goes to «رجوع», as VD-Void DialogRefused draws it.
  useEffect(() => {
    if (!busy && error !== null) backRef.current?.focus();
  }, [busy, error]);

  const press = (): void => {
    if (approver === null) return;
    const managerPin = normalizeDigits(pin);
    setPin('');
    props.onSubmit(approver, managerPin);
  };

  return (
    <Dialog label={props.title} onCancel={dismiss} initialFocusRef={backRef}>
      <h2 className="v5-void-dialog-title">{props.title}</h2>
      <p className="v5-void-summary">
        <VoidCode value={props.code} />
        <VoidMoney minor={props.amountMinor} />
      </p>
      <p>{props.body}</p>
      <form
        className="v5-void-form"
        noValidate
        onSubmit={(event) => {
          // The commit is a press on the danger button only: Enter never sends.
          event.preventDefault();
        }}
      >
        <ManagerChoice
          approvers={approvers}
          name={groupName}
          selected={selected}
          onSelect={setSelected}
        />
        <div className="v5-void-field">
          <label htmlFor={pinId}>{VOID_COPY.pinLabel}</label>
          <input
            id={pinId}
            className="v5-void-input v5-void-input--pin"
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
        <div className="v5-void-slot">{error !== null && <VoidAlert message={error} />}</div>
        <div className="v5-void-dialog-actions">
          <button
            ref={backRef}
            type="button"
            className="v5-void-btn v5-btn"
            disabled={busy}
            onClick={dismiss}
          >
            {VOID_COPY.back}
          </button>
          <button
            type="button"
            className="v5-void-btn v5-void-btn--danger v5-btn v5-btn--danger"
            disabled={!ready || busy}
            onClick={press}
          >
            {props.approveLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
