import { useState, type JSX } from 'react';

import type { CartDiscountPlaceholdersAddResponse } from '../../../../shared/cart/bridge-types';
import { discountApprovalSubjectRef } from '../../../../shared/cart/discount-approval';
import type {
  ManagerApprovalBridgeAPI,
  ManagerApprover,
} from '../../../../shared/operator/manager-approval';
import type { DiscountAddInput } from '../../../sale/useSaleCartController';
import { focusScanOwner } from '../../../scan/scan-anchor';
import { useSingleFlight } from '../../shift/shift-bridge';
import {
  addRefusalCopy,
  approvalRefusalCopy,
  DISCOUNT_COPY,
  type DiscountRefusalCopy,
} from './discount-copy';
import { readDiscountEntry, type DiscountEntry } from './discount-math';
import { DiscountApprovalDialog, type ApprovalError } from './DiscountApprovalDialog';
import { DiscountSheet, EMPTY_DRAFT, type DiscountDraft, type DiscountLine } from './DiscountSheet';
import './discount.css';

type AddResult = CartDiscountPlaceholdersAddResponse | null;

export interface DiscountControlProps {
  /** The selected line (OD-1: the last added, or the row that had focus); null for none. */
  readonly line: DiscountLine | null;
  /** The cart takes a discount on that line now (editable, and the line has none: OD-5). */
  readonly enabled: boolean;
  /** A cashier asks a manager (RT-114); a manager or admin applies directly (D2). */
  readonly needsApproval: boolean;
  /** The manager's own name, shown on the line as the approver on the direct path. */
  readonly selfName: string;
  readonly cartId: string | null;
  readonly approvalBridge: ManagerApprovalBridgeAPI | null;
  readonly onAdd: (input: DiscountAddInput) => Promise<AddResult>;
  /** A refusal that ends the flow; the Sale shows it beside the total. */
  readonly onCartRefusal: (message: string) => void;
}

type OpenStep =
  | { readonly kind: 'sheet'; readonly line: DiscountLine; readonly error: string | null }
  | {
      readonly kind: 'approval';
      readonly line: DiscountLine;
      readonly error: ApprovalError | null;
    };

type Step = { readonly kind: 'closed' } | OpenStep;

const CLOSED: Step = { kind: 'closed' };

/** The draft as a value main accepts, with its chosen reason; null otherwise. */
function readyEntry(draft: DiscountDraft, entry: DiscountEntry) {
  return entry.kind === 'ok' && draft.reason !== null ? { entry, reason: draft.reason } : null;
}

function approvalError(copy: DiscountRefusalCopy): ApprovalError {
  return { message: copy.message, stale: copy.place === 'stale' };
}

/**
 * RT-855 (RT-699 I2; doc 28 §4; D1 OD-1) — the «خصم» control in the cart
 * header and the flows behind it, for every role (FR-023 / D2):
 *
 * - the sheet (kind, value, reason, preview) for the selected line;
 * - cashier: «طلب موافقة المدير» opens the RT-114 prompt; main issues an
 *   approval bound to this cart, line and token, and the add carries only its
 *   `approval_id`;
 * - manager or admin: «تطبيق الخصم» adds directly with the reason code.
 *
 * Main is the authority on every refusal; each one is shown where D1 draws it.
 */
export function DiscountControl(props: Readonly<DiscountControlProps>): JSX.Element {
  const [step, setStep] = useState<Step>(CLOSED);
  const [draft, setDraft] = useState<DiscountDraft>(EMPTY_DRAFT);
  const flight = useSingleFlight();
  return (
    <>
      <button
        type="button"
        className="v5-btn v5-discount-open"
        // Stays enabled behind its own dialog, so the dialog can hand focus back to it.
        disabled={step.kind === 'closed' && (!props.enabled || props.line === null)}
        onClick={() => {
          if (step.kind === 'closed' && props.line !== null) {
            setStep({ kind: 'sheet', line: props.line, error: null });
          }
        }}
      >
        <span className="v5-discount-glyph" dir="ltr" aria-hidden="true">
          %
        </span>
        {DISCOUNT_COPY.open}
      </button>
      {step.kind !== 'closed' && (
        <DiscountFlow
          {...props}
          step={step}
          draft={draft}
          flight={flight}
          setStep={setStep}
          setDraft={setDraft}
        />
      )}
    </>
  );
}

