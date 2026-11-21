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
import {
  VOID_COPY,
  voidMismatchMessage,
  voidRefusalMessage,
  voidStateLabel,
  voidWaitingMessage,
} from './void-copy';
import type { VoidBridges } from './void-bridges';
import { VoidActionDialog } from './VoidActionDialog';
import { VoidCashExceptionDialog } from './VoidCashExceptionDialog';
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
  // RT-1403 S2: the void whose cash exception is being recorded, and that one just recorded.
  const [excepting, setExcepting] = useState<SaleVoidJournalView | null>(null);
  const [exceptionRecorded, setExceptionRecorded] = useState(false);
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
        {exceptionRecorded && (
          <Notice tone="success" testId="void-cash-exception-recorded">
            {VOID_COPY.exceptionRecorded}
          </Notice>
        )}
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
          <HistoryPanel
            listed={listed}
            bridges={bridges}
            onChanged={reload}
            onException={(entry) => {
              setExceptionRecorded(false);
              setExcepting(entry);
            }}
          />
        </div>
      </div>
      {excepting !== null && (
        <VoidCashExceptionDialog
          entry={excepting}
          bridges={bridges}
          onDismiss={() => {
            setExcepting(null);
          }}
          onRecorded={() => {
            setExcepting(null);
            setExceptionRecorded(true);
            reload();
          }}
        />
      )}
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

interface HistoryProps {
  listed: Listed;
  bridges: VoidBridges;
  onChanged: () => void;
  /** RT-1403 S2: open the cash exception dialog for this void. */
  onException: (entry: SaleVoidJournalView) => void;
}

function HistoryPanel(props: HistoryProps): JSX.Element {
  return (
    <VoidPanel title={VOID_COPY.historyTitle}>
      <HistoryBody {...props} />
    </VoidPanel>
  );
}

function HistoryBody(props: HistoryProps): JSX.Element {
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
          onException={props.onException}
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
  onException: (entry: SaleVoidJournalView) => void;
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
      <VoidCash
        entry={entry}
        bridges={props.bridges}
        onChanged={props.onChanged}
        onException={props.onException}
      />
    </li>
  );
}

/** Whether the manager-attested exception is offered: the cash is not paid, and the gate cannot pay it. */
function exceptionOffered(entry: SaleVoidJournalView): boolean {
  const { payout } = entry;
  if (payout.state !== 'none' || entry.cash_minor === 0) return false;
  if (payout.blocked_reason === 'payout_already_recorded') return false;
  return entry.state !== 'confirmed' || payout.blocked_reason !== null;
}

/**
 * RT-1403 S2 (PROPOSED copy) — the cash of one void. A request moves no cash: once the server
 * confirmed the void and the payout gate allows it, «صرف النقد» hands it out; otherwise the row says
 * why, and only a manager-attested exception can record cash that left anyway.
 */
function VoidCash(props: {
  entry: SaleVoidJournalView;
  bridges: VoidBridges;
  onChanged: () => void;
  onException: (entry: SaleVoidJournalView) => void;
}): JSX.Element | null {
  const { entry } = props;
  const { payout } = entry;
  const { busy, run } = useSingleFlight();
  const [error, setError] = useState<string | null>(null);
  const payOut = (): void => {
    setError(null);
    run(async () => {
      try {
        const answer = await props.bridges.saleVoid.payOut({ void_id: entry.void_id });
        if (answer.kind === 'refused') setError(voidRefusalMessage(answer.reason));
      } catch {
        setError(VOID_COPY.unavailable);
      } finally {
        props.onChanged();
      }
    });
  };
  if (payout.state !== 'none') {
    return (
      <div className="v5-void-row__full v5-void-row__cash" data-testid="void-cash">
        <span>
          {payout.state === 'paid_out' ? VOID_COPY.paidOut : VOID_COPY.exceptionRecordedLabel}:{' '}
          <VoidMoney minor={entry.cash_minor} />
        </span>
        {payout.paid_at !== null && (
          <p className="v5-void-row__meta">
            {VOID_COPY.paidAt}: <VoidTime iso={payout.paid_at} />
          </p>
        )}
        {payout.mismatch_reason !== null && (
          <VoidAlert message={voidMismatchMessage(payout.mismatch_reason)} />
        )}
      </div>
    );
  }
  if (entry.cash_minor === 0) return null;
  const due = entry.state === 'confirmed';
  const canPay = due && payout.blocked_reason === null;
  return (
    <div className="v5-void-row__full v5-void-row__cash" data-testid="void-cash">
      {due && (
        <span>
          {VOID_COPY.cashDue}: <VoidMoney minor={entry.cash_minor} />
        </span>
      )}
      {due && payout.blocked_reason !== null && (
        <VoidAlert message={voidRefusalMessage(payout.blocked_reason)} />
      )}
      {error !== null && <VoidAlert message={error} />}
      <div className="v5-void-row__actions">
        {canPay && (
          <button type="button" className="v5-void-btn v5-btn" disabled={busy} onClick={payOut}>
            {VOID_COPY.payOut}
          </button>
        )}
        {exceptionOffered(entry) && (
          <button
            type="button"
            className="v5-void-btn v5-btn"
            disabled={busy}
            onClick={() => {
              props.onException(entry);
            }}
          >
            {VOID_COPY.exceptionAction}
          </button>
        )}
      </div>
    </div>
  );
}
