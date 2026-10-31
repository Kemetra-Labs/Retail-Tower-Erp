/**
 * RT-604 (VN-S6 S6-3, doc 24 §4.1 / §4.2) — the StatusIndicator in the V5
 * navigation footer: a connection row, a sync row when there is something to
 * say, and a printer row only while the last print failed (D-6-7). Fed by the
 * `terminalStatus` bridge push; it never polls the status itself.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStatusSnapshot } from '../../../shared/terminal-status/types';
import { STATUS_NOW as NOW, snap } from '../../terminal-status/__tests__/__helpers__/snapshot';
import { SYNC_ATTENTION_AGE_MS } from '../../terminal-status/status-mapping';
import { expectNoAxeViolations } from '../../test-utils/axe-config';
import {
  installStatusApi,
  renderStatusFrame,
  resetStatusKit,
  signInCashier,
  useStatusClock,
  type StatusApi,
} from './__helpers__/terminal-status-kit';

let api: StatusApi;
let printFailed = false;

function installApi(first: TerminalStatusSnapshot | 'reject'): void {
  api = installStatusApi(first, { printFailed });
}

async function renderAt(path = '/app/dashboard'): ReturnType<typeof renderStatusFrame> {
  signInCashier();
  return renderStatusFrame(path);
}

function indicator(): HTMLElement {
  return screen.getByTestId('v5-status-indicator');
}

function row(name: 'connection' | 'sync' | 'printer'): HTMLElement | null {
  return indicator().querySelector(`[data-row="${name}"]`);
}

async function pushNow(s: TerminalStatusSnapshot): Promise<void> {
  await api.push(s);
}

beforeEach(() => {
  useStatusClock();
  printFailed = false;
});

afterEach(() => {
  cleanup();
  resetStatusKit();
});

describe('StatusIndicator — placement', () => {
  it('lives in the navigation footer, before the operator block', async () => {
    installApi(snap('online'));
    await renderAt();
    const nav = screen.getByRole('navigation', { name: 'التنقل الرئيسي' });
    expect(within(nav).getByTestId('v5-status-indicator')).toBeInTheDocument();
    const operator = screen.getByTestId('v5-frame-operator');
    expect(
      indicator().compareDocumentPosition(operator) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('StatusIndicator — connection row', () => {
  it('shows «جارٍ التحقق من الاتصال» until the first snapshot, never «متصل»', async () => {
    installApi('reject');
    await renderAt();
    expect(row('connection')).toHaveTextContent('جارٍ التحقق من الاتصال');
    expect(row('connection')).toHaveAttribute('data-tone', 'neutral');
    expect(indicator()).not.toHaveTextContent('متصل');
  });

  it.each([
    ['online', 'متصل', 'success'],
    ['offline', 'غير متصل', 'warning'],
    ['degraded', 'غير متصل', 'warning'],
    ['checking', 'جارٍ التحقق من الاتصال', 'neutral'],
  ] as const)('%s → «%s» (%s)', async (connection, text, tone) => {
    installApi(snap(connection));
    await renderAt();
    expect(row('connection')).toHaveTextContent(text);
    expect(row('connection')).toHaveAttribute('data-tone', tone);
  });

  it('follows the push', async () => {
    installApi(snap('online'));
    await renderAt();
    expect(row('connection')).toHaveTextContent('متصل');
    await pushNow(snap('offline'));
    expect(row('connection')).toHaveTextContent('غير متصل');
  });

  it('pairs every tone with a glyph, so it is never told by colour alone', async () => {
    installApi(snap('offline'));
    await renderAt();
    const glyph = row('connection')?.querySelector('svg');
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
  });

  it('is the only polite live region: a connection change is announced, a count change is not', async () => {
    installApi(snap('online', { pending: 2, oldestPendingAt: '2026-10-17T11:00:00.000Z' }));
    await renderAt();
    expect(row('connection')).toHaveAttribute('role', 'status');
    expect(row('connection')).toHaveAttribute('aria-live', 'polite');
    expect(row('sync')?.closest('[aria-live]')).toBeNull();
  });
});

describe('StatusIndicator — sync row', () => {
  const oldest = '2026-10-17T11:00:00.000Z';

  it('shows no sync row when nothing is pending (idle)', async () => {
    installApi(snap('online'));
    await renderAt();
    expect(row('sync')).toBeNull();
  });

  it('shows S16 «جارٍ إرسال ‹n› عمليات…» while online and sending', async () => {
    installApi(snap('online', { pending: 3, oldestPendingAt: oldest }));
    await renderAt();
    expect(row('sync')).toHaveTextContent('جارٍ إرسال 3 عمليات…');
    expect(row('sync')).toHaveAttribute('data-tone', 'info');
  });

  it('shows M-O2 «عمليتان بانتظار الإرسال» while paused — never «sending» (D-6-6)', async () => {
    installApi(
      snap('online', { pending: 2, oldestPendingAt: oldest, paused: 'no_operator_credential' }),
    );
    await renderAt();
    expect(row('sync')).toHaveTextContent('عمليتان بانتظار الإرسال');
    expect(row('sync')).not.toHaveTextContent('جارٍ إرسال');
  });

  it('shows M-O2 while offline', async () => {
    installApi(snap('offline', { pending: 4, oldestPendingAt: oldest }));
    await renderAt();
    expect(row('sync')).toHaveTextContent('4 عمليات بانتظار الإرسال');
  });

  it('shows «تحتاج مراجعة» on a dead letter', async () => {
    installApi(snap('online', { deadLetter: 1 }));
    await renderAt();
    expect(row('sync')).toHaveTextContent('تحتاج مراجعة');
    expect(row('sync')).toHaveAttribute('data-tone', 'danger');
  });

  it('isolates the count as an LTR run in Western digits', async () => {
    installApi(snap('online', { pending: 12, oldestPendingAt: oldest }));
    await renderAt();
    const num = row('sync')?.querySelector('.v5-status__num');
    expect(num).toHaveTextContent(/^12$/);
    expect(num).toHaveAttribute('dir', 'ltr');
  });

  it('turns to «تحتاج مراجعة» once the oldest pending sale passes 24 h, with no extra read', async () => {
    const since = NOW - SYNC_ATTENTION_AGE_MS + 60_000;
    installApi(snap('online', { pending: 1, oldestPendingAt: new Date(since).toISOString() }));
    await renderAt();
    expect(row('sync')).toHaveTextContent('جارٍ إرسال عملية واحدة…');
    await act(async () => {
      vi.advanceTimersByTime(60_001);
      await Promise.resolve();
    });
    expect(row('sync')).toHaveTextContent('تحتاج مراجعة');
    expect(api.getStatus).toHaveBeenCalledTimes(1);
  });
});

describe('StatusIndicator — printer row (D-6-7)', () => {
  it('shows «فشل آخر إيصال» only while the last print failed', async () => {
    printFailed = true;
    installApi(snap('online'));
    await renderAt();
    await act(async () => {
      await Promise.resolve();
    });
    expect(row('printer')).toHaveTextContent('فشل آخر إيصال');
    expect(row('printer')).toHaveAttribute('data-tone', 'warning');
  });

  it('RT-886: shows no failure otherwise, and never «جاهز»', async () => {
    installApi(snap('online'));
    await renderAt();
    // RT-886 (RT-839 D4): a signed-in operator always has the printer row (it
    // opens the «الطابعة» panel); it no longer means only "the last print failed".
    expect(row('printer')).not.toHaveTextContent('فشل آخر إيصال');
    expect(row('printer')).not.toHaveAttribute('data-tone', 'warning');
    expect(indicator()).not.toHaveTextContent('جاهز');
  });
});

function shortLabel(el: HTMLElement | null): HTMLElement | null {
  return el?.querySelector<HTMLElement>('.v5-status__label') ?? null;
}

describe('StatusIndicator — slim rail and lifetime', () => {
  // RT-1023 (owner decision 2026-10-31): the slim rail is on every screen, so
  // glyphs alone could not tell «offline» from «printer unknown». Each row
  // shows a short one-word label under its glyph (DESIGN.md "dot plus text").
  it('shows a short label under each glyph in the slim rail, and keeps the full text', async () => {
    printFailed = true;
    installApi(
      snap('offline', { pending: 3, held: 1, oldestPendingAt: '2026-10-17T11:00:00.000Z' }),
    );
    await renderAt('/app/cart');
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('v5-frame')).toHaveAttribute('data-nav', 'slim');
    const held = indicator().querySelector<HTMLElement>('[data-row="held"]');
    expect(shortLabel(row('connection'))).toHaveTextContent(/^الاتصال$/);
    expect(shortLabel(row('sync'))).toHaveTextContent(/^المزامنة$/);
    expect(shortLabel(held)).toHaveTextContent(/^المعلّقة$/);
    expect(shortLabel(row('printer'))).toHaveTextContent(/^الطابعة$/);
    expect(row('connection')).toHaveTextContent('غير متصل');
    expect(row('sync')).toHaveTextContent('عمليتان بانتظار الإرسال');
    expect(held).toHaveTextContent('إرسال عملية واحدة بخصم مؤجَّل');
    expect(row('printer')).toHaveTextContent('فشل آخر إيصال');
  });

  it('keeps the short label out of the accessibility tree: names and announcements are unchanged', async () => {
    installApi(snap('offline'));
    await renderAt('/app/cart');
    for (const el of Array.from(indicator().querySelectorAll('.v5-status__label'))) {
      expect(el).toHaveAttribute('aria-hidden', 'true');
    }
    expect(row('connection')?.querySelector('.v5-status__text')).toHaveTextContent(/^غير متصل$/);
    // The printer button's name still carries its visible label (WCAG 2.5.3).
    expect(within(indicator()).getByRole('button')).toHaveAccessibleName(/^الطابعة/);
  });

  it('unsubscribes from the push on unmount', async () => {
    installApi(snap('online'));
    const { unmount } = await renderAt();
    unmount();
    expect(api.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('is axe-clean in the labelled panel and the slim rail', async () => {
    printFailed = true;
    installApi(snap('offline', { pending: 2, oldestPendingAt: '2026-10-17T11:00:00.000Z' }));
    const panel = await renderAt();
    await expectNoAxeViolations(panel.container);
    cleanup();
    installApi(snap('online', { deadLetter: 1 }));
    const slim = await renderAt('/app/cart');
    await expectNoAxeViolations(slim.container);
  });
});

describe('StatusIndicator CSS', () => {
  const css = readFileSync(resolve(__dirname, '../frame/status-indicator.css'), 'utf8');

  it('uses tabular Western digits for counts', () => {
    expect(css).toMatch(/\.v5-status__num\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  });

  it('keeps a visible edge for each glyph in forced colours', () => {
    expect(css).toMatch(/@media \(forced-colors: active\)/);
  });

  it('never sets indicator text below 12px', () => {
    expect(css).not.toMatch(/font-size:\s*(?:var\(--font-size-2xs\)|1[01]px|[0-9]px)/);
  });

  // Tripwires, not cascade proof (jsdom applies no stylesheet): the short label
  // shows only in the slim rail, at 12px, under a centred glyph. The captures
  // in captures/RT-1023 prove it renders and fits.
  it('RT-1023: shows the short label only in the slim rail, at 12px, under the glyph', () => {
    expect(css).toMatch(/\.v5-status__label\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(
      /\.v5-frame\[data-nav='slim'\] \.v5-status__label\s*\{[^}]*display:\s*block[^}]*font-size:\s*var\(--font-size-xs\)/,
    );
    expect(css).toMatch(
      /\.v5-frame\[data-nav='slim'\] \.v5-status__row\s*\{[^}]*flex-direction:\s*column[^}]*align-items:\s*center/,
    );
  });

  // Tripwire, not cascade proof: the printer row is a full-width button, so in
  // the slim rail its glyph sat at the inline start, off the other glyphs'
  // centre line (owner report 2026-10-30, build e4d25139).
  it('centres the printer row glyph in the slim rail', () => {
    const printerCss = readFileSync(resolve(__dirname, '../printer/printer.css'), 'utf8');
    expect(printerCss).toMatch(
      /\.v5-frame\[data-nav='slim'\] \.v5-status__row--action\s*\{[^}]*justify-content:\s*center/,
    );
  });
});
