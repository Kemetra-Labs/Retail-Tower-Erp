import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import type {
  SaleVoidJournalView,
  SaleVoidListResponse,
  SaleVoidSaleView,
  SaleVoidState,
} from '../../../shared/sale-void/types';
import { useRecentSales } from '../../sale-lookup/useRecentSales';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { Notice } from '../foundation/Notice';
import { ScreenSection } from '../foundation/ScreenSection';
import { Icon } from '../../icons/Icon';
import type { IconName } from '../../icons/registry';
import { useSingleFlight } from '../shift/shift-bridge';
import { VOID_COPY, voidRefusalMessage, voidStateLabel, voidWaitingMessage } from './void-copy';
import type { VoidBridges } from './void-bridges';
import { VoidActionDialog } from './VoidActionDialog';
import { VoidLookup, type Found } from './VoidLookup';
import { VoidAlert, VoidCode, VoidMoney, VoidPanel, VoidTime } from './void-parts';
import './void.css';

/**
 * RT-530 — «إلغاء بيع», `/app/void`: find a finalized sale of this terminal by
 * its receipt number, void it with another manager's PIN, and watch the queued
 * voids. A void waits (visibly) for its sale to sync and for the operator who
 * requested it to be signed in online; a refusal by Backend-Core stays on the
 * list, flagged, until someone acknowledges it. Nothing is ever dropped.
 *
 * RT-654 — composed on the G-6 vocabulary (frozen references VD-Void,
 * owner-approved OD-1…OD-8): the ScreenSection page header, the lookup and the
 * void journal as two panels, 44px V5 buttons, refusals as V5 notices. Arabic
 * (times, names) stays in the text face; only the sale number and amounts are
 * LTR tabular runs.
 */
export interface VoidScreenProps {
  readonly bridges: VoidBridges;
  /** How often the list re-reads while the screen is open (ms); 0 turns the refresh off. */
  readonly refreshMs?: number;
}

type Listed = { kind: 'loading' } | SaleVoidListResponse;

function useVoidList(
  bridges: VoidBridges,
  refreshMs: number,
): { listed: Listed; reload: () => void } {
  const [listed, setListed] = useState<Listed>({ kind: 'loading' });
  const ticket = useRef(0);
  const reload = useCallback(() => {
    ticket.current += 1;
    const mine = ticket.current;
    bridges.saleVoid.list().then(
      (answer) => {
        if (mine === ticket.current) setListed(answer);
      },
      () => {
        if (mine === ticket.current) setListed({ kind: 'refused', reason: 'void_unavailable' });
      },
    );
  }, [bridges]);
  useEffect(reload, [reload]);
  useEffect(() => {
    if (refreshMs <= 0) return;
    const timer = setInterval(reload, refreshMs);
    return () => {
      clearInterval(timer);
    };
  }, [reload, refreshMs]);
  return { listed, reload };
}

export function VoidScreen({ bridges, refreshMs = 10_000 }: VoidScreenProps): JSX.Element {
  const { listed, reload } = useVoidList(bridges, refreshMs);
  const [found, setFound] = useState<Found>({ kind: 'idle' });
  const [voiding, setVoiding] = useState<SaleVoidSaleView | null>(null);
  const [outcome, setOutcome] = useState<SaleVoidJournalView | null>(null);
  // The void button that opened the dialog is gone once the sale is cleared, so
  // the screen sends focus back to the sale number field after a request.
  const lookupRef = useRef<HTMLInputElement>(null);
  const [refocus, setRefocus] = useState(false);
  const role = useOperatorSessionStore((s) =>
    s.state.kind === 'signedIn' ? s.state.session.role : null,
  );
  // The list reads again after a void is requested; main scopes the rows (cashier: own sales).
  const recent = useRecentSales(bridges.sales ?? null, outcome?.void_id ?? null);
  useEffect(() => {
    if (!refocus) return;
    lookupRef.current?.focus();
    setRefocus(false);
  }, [refocus]);

  return (
    <ScreenSection title={VOID_COPY.title}>
      <div className="v5-void" dir="rtl" lang="ar">
        {outcome !== null && <RequestedNotice entry={outcome} />}
        <div className="v5-void-cols">
          <VoidLookup
            inputRef={lookupRef}
            bridges={bridges}
            found={found}
            recent={recent}
            scope={role === 'cashier' ? 'own' : 'terminal'}
            onFound={(next) => {
              setOutcome(null);
              setFound(next);
            }}
            onVoid={setVoiding}
          />
          <HistoryPanel listed={listed} bridges={bridges} onChanged={reload} />
        </div>
      </div>
      {voiding !== null && (
        <VoidActionDialog
          sale={voiding}
          bridges={bridges}
          onDismiss={() => {
            setVoiding(null);
          }}
          onRequested={(entry) => {
            setVoiding(null);
            setFound({ kind: 'idle' });
            setOutcome(entry);
            setRefocus(true);
            reload();
          }}
        />
      )}
    </ScreenSection>
  );
}

