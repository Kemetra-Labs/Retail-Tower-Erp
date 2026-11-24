/**
 * RT-1563 — a manager cancels several PARKED sales with one confirmation. The screen only ticks
 * sales; what the PIN covers is the snapshot main takes (`prepareCancelHeldCarts`), so these tests
 * pin: who may tick (parked drafts, two or more, with a PIN), that nothing is ticked by default, the
 * scope shown BEFORE the PIN, the approval bound to the snapshot reference, and that only what main
 * reports cancelled is claimed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { formatCheckoutMoney } from '../../../ui/payments/format-checkout-money';
import { RecoveryScreen } from '../RecoveryScreen';
import { RECOVERY_ACTION_KIND, recoverySubjectOf } from '../recovery-actions';
import {
  RECOVERY_COPY,
  batchCancelled,
  batchWillCancel,
  recoveryRefusalMessage,
} from '../recovery-copy';
import { fakeBridges, heldCart, heldView, type FakeBridges } from './__helpers__/recovery-fixtures';

afterEach(cleanup);

const parked = (id: string, over: Parameters<typeof heldCart>[0] = {}) =>
  heldCart({ cart_id: id, parked: true, total_minor: 2_000, ...over });

function show(bridges: FakeBridges): FakeBridges {
  render(<RecoveryScreen bridges={bridges} />);
  return bridges;
}

const rowBoxes = () =>
  screen.queryAllByRole('checkbox', { name: new RegExp(RECOVERY_COPY.selectRow) });
const selectAll = () => screen.getByRole('checkbox', { name: RECOVERY_COPY.selectAllParked });
const cancelSelected = () => screen.getByRole('button', { name: RECOVERY_COPY.cancelSelected });

async function bulkScreen(
  extra = {},
): Promise<{ bridges: FakeBridges; user: ReturnType<typeof userEvent.setup> }> {
  const bridges = show(
    fakeBridges(
      heldView({
        held: [parked('p1'), parked('p2'), parked('p3'), ...Object.values(extra)] as never,
      }),
    ),
  );
  await screen.findByRole('checkbox', { name: RECOVERY_COPY.selectAllParked });
  return { bridges, user: userEvent.setup() };
}

describe('RecoveryScreen — bulk cancel: who may tick', () => {
  it('offers selection for two or more parked drafts: one box per sale, nothing ticked, action disabled', async () => {
    await bulkScreen();
    expect(rowBoxes()).toHaveLength(3);
    for (const box of rowBoxes()) expect(box).not.toBeChecked();
    expect(selectAll()).not.toBeChecked();
    expect(cancelSelected()).toBeDisabled();
    expect(screen.getByText(new RegExp(`^${RECOVERY_COPY.selectedLabel}:`))).toHaveTextContent('0');
  });

  it('keeps the single-sale button on every row, including parked ones', async () => {
    await bulkScreen();
    expect(screen.getAllByRole('button', { name: RECOVERY_COPY.cancelSale })).toHaveLength(3);
  });

  it('offers no selection for a single parked draft', async () => {
    show(fakeBridges(heldView({ held: [parked('p1')] })));
    await screen.findByRole('button', { name: RECOVERY_COPY.cancelSale });
    expect(rowBoxes()).toHaveLength(0);
    expect(screen.queryByRole('checkbox', { name: RECOVERY_COPY.selectAllParked })).toBeNull();
  });

  it('only a PARKED DRAFT gets a box: not an unparked draft, not a handed-off sale', async () => {
    show(
      fakeBridges(
        heldView({
          held: [
            parked('p1'),
            parked('p2'),
            heldCart({ cart_id: 'u1', parked: false }),
            heldCart({ cart_id: 'h1', kind: 'handed_off', parked: false }),
          ],
        }),
      ),
    );
    await screen.findByRole('checkbox', { name: RECOVERY_COPY.selectAllParked });
    expect(rowBoxes()).toHaveLength(2);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('offers no selection without a manager PIN (RT-846)', async () => {
    const bridges = fakeBridges(heldView({ held: [parked('p1'), parked('p2')] }));
    bridges.approval.listApprovers.mockResolvedValue({ kind: 'approvers', approvers: [] });
    show(bridges);
    expect(await screen.findByText(RECOVERY_COPY.cancelSaleNoPin)).toBeInTheDocument();
    expect(rowBoxes()).toHaveLength(0);
  });
});

describe('RecoveryScreen — bulk cancel: selecting', () => {
  it('ticks and unticks one sale, and the count follows', async () => {
    const { user } = await bulkScreen();
    const [first] = rowBoxes();
    if (first === undefined) throw new Error('no box');
    await user.click(first);
    expect(first).toBeChecked();
    expect(cancelSelected()).toBeEnabled();
    expect(screen.getByText(new RegExp(`^${RECOVERY_COPY.selectedLabel}:`))).toHaveTextContent('1');
    await user.click(first);
    expect(first).not.toBeChecked();
    expect(cancelSelected()).toBeDisabled();
  });

  it('select all ticks every parked draft, and again clears them', async () => {
    const { user } = await bulkScreen();
    await user.click(selectAll());
    for (const box of rowBoxes()) expect(box).toBeChecked();
    expect(selectAll()).toBeChecked();
    expect(screen.getByText(new RegExp(`^${RECOVERY_COPY.selectedLabel}:`))).toHaveTextContent('3');
    await user.click(selectAll());
    for (const box of rowBoxes()) expect(box).not.toBeChecked();
  });
});

describe('RecoveryScreen — bulk cancel: scope before the PIN, then one approval', () => {
  it('snapshots in main, shows count, total and consequence, asks the approver for the batch kind', async () => {
    const { bridges, user } = await bulkScreen();
    await user.click(selectAll());
    await user.click(cancelSelected());
    const dialog = await screen.findByRole('dialog');
    expect(bridges.recovery.prepareCancelHeldCarts).toHaveBeenCalledWith({
      cart_ids: ['p1', 'p2', 'p3'],
    });
    // The scope comes from main's snapshot (3 sales, 3 x 1,000 in the fake), before any PIN.
    expect(within(dialog).getByText(batchWillCancel(3))).toBeInTheDocument();
    expect(within(dialog).getByText(RECOVERY_COPY.cannotUndo)).toBeInTheDocument();
    expect(within(dialog).getByText(formatCheckoutMoney(3_000))).toBeInTheDocument();
    expect(bridges.recovery.cancelHeldCarts).not.toHaveBeenCalled();
    expect(bridges.approval.listApprovers).toHaveBeenCalledWith({
      action_kind: 'recovery.cancel_held_carts',
    });
    // The safe option has the focus, as for every destructive confirmation.
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: RECOVERY_COPY.back })).toHaveFocus();
    });
  });

  it('requests ONE approval for the snapshot reference, then spends it once', async () => {
    const { bridges, user } = await bulkScreen();
    await user.click(selectAll());
    await user.click(cancelSelected());
    const dialog = await screen.findByRole('dialog');
    await user.type(
      await within(dialog).findByLabelText(new RegExp(RECOVERY_COPY.pinLabel)),
      '246810',
    );
    await user.click(within(dialog).getByRole('button', { name: RECOVERY_COPY.approve }));
    expect(await screen.findByText(batchCancelled(3))).toBeInTheDocument();
    expect(bridges.approval.request).toHaveBeenCalledTimes(1);
    expect(bridges.approval.request).toHaveBeenCalledWith(
      expect.objectContaining({
        action_kind: 'recovery.cancel_held_carts',
        subject_ref: 'batch-1',
        reason_code: 'manager_recovery',
      }),
    );
    expect(bridges.recovery.cancelHeldCarts).toHaveBeenCalledTimes(1);
    expect(bridges.recovery.cancelHeldCarts).toHaveBeenCalledWith({
      batch_id: 'batch-1',
      approval_id: 'approval-1',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    // The list is read again and the ticks are cleared.
    await waitFor(() => {
      expect(bridges.recovery.listHeld).toHaveBeenCalledTimes(2);
    });
    for (const box of rowBoxes()) expect(box).not.toBeChecked();
  });

  it('names the selected sales main left out (no longer a parked draft)', async () => {
    const bridges = fakeBridges(heldView({ held: [parked('p1'), parked('p2')] }));
    bridges.recovery.prepareCancelHeldCarts.mockResolvedValue({
      kind: 'prepared',
      batch_id: 'batch-9',
      count: 1,
      total_minor: 2_000,
      excluded_cart_ids: ['p2'],
    });
    show(bridges);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: RECOVERY_COPY.selectAllParked }));
    await user.click(cancelSelected());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(batchWillCancel(1))).toBeInTheDocument();
    expect(within(dialog).getByText(new RegExp(RECOVERY_COPY.excludedLabel))).toHaveTextContent(
      '1',
    );
  });

  it('a refused PIN never reaches the cancel, and the dialog stays open', async () => {
    const { bridges, user } = await bulkScreen();
    bridges.approval.request.mockResolvedValue({ kind: 'refused', reason: 'approval_unavailable' });
    await user.click(selectAll());
    await user.click(cancelSelected());
    const dialog = await screen.findByRole('dialog');
    await user.type(
      await within(dialog).findByLabelText(new RegExp(RECOVERY_COPY.pinLabel)),
      '246810',
    );
    await user.click(within(dialog).getByRole('button', { name: RECOVERY_COPY.approve }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      recoveryRefusalMessage('approval_unavailable'),
    );
    expect(bridges.recovery.cancelHeldCarts).not.toHaveBeenCalled();
  });

  it('رجوع closes the dialog and cancels nothing, but reads the list again', async () => {
    const { bridges, user } = await bulkScreen();
    await user.click(selectAll());
    await user.click(cancelSelected());
    await user.click(await screen.findByRole('button', { name: RECOVERY_COPY.back }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bridges.recovery.cancelHeldCarts).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(bridges.recovery.listHeld).toHaveBeenCalledTimes(2);
    });
  });
});

describe('RecoveryScreen — bulk cancel: claims only what main proved', () => {
  async function approveBatch(bridges: FakeBridges, user: ReturnType<typeof userEvent.setup>) {
    await user.click(selectAll());
    await user.click(cancelSelected());
    const dialog = await screen.findByRole('dialog');
    await user.type(
      await within(dialog).findByLabelText(new RegExp(RECOVERY_COPY.pinLabel)),
      '246810',
    );
    await user.click(within(dialog).getByRole('button', { name: RECOVERY_COPY.approve }));
    return { bridges, dialog };
  }

  it('a partial result says what was cancelled and how many were left', async () => {
    const { bridges, user } = await bulkScreen();
    bridges.recovery.cancelHeldCarts.mockResolvedValue({
      kind: 'cancelled_batch',
      cancelled_cart_ids: ['p1', 'p3'],
      skipped: [{ cart_id: 'p2', reason: 'changed' }],
    });
    await approveBatch(bridges, user);
    const notice = await screen.findByText(new RegExp(batchCancelled(2)));
    expect(notice).toHaveTextContent(`${RECOVERY_COPY.skippedLabel}: 1`);
    expect(notice).not.toHaveTextContent(batchCancelled(3));
  });

  it('when nothing was cancelled the dialog closes, the list is re-read, and a WARNING says so', async () => {
    const { bridges, user } = await bulkScreen();
    bridges.recovery.cancelHeldCarts.mockResolvedValue({
      kind: 'cancelled_batch',
      cancelled_cart_ids: [],
      skipped: [
        { cart_id: 'p1', reason: 'changed' },
        { cart_id: 'p2', reason: 'no_longer_held' },
        { cart_id: 'p3', reason: 'changed' },
      ],
    });
    await approveBatch(bridges, user);
    // The consumed batch is not offered again: the dialog is gone, and the list was read again.
    const notice = await screen.findByText(RECOVERY_COPY.batchNoneCancelled);
    expect(notice.closest('[data-tone]')).toHaveAttribute('data-tone', 'warning');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(bridges.recovery.listHeld).toHaveBeenCalledTimes(2);
    });
    expect(bridges.recovery.cancelHeldCarts).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(new RegExp(RECOVERY_COPY.skippedLabel))).toBeNull();
  });

  it('a spent or stale approval is refused with its own message', async () => {
    const { bridges, user } = await bulkScreen();
    bridges.recovery.cancelHeldCarts.mockResolvedValue({
      kind: 'refused',
      reason: 'approval_stale',
    });
    const { dialog } = await approveBatch(bridges, user);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      recoveryRefusalMessage('approval_stale'),
    );
  });

  it('a prepare with nothing eligible shows one message, opens no dialog and reads the list again', async () => {
    const bridges = fakeBridges(heldView({ held: [parked('p1'), parked('p2')] }));
    bridges.recovery.prepareCancelHeldCarts.mockResolvedValue({
      kind: 'refused',
      reason: 'not_found',
    });
    show(bridges);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: RECOVERY_COPY.selectAllParked }));
    await user.click(cancelSelected());
    expect(await screen.findByRole('alert')).toHaveTextContent(RECOVERY_COPY.batchNoneEligible);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(bridges.recovery.listHeld).toHaveBeenCalledTimes(2);
    });
  });

  it('a prepare that throws says unavailable and keeps the selection', async () => {
    const bridges = fakeBridges(heldView({ held: [parked('p1'), parked('p2')] }));
    bridges.recovery.prepareCancelHeldCarts.mockRejectedValue(new Error('ipc down'));
    show(bridges);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: RECOVERY_COPY.selectAllParked }));
    await user.click(cancelSelected());
    expect(await screen.findByRole('alert')).toHaveTextContent(RECOVERY_COPY.unavailable);
    expect(selectAll()).toBeChecked();
  });
});

describe('bulk cancel copy and plumbing', () => {
  it('the approval kind and subject: the batch kind, keyed by the snapshot reference', () => {
    const action = {
      kind: 'cancel_parked_batch',
      batch: { batch_id: 'batch-7', count: 2, total_minor: 4_000, excluded: 0 },
    } as const;
    expect(RECOVERY_ACTION_KIND.cancel_parked_batch).toBe('recovery.cancel_held_carts');
    expect(recoverySubjectOf(action)).toBe('batch-7');
  });

  it('counted sentences use a full form per plural category, with Western digits', () => {
    const forms = [1, 2, 3, 10, 11, 99, 100].map((n) => batchWillCancel(n));
    expect(new Set(forms).size).toBe(7);
    expect(batchWillCancel(1)).toBe('سيُلغى بيع معلّق واحد.');
    expect(batchWillCancel(2)).toBe('سيُلغى بيعان معلّقان.');
    expect(batchWillCancel(3)).toContain('3');
    expect(batchWillCancel(11)).toContain('11');
    expect(batchCancelled(1)).toBe('أُلغي بيع معلّق واحد.');
    expect(batchCancelled(2)).toBe('أُلغي بيعان معلّقان.');
    for (const n of [3, 11, 100]) expect(batchCancelled(n)).toMatch(/[0-9]/);
    expect(batchWillCancel(3)).not.toMatch(/[٠-٩]/);
  });
});

describe('RecoveryScreen — bulk cancel: review findings', () => {
  it('a LATE prepare never replaces an action the manager already opened', async () => {
    const bridges = fakeBridges(heldView({ held: [parked('p1'), parked('p2'), parked('p3')] }));
    let release: (
      answer: Awaited<ReturnType<typeof bridges.recovery.prepareCancelHeldCarts>>,
    ) => void = () => undefined;
    bridges.recovery.prepareCancelHeldCarts.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    show(bridges);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: RECOVERY_COPY.selectAllParked }));
    await user.click(cancelSelected());
    // While the prepare is still in flight, the manager opens ONE sale's cancel instead.
    await user.click(
      screen.getAllByRole('button', { name: RECOVERY_COPY.cancelSale })[0] as HTMLElement,
    );
    const single = await screen.findByRole('dialog', { name: RECOVERY_COPY.cancelSale });
    await user.type(await within(single).findByLabelText(new RegExp(RECOVERY_COPY.pinLabel)), '24');
    release({
      kind: 'prepared',
      batch_id: 'late-batch',
      count: 3,
      total_minor: 6_000,
      excluded_cart_ids: [],
    });
    await waitFor(() => {
      expect(bridges.recovery.prepareCancelHeldCarts).toHaveBeenCalledTimes(1);
    });
    // Still the single-sale dialog, with the PIN the manager typed for IT; the batch never replaced it.
    expect(screen.getByRole('dialog', { name: RECOVERY_COPY.cancelSale })).toBe(single);
    expect(screen.queryByRole('dialog', { name: RECOVERY_COPY.cancelParkedTitle })).toBeNull();
    expect(within(single).getByLabelText(new RegExp(RECOVERY_COPY.pinLabel))).toHaveValue('24');
    expect(bridges.approval.request).not.toHaveBeenCalled();
    expect(bridges.recovery.cancelHeldCarts).not.toHaveBeenCalled();
  });

  it('a batch can hold at most 500 sales: select all stops there and a single tick cannot pass it', async () => {
    const many = Array.from({ length: 501 }, (_, i) => parked(`m${String(i)}`));
    const bridges = show(fakeBridges(heldView({ held: many })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: RECOVERY_COPY.selectAllParked }));
    expect(screen.getByText(new RegExp(`^${RECOVERY_COPY.selectedLabel}:`))).toHaveTextContent(
      '500',
    );
    const boxes = rowBoxes();
    expect(boxes).toHaveLength(501);
    const last = boxes[500] as HTMLElement;
    expect(last).not.toBeChecked();
    await user.click(last);
    expect(last).not.toBeChecked();
    expect(screen.getByText(new RegExp(`^${RECOVERY_COPY.selectedLabel}:`))).toHaveTextContent(
      '500',
    );
    // Unticking is always possible, and then another can be added.
    await user.click(boxes[0] as HTMLElement);
    await user.click(last);
    expect(last).toBeChecked();
    await user.click(cancelSelected());
    await waitFor(() => {
      expect(bridges.recovery.prepareCancelHeldCarts).toHaveBeenCalledTimes(1);
    });
    const sent = bridges.recovery.prepareCancelHeldCarts.mock.calls[0]?.[0].cart_ids ?? [];
    expect(sent).toHaveLength(500);
  });
});
