import type { JSX } from 'react';

import type { ReturnJournalView } from '../../shared/returns/types.js';
import { Notice } from '../v5/foundation/Notice';
import { ToneIcon } from '../v5/foundation/ToneIcon';
import type { IconName } from '../icons/registry';
import { ReturnNotice } from './ReturnNotice';
import { ReturnsPanel, StatePill } from './ReturnsPanel';
import { formatReturnMoney, formatReturnTime } from './returns-format.js';
import {
  DISPOSITION_COPY,
  ESCALATE_COPY,
  OUTCOME_COPY,
  PAYOUT_COPY,
  UNRESOLVED_COPY,
  refusalMessage,
  reprintMessage,
  stateLabel,
} from './returns-messages.js';
import type { HistoryEscalate } from './useHistoryEscalate.js';
import type { HistoryReprint } from './useHistoryReprint.js';
import type { HistoryResend } from './useHistoryResend.js';
import type { HistoryState, ReturnHistory } from './useReturnHistory.js';

/**
 * RT-15 S3 — this terminal's recent returns, straight from `returns.list`
 * (H1..H3). It is where the true state of an unconfirmed or session-changed
 * submit is read. "Check again" re-sends unresolved returns through main's
 * resolver (same request, same key; never a second return).
 *
 * RT-15 S4 (R5): each row offers the one payout action it allows: a
 * confirmed return "pay out", a started-but-unpaid payout "complete" (never a
 * fresh start), a paid-out return "print a copy" of its slip.
 *
 * RT-1498 S4/S5: an unresolved return the server never answered for can be handed to support
 * («تحويل إلى الدعم», another manager's PIN). A return with a recorded disposition reads as such
 * («بانتظار الدعم», «لم يُسجَّل — مغلق»): a closed one offers nothing, a needs-support one keeps only
 * its own «إعادة الإرسال» (the resolver and the bar no longer resend it).
 */
const HEADING_ID = 'v5-returns-history';

const UNRESOLVED: ReadonlySet<ReturnJournalView['state']> = new Set(['pending', 'unknown']);

/** RD-5: one glyph per state, so a state never rests on colour alone. */
const STATE_ICON: Readonly<Record<ReturnJournalView['state'], IconName>> = {
  pending: 'shift',
  confirmed: 'status.success',
  paid_out: 'cash',
  refused: 'status.danger',
  unknown: 'status.unknown',
};

function amountOf(row: ReturnJournalView): string {
  const minor = row.returnTotalMinor ?? row.quotedTotalMinor;
  return formatReturnMoney(minor, row.currencyCode);
}

/** RT-15 S4: what the journal can do with a row. */
export interface HistoryActions {
  /** Show a confirmed return's payout (start or complete). */
  readonly pay: (row: ReturnJournalView) => void;
  readonly reprint: HistoryReprint;
  /** RT-1498: send an unresolved (pending / unknown) return again. */
  readonly resend: HistoryResend;
  /** RT-1498: the bar's "check unresolved" is running (it holds the per-row resend). */
  readonly checking: boolean;
  /**
   * RT-1498 S4/S5: hand an unresolved return to support. Null when the terminal has no manager
   * approval bridge, so «تحويل إلى الدعم» is not offered at all.
   */
  readonly escalate: HistoryEscalate | null;
}

type RowAction = 'pay' | 'complete' | 'reprint' | 'resend' | 'escalate';

/** RT-1498 S4: a return the till closed as "not recorded" is out of the flow for good. */
function isClosed(row: ReturnJournalView): boolean {
  return row.disposition === 'closed';
}

/** RT-1498 S4/S5: unresolved and with no disposition: the resolver and the bar still act on it. */
function isOpenUnresolved(row: ReturnJournalView): boolean {
  return UNRESOLVED.has(row.state) && row.disposition === null;
}

/** The actions a row offers, in order. */
function rowActions(row: ReturnJournalView, actions: HistoryActions): readonly RowAction[] {
  if (UNRESOLVED.has(row.state)) {
    if (isClosed(row)) return [];
    // Handing a return to support needs a sent attempt to judge (a never-sent one is sent first).
    const support =
      actions.escalate !== null && row.disposition === null && row.lastAttemptAt !== null;
    return support ? ['resend', 'escalate'] : ['resend'];
  }
  if (row.state === 'paid_out') return ['reprint'];
  if (row.state !== 'confirmed') return [];
  return [row.payout === null ? 'pay' : 'complete'];
}

const ACTION_LABEL: Readonly<Record<RowAction, string>> = {
  pay: PAYOUT_COPY.historyPay,
  complete: PAYOUT_COPY.historyComplete,
  reprint: PAYOUT_COPY.historyReprint,
  resend: UNRESOLVED_COPY.resend,
  escalate: ESCALATE_COPY.action,
};

