/**
 * RT-1403 S2 — the cash of a void on the void screen (PROPOSED Arabic copy, pending owner review).
 *
 * A request moves no cash. Once Backend-Core confirmed the void a MANAGER's row offers «صرف النقد»
 * while the payout gate allows it; a claimed payout says the drawer may be open and offers a retry or
 * a manual completion; a refusal after the kick says the drawer may be open; and only a
 * manager-attested exception (another manager's PIN, once) can record cash that left anyway.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { SaleVoidJournalView } from '../../../../shared/sale-void/types';
import type { Role } from '../../../../shared/operator/role';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { VOID_COPY, voidMismatchMessage, voidRefusalMessage, voidStateLabel } from '../void-copy';
import { VoidScreen } from '../VoidScreen';
import {
  MANAGER,
  NO_PAYOUT,
  fakeBridges,
  journalView,
  type FakeBridges,
} from './__helpers__/void-fixtures';

afterEach(cleanup);

const PIN = '246810';
const APPROVAL_ID = '0190f5a2-3b4c-7d8e-9f01-000000000001';

function signIn(role: Role): void {
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: `session-${role}`,
    operator_id: `op-${role}`,
    display_name: 'سارة',
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-06-07T07:00:00Z',
  });
}

beforeEach(() => {
  useOperatorSessionStore.getState().reset();
  signIn('manager');
});

const confirmed = (over: Partial<SaleVoidJournalView> = {}): SaleVoidJournalView =>
  journalView({ state: 'confirmed', confirmed_at: '2026-06-07T10:40:00.000Z', ...over });

const claimed = (actions: Array<'retry_drawer' | 'manual'>): SaleVoidJournalView =>
  confirmed({
    needs_attention: true,
    payout: { ...NO_PAYOUT, state: 'claimed', claim_actions: actions },
  });

function show(voids: SaleVoidJournalView[], bridges = fakeBridges(voids)): FakeBridges {
  render(<VoidScreen bridges={bridges} refreshMs={0} />);
  return bridges;
}

const row = async (): Promise<HTMLElement> =>
  (await screen.findAllByTestId('void-row'))[0] as HTMLElement;
const button = (r: HTMLElement, name: string) => within(r).queryByRole('button', { name });
const payButton = (r: HTMLElement) => button(r, VOID_COPY.payOut);
const exceptionButton = (r: HTMLElement) => button(r, VOID_COPY.exceptionAction);

describe('the payout action', () => {
  it('offers «صرف النقد» to a manager on a confirmed void whose payout is available, and pays it out', async () => {
    const bridges = show([confirmed()]);
    const r = await row();
    expect(r).toHaveTextContent(VOID_COPY.cashDue);
    await userEvent.setup().click(payButton(r) as HTMLElement);
    expect(bridges.saleVoid.payOut).toHaveBeenCalledWith({ void_id: 'void-1', action: 'start' });
    await waitFor(() => {
      expect(bridges.saleVoid.list).toHaveBeenCalledTimes(2);
    });
  });

  it('offers an admin the payout too, and a cashier none (a manager pays out): L3', async () => {
    useOperatorSessionStore.getState().reset();
    signIn('cashier');
    show([confirmed()]);
    const r = await row();
    expect(payButton(r)).not.toBeInTheDocument();
    expect(r).toHaveTextContent(VOID_COPY.managerPays);
    cleanup();
    useOperatorSessionStore.getState().reset();
    signIn('admin');
    show([confirmed()]);
    expect(payButton(await row())).toBeInTheDocument();
  });

  it('shows the refusal of a payout, and no success', async () => {
    const bridges = fakeBridges([confirmed()]);
    bridges.saleVoid.payOut.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'another_payout_in_progress',
    });
    show([], bridges);
    const r = await row();
    await userEvent.setup().click(payButton(r) as HTMLElement);
    const alert = await within(r).findByRole('alert');
    expect(alert).toHaveTextContent(voidRefusalMessage('another_payout_in_progress'));
    expect(alert).not.toHaveTextContent(VOID_COPY.drawerMayBeOpen);
  });

  it('after a refusal that follows the kick, says the drawer may be open and the cash must not be handed over', async () => {
    const bridges = fakeBridges([confirmed()]);
    bridges.saleVoid.payOut.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'payout_no_open_shift',
      drawer_may_be_open: true,
    });
    show([], bridges);
    const r = await row();
    await userEvent.setup().click(payButton(r) as HTMLElement);
    const alert = await within(r).findByRole('alert');
    expect(alert).toHaveTextContent(voidRefusalMessage('payout_no_open_shift'));
    expect(alert).toHaveTextContent(VOID_COPY.drawerMayBeOpen);
    expect(VOID_COPY.drawerMayBeOpen).toContain('لا تُسلِّم النقد');
  });

  it('shows an unexpected payout failure as the generic message', async () => {
    const bridges = fakeBridges([confirmed()]);
    bridges.saleVoid.payOut.mockRejectedValueOnce(new Error('ipc down'));
    show([], bridges);
    const r = await row();
    await userEvent.setup().click(payButton(r) as HTMLElement);
    expect(await within(r).findByRole('alert')).toHaveTextContent(VOID_COPY.unavailable);
  });

  it.each([
    ['payout_wrong_day', 'انتهت مهلة'],
    ['payout_other_shift', 'انتهت مهلة'],
  ] as const)(
    'a %s block says the window passed and that another manager must approve a late payout (M5)',
    async (reason, words) => {
      show([
        confirmed({
          needs_attention: true,
          payout: { ...NO_PAYOUT, overdue: true, blocked_reason: reason },
        }),
      ]);
      const r = await row();
      expect(payButton(r)).not.toBeInTheDocument();
      expect(r).toHaveTextContent(words);
      expect(r).toHaveTextContent('يلزم إقرار مدير آخر');
      // The late payout is the exception: it is offered, the normal payout is not.
      expect(exceptionButton(r)).toBeInTheDocument();
      expect(r).toHaveAttribute('data-attention', 'true');
      // An overdue payout is not a refusal: nothing to acknowledge.
      expect(button(r, VOID_COPY.acknowledge)).not.toBeInTheDocument();
    },
  );

  it('offers no payout while the shift is not open, and says why', async () => {
    show([confirmed({ payout: { ...NO_PAYOUT, blocked_reason: 'payout_no_open_shift' } })]);
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
        payout: { ...NO_PAYOUT, state: 'paid_out', paid_at: '2026-06-07T11:00:00.000Z' },
      }),
    ]);
    const r = await row();
    expect(r).toHaveTextContent(VOID_COPY.paidOut);
    expect(payButton(r)).not.toBeInTheDocument();
    expect(exceptionButton(r)).not.toBeInTheDocument();
  });

  it('shows an exception with its mismatch flag AND the void state next to it (L2)', async () => {
    show([
      journalView({
        state: 'refused',
        refusal_reason: 'void_self_approval',
        payout: {
          ...NO_PAYOUT,
          state: 'exception',
          paid_at: '2026-06-07T11:00:00.000Z',
          mismatch_reason: 'void_refused',
        },
      }),
    ]);
    const r = await row();
    expect(r).toHaveTextContent(VOID_COPY.exceptionRecordedLabel);
    expect(r).toHaveTextContent(voidMismatchMessage('void_refused'));
    expect(r).toHaveTextContent(`${VOID_COPY.voidStateIs}: ${voidStateLabel('refused')}`);
    expect(exceptionButton(r)).not.toBeInTheDocument();
  });
});

describe('a claimed payout (the drawer may be open)', () => {
  it('says so, offers a manager the retry and the manual completion, and flags the row', async () => {
    const bridges = show([claimed(['retry_drawer', 'manual'])]);
    const r = await row();
    expect(r).toHaveTextContent(VOID_COPY.claimed);
    expect(r).toHaveTextContent(VOID_COPY.drawerMayBeOpen);
    expect(r).toHaveAttribute('data-attention', 'true');
    expect(payButton(r)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(button(r, VOID_COPY.retryDrawer) as HTMLElement);
    expect(bridges.saleVoid.payOut).toHaveBeenLastCalledWith({
      void_id: 'void-1',
      action: 'retry_drawer',
    });
    await user.click(
      await within(await row()).findByRole('button', { name: VOID_COPY.manualComplete }),
    );
    expect(bridges.saleVoid.payOut).toHaveBeenLastCalledWith({
      void_id: 'void-1',
      action: 'manual',
    });
  });

  it('offers only the manual completion after a kick that may have opened the drawer', async () => {
    show([claimed(['manual'])]);
    const r = await row();
    expect(button(r, VOID_COPY.retryDrawer)).not.toBeInTheDocument();
    expect(button(r, VOID_COPY.manualComplete)).toBeInTheDocument();
  });

  it('offers nothing while a kick is in flight, but still the exception path to a manager’s PIN', async () => {
    show([claimed([])]);
    const r = await row();
    expect(button(r, VOID_COPY.retryDrawer)).not.toBeInTheDocument();
    expect(button(r, VOID_COPY.manualComplete)).not.toBeInTheDocument();
    expect(exceptionButton(r)).toBeInTheDocument();
  });

  it('shows a cashier the warning and no payout step (a manager completes it)', async () => {
    useOperatorSessionStore.getState().reset();
    signIn('cashier');
    show([claimed(['retry_drawer', 'manual'])]);
    const r = await row();
    expect(r).toHaveTextContent(VOID_COPY.drawerMayBeOpen);
    expect(button(r, VOID_COPY.retryDrawer)).not.toBeInTheDocument();
    expect(button(r, VOID_COPY.manualComplete)).not.toBeInTheDocument();
  });

  it('shows the refusal of a step, with the warning when the drawer may be open', async () => {
    const bridges = fakeBridges([claimed(['manual'])]);
    bridges.saleVoid.payOut.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'payout_wrong_day',
    });
    show([], bridges);
    const r = await row();
    await userEvent.setup().click(button(r, VOID_COPY.manualComplete) as HTMLElement);
    const alerts = await within(r).findAllByRole('alert');
    expect(alerts.map((a) => a.textContent).join(' ')).toContain(
      voidRefusalMessage('payout_wrong_day'),
    );
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

  it('shows any other refusal of the approval with its own message, never the four-eyes one', async () => {
    const bridges = fakeBridges([journalView({ state: 'refused' })]);
    bridges.approval.request.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'approval_attempts_exhausted',
    });
    await open(bridges);
    await chooseManagerAndPin();
    await userEvent.setup().click(commit());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(voidRefusalMessage('approval_attempts_exhausted'));
    expect(alert).not.toHaveTextContent(VOID_COPY.exceptionApprovalUnavailable);
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
