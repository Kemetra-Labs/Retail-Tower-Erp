/**
 * RT-1442 — a shift a manager closed on the server without a count: the
 * cashier and the manager see «أغلق مدير هذه الوردية دون عدّ.» in the frame
 * gate and on the shift screen, with the way to open a new shift. Once a newer
 * shift is open, or when no shift was closed that way, the line is not shown.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { ShiftNotice } from '../shift/ShiftNotice';
import { V5ShiftRoute } from '../shift/V5ShiftRoute';
import { SHIFT_COPY } from '../shift/shift-copy';
import {
  FLOAT_FIELD,
  enableShiftFlag,
  fakeShiftBridge,
  openShiftView,
  renderAt,
  resetShiftStores,
  signIn,
  statusView,
} from './__helpers__/shift-test-kit';

afterEach(() => {
  cleanup();
  resetShiftStores();
});

const MESSAGE = 'أغلق مدير هذه الوردية دون عدّ.';

describe('the manager-closed line (RT-1442)', () => {
  it('is the owner-approved wording', () => {
    expect(SHIFT_COPY.managerClosed).toBe(MESSAGE);
  });

  it.each(['cashier', 'manager'] as const)(
    'the frame gate tells a %s, above the open-a-shift line and its link',
    async (role) => {
      signIn(role);
      enableShiftFlag();
      renderAt({
        path: '/app/cart',
        pattern: '/app/*',
        element: <ShiftNotice bridge={fakeShiftBridge(statusView({ managerClosed: true }))} />,
      });
      const banner = await screen.findByTestId('shift-gate-banner');
      expect(screen.getByTestId('shift-manager-closed')).toHaveTextContent(MESSAGE);
      expect(banner).toHaveTextContent(SHIFT_COPY.gateBanner);
      expect(screen.getByRole('link', { name: SHIFT_COPY.gateAction })).toHaveAttribute(
        'href',
        '/app/shift',
      );
    },
  );

  it('the frame gate does not say it while a shift is open', async () => {
    signIn('cashier');
    enableShiftFlag();
    renderAt({
      path: '/app/cart',
      pattern: '/app/*',
      element: (
        <ShiftNotice
          bridge={fakeShiftBridge(statusView({ openShift: openShiftView(), managerClosed: false }))}
        />
      ),
    });
    expect(await screen.findByRole('link', { name: SHIFT_COPY.manageShift })).toBeInTheDocument();
    expect(screen.queryByTestId('shift-manager-closed')).not.toBeInTheDocument();
  });

  it('the shift screen tells the cashier and offers the opening form; opening clears it', async () => {
    signIn('cashier');
    enableShiftFlag();
    const bridge = fakeShiftBridge(statusView({ managerClosed: true }));
    renderAt({
      path: '/app/shift',
      pattern: '/app/shift',
      element: <V5ShiftRoute bridge={bridge} />,
    });
    expect(await screen.findByTestId('shift-manager-closed')).toHaveTextContent(MESSAGE);
    expect(screen.getByLabelText(FLOAT_FIELD)).toBeInTheDocument();

    bridge.status.mockResolvedValue({
      kind: 'status',
      status: statusView({ openShift: openShiftView(), managerClosed: false }),
    });
    fireEvent.change(screen.getByLabelText(FLOAT_FIELD), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: SHIFT_COPY.openCommit }));
    await waitFor(() => {
      expect(bridge.open).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('shift-manager-closed')).not.toBeInTheDocument();
    });
  });

  it.each([
    { surface: 'the frame gate', path: '/app/cart', pattern: '/app/*', ready: 'shift-gate-banner' },
    { surface: 'the shift screen', path: '/app/shift', pattern: '/app/shift', ready: null },
  ])('$surface does not say it when no shift was closed that way', async (c) => {
    signIn('cashier');
    enableShiftFlag();
    const bridge = fakeShiftBridge();
    const element =
      c.ready === null ? <V5ShiftRoute bridge={bridge} /> : <ShiftNotice bridge={bridge} />;
    renderAt({ path: c.path, pattern: c.pattern, element });
    if (c.ready === null) expect(await screen.findByLabelText(FLOAT_FIELD)).toBeInTheDocument();
    else expect(await screen.findByTestId(c.ready)).toBeInTheDocument();
    expect(screen.queryByTestId('shift-manager-closed')).not.toBeInTheDocument();
  });
});
