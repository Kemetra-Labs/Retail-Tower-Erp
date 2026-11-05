/**
 * RT-1193 — the manager home's one count per tile, from reads that already
 * exist: `recovery.listHeld()` (the recovery tile) and `operator.listStuckShifts()`
 * (the stuck-shifts tile). A count shows only for a clean answer above zero:
 * never «0», never a spinner, nothing while loading or after a failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { ListStuckShiftsResponse } from '../../../../../shared/bridge-api';
import type { RecoveryListHeldResponse } from '../../../../../shared/operator/recovery';
import { DashboardRoute } from '../../../../routes/app/DashboardRoute';
import { expectNoAxeViolations } from '../../../../test-utils/axe-config';
import {
  fakeBridges,
  heldCart,
  heldView,
  stuckAttempt,
} from '../../../recovery/__tests__/__helpers__/recovery-fixtures';
import {
  enableShiftFlag,
  renderAt,
  resetShiftStores,
  signIn,
} from '../../../__tests__/__helpers__/shift-test-kit';
import { HOME_COPY } from '../home-copy';

afterEach(() => {
  cleanup();
  resetShiftStores();
  delete (window as unknown as { api?: unknown }).api;
});

const DIGIT = /[0-9٠-٩]/;

type Answer<T> = T | 'pending' | 'reject';

function answer<T>(value: Answer<T>): Promise<T> {
  if (value === 'pending') return new Promise<T>(() => undefined);
  if (value === 'reject') return Promise.reject(new Error('bridge down'));
  return Promise.resolve(value);
}

function stuckShifts(n: number): ListStuckShiftsResponse {
  return {
    kind: 'stuck_shifts',
    shifts: Array.from({ length: n }, (_, i) => ({
      shift_id: `shift-${String(i)}`,
      cashier_display_name: 'أحمد سمير',
      terminal_label: 'POS-01',
      opened_at: '2026-10-15T06:00:00Z',
      duration_minutes: 190,
    })),
  };
}

interface Reads {
  held?: Answer<RecoveryListHeldResponse>;
  shifts?: Answer<ListStuckShiftsResponse>;
}

function mount(reads: Reads) {
  signIn('manager');
  enableShiftFlag();
  const bridges = fakeBridges();
  bridges.recovery.listHeld.mockImplementation(() => answer(reads.held ?? heldView()));
  const listStuckShifts = vi.fn(() => answer(reads.shifts ?? stuckShifts(0)));
  (window as unknown as { api: unknown }).api = {
    recovery: bridges.recovery,
    approval: bridges.approval,
    operator: { listStuckShifts },
  };
  const view = renderAt({
    path: '/app/dashboard',
    pattern: '/app/dashboard',
    element: <DashboardRoute />,
  });
  return { ...view, bridges, listStuckShifts };
}

const recoveryTile = (): HTMLElement =>
  screen.getByRole('link', { name: HOME_COPY.recovery.title });
const shiftsTile = (): HTMLElement =>
  screen.getByRole('link', { name: HOME_COPY.stuckShifts.title });
const countOf = (tile: HTMLElement): HTMLElement | null =>
  tile.querySelector('.v5-manager-tile__count');

describe('the recovery tile count (listHeld)', () => {
  it('shows the held sales as a figure, a dot and text', async () => {
    mount({
      held: heldView({
        held: [heldCart(), heldCart({ cart_id: 'c2' }), heldCart({ cart_id: 'c3' })],
      }),
    });
    await waitFor(() => {
      expect(countOf(recoveryTile())).not.toBeNull();
    });
    const count = countOf(recoveryTile());
    expect(count).toHaveTextContent('3');
    expect(count).toHaveTextContent('مبيعات محفوظة');
    expect(count?.querySelector('.v5-manager-tile__dot')).toHaveAttribute('aria-hidden', 'true');
  });

  it('uses the Arabic plural for one and two held sales', async () => {
    mount({ held: heldView({ held: [heldCart()] }) });
    await waitFor(() => {
      expect(countOf(recoveryTile())).toHaveTextContent('1');
    });
    expect(countOf(recoveryTile())).toHaveTextContent('بيع محفوظ');
    expect(countOf(recoveryTile())).not.toHaveTextContent('مبيعات');
  });

  it('puts a stuck payment first: the line names the payment, not the held sales', async () => {
    mount({
      held: heldView({ stuck: stuckAttempt(), held: [heldCart(), heldCart({ cart_id: 'c2' })] }),
    });
    await waitFor(() => {
      expect(countOf(recoveryTile())).not.toBeNull();
    });
    expect(countOf(recoveryTile())).toHaveTextContent('دفع معلّق');
    expect(countOf(recoveryTile())).not.toHaveTextContent('محفوظ');
  });

  it('adds the count to the tile description, and keeps the name the title alone', async () => {
    mount({ held: heldView({ held: [heldCart(), heldCart({ cart_id: 'c2' })] }) });
    await waitFor(() => {
      expect(countOf(recoveryTile())).not.toBeNull();
    });
    expect(recoveryTile()).toHaveAccessibleName(HOME_COPY.recovery.title);
    expect(recoveryTile()).toHaveAccessibleDescription(/المبيعات|دفع معلّق، أو/);
    expect(recoveryTile()).toHaveAccessibleDescription(/2/);
  });

  it('reads once: the recovery-mode redirect and the count share one listHeld call', async () => {
    const { bridges } = mount({ held: heldView({ held: [heldCart()] }) });
    await waitFor(() => {
      expect(countOf(recoveryTile())).not.toBeNull();
    });
    expect(bridges.recovery.listHeld).toHaveBeenCalledTimes(1);
  });

  const refusedHeld: RecoveryListHeldResponse = { kind: 'refused', reason: 'role_mismatch' };
  it.each<[string, RecoveryListHeldResponse]>([
    ['nothing held', heldView()],
    ['a refusal', refusedHeld],
  ])('shows nothing for %s', async (_name, held) => {
    const { bridges } = mount({ held });
    await waitFor(() => {
      expect(bridges.recovery.listHeld).toHaveBeenCalled();
    });
    await Promise.resolve();
    expect(countOf(recoveryTile())).toBeNull();
  });

  it.each([['pending' as const], ['reject' as const]])(
    'shows nothing while the read is %s',
    async (held) => {
      const { bridges } = mount({ held });
      await waitFor(() => {
        expect(bridges.recovery.listHeld).toHaveBeenCalled();
      });
      await Promise.resolve();
      expect(countOf(recoveryTile())).toBeNull();
    },
  );
});

describe('the stuck-shifts tile count (listStuckShifts)', () => {
  it('shows the stuck shifts as a figure, a dot and text', async () => {
    mount({ shifts: stuckShifts(4) });
    await waitFor(() => {
      expect(countOf(shiftsTile())).not.toBeNull();
    });
    expect(countOf(shiftsTile())).toHaveTextContent('4');
    expect(countOf(shiftsTile())).toHaveTextContent('ورديات عالقة');
  });

  it('uses the dual for two shifts', async () => {
    mount({ shifts: stuckShifts(2) });
    await waitFor(() => {
      expect(countOf(shiftsTile())).not.toBeNull();
    });
    expect(countOf(shiftsTile())).toHaveTextContent('ورديتان عالقتان');
  });

  it.each<[string, ListStuckShiftsResponse]>([
    ['zero shifts', stuckShifts(0)],
    ['a refusal', { kind: 'refused', category: 'no_connection' }],
    ['a reauth refusal', { kind: 'refused', category: 'reauth_required' }],
  ])('shows nothing for %s', async (_name, shifts) => {
    const { listStuckShifts } = mount({ shifts });
    await waitFor(() => {
      expect(listStuckShifts).toHaveBeenCalled();
    });
    await Promise.resolve();
    expect(countOf(shiftsTile())).toBeNull();
  });

  it.each([['pending' as const], ['reject' as const]])(
    'shows nothing while the read is %s',
    async (shifts) => {
      const { listStuckShifts } = mount({ shifts });
      await waitFor(() => {
        expect(listStuckShifts).toHaveBeenCalled();
      });
      await Promise.resolve();
      expect(countOf(shiftsTile())).toBeNull();
    },
  );

  it('shows nothing when the operator bridge is missing', () => {
    signIn('manager');
    enableShiftFlag();
    renderAt({ path: '/app/dashboard', pattern: '/app/dashboard', element: <DashboardRoute /> });
    expect(countOf(shiftsTile())).toBeNull();
  });
});

describe('never «0», never a spinner', () => {
  it.each([
    ['zero counts', { held: heldView(), shifts: stuckShifts(0) }],
    ['reads that never answer', { held: 'pending' as const, shifts: 'pending' as const }],
    ['reads that fail', { held: 'reject' as const, shifts: 'reject' as const }],
  ])('puts no digit and no status on the home for %s', async (_name, reads) => {
    const { bridges, listStuckShifts } = mount(reads);
    await waitFor(() => {
      expect(bridges.recovery.listHeld).toHaveBeenCalled();
      expect(listStuckShifts).toHaveBeenCalled();
    });
    await Promise.resolve();
    expect(screen.getByTestId('v5-screen-section').textContent).not.toMatch(DIGIT);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

describe('with counts', () => {
  it('has no axe violations', async () => {
    const { container } = mount({
      held: heldView({ held: [heldCart(), heldCart({ cart_id: 'c2' })] }),
      shifts: stuckShifts(3),
    });
    await waitFor(() => {
      expect(countOf(shiftsTile())).not.toBeNull();
      expect(countOf(recoveryTile())).not.toBeNull();
    });
    await expectNoAxeViolations(container);
  });
});
