/**
 * RT-886 (RT-839 S1+S2) — the renderer side of the printer choice:
 *   - the RT-604 footer row is always there for a signed-in operator (any role)
 *     and opens the «الطابعة» panel;
 *   - the panel lists the printers plus «Windows default», saves, and sends a
 *     test page with honest copy (Windows accepted ≠ printed);
 *   - the printer failure banner offers «تغيير الطابعة»;
 *   - the Sale prompt is non-blocking, shown once, and «Windows default»
 *     counts as a choice.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PrinterBridgeAPI,
  PrinterChoice,
  PrinterGetResponse,
  PrinterListResponse,
  PrinterSetResponse,
  PrinterTestPrintResponse,
} from '../../../../shared/printer/types';
import { expectNoAxeViolations } from '../../../test-utils/axe-config';
import { PrinterFailureBanner } from '../../../ui/receipts/PrinterFailureBanner';
import { DialogHost } from '../../foundation/Dialog';
import { PrinterChoicePrompt } from '../PrinterChoicePrompt';
import { PrinterPanel, PrinterPanelHost } from '../PrinterPanel';
import { PrinterStatusRow } from '../PrinterStatusRow';
import { printerLabel, refusalMessage } from '../printer-copy';
import {
  acceptPrinterChoice,
  openPrinterPanel,
  refreshPrinterChoice,
  resetPrinterStore,
  useSaleScreenMark,
  usePrinterChoiceSync,
  usePrinterStore,
} from '../printer-store';

const BIXOLON: PrinterChoice = { source: 'chosen', printer_name: 'BIXOLON SRP-330II' };

interface FakeBridge extends PrinterBridgeAPI {
  list: ReturnType<typeof vi.fn<() => Promise<PrinterListResponse>>>;
  get: ReturnType<typeof vi.fn<() => Promise<PrinterGetResponse>>>;
  set: ReturnType<typeof vi.fn<PrinterBridgeAPI['set']>>;
  testPrint: ReturnType<typeof vi.fn<() => Promise<PrinterTestPrintResponse>>>;
}

function fakeBridge(over: Partial<PrinterBridgeAPI> = {}): FakeBridge {
  let saved: PrinterChoice | null = null;
  return {
    list: vi.fn(
      over.list ??
        (() =>
          Promise.resolve({
            kind: 'ok' as const,
            printers: [{ name: 'HP LaserJet' }, { name: 'BIXOLON SRP-330II' }],
          })),
    ),
    get: vi.fn(over.get ?? (() => Promise.resolve({ kind: 'ok' as const, choice: saved }))),
    set: vi.fn(
      over.set ??
        ((req): Promise<PrinterSetResponse> => {
          saved = req.choice;
          return Promise.resolve({ kind: 'ok', choice: req.choice });
        }),
    ),
    testPrint: vi.fn(
      over.testPrint ?? (() => Promise.resolve({ kind: 'accepted' as const, choice: saved })),
    ),
  };
}

function installBridge(bridge: PrinterBridgeAPI | undefined): void {
  (window as unknown as { api?: unknown }).api = bridge === undefined ? {} : { printer: bridge };
}

beforeEach(() => {
  resetPrinterStore();
});

afterEach(() => {
  cleanup();
  resetPrinterStore();
  delete (window as unknown as { api?: unknown }).api;
});

describe('printer copy', () => {
  it('names the printer, «Windows default», or no choice', () => {
    expect(printerLabel(null)).toBe('لم تُختر طابعة');
    expect(printerLabel({ source: 'os_default' })).toBe('طابعة Windows الافتراضية');
    expect(printerLabel(BIXOLON)).toBe('BIXOLON SRP-330II');
  });

  it('says one sentence per refusal', () => {
    expect(refusalMessage('printer_not_found')).toContain('لم تعد مثبّتة');
    expect(refusalMessage('not_signed_in')).toContain('سجّل الدخول');
    expect(refusalMessage('session_locked')).toBe(refusalMessage('not_signed_in'));
    expect(refusalMessage('printer_unavailable')).toContain('حاول مرة أخرى');
  });
});

describe('printer store', () => {
  it('stays unknown on a refusal, a failure or no bridge', async () => {
    await refreshPrinterChoice(undefined);
    await refreshPrinterChoice(
      fakeBridge({ get: () => Promise.resolve({ kind: 'refused', reason: 'not_signed_in' }) }),
    );
    await refreshPrinterChoice(fakeBridge({ get: () => Promise.reject(new Error('x')) }));
    expect(usePrinterStore.getState().loaded).toBe(false);
  });

  it('reads the choice once per signed-in session', async () => {
    const bridge = fakeBridge({ get: () => Promise.resolve({ kind: 'ok', choice: BIXOLON }) });
    installBridge(bridge);
    function Probe({ id }: Readonly<{ id: string | undefined }>): null {
      usePrinterChoiceSync(id);
      return null;
    }
    const view = render(<Probe id={undefined} />);
    expect(bridge.get).not.toHaveBeenCalled();
    await act(async () => {
      view.rerender(<Probe id="session-1" />);
      await Promise.resolve();
    });
    expect(bridge.get).toHaveBeenCalledTimes(1);
    expect(usePrinterStore.getState()).toMatchObject({ loaded: true, choice: BIXOLON });
  });

  it('a panel left open never carries over to the next session', async () => {
    installBridge(fakeBridge());
    function Probe({ id }: Readonly<{ id: string | undefined }>): null {
      usePrinterChoiceSync(id);
      return null;
    }
    const view = render(<Probe id="session-1" />);
    act(() => {
      openPrinterPanel();
    });
    await act(async () => {
      view.rerender(<Probe id={undefined} />);
      await Promise.resolve();
    });
    expect(usePrinterStore.getState().panelOpen).toBe(false);
  });

  it('clears the previous session before reading, keeps the dismissed prompt, and drops a stale answer', async () => {
    const first: { resolve: (r: PrinterGetResponse) => void } = { resolve: () => undefined };
    let calls = 0;
    const bridge = fakeBridge({
      get: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<PrinterGetResponse>((resolve) => {
            first.resolve = resolve;
          });
        }
        return Promise.resolve({ kind: 'ok', choice: { source: 'os_default' } });
      },
    });
    installBridge(bridge);
    function Probe({ id }: Readonly<{ id: string | undefined }>): null {
      usePrinterChoiceSync(id);
      return null;
    }
    // A previous session's view, with the prompt already answered this run.
    usePrinterStore.setState({
      loaded: true,
      choice: BIXOLON,
      panelOpen: true,
      promptDismissed: true,
    });
    const view = render(<Probe id="session-1" />);
    // Cleared before the read: no stale name, no open panel.
    expect(usePrinterStore.getState()).toMatchObject({
      loaded: false,
      choice: null,
      panelOpen: false,
      promptDismissed: true,
    });
    // Session 1 ends while its read is still in flight; session 2 reads.
    await act(async () => {
      view.rerender(<Probe id="session-2" />);
      await Promise.resolve();
    });
    expect(usePrinterStore.getState().choice).toEqual({ source: 'os_default' });
    // Session 1's slow answer lands last and is dropped.
    await act(async () => {
      first.resolve({ kind: 'ok', choice: BIXOLON });
      await Promise.resolve();
    });
    expect(usePrinterStore.getState()).toMatchObject({
      loaded: true,
      choice: { source: 'os_default' },
      promptDismissed: true,
    });
    // Sign-out clears the session view again.
    act(() => {
      view.rerender(<Probe id={undefined} />);
    });
    expect(usePrinterStore.getState()).toMatchObject({ loaded: false, choice: null });
  });

  it('marks the Sale screen only while it is mounted', () => {
    function Sale(): null {
      useSaleScreenMark();
      return null;
    }
    const view = render(<Sale />);
    expect(usePrinterStore.getState().onSaleScreen).toBe(true);
    view.unmount();
    expect(usePrinterStore.getState().onSaleScreen).toBe(false);
  });
});

describe('PrinterStatusRow (RT-604 footer row)', () => {
  it('shows no guess before main answered', () => {
    render(<PrinterStatusRow lastPrintFailed={false} />);
    const row = screen.getByRole('button');
    expect(row).toHaveTextContent('الطابعة');
    expect(row).not.toHaveTextContent('لم تُختر طابعة');
    expect(row).toHaveAttribute('data-tone', 'neutral');
  });

  it('shows «لم تُختر طابعة» when no printer was ever chosen', () => {
    usePrinterStore.setState({ loaded: true, choice: null });
    render(<PrinterStatusRow lastPrintFailed={false} />);
    expect(screen.getByRole('button', { name: /لم تُختر طابعة/ })).toHaveAttribute(
      'data-tone',
      'info',
    );
  });

  it('names the chosen printer, and never says «جاهز»', () => {
    acceptPrinterChoice(BIXOLON);
    render(<PrinterStatusRow lastPrintFailed={false} />);
    const row = screen.getByRole('button', { name: 'الطابعة: BIXOLON SRP-330II' });
    expect(row).not.toHaveTextContent('جاهز');
  });

  it('leads with «فشل آخر إيصال» while the last print failed', () => {
    acceptPrinterChoice({ source: 'os_default' });
    render(<PrinterStatusRow lastPrintFailed />);
    const row = screen.getByRole('button');
    expect(row).toHaveTextContent('فشل آخر إيصال');
    expect(row).toHaveTextContent('طابعة Windows الافتراضية');
    expect(row).toHaveAttribute('data-tone', 'warning');
  });

  it('opens the «الطابعة» panel', () => {
    render(<PrinterStatusRow lastPrintFailed={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(usePrinterStore.getState().panelOpen).toBe(true);
  });
});

async function renderPanel(bridge: PrinterBridgeAPI | undefined, onClose = vi.fn()) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <DialogHost>
        <PrinterPanel bridge={bridge} onClose={onClose} />
      </DialogHost>,
    );
    await Promise.resolve();
  });
  return { view, onClose, dialog: screen.getByRole('dialog', { name: 'الطابعة' }) };
}

describe('PrinterPanel', () => {
  it('lists «Windows default» and the installed printers, focus on «إغلاق»', async () => {
    const { dialog } = await renderPanel(fakeBridge());
    const radios = within(dialog).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(within(dialog).getByRole('radio', { name: /طابعة Windows الافتراضية/ })).toBeVisible();
    expect(within(dialog).getByRole('radio', { name: 'BIXOLON SRP-330II' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'إغلاق' })).toHaveFocus();
    // Nothing chosen yet: nothing to save, nothing to test.
    expect(within(dialog).getByRole('button', { name: 'حفظ' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'طباعة صفحة اختبار' })).toBeDisabled();
    await expectNoAxeViolations(dialog);
  });

  it('pre-selects the saved choice', async () => {
    acceptPrinterChoice(BIXOLON);
    const { dialog } = await renderPanel(fakeBridge());
    expect(within(dialog).getByRole('radio', { name: 'BIXOLON SRP-330II' })).toBeChecked();
  });

  it('saves a printer (AC1) and mirrors it in the store', async () => {
    const bridge = fakeBridge();
    const { dialog } = await renderPanel(bridge);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'BIXOLON SRP-330II' }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
      await Promise.resolve();
    });
    expect(bridge.set).toHaveBeenCalledWith({ choice: BIXOLON });
    expect(await within(dialog).findByText('حُفظت الطابعة.')).toBeVisible();
    expect(usePrinterStore.getState().choice).toEqual(BIXOLON);
    expect(within(dialog).getByRole('button', { name: 'حفظ' })).toBeDisabled();
  });

  it('«Windows default» is a choice', async () => {
    const bridge = fakeBridge();
    const { dialog } = await renderPanel(bridge);
    fireEvent.click(within(dialog).getByRole('radio', { name: /طابعة Windows الافتراضية/ }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
      await Promise.resolve();
    });
    expect(bridge.set).toHaveBeenCalledWith({ choice: { source: 'os_default' } });
    expect(usePrinterStore.getState()).toMatchObject({
      choice: { source: 'os_default' },
      promptDismissed: true,
    });
  });

  it('says why a save was refused and keeps the old choice', async () => {
    const bridge = fakeBridge({
      set: () => Promise.resolve({ kind: 'refused', reason: 'printer_not_found' }),
    });
    const { dialog } = await renderPanel(bridge);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'HP LaserJet' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByText(/لم تعد مثبّتة/)).toBeVisible();
    expect(usePrinterStore.getState().choice).toBeNull();
  });

  it('a test page saves the pick first, then says Windows accepted it (never "printed")', async () => {
    const bridge = fakeBridge();
    const { dialog } = await renderPanel(bridge);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'BIXOLON SRP-330II' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'طباعة صفحة اختبار' }));
    const message = await within(dialog).findByText(/أُرسلت صفحة الاختبار إلى «BIXOLON SRP-330II»/);
    expect(message).toHaveTextContent('تأكد أنها خرجت من الطابعة الصحيحة');
    expect(dialog).not.toHaveTextContent('طُبعت');
    expect(bridge.set.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.testPrint.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('tests the saved printer without saving again', async () => {
    acceptPrinterChoice({ source: 'os_default' });
    const bridge = fakeBridge({
      testPrint: () => Promise.resolve({ kind: 'accepted', choice: { source: 'os_default' } }),
    });
    const { dialog } = await renderPanel(bridge);
    fireEvent.click(within(dialog).getByRole('button', { name: 'طباعة صفحة اختبار' }));
    expect(
      await within(dialog).findByText(/أُرسلت صفحة الاختبار إلى «طابعة Windows الافتراضية»/),
    ).toBeVisible();
    expect(bridge.set).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'failed', reason: 'printer_missing', choice: BIXOLON }, /غير موجودة على هذا الجهاز/],
    [{ kind: 'failed', reason: 'print_failed', choice: BIXOLON }, /تعذّرت الطباعة على/],
    [{ kind: 'refused', reason: 'session_locked' }, /سجّل الدخول/],
  ] as const)('says a failed test page plainly (%o)', async (answer, text) => {
    acceptPrinterChoice(BIXOLON);
    const bridge = fakeBridge({ testPrint: () => Promise.resolve(answer) });
    const { dialog } = await renderPanel(bridge);
    fireEvent.click(within(dialog).getByRole('button', { name: 'طباعة صفحة اختبار' }));
    expect(await within(dialog).findByText(text)).toBeVisible();
  });

  it('a bridge that throws is a generic, retryable message', async () => {
    acceptPrinterChoice(BIXOLON);
    const bridge = fakeBridge({ testPrint: () => Promise.reject(new Error('ipc')) });
    const { dialog } = await renderPanel(bridge);
    fireEvent.click(within(dialog).getByRole('button', { name: 'طباعة صفحة اختبار' }));
    expect(await within(dialog).findByText(/حاول مرة أخرى/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'طباعة صفحة اختبار' })).toBeEnabled();
  });

  it('shows an empty or refused printer list, and still offers «Windows default»', async () => {
    const empty = await renderPanel(
      fakeBridge({ list: () => Promise.resolve({ kind: 'ok', printers: [] }) }),
    );
    expect(within(empty.dialog).getByText('لا توجد طابعات مثبّتة على هذا الجهاز.')).toBeVisible();
    cleanup();
    const refused = await renderPanel(
      fakeBridge({ list: () => Promise.resolve({ kind: 'refused', reason: 'not_signed_in' }) }),
    );
    expect(within(refused.dialog).getByText(/سجّل الدخول/)).toBeVisible();
    expect(within(refused.dialog).getAllByRole('radio')).toHaveLength(1);
    cleanup();
    const thrown = await renderPanel(fakeBridge({ list: () => Promise.reject(new Error('x')) }));
    expect(within(thrown.dialog).getByText(/حاول مرة أخرى/)).toBeVisible();
  });

  it('without a bridge it can only be closed', async () => {
    const { dialog } = await renderPanel(undefined);
    expect(within(dialog).getByText(/حاول مرة أخرى/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'حفظ' })).toBeDisabled();
  });

  it('closes on «إغلاق» and on Esc', async () => {
    const { dialog, onClose } = await renderPanel(fakeBridge());
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إغلاق' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('the host mounts the panel only while it is open', async () => {
    installBridge(fakeBridge());
    render(
      <DialogHost>
        <PrinterPanelHost />
      </DialogHost>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {
      openPrinterPanel();
      await Promise.resolve();
    });
    const dialog = screen.getByRole('dialog', { name: 'الطابعة' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إغلاق' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('PrinterFailureBanner — «تغيير الطابعة» (RT-839 D4)', () => {
  it('opens the panel', () => {
    render(
      <PrinterFailureBanner
        printFailure={{
          sale_id: 's-1',
          failure_reason: 'os_print_error',
          has_successful_print: false,
        }}
        onReprint={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'تغيير الطابعة' }));
    expect(usePrinterStore.getState().panelOpen).toBe(true);
  });
});

describe('PrinterChoicePrompt — non-blocking, once, on the Sale screen', () => {
  function showPromptState(over: Partial<ReturnType<typeof usePrinterStore.getState>> = {}): void {
    usePrinterStore.setState({ loaded: true, choice: null, onSaleScreen: true, ...over });
  }

  it('shows on the Sale screen when no printer was chosen, without taking focus or blocking', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    showPromptState();
    const { container } = render(<PrinterChoicePrompt />);
    const prompt = screen.getByTestId('printer-choice-prompt');
    expect(prompt).toHaveTextContent('لم تُختر طابعة الإيصالات بعد');
    expect(prompt).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(input).toHaveFocus();
    await expectNoAxeViolations(container);
    input.remove();
  });

  it.each([
    ['off the Sale screen', { onSaleScreen: false }],
    ['before main answered', { loaded: false }],
    ['once «Windows default» was chosen', { choice: { source: 'os_default' } as PrinterChoice }],
    ['once a printer was chosen', { choice: BIXOLON }],
    ['once dismissed', { promptDismissed: true }],
  ])('stays hidden %s', (_label, over) => {
    showPromptState(over);
    render(<PrinterChoicePrompt />);
    expect(screen.queryByTestId('printer-choice-prompt')).toBeNull();
  });

  it('«لاحقًا» retires it for this run (shown once)', () => {
    showPromptState();
    render(<PrinterChoicePrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'لاحقًا' }));
    expect(screen.queryByTestId('printer-choice-prompt')).toBeNull();
    act(() => {
      usePrinterStore.setState({ onSaleScreen: false });
    });
    act(() => {
      usePrinterStore.setState({ onSaleScreen: true });
    });
    expect(screen.queryByTestId('printer-choice-prompt')).toBeNull();
  });

  it('«اختيار الطابعة» opens the panel and retires the prompt', () => {
    showPromptState();
    render(<PrinterChoicePrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'اختيار الطابعة' }));
    expect(usePrinterStore.getState()).toMatchObject({ panelOpen: true, promptDismissed: true });
    expect(screen.queryByTestId('printer-choice-prompt')).toBeNull();
  });
});

describe('V5 frame — the printer row for any signed-in role', () => {
  it('a cashier sees the row and opens the panel from it', async () => {
    const { installStatusApi, renderStatusFrame, signInCashier, resetStatusKit } =
      await import('../../__tests__/__helpers__/terminal-status-kit');
    const { snap } = await import('../../../terminal-status/__tests__/__helpers__/snapshot');
    installStatusApi(snap('online'));
    const bridge = fakeBridge({ get: () => Promise.resolve({ kind: 'ok', choice: null }) });
    (window as unknown as { api: Record<string, unknown> }).api['printer'] = bridge;
    signInCashier();
    await renderStatusFrame();
    const row = await waitFor(() => {
      const el = screen.getByTestId('v5-status-indicator').querySelector('[data-row="printer"]');
      expect(el).toHaveTextContent('لم تُختر طابعة');
      return el as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
    });
    expect(await screen.findByRole('dialog', { name: 'الطابعة' })).toBeVisible();
    resetStatusKit();
  });
});
