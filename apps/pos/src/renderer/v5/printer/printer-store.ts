import { useEffect } from 'react';
import { create } from 'zustand';
import type { PrinterBridgeAPI, PrinterChoice } from '../../../shared/printer/types';

/**
 * RT-886 (RT-839 S1+S2) — the renderer's view of the terminal's printer choice.
 *
 * Main owns the choice (migration 0057); this store only mirrors what
 * `printer.get` / `printer.set` answered, so the footer row, the panel, the
 * banner shortcut and the Sale prompt agree. `loaded` stays false until main
 * answered: an unknown choice never shows «لم تُختر طابعة» or the prompt.
 *
 * The prompt is offered once per app run: «لاحقًا», opening the panel from it,
 * or any saved choice («Windows default» included) retires it.
 */
interface PrinterState {
  readonly loaded: boolean;
  readonly choice: PrinterChoice | null;
  readonly panelOpen: boolean;
  readonly promptDismissed: boolean;
  /** The Sale screen is mounted (it sets this itself). */
  readonly onSaleScreen: boolean;
}

const INITIAL: PrinterState = {
  loaded: false,
  choice: null,
  panelOpen: false,
  promptDismissed: false,
  onSaleScreen: false,
};

export const usePrinterStore = create<PrinterState>()(() => ({ ...INITIAL }));

export function printerBridge(): PrinterBridgeAPI | undefined {
  const api = (window as unknown as { api?: { printer?: PrinterBridgeAPI } }).api;
  return api?.printer;
}

/** Read the saved choice from main. A refusal or failure leaves it unknown. */
export async function refreshPrinterChoice(
  bridge: PrinterBridgeAPI | undefined = printerBridge(),
): Promise<void> {
  if (bridge === undefined) return;
  try {
    const answer = await bridge.get();
    if (answer.kind === 'ok') usePrinterStore.setState({ loaded: true, choice: answer.choice });
  } catch {
    // Unknown stays unknown: no row text guess, no prompt.
  }
}

/** Main saved this choice. */
export function acceptPrinterChoice(choice: PrinterChoice): void {
  usePrinterStore.setState({ loaded: true, choice, promptDismissed: true });
}

export function openPrinterPanel(): void {
  usePrinterStore.setState({ panelOpen: true, promptDismissed: true });
}

export function closePrinterPanel(): void {
  usePrinterStore.setState({ panelOpen: false });
}

export function dismissPrinterPrompt(): void {
  usePrinterStore.setState({ promptDismissed: true });
}

/** Tests only: back to the first-launch state. */
export function resetPrinterStore(): void {
  usePrinterStore.setState({ ...INITIAL });
}

/**
 * Read the choice once per signed-in operator (the session key changes on
 * sign-in). A panel left open never carries over to the next session.
 */
export function usePrinterChoiceSync(sessionKey: string | undefined): void {
  useEffect(() => {
    if (sessionKey === undefined) return;
    void refreshPrinterChoice();
    return closePrinterPanel;
  }, [sessionKey]);
}

/** Mark the Sale screen as shown while it is mounted (for the once-only prompt). */
export function useSaleScreenMark(): void {
  useEffect(() => {
    usePrinterStore.setState({ onSaleScreen: true });
    return () => {
      usePrinterStore.setState({ onSaleScreen: false });
    };
  }, []);
}
