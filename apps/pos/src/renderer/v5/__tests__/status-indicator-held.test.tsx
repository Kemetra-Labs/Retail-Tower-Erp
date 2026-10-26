/**
 * RT-887 (RT-856 residual) — the StatusIndicator and the M-O3 attention banner
 * with discount-held sales. A held sale (RT-856, unsent until RT-858) is never
 * «sending» and never raises the 24 h banner; its count shows as a separate
 * neutral row. With no held sale nothing changes.
 */
import { act, cleanup, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStatusSnapshot } from '../../../shared/terminal-status/types';
import { STATUS_NOW as NOW, snap } from '../../terminal-status/__tests__/__helpers__/snapshot';
import { SYNC_ATTENTION_AGE_MS } from '../../terminal-status/status-mapping';
import { expectNoAxeViolations } from '../../test-utils/axe-config';
import { V5OperationalNotices } from '../frame/V5OperationalNotices';
import {
  installStatusApi,
  renderStatusFrame,
  resetStatusKit,
  signInCashier,
  useStatusClock,
} from './__helpers__/terminal-status-kit';

async function renderWith(first: TerminalStatusSnapshot): Promise<void> {
  installStatusApi(first);
  signInCashier();
  await renderStatusFrame('/app/dashboard', <V5OperationalNotices />);
}

function row(name: 'sync' | 'held'): HTMLElement | null {
  return screen.getByTestId('v5-status-indicator').querySelector(`[data-row="${name}"]`);
}

function attentionBanner(): HTMLElement | null {
  return screen.queryByTestId('v5-sync-attention-banner');
}

beforeEach(() => {
  useStatusClock();
});

afterEach(() => {
  cleanup();
  resetStatusKit();
});

describe('StatusIndicator — held discounted sales (RT-887)', () => {
  it('held-only: no «sending», no banner, a neutral held row', async () => {
    await renderWith(snap('online', { pending: 2, held: 2, oldestPendingAt: null }));
    expect(row('sync')).toBeNull();
    expect(row('held')).toHaveTextContent('إرسال عمليتين بخصم مؤجَّل');
    expect(row('held')).toHaveAttribute('data-tone', 'neutral');
    expect(row('held')?.closest('[aria-live]')).toBeNull();
    expect(attentionBanner()).toBeNull();
  });

  it('held-only: still no banner after more than 24 h', async () => {
    await renderWith(snap('online', { pending: 1, held: 1, oldestPendingAt: null }));
    await act(async () => {
      vi.advanceTimersByTime(SYNC_ATTENTION_AGE_MS + 60_000);
      await Promise.resolve();
    });
    expect(attentionBanner()).toBeNull();
    expect(row('sync')).toBeNull();
    expect(row('held')).toHaveTextContent('إرسال عملية واحدة بخصم مؤجَّل');
  });

  it('mixed: «sending» counts the non-held sales; the held count is its own row', async () => {
    await renderWith(
      snap('online', { pending: 5, held: 2, oldestPendingAt: '2026-10-17T11:00:00.000Z' }),
    );
    expect(row('sync')).toHaveTextContent('جارٍ إرسال 3 عمليات…');
    expect(row('held')).toHaveTextContent('إرسال عمليتين بخصم مؤجَّل');
    const num = row('sync')?.querySelector('.v5-status__num');
    expect(num).toHaveTextContent(/^3$/);
  });

  it('mixed: an aged non-held sale raises the banner, counting the non-held sales only', async () => {
    const aged = new Date(NOW - SYNC_ATTENTION_AGE_MS - 60_000).toISOString();
    await renderWith(snap('online', { pending: 4, held: 1, oldestPendingAt: aged }));
    expect(row('sync')).toHaveTextContent('تحتاج مراجعة');
    expect(attentionBanner()).toHaveTextContent('تعذّر إرسال 3 عمليات. راجع المدير.');
    expect(row('held')).toHaveTextContent('إرسال عملية واحدة بخصم مؤجَّل');
  });

  it('none held: no held row', async () => {
    await renderWith(snap('online', { pending: 3, oldestPendingAt: '2026-10-17T11:00:00.000Z' }));
    expect(row('held')).toBeNull();
    expect(row('sync')).toHaveTextContent('جارٍ إرسال 3 عمليات…');
  });

  it('has no axe violations with a held row', async () => {
    await renderWith(snap('online', { pending: 2, held: 1, oldestPendingAt: null }));
    await expectNoAxeViolations(screen.getByTestId('v5-status-indicator'));
  });
});
