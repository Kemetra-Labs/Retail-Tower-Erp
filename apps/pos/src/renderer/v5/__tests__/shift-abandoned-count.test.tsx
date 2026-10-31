/**
 * RT-1003 — the renderer event of an abandoned blind count. The definition
 * (written down for the owner in the PR): a count is ABANDONED when the
 * cashier walks away from a blind count they entered and did not see through:
 *
 *   • the manager approval dialog is dismissed (Cancel or Escape), or the
 *     screen is left while it is open — the refused count it carries; or
 *   • the close panel is left (navigation, sign-out) holding a valid count
 *     that was never sent, or was edited since it was last sent.
 *
 * Each walk-away is reported once, fire-and-forget, with the amount only; the
 * answer is never shown. Leaving with nothing entered, an invalid or an
 * implausible entry, a count already sent unchanged, or after the close
 * reports nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { ShiftCloseResponse } from '../../../shared/shift-cashup/types';
import { V5ShiftRoute } from '../shift/V5ShiftRoute';
import { SHIFT_COPY } from '../shift/shift-copy';
import {
  MANAGERS,
  MONEY_TEXT,
  enableShiftFlag,
  fakeShiftBridge,
  openShiftView,
  renderAt,
  resetShiftStores,
  signIn,
  statusView,
  type FakeShiftBridge,
} from './__helpers__/shift-test-kit';

afterEach(() => {
  cleanup();
  resetShiftStores();
});

const NEEDS_APPROVAL: ShiftCloseResponse = {
  kind: 'refused',
  reason: 'variance_approval_required',
};

async function startClose() {
  const bridge = fakeShiftBridge(statusView({ openShift: openShiftView() }));
  signIn('cashier');
  enableShiftFlag();
  const view = renderAt({
    path: '/app/shift',
    pattern: '/app/shift',
    element: <V5ShiftRoute bridge={bridge} />,
  });
  const panel = await screen.findByTestId('shift-close-panel');
  return { bridge, panel, unmount: view.unmount };
}

function typeCount(value: string): void {
  fireEvent.change(screen.getByLabelText(SHIFT_COPY.countLabel), { target: { value } });
}

function press(name: string, scope: HTMLElement): void {
  fireEvent.click(within(scope).getByRole('button', { name }));
}

async function reachApproval(bridge: FakeShiftBridge, panel: HTMLElement): Promise<HTMLElement> {
  bridge.close.mockResolvedValueOnce(NEEDS_APPROVAL);
  typeCount('520');
  press(SHIFT_COPY.closeCommit, panel);
  const dialog = await screen.findByRole('dialog', { name: SHIFT_COPY.approvalTitle });
  await within(dialog).findByRole('radio', { name: MANAGERS[0].displayName });
  return dialog;
}

describe('leaving the close panel', () => {
  it('reports a valid count that was never sent, once, with the amount only', async () => {
    const { bridge, unmount } = await startClose();
    typeCount('٥٢٠');
    unmount();
    expect(bridge.abandonCount).toHaveBeenCalledTimes(1);
    expect(bridge.abandonCount).toHaveBeenCalledWith({ countedCashMinor: 52_000 });
    expect(bridge.close).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing entered', ''],
    ['only spaces', '   '],
    ['an invalid amount', '1.234'],
    ['an implausible amount (scanner digits)', '62221234567890'],
  ])('reports nothing for %s', async (_case, value) => {
    const { bridge, unmount } = await startClose();
    if (value !== '') typeCount(value);
    unmount();
    expect(bridge.abandonCount).not.toHaveBeenCalled();
  });

  it('reports nothing after the shift closed', async () => {
    const { bridge, panel, unmount } = await startClose();
    bridge.status.mockResolvedValue({ kind: 'status', status: statusView() });
    typeCount('515');
    press(SHIFT_COPY.closeCommit, panel);
    await screen.findByTestId('shift-closed-outcome');
    unmount();
    expect(bridge.abandonCount).not.toHaveBeenCalled();
  });

  it('reports nothing for a count sent and refused, left unchanged', async () => {
    const { bridge, panel, unmount } = await startClose();
    bridge.close.mockResolvedValue({ kind: 'refused', reason: 'drawer_activity_pending' });
    typeCount('515');
    press(SHIFT_COPY.closeCommit, panel);
    await within(panel).findByRole('alert');
    unmount();
    expect(bridge.abandonCount).not.toHaveBeenCalled();
  });

  it('reports a count edited after it was sent', async () => {
    const { bridge, panel, unmount } = await startClose();
    bridge.close.mockResolvedValue({ kind: 'refused', reason: 'drawer_activity_pending' });
    typeCount('515');
    press(SHIFT_COPY.closeCommit, panel);
    await within(panel).findByRole('alert');
    typeCount('516');
    unmount();
    expect(bridge.abandonCount).toHaveBeenCalledTimes(1);
    expect(bridge.abandonCount).toHaveBeenCalledWith({ countedCashMinor: 51_600 });
  });
});

describe('dismissing the manager approval', () => {
  it('reports the refused count once on Cancel, and not again on leaving', async () => {
    const { bridge, panel, unmount } = await startClose();
    const dialog = await reachApproval(bridge, panel);
    press(SHIFT_COPY.cancel, dialog);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(bridge.abandonCount).toHaveBeenCalledTimes(1);
    expect(bridge.abandonCount).toHaveBeenCalledWith({ countedCashMinor: 52_000 });
    unmount();
    expect(bridge.abandonCount).toHaveBeenCalledTimes(1);
  });

  it('reports it on Escape', async () => {
    const { bridge, panel } = await startClose();
    const dialog = await reachApproval(bridge, panel);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => {
      expect(bridge.abandonCount).toHaveBeenCalledWith({ countedCashMinor: 52_000 });
    });
  });

  it('reports it once when the screen is left with the dialog open', async () => {
    const { bridge, panel, unmount } = await startClose();
    await reachApproval(bridge, panel);
    unmount();
    expect(bridge.abandonCount).toHaveBeenCalledTimes(1);
    expect(bridge.abandonCount).toHaveBeenCalledWith({ countedCashMinor: 52_000 });
  });

  it('reports nothing when the approval went stale (the cashier counts again)', async () => {
    const { bridge, panel, unmount } = await startClose();
    const dialog = await reachApproval(bridge, panel);
    bridge.close.mockResolvedValueOnce({ kind: 'refused', reason: 'approval_stale' });
    fireEvent.click(within(dialog).getByRole('radio', { name: MANAGERS[0].displayName }));
    fireEvent.change(within(dialog).getByLabelText(SHIFT_COPY.pinLabel), {
      target: { value: '246813' },
    });
    press(SHIFT_COPY.approveCommit, dialog);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    unmount();
    expect(bridge.abandonCount).not.toHaveBeenCalled();
  });

  it('shows nothing of the answer, and a failed report is silent', async () => {
    const { bridge, panel } = await startClose();
    bridge.abandonCount.mockRejectedValueOnce(new Error('ipc down: expected 515.00 EGP'));
    const dialog = await reachApproval(bridge, panel);
    press(SHIFT_COPY.cancel, dialog);
    await waitFor(() => {
      expect(bridge.abandonCount).toHaveBeenCalledTimes(1);
    });
    expect(within(panel).queryByRole('alert')).not.toBeInTheDocument();
    expect(panel.textContent).not.toMatch(MONEY_TEXT);
    expect(document.body.textContent).not.toContain('ipc down');
  });
});
