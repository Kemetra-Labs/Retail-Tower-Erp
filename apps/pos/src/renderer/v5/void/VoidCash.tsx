import { useState, type JSX } from 'react';

import type { SaleVoidJournalView, SaleVoidPayoutAction } from '../../../shared/sale-void/types';
import { useSingleFlight } from '../shift/shift-bridge';
import { VOID_COPY, voidMismatchMessage, voidRefusalMessage, voidStateLabel } from './void-copy';
import type { VoidBridges } from './void-bridges';
import { VoidAlert, VoidMoney, VoidTime } from './void-parts';
import './void.css';

interface CashProps {
  entry: SaleVoidJournalView;
  bridges: VoidBridges;
  /** A manager or admin pays out; a cashier never does (main refuses it too). */
  canPayOut: boolean;
  onChanged: () => void;
  onException: (entry: SaleVoidJournalView) => void;
}

/** The label of each payout step a manager may take. */
const STEP_LABEL: Readonly<Record<SaleVoidPayoutAction, string>> = {
  start: VOID_COPY.payOut,
  retry_drawer: VOID_COPY.retryDrawer,
  manual: VOID_COPY.manualComplete,
};

/**
 * Whether the manager-attested exception is offered: the cash is not paid, the gate cannot pay it
 * (or its claim is stuck), and the sale has no cash record yet. After the payout window it is the
 * late-payout path (owner decision, RT-1403: current open shift, another manager's PIN, once, flagged).
 */
function exceptionOffered(entry: SaleVoidJournalView): boolean {
  const { payout } = entry;
  if (entry.cash_minor === 0) return false;
  if (payout.state === 'claimed') return true;
  if (payout.state !== 'none' || payout.blocked_reason === 'payout_already_recorded') return false;
  return entry.state !== 'confirmed' || payout.blocked_reason !== null;
}

/** The refusal of a payout step, and (when the drawer was kicked first) the warning to hold the cash. */
function payoutRefusalMessage(reason: string, drawerMayBeOpen: boolean): string {
  const message = voidRefusalMessage(reason);
  return drawerMayBeOpen ? `${message} ${VOID_COPY.drawerMayBeOpen}` : message;
}

/** One payout step at a time, its refusal shown on the row, the list read again after it. */
function usePayoutStep(props: CashProps): {
  busy: boolean;
  error: string | null;
  step: (action: SaleVoidPayoutAction) => void;
} {
  const { busy, run } = useSingleFlight();
  const [error, setError] = useState<string | null>(null);
  const step = (action: SaleVoidPayoutAction): void => {
    setError(null);
    run(async () => {
      try {
        const answer = await props.bridges.saleVoid.payOut({
          void_id: props.entry.void_id,
          action,
        });
        if (answer.kind === 'refused') {
          setError(payoutRefusalMessage(answer.reason, answer.drawer_may_be_open === true));
        }
      } catch {
        setError(VOID_COPY.unavailable);
      } finally {
        props.onChanged();
      }
    });
  };
  return { busy, error, step };
}

function StepButton(props: {
  action: SaleVoidPayoutAction;
  busy: boolean;
  step: (action: SaleVoidPayoutAction) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="v5-void-btn v5-btn"
      disabled={props.busy}
      onClick={() => {
        props.step(props.action);
      }}
    >
      {STEP_LABEL[props.action]}
    </button>
  );
}

function ExceptionButton(props: CashProps & { busy: boolean }): JSX.Element | null {
  if (!exceptionOffered(props.entry)) return null;
  return (
    <button
      type="button"
      className="v5-void-btn v5-btn"
      disabled={props.busy}
      onClick={() => {
        props.onException(props.entry);
      }}
    >
      {VOID_COPY.exceptionAction}
    </button>
  );
}

