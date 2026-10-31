import { useEffect, type JSX } from 'react';
import {
  mapTerminalStatus,
  printerRow,
  type IndicatorRow,
  type IndicatorTone,
} from '../../terminal-status/status-mapping';
import {
  connectTerminalStatus,
  terminalStatusBridge,
  useTerminalStatusStore,
} from '../../terminal-status/terminal-status-store';
import { useAttentionDeadline } from '../../terminal-status/use-attention-deadline';
import type { StatusRowName } from '../../terminal-status/status-copy';
import { useBannerState } from '../../ui/receipts/useBannerState';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { PrinterStatusRow } from '../printer/PrinterStatusRow';
import { StatusRowLabel } from './StatusRowLabel';
import { usePrinterChoiceSync } from '../printer/printer-store';
import { Icon } from '../../icons/Icon';
import type { IconName } from '../../icons/registry';
import './status-indicator.css';

/** Each tone has its own glyph shape, so a row is never told by colour alone. */
const MARK: Readonly<Record<IndicatorTone, IconName>> = {
  success: 'status.success',
  warning: 'status.warning',
  info: 'status.info',
  danger: 'status.danger',
  neutral: 'status.neutral',
};

function RowContent({
  name,
  row,
}: Readonly<{ name: StatusRowName; row: IndicatorRow }>): JSX.Element {
  return (
    <>
      <span className="v5-status__mark">
        <Icon name={MARK[row.tone]} size="sm" />
      </span>
      <StatusRowLabel name={name} />
      <span className="v5-status__text">
        {row.before}
        {row.count !== null && (
          <span className="v5-status__num" dir="ltr">
            {String(row.count)}
          </span>
        )}
        {row.after}
      </span>
    </>
  );
}

/**
 * RT-604 (VN-S6 S6-3, doc 24 §4.2) — the nav footer's status indicator
 * (DESIGN.md §Navigation): connection, sale sync, held discounted sales
 * (RT-887, neutral) and printer, each a glyph plus text. Fed by the
 * `terminalStatus` push; the printer row reads the existing `banner_state`
 * feed and, with no operator signed in, appears only while the last print
 * failed.
 *
 * RT-886 (RT-839 D4): for a signed-in operator (any role) the printer row is
 * always shown. It names the printer receipts go to and opens the «الطابعة»
 * panel; while the last print failed it still leads with «فشل آخر إيصال».
 *
 * Only the connection row is a polite live region, so a connection change is
 * announced and a count change is not. In the slim rail each row shows its glyph
 * over a one-word label (RT-1023); the full text stays in the accessibility tree.
 */
export function StatusIndicator(): JSX.Element {
  const snapshot = useTerminalStatusStore((s) => s.snapshot);
  useEffect(() => connectTerminalStatus(terminalStatusBridge()), []);
  useAttentionDeadline(snapshot);
  const printFailure = useBannerState();
  const sessionId = useOperatorSessionStore((s) =>
    s.state.kind === 'signedIn' ? s.state.session.id : undefined,
  );
  usePrinterChoiceSync(sessionId);

  const view = mapTerminalStatus(snapshot, Date.now());
  const printer = printerRow(printFailure !== null);

  return (
    <div className="v5-status" data-testid="v5-status-indicator">
      <p
        className="v5-status__row"
        data-row="connection"
        data-tone={view.connection.tone}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <RowContent name="connection" row={view.connection} />
      </p>
      {view.sync !== null && (
        <p className="v5-status__row" data-row="sync" data-tone={view.sync.tone}>
          <RowContent name="sync" row={view.sync} />
        </p>
      )}
      {view.held !== null && (
        <p className="v5-status__row" data-row="held" data-tone={view.held.tone}>
          <RowContent name="held" row={view.held} />
        </p>
      )}
      {sessionId !== undefined ? (
        <PrinterStatusRow lastPrintFailed={printFailure !== null} />
      ) : (
        printer !== null && (
          <p className="v5-status__row" data-row="printer" data-tone={printer.tone}>
            <RowContent name="printer" row={printer} />
          </p>
        )
      )}
    </div>
  );
}
