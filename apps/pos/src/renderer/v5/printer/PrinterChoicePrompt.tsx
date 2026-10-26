import type { JSX } from 'react';
import { Banner } from '../foundation/Banner';
import { PRINTER_COPY } from './printer-copy';
import { dismissPrinterPrompt, openPrinterPanel, usePrinterStore } from './printer-store';

/**
 * RT-886 (RT-839 Q1 / D4) — the Sale screen's printer prompt. Shown while the
 * Sale screen is up, main has answered that no printer was ever chosen, and
 * the prompt has not been answered in this app run.
 *
 * NON-BLOCKING (owner decision, RT-839 comment 13968): an info banner in the
 * notices stack, never a dialog. It takes no focus, so scanning and selling go
 * on underneath it, and the receipt still prints on the Windows default.
 * «اختيار الطابعة» opens the panel; «لاحقًا» retires it; any saved choice
 * («Windows default» included) retires it too.
 */
export function PrinterChoicePrompt(): JSX.Element | null {
  const show = usePrinterStore(
    (s) => s.onSaleScreen && s.loaded && s.choice === null && !s.promptDismissed,
  );
  if (!show) return null;
  return (
    <Banner
      tone="info"
      icon="print"
      testId="printer-choice-prompt"
      actions={
        <>
          <button
            type="button"
            className="v5-btn"
            aria-haspopup="dialog"
            onClick={openPrinterPanel}
          >
            {PRINTER_COPY.promptChoose}
          </button>
          <button type="button" className="v5-btn v5-btn--quiet" onClick={dismissPrinterPrompt}>
            {PRINTER_COPY.promptLater}
          </button>
        </>
      }
    >
      <p>{PRINTER_COPY.prompt}</p>
    </Banner>
  );
}