/** The cash a payout or an exception recorded, and (L2) the flag with the void state next to it. */
function RecordedCash({ entry }: { entry: SaleVoidJournalView }): JSX.Element {
  const { payout } = entry;
  const label = payout.state === 'paid_out' ? VOID_COPY.paidOut : VOID_COPY.exceptionRecordedLabel;
  return (
    <div className="v5-void-row__full v5-void-row__cash" data-testid="void-cash">
      <span>
        {label}: <VoidMoney minor={entry.cash_minor} />
      </span>
      {payout.paid_at !== null && (
        <p className="v5-void-row__meta">
          {VOID_COPY.paidAt}: <VoidTime iso={payout.paid_at} />
        </p>
      )}
      {payout.mismatch_reason !== null && (
        <VoidAlert
          message={`${voidMismatchMessage(payout.mismatch_reason)} ${VOID_COPY.voidStateIs}: ${voidStateLabel(entry.state)}.`}
        />
      )}
    </div>
  );
}

/**
 * A payout that was claimed and has no record: the drawer may be open (RT-15's rule). A manager may
 * retry the drawer (only after a kick that never left) or complete it by hand; anyone may ask for the
 * manager-attested exception. A claim whose window closed (its shift is gone, or the day passed) says
 * so and offers only that exception (RT-1403 c18183).
 */
function ClaimedCash(props: CashProps): JSX.Element {
  const { entry } = props;
  const { busy, error, step } = usePayoutStep(props);
  return (
    <div className="v5-void-row__full v5-void-row__cash" data-testid="void-cash">
      <span>
        {VOID_COPY.claimed}: <VoidMoney minor={entry.cash_minor} />
      </span>
      <VoidAlert message={VOID_COPY.drawerMayBeOpen} />
      {entry.payout.claim_window_closed === true && (
        <VoidAlert message={VOID_COPY.claimWindowClosed} />
      )}
      {error !== null && <VoidAlert message={error} />}
      <div className="v5-void-row__actions">
        {props.canPayOut &&
          entry.payout.claim_actions.map((action) => (
            <StepButton key={action} action={action} busy={busy} step={step} />
          ))}
        <ExceptionButton {...props} busy={busy} />
      </div>
    </div>
  );
}

/** A confirmed void's cash not paid yet: the payout if the gate allows it, else why it does not. */
function DueCash(props: CashProps): JSX.Element {
  const { entry } = props;
  const { blocked_reason: blocked } = entry.payout;
  const { busy, error, step } = usePayoutStep(props);
  const due = entry.state === 'confirmed';
  return (
    <div className="v5-void-row__full v5-void-row__cash" data-testid="void-cash">
      {due && (
        <span>
          {VOID_COPY.cashDue}: <VoidMoney minor={entry.cash_minor} />
        </span>
      )}
      {due && blocked !== null && <VoidAlert message={voidRefusalMessage(blocked)} />}
      {due && blocked === null && !props.canPayOut && (
        <p className="v5-void-row__meta">{VOID_COPY.managerPays}</p>
      )}
      {error !== null && <VoidAlert message={error} />}
      <div className="v5-void-row__actions">
        {due && blocked === null && props.canPayOut && (
          <StepButton action="start" busy={busy} step={step} />
        )}
        <ExceptionButton {...props} busy={busy} />
      </div>
    </div>
  );
}

/**
 * RT-1403 S2 (PROPOSED copy) — the cash of one void. A request moves no cash: once the server
 * confirmed the void and the payout gate allows it, a manager's «صرف النقد» claims the payout and
 * opens the drawer. A claimed payout whose record is missing says the drawer may be open and offers
 * a retry or a manual completion; otherwise the row says why, and only a manager-attested exception
 * can record cash that left anyway (the late-payout path).
 */
export function VoidCash(props: CashProps): JSX.Element | null {
  const { state } = props.entry.payout;
  if (state === 'paid_out' || state === 'exception') return <RecordedCash entry={props.entry} />;
  if (state === 'claimed') return <ClaimedCash {...props} />;
  return props.entry.cash_minor === 0 ? null : <DueCash {...props} />;
}
