import { useMemo, type JSX } from 'react';

import type { ManagerApprovalBridgeAPI } from '../../shared/operator/manager-approval.js';
import type { ReturnJournalView, ReturnsBridgeAPI } from '../../shared/returns/types.js';
import { ManagerPinDialog, useApprovalSubmit } from '../v5/void/ManagerPinDialog';
import { attempt } from './returns-bridge.js';
import {
  ESCALATE_COPY,
  OUTCOME_COPY,
  escalateApprovalMessage,
  refusalMessage,
} from './returns-messages.js';

/**
 * RT-1498 S4/S5 (PROPOSED copy) — hand one unresolved return to support, confirmed with ANOTHER
 * manager's PIN (RT-114: a single-use approval of kind `return.resolve_unknown`, spent by main in the
 * same transaction as the disposition). The approval is bound to THIS return and to the disposition
 * `escalate`: its subject ref is `<returnId>_escalate` (main builds the same ref and refuses any other).
 * A refused approval never reaches `escalate`; the journal is re-read after any answer main gave.
 */
interface Props {
  readonly row: ReturnJournalView;
  readonly bridge: ReturnsBridgeAPI;
  readonly approval: ManagerApprovalBridgeAPI;
  readonly onDismiss: () => void;
  /** Main answered, whatever it said: the journal is the truth, so re-read it. */
  readonly onAnswered: () => void;
  /** Main recorded the disposition for this row. */
  readonly onEscalated: (row: ReturnJournalView) => void;
}

export function EscalateDialog({
  row,
  bridge,
  approval,
  onDismiss,
  onAnswered,
  onEscalated,
}: Readonly<Props>): JSX.Element {
  // One stable object: the manager list is read once per sheet, not once per render.
  const bridges = useMemo(() => ({ approval }), [approval]);
  const { busy, error, submit } = useApprovalSubmit({
    bridges,
    kind: 'return.resolve_unknown',
    subjectRef: `${row.returnId}_escalate`,
    reasonCode: 'escalate_unknown',
    approvalRefusal: escalateApprovalMessage,
    spend: async (approvalId) => {
      const answer = await attempt(() => bridge.escalate({ returnId: row.returnId, approvalId }));
      // The journal is the truth after any answer, including a lost one.
      onAnswered();
      if (typeof answer === 'symbol') return OUTCOME_COPY.callFailed;
      if (answer.kind === 'escalated') {
        onEscalated(row);
        return null;
      }
      return refusalMessage(answer.reason);
    },
  });
  return (
    <ManagerPinDialog
      bridges={bridges}
      actionKind="return.resolve_unknown"
      title={ESCALATE_COPY.title}
      body={ESCALATE_COPY.body}
      approveLabel={ESCALATE_COPY.approve}
      code={row.saleNumber}
      amountMinor={row.quotedTotalMinor}
      busy={busy}
      error={error}
      onDismiss={onDismiss}
      onSubmit={submit}
    />
  );
}