interface FlowProps extends DiscountControlProps {
  readonly step: OpenStep;
  readonly draft: DiscountDraft;
  readonly flight: ReturnType<typeof useSingleFlight>;
  readonly setStep: (step: Step) => void;
  readonly setDraft: (draft: DiscountDraft) => void;
}

/** The open sheet or approval prompt, and the bridge calls behind them. */
function DiscountFlow(props: Readonly<FlowProps>): JSX.Element {
  const { step, draft, setStep, flight } = props;
  const { line } = step;
  const entry = readDiscountEntry(draft.kind, draft.raw, line.lineSubtotalMinor);
  const ready = readyEntry(draft, entry);

  const close = (): void => {
    setStep(CLOSED);
    props.setDraft(EMPTY_DRAFT);
  };
  const finish = (): void => {
    close();
    // 15 §3.1 rule 6: after a cart change the next scan is the next thing the cashier does.
    setTimeout(focusScanOwner, 0);
  };

  /** Route main's answer to the add to where D1 draws it. */
  const settle = (res: AddResult): void => {
    if (res?.kind === 'ok') {
      finish();
      return;
    }
    const copy: DiscountRefusalCopy =
      res === null
        ? { message: DISCOUNT_COPY.unavailable, place: step.kind }
        : addRefusalCopy(res.reason);
    if (copy.place === 'cart') {
      finish();
      props.onCartRefusal(copy.message);
    } else if (copy.place === 'sheet' || step.kind === 'sheet') {
      setStep({ kind: 'sheet', line, error: copy.message });
    } else {
      setStep({ kind: 'approval', line, error: approvalError(copy) });
    }
  };

  if (ready === null || step.kind === 'sheet') {
    return (
      <DiscountSheet
        line={line}
        needsApproval={props.needsApproval}
        draft={draft}
        entry={entry}
        busy={flight.busy}
        error={step.kind === 'sheet' ? step.error : null}
        onChange={(next) => {
          props.setDraft(next);
          if (step.kind === 'sheet' && step.error !== null) setStep({ ...step, error: null });
        }}
        onCancel={close}
        onSubmit={() => {
          if (ready === null) return;
          if (props.needsApproval) {
            setStep({ kind: 'approval', line, error: null });
            return;
          }
          // D2: the manager or admin is the approver; the reason code is required.
          flight.run(async () => {
            settle(
              await props.onAdd({
                lineId: line.lineId,
                token: ready.entry.token,
                reasonCode: ready.reason,
                approverName: props.selfName,
              }),
            );
          });
        }}
      />
    );
  }

  const approve = (approver: ManagerApprover, pin: string): void => {
    const bridge = props.approvalBridge;
    const cartId = props.cartId;
    if (bridge === null || cartId === null) return;
    setStep({ kind: 'approval', line, error: null });
    flight.run(async () => {
      try {
        const granted = await bridge.request({
          action_kind: 'cart.discount.manual',
          subject_ref: discountApprovalSubjectRef({
            cart_id: cartId,
            line_id: line.lineId,
            placeholder_kind: ready.entry.token,
          }),
          reason_code: ready.reason,
          approver_ref: approver.approver_ref,
          pin,
        });
        if (granted.kind !== 'approved') {
          const error = approvalError(approvalRefusalCopy(granted.reason));
          setStep({ kind: 'approval', line, error });
          return;
        }
        // §4.1 step 5: the add carries only the approval id; the approval binds value and reason.
        settle(
          await props.onAdd({
            lineId: line.lineId,
            token: ready.entry.token,
            reasonCode: ready.reason,
            approvalId: granted.approval_id,
            approverName: approver.display_name,
          }),
        );
      } catch {
        const error = { message: DISCOUNT_COPY.unavailable, stale: false };
        setStep({ kind: 'approval', line, error });
      }
    });
  };

  return (
    <DiscountApprovalDialog
      line={line}
      token={ready.entry.token}
      amountMinor={ready.entry.amountMinor}
      reason={ready.reason}
      bridge={props.approvalBridge}
      busy={flight.busy}
      error={step.error}
      onCancel={close}
      onBack={() => {
        setStep({ kind: 'sheet', line, error: null });
      }}
      onApprove={approve}
    />
  );
}