/** Is the row's action held by another one in flight (one call at a time)? */
function actionHeld(action: RowAction, actions: HistoryActions): boolean {
  if (action === 'reprint') return actions.reprint.printing !== null;
  if (action === 'resend' || action === 'escalate') {
    return actions.resend.sending !== null || actions.checking;
  }
  return false;
}

function RowActionButton({
  row,
  action,
  actions,
}: Readonly<{ row: ReturnJournalView; action: RowAction; actions: HistoryActions }>) {
  const { reprint, resend } = actions;
  const busy =
    (action === 'reprint' && reprint.printing === row.returnId) ||
    (action === 'resend' && resend.sending === row.returnId);
  const onClick = (): void => {
    if (action === 'reprint') void reprint.run(row.returnId);
    else if (action === 'resend') void resend.run(row.returnId, row.saleNumber);
    else if (action === 'escalate') actions.escalate?.open(row);
    else actions.pay(row);
  };
  return (
    <button
      type="button"
      className="v5-manager-btn v5-btn"
      aria-label={`${ACTION_LABEL[action]} ${row.saleNumber}`}
      disabled={actionHeld(action, actions)}
      aria-busy={busy}
      onClick={onClick}
    >
      {ACTION_LABEL[action]}
    </button>
  );
}

function RowActions({
  row,
  actions,
}: Readonly<{ row: ReturnJournalView; actions: HistoryActions }>): JSX.Element | null {
  const offered = rowActions(row, actions);
  if (offered.length === 0) return null;
  return (
    <div className="v5-returns-row-actions">
      {offered.map((action) => (
        <RowActionButton key={action} row={row} action={action} actions={actions} />
      ))}
    </div>
  );
}

/**
 * RT-1498: what the local audit proves about an unresolved return: how many
 * sends were attempted, when the last one was, and why it left the return
 * unknown (the closed cause code, with its wording). Never a body or a status
 * text. While unresolved, no cash is paid (a standing line).
 */
function UnresolvedDetail({ row }: Readonly<{ row: ReturnJournalView }>): JSX.Element | null {
  if (!UNRESOLVED.has(row.state)) return null;
  // RT-1498 S4: a closed return is no longer unresolved: it says so, and does not tell to wait.
  if (isClosed(row)) {
    return (
      <div className="v5-returns-state__detail">
        <span>{DISPOSITION_COPY.closedDetail}</span>
      </div>
    );
  }
  const cause = row.lastCause === null ? '' : UNRESOLVED_COPY.cause(row.lastCause);
  return (
    <div className="v5-returns-state__detail">
      {row.lastAttemptAt === null ? (
        <span>{UNRESOLVED_COPY.neverSent}</span>
      ) : (
        <>
          <span>{UNRESOLVED_COPY.attempts(row.attemptCount)}</span>
          <span>
            {UNRESOLVED_COPY.lastAttemptLabel}:{' '}
            <time dateTime={row.lastAttemptAt}>{formatReturnTime(row.lastAttemptAt)}</time>
          </span>
        </>
      )}
      {row.lastCause !== null && cause !== '' && (
        <span>
          {cause}{' '}
          <span className="v5-returns-state__code">
            {UNRESOLVED_COPY.codeLabel}: <bdi>{row.lastCause}</bdi>
          </span>
        </span>
      )}
      {row.disposition === 'needs_support' && <span>{DISPOSITION_COPY.supportDetail}</span>}
      <strong>{UNRESOLVED_COPY.doNotPay}</strong>
    </div>
  );
}

function Row({
  row,
  actions,
}: Readonly<{ row: ReturnJournalView; actions: HistoryActions }>): JSX.Element {
  return (
    <tr data-state={row.state}>
      <td>
        <bdi className="v5-manager-num v5-returns-code">{row.saleNumber}</bdi>
      </td>
      <td>
        <time dateTime={row.createdAt}>{formatReturnTime(row.createdAt)}</time>
      </td>
      <td>
        <StatePill state={row.state} icon={STATE_ICON[row.state]}>
          {row.disposition === null
            ? stateLabel(row.state)
            : DISPOSITION_COPY.label[row.disposition]}
        </StatePill>
        {row.refusalReason !== null && (
          <span className="v5-returns-state__reason">{refusalMessage(row.refusalReason)}</span>
        )}
        <UnresolvedDetail row={row} />
      </td>
      <td>
        <bdi className="v5-manager-num">{amountOf(row)}</bdi>
      </td>
      <td>
        <bdi className="v5-manager-num v5-returns-code">{row.returnRef ?? '—'}</bdi>
      </td>
      <td>
        <RowActions row={row} actions={actions} />
      </td>
    </tr>
  );
}

