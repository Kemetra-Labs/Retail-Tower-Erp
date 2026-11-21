/**
 * RT-1403 S2 — the cash of a void on the void screen (PROPOSED Arabic copy, pending owner review).
 *
 * A request moves no cash. Once Backend-Core confirmed the void the row offers «صرف النقد» while the
 * payout gate allows it (an open shift, the void's day and shift); otherwise the row says why and
 * only a manager-attested exception (another manager's PIN, once) can record cash that left anyway.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { SaleVoidJournalView } from '../../../../shared/sale-void/types';
import { VOID_COPY, voidMismatchMessage, voidRefusalMessage } from '../void-copy';
import { VoidScreen } from '../VoidScreen';
import { MANAGER, fakeBridges, journalView, type FakeBridges } from './__helpers__/void-fixtures';

afterEach(cleanup);

const PIN = '246810';
const APPROVAL_ID = '0190f5a2-3b4c-7d8e-9f01-000000000001';

const confirmed = (over: Partial<SaleVoidJournalView> = {}): SaleVoidJournalView =>
  journalView({ state: 'confirmed', confirmed_at: '2026-06-07T10:40:00.000Z', ...over });

function show(voids: SaleVoidJournalView[]): FakeBridges {
  const bridges = fakeBridges(voids);
  render(<VoidScreen bridges={bridges} refreshMs={0} />);
  return bridges;
}

const row = async (): Promise<HTMLElement> =>
  (await screen.findAllByTestId('void-row'))[0] as HTMLElement;
const payButton = (r: HTMLElement) => within(r).queryByRole('button', { name: VOID_COPY.payOut });
const exceptionButton = (r: HTMLElement) =>
  within(r).queryByRole('button', { name: VOID_COPY.exceptionAction });

describe('the payout action', () => {
  it('offers «صرف النقد» on a confirmed void whose payout is available, and pays it out', async () => {
    const bridges = show([confirmed()]);
    const r = await row();
    expect(r).toHaveTextContent(VOID_COPY.cashDue);
    await userEvent.setup().click(payButton(r) as HTMLElement);
    expect(bridges.saleVoid.payOut).toHaveBeenCalledWith({ void_id: 'void-1' });
    await waitFor(() => {
      expect(bridges.saleVoid.list).toHaveBeenCalledTimes(2);
    });
  });

  it('shows the refusal of a payout, and no success', async () => {
    const bridges = fakeBridges([confirmed()]);
    bridges.saleVoid.payOut.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'payout_drawer_failed',
    });
    render(<VoidScreen bridges={bridges} refreshMs={0} />);
    const r = await row();
    await userEvent.setup().click(payButton(r) as HTMLElement);
    expect(await within(r).findByRole('alert')).toHaveTextContent(
      voidRefusalMessage('payout_drawer_failed'),
    );
  });

  it('shows an unexpected payout failure as the generic message', async () => {
    const bridges = fakeBridges([confirmed()]);
    bridges.saleVoid.payOut.mockRejectedValueOnce(new Error('ipc down'));
    render(<VoidScreen bridges={bridges} refreshMs={0} />);
    const r = await row();
    await userEvent.setup().click(payButton(r) as HTMLElement);
    expect(await within(r).findByRole('alert')).toHaveTextContent(VOID_COPY.unavailable);
  });

  it('offers no payout while the gate blocks it, and says why', async () => {
    show([
      confirmed({
        payout: {
          state: 'none',
          paid_at: null,
          mismatch_reason: null,
          blocked_reason: 'payout_no_open_shift',
        },
      }),
    ]);
    const r = await row();
    expect(payButton(r)).not.toBeInTheDocument();
    expect(r).toHaveTextContent(voidRefusalMessage('payout_no_open_shift'));
    expect(exceptionButton(r)).toBeInTheDocument();
  });

  it.each(['pending', 'unknown', 'refused'] as const)(
    'offers no payout for a %s void (no cash), only the exception',
    async (state) => {
      show([journalView({ state })]);
      const r = await row();
      expect(payButton(r)).not.toBeInTheDocument();
      expect(exceptionButton(r)).toBeInTheDocument();
    },
  );

  it('offers neither action for a void with no cash (a card sale)', async () => {
    show([confirmed({ cash_minor: 0 })]);
    const r = await row();
    expect(payButton(r)).not.toBeInTheDocument();
    expect(exceptionButton(r)).not.toBeInTheDocument();
    expect(r).not.toHaveTextContent(VOID_COPY.cashDue);
  });

  it('shows a paid-out void as paid, with no further action', async () => {
    show([
      confirmed({
        payout: {
          state: 'paid_out',
          paid_at: '2026-06-07T11:00:00.000Z',
          mismatch_reason: null,
          blocked_reason: null,
        },
      }),
    ]);
    const r = await row();
    expect(r).toHaveTextContent(VOID_COPY.paidOut);
    expect(payButton(r)).not.toBeInTheDocument();
    expect(exceptionButton(r)).not.toBeInTheDocument();
  });

  it('shows an exception as recorded, with its mismatch flag for review', async () => {
    show([
      journalView({
        state: 'refused',
        refusal_reason: 'void_self_approval',
        payout: {
          state: 'exception',
          paid_at: '2026-06-07T11:00:00.000Z',
          mismatch_reason: 'void_refused',
          blocked_reason: null,
        },
      }),
    ]);
    const r = await row();
    expect(r).toHaveTextContent(VOID_COPY.exceptionRecordedLabel);
    expect(r).toHaveTextContent(voidMismatchMessage('void_refused'));
    expect(exceptionButton(r)).not.toBeInTheDocument();
  });
});

describe('the cash exception dialog', () => {
  async function open(bridges = fakeBridges([journalView({ state: 'refused' })])) {
    render(<VoidScreen bridges={bridges} refreshMs={0} />);
    const r = await row();
    await userEvent.setup().click(exceptionButton(r) as HTMLElement);
    await screen.findByRole('dialog');
    return bridges;
  }

  const commit = () => screen.getByRole('button', { name: VOID_COPY.exceptionApprove });

  async function chooseManagerAndPin(pin = PIN): Promise<void> {
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(MANAGER.display_name));
    await user.type(await screen.findByLabelText(VOID_COPY.pinLabel), pin);
  }

  it('lists the managers for the exception kind and stays disabled until name and PIN are set', async () => {
    const bridges = await open();
    expect(bridges.approval.listApprovers).toHaveBeenCalledWith({
      action_kind: 'sale.void_cash_exception',
    });
    expect(commit()).toBeDisabled();
    await chooseManagerAndPin();
    expect(commit()).toBeEnabled();
  });

  it('binds the approval to THIS void, then records the exception, clearing the PIN', async () => {
    const bridges = await open();
    await chooseManagerAndPin();
    await userEvent.setup().click(commit());
    await waitFor(() => {
      expect(bridges.saleVoid.recordCashException).toHaveBeenCalledTimes(1);
    });
    expect(bridges.approval.request).toHaveBeenCalledWith({
      action_kind: 'sale.void_cash_exception',
      subject_ref: 'void-1',
      reason_code: 'cash_exception',
      approver_ref: MANAGER.approver_ref,
      pin: PIN,
    });
    expect(bridges.saleVoid.recordCashException).toHaveBeenCalledWith({
      void_id: 'void-1',
      approval_id: APPROVAL_ID,
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(await screen.findByTestId('void-cash-exception-recorded')).toHaveTextContent(
      VOID_COPY.exceptionRecorded,
    );
  });

  it('never reaches the exception record when the approval is refused, and names the four-eyes rule', async () => {
    const bridges = fakeBridges([journalView({ state: 'refused' })]);
    bridges.approval.request.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'approval_unavailable',
    });
    await open(bridges);
    await chooseManagerAndPin();
    await userEvent.setup().click(commit());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      VOID_COPY.exceptionApprovalUnavailable,
    );
    expect(bridges.saleVoid.recordCashException).not.toHaveBeenCalled();
  });

  it('shows the refusal of the record itself, and keeps the dialog open', async () => {
    const bridges = fakeBridges([journalView({ state: 'refused' })]);
    bridges.saleVoid.recordCashException.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    await open(bridges);
    await chooseManagerAndPin();
    await userEvent.setup().click(commit());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      voidRefusalMessage('payout_no_open_shift'),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows an unexpected failure as the generic message', async () => {
    const bridges = fakeBridges([journalView({ state: 'refused' })]);
    bridges.approval.request.mockRejectedValueOnce(new Error('ipc down'));
    await open(bridges);
    await chooseManagerAndPin();
    await userEvent.setup().click(commit());
    expect(await screen.findByRole('alert')).toHaveTextContent(VOID_COPY.unavailable);
  });

  it('closes on back without any approval or record', async () => {
    const bridges = await open();
    await userEvent.setup().click(screen.getByRole('button', { name: VOID_COPY.back }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bridges.approval.request).not.toHaveBeenCalled();
    expect(bridges.saleVoid.recordCashException).not.toHaveBeenCalled();
  });
});
