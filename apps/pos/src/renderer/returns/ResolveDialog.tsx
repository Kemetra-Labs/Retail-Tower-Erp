import { useMemo, type JSX } from 'react';

import type { ManagerApprovalBridgeAPI } from '../../shared/operator/manager-approval.js';
import type {
  ReturnJournalView,
  ReturnsCloseResponse,
  ReturnsEscalateResponse,
} from '../../shared/returns/types.js';
import { ManagerPinDialog, useApprovalSubmit } from '../v5/void/ManagerPinDialog';
import { attempt } from './returns-bridge.js';
import { OUTCOME_COPY, refusalMessage } from './returns-messages.js';

/**
 * RT-1498 S4/S5 and the close slice — the manager-PIN sheet that resolves ONE unresolved return: hand it
 * to support (`escalate`) or close it as "not recorded" (`close`). Both are confirmed with ANOTHER
 * manager's PIN (RT-114: a single-use approval of kind `return.resolve_unknown`, spent by main in the same
 * transaction as the disposition). The approval is bound to THIS return and to the chosen disposition:
 * its subject ref is `<returnId>_<disposition>` and its reason code `<disposition>_unknown` (main builds
 * the same ref and refuses any other, so an approval for one cannot do the other). A refused approval
 * never reaches main's call; the journal is re-read after any answer main gave, including a lost one.
 */
type ResolveAnswer = ReturnsEscalateResponse | ReturnsCloseResponse;

interface Props {
  readonly row: ReturnJournalView;
  readonly approval: ManagerApprovalBridgeAPI;
  readonly disposition: 'close' | 'escalate';
  readonly copy: {
    readonly title: string;
    readonly body: string;
    readonly approve: string;
  };
  /** The message of a refused approval, in this disposition's own words. */
  readonly approvalRefusal: (reason: string) => string;
  /** Spend the granted approval in main (`returns.escalate` / `returns.close`). */
  readonly call: (approvalId: string) => Promise<ResolveAnswer>;
  readonly onDismiss: () => void;
  /** Main answered, whatever it said: the journal is the truth, so re-read it. */
  readonly onAnswered: () => void;
  /** Main recorded the disposition for this row. */
  readonly onDone: (row: ReturnJournalView) => void;
}

export function ResolveDialog({
  row,
  approval,
  disposition,
  copy,
  approvalRefusal,
  call,
  onDismiss,
  onAnswered,
  onDone,
}: Readonly<Props>): JSX.Element {
  // One stable object: the manager list is read once per sheet, not once per render.
  const bridges = useMemo(() => ({ approval }), [approval]);
  const { busy, error, submit } = useApprovalSubmit({
    bridges,
    kind: 'return.resolve_unknown',
    subjectRef: `${row.returnId}_${disposition}`,
    reasonCode: `${disposition}_unknown`,
    approvalRefusal,
    spend: async (approvalId) => {
      const answer = await attempt(() => call(approvalId));
      // The journal is the truth after any answer, including a lost one.
      onAnswered();
      if (typeof answer === 'symbol') return OUTCOME_COPY.callFailed;
      if (answer.kind === 'refused') return refusalMessage(answer.reason);
      onDone(row);
      return null;
    },
  });
  return (
    <ManagerPinDialog
      bridges={bridges}
      actionKind="return.resolve_unknown"
      title={copy.title}
      body={copy.body}
      approveLabel={copy.approve}
      code={row.saleNumber}
      amountMinor={row.quotedTotalMinor}
      busy={busy}
      error={error}
      onDismiss={onDismiss}
      onSubmit={submit}
    />
  );
}
