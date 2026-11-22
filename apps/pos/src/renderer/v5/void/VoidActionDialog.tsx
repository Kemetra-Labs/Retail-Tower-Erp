import type { JSX } from 'react';

import type { SaleVoidJournalView, SaleVoidSaleView } from '../../../shared/sale-void/types';
import { VOID_COPY, voidRefusalMessage } from './void-copy';
import type { VoidBridges } from './void-bridges';
import { ManagerPinDialog, useApprovalSubmit } from './ManagerPinDialog';

interface Props {
  readonly sale: SaleVoidSaleView;
  readonly bridges: VoidBridges;
  readonly onDismiss: () => void;
  /** The void was journaled; the row says what it waits for. */
  readonly onRequested: (entry: SaleVoidJournalView) => void;
}

/**
 * RT-530 — void one finalized sale, confirmed with ANOTHER manager's PIN (RT-114: an approval bound
 * to this sale, its total and the requester, spent by the void request in main). A refused approval
 * never reaches the void request (`useApprovalSubmit`). RT-654 — on the V5 Dialog as drawn in
 * VD-Void (`ManagerPinDialog`): «تأكيد الإلغاء» is the danger commit (OD-2).
 */
export function VoidActionDialog(props: Props): JSX.Element {
  const { sale } = props;
  const { busy, error, submit } = useApprovalSubmit({
    bridges: props.bridges,
    kind: 'sale.void',
    subjectRef: sale.sale_id,
    reasonCode: 'sale_void',
    spend: async (approvalId) => {
      const answer = await props.bridges.saleVoid.request({
        sale_id: sale.sale_id,
        approval_id: approvalId,
      });
      if (answer.kind === 'requested') {
        props.onRequested(answer.void);
        return null;
      }
      return voidRefusalMessage(answer.reason);
    },
  });
  return (
    <ManagerPinDialog
      bridges={props.bridges}
      actionKind="sale.void"
      title={VOID_COPY.dialogTitle}
      body={VOID_COPY.dialogBody}
      approveLabel={VOID_COPY.approve}
      code={sale.sale_number}
      amountMinor={sale.total_minor}
      busy={busy}
      error={error}
      onDismiss={props.onDismiss}
      onSubmit={submit}
    />
  );
}