function RequestedNotice({ entry }: { entry: SaleVoidJournalView }): JSX.Element {
  return (
    <Notice tone="success" testId="void-requested">
      {VOID_COPY.requested}
      {entry.waiting_for !== null && (
        <> {voidWaitingMessage(entry.waiting_for, entry.requester_display_name)}</>
      )}
    </Notice>
  );
}

function HistoryPanel(props: {
  listed: Listed;
  bridges: VoidBridges;
  onChanged: () => void;
}): JSX.Element {
  return (
    <VoidPanel title={VOID_COPY.historyTitle}>
      <HistoryBody {...props} />
    </VoidPanel>
  );
}

function HistoryBody(props: {
  listed: Listed;
  bridges: VoidBridges;
  onChanged: () => void;
}): JSX.Element {
  const { listed } = props;
  if (listed.kind === 'loading')
    return (
      <div className="v5-void-panel-state">
        <output>{VOID_COPY.loading}</output>
      </div>
    );
  if (listed.kind === 'refused')
    return (
      <div className="v5-void-panel-state">
        <VoidAlert message={voidRefusalMessage(listed.reason)} />
      </div>
    );
  if (listed.voids.length === 0)
    return (
      <div className="v5-void-panel-state v5-void-neutral">
        <Notice tone="info">{VOID_COPY.noHistory}</Notice>
      </div>
    );
  return (
    // A scroll region with no control in it must still take focus (axe scrollable-region-focusable, OD-5).
    <ul className="v5-void-rows" tabIndex={0} aria-label={VOID_COPY.historyTitle}>
      {listed.voids.map((entry) => (
        <HistoryRow
          key={entry.void_id}
          entry={entry}
          bridges={props.bridges}
          onChanged={props.onChanged}
        />
      ))}
    </ul>
  );
}

/** Each state has its own tone and glyph, so it never rests on colour alone (OD-3). */
const STATE_LOOK: Readonly<
  Record<SaleVoidState, { tone: 'neutral' | 'success' | 'danger'; icon: IconName }>
> = {
  // The clock glyph (the same path as the manager-home shift card).
  pending: { tone: 'neutral', icon: 'shift' },
  unknown: { tone: 'neutral', icon: 'retry' },
  confirmed: { tone: 'success', icon: 'status.success' },
  refused: { tone: 'danger', icon: 'status.warning' },
};

function StatePill({ state }: { state: SaleVoidState }): JSX.Element {
  const look = STATE_LOOK[state];
  return (
    <span className="v5-void-state" data-tone={look.tone}>
      <Icon name={look.icon} size="sm" />
      {voidStateLabel(state)}
    </span>
  );
}

function HistoryRow(props: {
  entry: SaleVoidJournalView;
  bridges: VoidBridges;
  onChanged: () => void;
}): JSX.Element {
  const { entry } = props;
  const { busy, run } = useSingleFlight();
  const acknowledge = (): void => {
    run(async () => {
      try {
        await props.bridges.saleVoid.acknowledge({ void_id: entry.void_id });
      } finally {
        props.onChanged();
      }
    });
  };
  return (
    <li
      className="v5-void-row"
      data-state={entry.state}
      data-attention={entry.needs_attention ? 'true' : 'false'}
      data-testid="void-row"
    >
      <VoidCode value={entry.sale_number} className="v5-void-row__ref" />
      <VoidMoney minor={entry.total_minor} className="v5-void-row__amount" />
      <div className="v5-void-row__full">
        <StatePill state={entry.state} />
      </div>
      <p className="v5-void-row__full v5-void-row__meta">
        {VOID_COPY.requestedAt}: <VoidTime iso={entry.requested_at} />
      </p>
      {entry.waiting_for !== null && (
        <output className="v5-void-row__full v5-void-row__waiting">
          <Icon name="shift" size="sm" />
          <span>{voidWaitingMessage(entry.waiting_for, entry.requester_display_name)}</span>
        </output>
      )}
      {entry.refusal_reason !== null && (
        <div className="v5-void-row__full">
          <VoidAlert message={voidRefusalMessage(entry.refusal_reason)} />
        </div>
      )}
      {entry.needs_attention && (
        <div className="v5-void-row__full">
          <button
            type="button"
            className="v5-void-btn v5-btn"
            disabled={busy}
            onClick={acknowledge}
          >
            {VOID_COPY.acknowledge}
          </button>
        </div>
      )}
    </li>
  );
}
