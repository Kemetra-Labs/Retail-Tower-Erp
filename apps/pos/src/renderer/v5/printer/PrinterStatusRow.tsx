import type { JSX } from 'react';
import { Icon } from '../../icons/Icon';
import type { IconName } from '../../icons/registry';
import { STATUS_COPY } from '../../terminal-status/status-copy';
import { PRINTER_COPY, printerLabel } from './printer-copy';
import { openPrinterPanel, usePrinterStore } from './printer-store';
import './printer.css';

type RowTone = 'warning' | 'info' | 'neutral';

const MARK: Readonly<Record<RowTone, IconName>> = {
  warning: 'status.warning',
  info: 'status.info',
  neutral: 'status.neutral',
};

/**
 * RT-886 (RT-839 D4) — the RT-604 footer printer row, always shown to a
 * signed-in operator. It names the printer receipts go to (the chosen queue,
 * «Windows default», or «لم تُختر طابعة») and opens the «الطابعة» panel. While
 * the last print failed it leads with D-6-7's «فشل آخر إيصال» (warning). It
 * never says «جاهز»: a name is not proof the printer works. Before main
 * answered, the row shows no printer text rather than a guess.
 *
 * In the slim rail only the glyph shows; the text stays for assistive tech.
 */
export function PrinterStatusRow({
  lastPrintFailed,
}: Readonly<{ lastPrintFailed: boolean }>): JSX.Element {
  const loaded = usePrinterStore((s) => s.loaded);
  const choice = usePrinterStore((s) => s.choice);
  const label = loaded ? printerLabel(choice) : null;
  let tone: RowTone = 'neutral';
  if (lastPrintFailed) tone = 'warning';
  else if (loaded && choice === null) tone = 'info';

  return (
    <button
      type="button"
      className="v5-status__row v5-status__row--action"
      data-row="printer"
      data-tone={tone}
      aria-haspopup="dialog"
      onClick={openPrinterPanel}
    >
      <span className="v5-status__mark">
        <Icon name={MARK[tone]} size="sm" />
      </span>
      <span className="v5-status__text">
        {lastPrintFailed && <span className="v5-status__line">{STATUS_COPY.printerFailed}</span>}
        {label === null ? (
          <span className="v5-status__line">{PRINTER_COPY.panelTitle}</span>
        ) : (
          <span className="v5-status__line">
            <span className="v5-printer-sr">{PRINTER_COPY.rowPrefix} </span>
            <bdi>{label}</bdi>
          </span>
        )}
      </span>
    </button>
  );
}
