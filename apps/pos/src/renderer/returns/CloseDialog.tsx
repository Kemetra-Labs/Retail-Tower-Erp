import type { JSX } from 'react';

import type { ManagerApprovalBridgeAPI } from '../../shared/operator/manager-approval.js';
import type { ReturnJournalView, ReturnsBridgeAPI } from '../../shared/returns/types.js';
import { CLOSE_COPY, closeApprovalMessage } from './returns-messages.js';
import { ResolveDialog } from './ResolveDialog';

/**
 * RT-1498 close slice (PROPOSED copy) — close one unresolved return as "not recorded", confirmed with
 * ANOTHER manager's PIN (disposition `close`: the approval's subject ref is `<returnId>_close`). It is
 * offered only after the server affirmed "not recorded" and the quiet period is over; main re-reads the
 * server and the clock and refuses on its own.
 */
interface Props {
  readonly row: ReturnJournalView;
  readonly bridge: ReturnsBridgeAPI;
  readonly approval: ManagerApprovalBridgeAPI;
  readonly onDismiss: () => void;
  /** Main answered, whatever it said: the journal is the truth, so re-read it. */
  readonly onAnswered: () => void;
  /** Main recorded the close for this row. */
  readonly onClosed: (row: ReturnJournalView) => void;
}

export function CloseDialog({
  row,
  bridge,
  approval,
  onDismiss,
  onAnswered,
  onClosed,
}: Readonly<Props>): JSX.Element {
  return (
    <ResolveDialog
      row={row}
      approval={approval}
      disposition="close"
      copy={CLOSE_COPY}
      approvalRefusal={closeApprovalMessage}
      call={(approvalId) => bridge.close({ returnId: row.returnId, approvalId })}
      onDismiss={onDismiss}
      onAnswered={onAnswered}
      onDone={onClosed}
    />
  );
}
