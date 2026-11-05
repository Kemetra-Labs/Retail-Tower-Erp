/**
 * RT-1192 (RT-249 N-S3, doc 20 §4, §7) — Returns: today's sales on this terminal
 * and the short-number field. The field resolves a short form to the exact number
 * and then calls `returns.lookup` as before; the list only fills the lookup.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { refusalMessage } from '../returns-messages.js';
import { SALE_LOOKUP_COPY as COPY } from '../../sale-lookup/sale-lookup-copy';
import {
  FULL_NUMBER,
  fakeRecentBridge,
  recentRow,
} from '../../sale-lookup/__tests__/recent-fixtures';
import { fakeBridge, renderReturns, resetStores } from './returns-test-kit.js';

afterEach(() => {
  cleanup();
  resetStores();
});

const field = () => screen.getByLabelText(COPY.fieldLabel);
const PICKER = { name: 'اختر الأصناف المرتجعة' };

describe("today's sales list (M-N1, M-N2, M-N6)", () => {
  it('lists the terminal sales under the manager title, asking main with no scope', async () => {
    const sales = fakeRecentBridge();
    renderReturns({ sales });
    const list = await screen.findByRole('list', { name: COPY.terminalTitle });
    expect(screen.getByRole('heading', { name: COPY.terminalTitle })).toBeInTheDocument();
    const row = within(list).getByRole('button');
    expect(row).toHaveTextContent('47');
    expect(row).toHaveTextContent('09:15');
    expect(row).toHaveTextContent('152.50 EGP');
    expect(row).toHaveTextContent('نقدي');
    expect(row).toHaveTextContent('رنا الكاشير');
    expect(row).toHaveTextContent(FULL_NUMBER);
    // The renderer names no role, operator, terminal or date: main derives the scope.
    expect(sales.listRecent.mock.calls).toEqual([[{}]]);
  });

  it('says so when there are no sales today', async () => {
    renderReturns({ sales: fakeRecentBridge([]) });
    expect(await screen.findByText(COPY.terminalEmpty)).toBeInTheDocument();
  });

  it('says only the newest 300 are shown when main truncated the list', async () => {
    renderReturns({ sales: fakeRecentBridge([recentRow()], true) });
    expect(await screen.findByText(COPY.truncated)).toBeInTheDocument();
  });

  it('shows the print state in words that never claim a print happened', async () => {
    renderReturns({
      sales: fakeRecentBridge([
        recentRow({ latest_print_outcome: 'success' }),
        recentRow({
          sale_id: 's2',
          sale_number: 'T1-2026-11-05-000046',
          short_number: '46',
          latest_print_outcome: 'failure',
        }),
      ]),
    });
    expect(await screen.findByText(COPY.printSent)).toBeInTheDocument();
    expect(screen.getByText(COPY.printFailed)).toBeInTheDocument();
    expect(screen.queryByText(/طُبع/)).not.toBeInTheDocument();
  });

  it('leaves the screen working when the list cannot be read', async () => {
    renderReturns({ sales: { listRecent: () => Promise.reject(new Error('ipc')) } });
    expect(await screen.findByText(COPY.unavailable)).toBeInTheDocument();
    expect(field()).toBeEnabled();
  });
});

describe('picking a row', () => {
  it('runs returns.lookup with the exact number', async () => {
    const bridge = fakeBridge();
    renderReturns({ bridge, sales: fakeRecentBridge() });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: new RegExp(FULL_NUMBER) }));
    await screen.findByRole('heading', PICKER);
    expect(bridge.lookup.mock.calls).toEqual([[{ saleNumber: FULL_NUMBER }]]);
  });
});

describe('the number field (M-N8, M-N3, M-N4)', () => {
  it('shows the label and the hint', async () => {
    renderReturns({ sales: fakeRecentBridge() });
    expect(await screen.findByText(COPY.fieldHint)).toBeInTheDocument();
    expect(field()).toHaveAccessibleDescription(COPY.fieldHint);
  });

  it('resolves a short number to the exact one, then calls returns.lookup', async () => {
    const bridge = fakeBridge();
    const sales = fakeRecentBridge();
    renderReturns({ bridge, sales });
    await userEvent.setup().type(field(), '47{Enter}');
    await screen.findByRole('heading', PICKER);
    expect(sales.listRecent).toHaveBeenLastCalledWith({ short_number: '47' });
    expect(bridge.lookup.mock.calls).toEqual([[{ saleNumber: FULL_NUMBER }]]);
  });

  it('reads Arabic-Indic digits', async () => {
    const bridge = fakeBridge();
    renderReturns({ bridge, sales: fakeRecentBridge() });
    await userEvent.setup().type(field(), '٤٧{Enter}');
    await screen.findByRole('heading', PICKER);
    expect(bridge.lookup.mock.calls).toEqual([[{ saleNumber: FULL_NUMBER }]]);
  });

  it('passes a full number straight to returns.lookup without reading the list again', async () => {
    const bridge = fakeBridge();
    const sales = fakeRecentBridge();
    renderReturns({ bridge, sales });
    await screen.findByRole('list', { name: COPY.terminalTitle });
    sales.listRecent.mockClear();
    await userEvent.setup().type(field(), 'T1-000042{Enter}');
    await screen.findByRole('heading', PICKER);
    expect(bridge.lookup.mock.calls).toEqual([[{ saleNumber: 'T1-000042' }]]);
    expect(sales.listRecent).not.toHaveBeenCalled();
  });

  it('shows M-R1 and M-N3 when no sale today has that short number', async () => {
    const bridge = fakeBridge();
    renderReturns({ bridge, sales: fakeRecentBridge() });
    await userEvent.setup().type(field(), '999{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(refusalMessage('sale_not_found'));
    expect(alert).toHaveTextContent(COPY.notFoundEarlier);
    expect(bridge.lookup).not.toHaveBeenCalled();
  });

  it('shows M-N4 and the candidates for an ambiguous short number, and never picks one', async () => {
    const bridge = fakeBridge();
    const older = recentRow({
      sale_id: 's-old',
      sale_number: 'T1-2026-11-04-000047',
      finalized_at: '2026-11-05T00:30:00.000Z',
    });
    renderReturns({ bridge, sales: fakeRecentBridge([recentRow(), older]) });
    const user = userEvent.setup();
    await user.type(field(), '47{Enter}');
    expect(await screen.findByText(COPY.ambiguous)).toBeInTheDocument();
    expect(bridge.lookup).not.toHaveBeenCalled();
    const candidates = screen.getByRole('list', { name: COPY.ambiguousList });
    await user.click(within(candidates).getByRole('button', { name: /T1-2026-11-04-000047/ }));
    await screen.findByRole('heading', PICKER);
    expect(bridge.lookup.mock.calls).toEqual([[{ saleNumber: 'T1-2026-11-04-000047' }]]);
  });

  it('shows the generic failure when the short form cannot be resolved', async () => {
    const bridge = fakeBridge();
    renderReturns({ bridge, sales: { listRecent: () => Promise.reject(new Error('ipc')) } });
    await userEvent.setup().type(field(), '47{Enter}');
    await screen.findByRole('alert');
    expect(bridge.lookup).not.toHaveBeenCalled();
  });
});
