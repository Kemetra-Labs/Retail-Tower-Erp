/**
 * RT-1192 (RT-249 N-S3, doc 20 §4, §7) — Void: the same short-number field and
 * today's list before `saleVoid.lookup`. A cashier sees «مبيعاتك اليوم» (main
 * already limits the rows to their own); a manager sees the terminal's sales.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { Role } from '../../../../shared/operator/role';
import { SALE_LOOKUP_COPY as COPY } from '../../../sale-lookup/sale-lookup-copy';
import {
  FULL_NUMBER,
  fakeRecentBridge,
  recentRow,
  type FakeRecentBridge,
} from '../../../sale-lookup/__tests__/recent-fixtures';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { VOID_COPY, voidRefusalMessage } from '../void-copy';
import { VoidScreen } from '../VoidScreen';
import { fakeBridges, type FakeBridges } from './__helpers__/void-fixtures';

afterEach(() => {
  cleanup();
  useOperatorSessionStore.getState().reset();
});

function show(role: Role = 'manager', sales: FakeRecentBridge = fakeRecentBridge()) {
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 's1',
        operator_id: 'op1',
        display_name: 'مستخدم',
        role,
        tenant_id: 't1',
        branch_id: 'b1',
        started_at: '2026-11-05T06:00:00.000Z',
      },
    },
  });
  const bridges: FakeBridges = { ...fakeBridges(), sales };
  render(<VoidScreen bridges={bridges} refreshMs={0} />);
  return { bridges, sales };
}

const field = () => screen.getByLabelText(VOID_COPY.numberLabel);

describe("today's sales list", () => {
  it('shows a cashier «مبيعاتك اليوم» with no seller column', async () => {
    const { sales } = show('cashier');
    const list = await screen.findByRole('list', { name: COPY.ownTitle });
    expect(screen.getByRole('heading', { name: COPY.ownTitle })).toBeInTheDocument();
    expect(within(list).getByRole('button')).not.toHaveTextContent('رنا الكاشير');
    expect(sales.listRecent.mock.calls).toEqual([[{}]]);
  });

  it('shows a manager the terminal title and the seller', async () => {
    show('manager');
    const list = await screen.findByRole('list', { name: COPY.terminalTitle });
    expect(within(list).getByRole('button')).toHaveTextContent('رنا الكاشير');
  });

  it('shows the empty line for the scope', async () => {
    show('cashier', fakeRecentBridge([]));
    expect(await screen.findByText(COPY.ownEmpty)).toBeInTheDocument();
  });

  it('picking a row fills the field and runs saleVoid.lookup with the exact number', async () => {
    const { bridges } = show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: new RegExp(FULL_NUMBER) }));
    await screen.findByTestId('void-sale');
    expect(bridges.saleVoid.lookup.mock.calls).toEqual([[{ sale_number: FULL_NUMBER }]]);
    expect(field()).toHaveValue(FULL_NUMBER);
  });
});

describe('the number field', () => {
  it('resolves a short number, in Arabic-Indic digits too, before saleVoid.lookup', async () => {
    const { bridges, sales } = show();
    await userEvent.setup().type(field(), '٤٧{Enter}');
    await screen.findByTestId('void-sale');
    expect(sales.listRecent).toHaveBeenLastCalledWith({ short_number: '47' });
    expect(bridges.saleVoid.lookup.mock.calls).toEqual([[{ sale_number: FULL_NUMBER }]]);
  });

  it('passes a full number unchanged without reading the list again', async () => {
    const { bridges, sales } = show();
    await screen.findByRole('list', { name: COPY.terminalTitle });
    sales.listRecent.mockClear();
    await userEvent.setup().type(field(), 'T1-2026-11-05-000047{Enter}');
    await screen.findByTestId('void-sale');
    expect(bridges.saleVoid.lookup.mock.calls).toEqual([[{ sale_number: FULL_NUMBER }]]);
    expect(sales.listRecent).not.toHaveBeenCalled();
  });

  it('shows the label hint (M-N8)', () => {
    show();
    expect(field()).toHaveAccessibleDescription(COPY.fieldHint);
  });

  it('shows not-found and M-N3 when no sale today has that short number', async () => {
    const { bridges } = show();
    await userEvent.setup().type(field(), '999{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(voidRefusalMessage('sale_not_found'));
    expect(alert).toHaveTextContent(COPY.notFoundEarlier);
    expect(bridges.saleVoid.lookup).not.toHaveBeenCalled();
  });

  it('shows M-N4 with the candidates for an ambiguous number and never picks', async () => {
    const older = recentRow({ sale_id: 's-old', sale_number: 'T1-2026-11-04-000047' });
    const { bridges } = show('manager', fakeRecentBridge([recentRow(), older]));
    const user = userEvent.setup();
    await user.type(field(), '47{Enter}');
    expect(await screen.findByText(COPY.ambiguous)).toBeInTheDocument();
    expect(bridges.saleVoid.lookup).not.toHaveBeenCalled();
    const candidates = screen.getByRole('list', { name: COPY.ambiguousList });
    await user.click(within(candidates).getByRole('button', { name: /T1-2026-11-04-000047/ }));
    await screen.findByTestId('void-sale');
    expect(bridges.saleVoid.lookup.mock.calls).toEqual([[{ sale_number: 'T1-2026-11-04-000047' }]]);
  });
});