function Rows({
  rows,
  actions,
}: Readonly<{
  rows: readonly ReturnJournalView[];
  actions: HistoryActions;
}>): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="v5-notice" data-tone="neutral">
        <ToneIcon tone="info" />
        <p className="v5-notice__text">{OUTCOME_COPY.historyEmpty}</p>
      </div>
    );
  }
  return (
    <table className="v5-returns-table v5-returns-table--journal" aria-labelledby={HEADING_ID}>
      <thead>
        <tr>
          <th scope="col">رقم البيع</th>
          <th scope="col">الوقت</th>
          <th scope="col">الحالة</th>
          <th scope="col">المبلغ</th>
          <th scope="col">مرجع الخادم</th>
          <th scope="col">{PAYOUT_COPY.historyAction}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <Row key={row.returnId} row={row} actions={actions} />
        ))}
      </tbody>
    </table>
  );
}

/** H4: a list main did not give is never a dead end. */
function Reload({ history }: Readonly<{ history: ReturnHistory }>): JSX.Element | null {
  const { status } = history.state;
  if (status !== 'failed' && status !== 'refused') return null;
  return (
    <button type="button" className="v5-manager-btn v5-btn" onClick={() => void history.reload()}>
      إعادة تحميل السجل
    </button>
  );
}

function Body({
  state,
  actions,
}: Readonly<{ state: HistoryState; actions: HistoryActions }>): JSX.Element {
  switch (state.status) {
    case 'loading':
      return <p className="v5-returns-meta">جارٍ تحميل السجل…</p>;
    case 'ok':
      return <Rows rows={state.rows} actions={actions} />;
    case 'refused':
      return <ReturnNotice notice={{ kind: 'refused', reason: state.reason }} />;
    case 'failed':
      return <ReturnNotice notice={{ kind: 'failed' }} />;
  }
}

/** The bar re-sends what the resolver would: a return with a disposition is not part of it. */
function hasUnresolved(state: HistoryState): boolean {
  return state.status === 'ok' && state.rows.some(isOpenUnresolved);
}

/** The last journal reprint's result, announced politely. */
function ReprintNotice({ reprint }: Readonly<{ reprint: HistoryReprint }>): JSX.Element | null {
  if (reprint.result === null) return null;
  if (reprint.result.kind === 'printed') {
    return <output className="v5-returns-meta">{reprintMessage(reprint.result)}</output>;
  }
  return (
    <output className="v5-notice" data-tone="danger">
      <ToneIcon tone="danger" />
      <span className="v5-notice__text">{reprintMessage(reprint.result)}</span>
    </output>
  );
}

/** RT-1498: the last per-row resend's result; `success` only for a confirmation main reported. */
function ResendNotice({ resend }: Readonly<{ resend: HistoryResend }>): JSX.Element | null {
  if (resend.result === null) return null;
  const { saleNumber, tone, text } = resend.result;
  return (
    <Notice tone={tone}>
      <bdi className="v5-manager-num">{saleNumber}</bdi>: {text}
    </Notice>
  );
}

/** RT-1498 S4/S5: the last return main handed to support (only once main recorded it). */
function EscalateNotice({
  escalate,
}: Readonly<{ escalate: HistoryEscalate | null }>): JSX.Element | null {
  if (escalate === null || escalate.done === null) return null;
  return (
    // `info`, not `success`: the return is still unresolved and its sale still blocked.
    <Notice tone="info">
      <bdi className="v5-manager-num">{escalate.done.saleNumber}</bdi>: {ESCALATE_COPY.raised}
    </Notice>
  );
}

function hasNotice(history: ReturnHistory, actions: HistoryActions): boolean {
  return (
    history.checkNotice !== null ||
    actions.reprint.result !== null ||
    actions.resend.result !== null ||
    (actions.escalate?.done ?? null) !== null
  );
}

export function ReturnsHistory({
  history,
  actions,
}: Readonly<{
  history: ReturnHistory;
  actions: HistoryActions;
}>): JSX.Element {
  const { state } = history;
  const bar = hasUnresolved(state) ? (
    <button
      type="button"
      className="v5-manager-btn v5-btn"
      disabled={history.checking || actions.resend.sending !== null}
      aria-busy={history.checking}
      onClick={() => void history.checkUnresolved()}
    >
      تحقّق من غير المؤكدة
    </button>
  ) : null;
  return (
    <ReturnsPanel id={HEADING_ID} title="سجل المرتجعات على هذا الجهاز" bar={bar} journal>
      {hasNotice(history, actions) && (
        <div className="v5-manager-panel__body v5-returns-journal__notices">
          <ReturnNotice notice={history.checkNotice} />
          <ReprintNotice reprint={actions.reprint} />
          <ResendNotice resend={actions.resend} />
          <EscalateNotice escalate={actions.escalate} />
        </div>
      )}
      {state.status === 'ok' && state.rows.length > 0 ? (
        // RD-3: the journal reaches the foot of the screen and only its table scrolls.
        <div className="v5-returns-table-scroll">
          <Rows rows={state.rows} actions={actions} />
        </div>
      ) : (
        <div className="v5-manager-panel__body">
          <Body state={state} actions={actions} />
          <Reload history={history} />
        </div>
      )}
    </ReturnsPanel>
  );
}
