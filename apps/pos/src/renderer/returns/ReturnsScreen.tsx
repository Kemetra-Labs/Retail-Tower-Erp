import type { JSX } from 'react';

import type { ReturnJournalView, ReturnsBridgeAPI } from '../../shared/returns/types.js';
import type { RecentSalesBridge } from '../sale-lookup/recent-sales-bridge';
import type { SessionEvents } from './returns-bridge.js';
import { LinePicker } from './LinePicker';
import { RefundSummary } from './RefundSummary';
import { ReturnOutcome, type PayoutDeps } from './ReturnOutcome';
import { ReturnsHistory } from './ReturnsHistory';
import { SaleLookup } from './SaleLookup';
import type { Outcome } from './return-flow-state.js';
import { useReturnFlow, type ReturnFlow } from './useReturnFlow.js';
import { useHistoryReprint } from './useHistoryReprint.js';
import { useReturnHistory } from './useReturnHistory.js';

/**
 * RT-15 S3 — the return flow (one step at a time) above this terminal's
 * return journal. RT-15 S4: a confirmed outcome carries its payout; the
 * journal offers pay out / complete / reprint per row.
 */
export interface ReturnsScreenProps {
  readonly bridge: ReturnsBridgeAPI;
  /** Unlock re-reads the journal (H4); null when no push is available. */
  readonly sessionEvents: SessionEvents | null;
  /** RT-1192: today's sales for the lookup step; null hides the list and the short number. */
  readonly sales: RecentSalesBridge | null;
}

function outcomeKey(outcome: Outcome): string {
  if (outcome.kind === 'failed') return 'failed';
  return outcome.ret?.returnId ?? 'none';
}

/** The last listed view of `returnId` (kept across a failed or refused reload). */
function latestIn(rows: readonly ReturnJournalView[], returnId: string): ReturnJournalView | null {
  return rows.find((row) => row.returnId === returnId) ?? null;
}

function FlowStep({
  flow,
  payout,
  sales,
}: {
  readonly flow: ReturnFlow;
  readonly payout: PayoutDeps;
  readonly sales: RecentSalesBridge | null;
}): JSX.Element {
  const { state } = flow;
  switch (state.step) {
    case 'lookup':
      return <SaleLookup flow={flow} notice={state.notice} recent={sales} />;
    case 'select':
      return <LinePicker flow={flow} state={state} />;
    case 'summary':
      return <RefundSummary flow={flow} state={state} />;
    case 'outcome':
      // Keyed by the return: opening another return's payout starts afresh.
      return (
        <ReturnOutcome
          key={outcomeKey(state.outcome)}
          flow={flow}
          outcome={state.outcome}
          payout={payout}
        />
      );
  }
}

export function ReturnsScreen({ bridge, sessionEvents, sales }: ReturnsScreenProps): JSX.Element {
  const history = useReturnHistory(bridge, sessionEvents);
  const flow = useReturnFlow(bridge, history.reload);
  const reprint = useHistoryReprint(bridge);
  return (
    <>
      <FlowStep
        flow={flow}
        sales={sales}
        payout={{
          bridge,
          reload: history.reload,
          latest: (returnId) => latestIn(history.known, returnId),
        }}
      />
      <ReturnsHistory history={history} actions={{ pay: flow.openPayout, reprint }} />
    </>
  );
}
