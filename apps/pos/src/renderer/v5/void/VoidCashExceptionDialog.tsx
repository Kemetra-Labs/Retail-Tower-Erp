import type { JSX } from 'react';

import type { SaleVoidJournalView } from '../../../shared/sale-void/types';
import { VOID_COPY, voidRefusalMessage } from './void-copy';
import type { VoidBridges } from './void-bridges';
import { ManagerPinDialog, useApprovalSubmit } from './ManagerPinDialog';

interface Props {
  readonly entry: SaleVoidJournalView;
  readonly bridges: VoidBridges;
  readonly onDismiss: () => void;
  /** The exception was recorded on the till. */
  readonly onRecorded: () => void;
}

/**
 * RT-1403 S2 (PROPOSED copy) — record cash that left the drawer outside the payout gate, confirmed
 * with ANOTHER manager's PIN (RT-114: a single-use approval bound to this void and its cash, spent by
 * the record in main). A refused approval never reaches the record. Its refusal names the four-eyes
 * rule for an exception, not the void's.
 */
export function VoidCashExceptionDialog(props: Props): JSX.Element {
  const { entry } = props;
  const { busy, error, submit } = useApprovalSubmit({
    bridges: props.bridges,
    kind: 'sale.void_cash_exception',
    subjectRef: entry.void_id,
    reasonCode: 'cash_exception',
    approvalRefusal: (reason) =>
      reason === 'approval_unavailable'
        ? VOID_COPY.exceptionApprovalUnavailable
        : voidRefusalMessage(reason),
    spend: async (approvalId) => {
      const answer = await props.bridges.saleVoid.recordCashException({
        void_id: entry.void_id,
        approval_id: approvalId,
      });
      if (answer.kind === 'exception_recorded') {
        props.onRecorded();
        return null;
      }
      return voidRefusalMessage(answer.reason);
    },
  });
  return (
    <ManagerPinDialog
      bridges={props.bridges}
      actionKind="sale.void_cash_exception"
      title={VOID_COPY.exceptionTitle}
      body={VOID_COPY.exceptionBody}
      approveLabel={VOID_COPY.exceptionApprove}
      code={entry.sale_number}
      amountMinor={entry.cash_minor}
      busy={busy}
      error={error}
      onDismiss={props.onDismiss}
      onSubmit={submit}
    />
  );
}
