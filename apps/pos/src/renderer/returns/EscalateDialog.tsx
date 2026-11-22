import type { JSX } from 'react';

import type { ManagerApprovalBridgeAPI } from '../../shared/operator/manager-approval.js';
import type { ReturnJournalView, ReturnsBridgeAPI } from '../../shared/returns/types.js';
import { ESCALATE_COPY, escalateApprovalMessage } from './returns-messages.js';
import { ResolveDialog } from './ResolveDialog';

/**
 * RT-1498 S4/S5 (PROPOSED copy) — hand one unresolved return to support, confirmed with ANOTHER
 * manager's PIN (disposition `escalate`: the approval's subject ref is `<returnId>_escalate`; main builds
 * the same ref and refuses any other). A refused approval never reaches `escalate`; the journal is re-read
 * after any answer main gave.
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
  return (
    <ResolveDialog
      row={row}
      approval={approval}
      disposition="escalate"
      copy={ESCALATE_COPY}
      approvalRefusal={escalateApprovalMessage}
      call={(approvalId) => bridge.escalate({ returnId: row.returnId, approvalId })}
      onDismiss={onDismiss}
      onAnswered={onAnswered}
      onDone={onEscalated}
    />
  );
}
