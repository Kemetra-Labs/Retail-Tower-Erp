/**
 * RT-1331 (RT-1098 R-5, decision 1A) — <VoucherEntry> forfeit confirmation.
 *
 * A voucher is consumed whole. When main answers `forfeit_confirmation_required`
 * with the amount that would be forfeited, the cashier sees it and must confirm
 * before the line is applied. Confirming sends the SAME request again carrying
 * `voucher_forfeit_ack_minor` and a fresh idempotency key; cancelling sends
 * nothing. The gate itself is enforced in main (voucher-forfeit-gate.test.ts);
 * this surface only collects the confirmation.
 *
 * The Arabic copy is a placeholder pending the owner / legal decision on
 * forfeiting an unused balance, so these tests pin the behaviour and the amount
 * shown, not the wording.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { VoucherEntry } from '../../../../src/renderer/ui/payments/VoucherEntry.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../../src/shared/bridge-api.js';

afterEach(() => {
  cleanup();
});

type BridgeFn = (req: TenderApplyRequest) => Promise<TenderApplyResponse>;

const REQUIRED_250: TenderApplyResponse = {
  kind: 'forfeit_confirmation_required',
  forfeited_amount_minor: 250,
};
const OK: TenderApplyResponse = {
  kind: 'ok',
  tender_line_id: 'tl-voucher-1',
  applied_at: '2026-05-25T14:00:00.000Z',
};

function mount(...responses: TenderApplyResponse[]) {
  const queue = [...responses];
  const spy = vi.fn<BridgeFn>(async () => await Promise.resolve(queue.shift() ?? OK));
  const onApplied = vi.fn();
  render(
    <VoucherEntry
      remainingBalanceMinor={5000}
      paymentAttemptId="pa-1"
      tenderApply={spy}
      onApplied={onApplied}
    />,
  );
  return { spy, onApplied };
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId('voucher-entry-code-input'), 'V-CODE-1');
  await user.type(screen.getByTestId('voucher-entry-amount-input'), '15.00');
  await user.click(screen.getByTestId('voucher-entry-confirm'));
}

describe('RT-1331 — VoucherEntry forfeit confirmation', () => {
  it('shows the forfeited amount and applies nothing until the cashier confirms', async () => {
    const user = userEvent.setup();
    const { spy, onApplied } = mount(REQUIRED_250);
    await submit(user);

    const panel = await screen.findByTestId('voucher-entry-forfeit');
    expect(panel).toHaveTextContent('2.50');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('voucher_forfeit_ack_minor');
    expect(onApplied).not.toHaveBeenCalled();
    // It is not the generic refusal: nothing was refused.
    expect(screen.queryByTestId('voucher-entry-refused')).not.toBeInTheDocument();
  });

  it('confirm re-sends the same request with the acknowledgement and a fresh key', async () => {
    const user = userEvent.setup();
    const { spy, onApplied } = mount(REQUIRED_250, OK);
    await submit(user);
    await user.click(await screen.findByTestId('voucher-entry-forfeit-confirm'));

    await waitFor(() => {
      expect(onApplied).toHaveBeenCalledTimes(1);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    const [first, second] = [spy.mock.calls[0]?.[0], spy.mock.calls[1]?.[0]];
    expect(second).toMatchObject({
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_code: 'V-CODE-1',
      voucher_forfeit_ack_minor: 250,
    });
    expect(second?.idempotency_key).not.toBe(first?.idempotency_key);
    expect(screen.queryByTestId('voucher-entry-forfeit')).not.toBeInTheDocument();
  });

  it('cancel sends nothing, closes the prompt and keeps the typed values', async () => {
    const user = userEvent.setup();
    const { spy, onApplied } = mount(REQUIRED_250);
    await submit(user);
    await user.click(await screen.findByTestId('voucher-entry-forfeit-cancel'));

    expect(screen.queryByTestId('voucher-entry-forfeit')).not.toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(onApplied).not.toHaveBeenCalled();
    expect(screen.getByTestId('voucher-entry-code-input')).toHaveValue('V-CODE-1');
    expect(screen.getByTestId('voucher-entry-amount-input')).toHaveValue('15.00');
  });

  it('editing the code or the amount dismisses a pending confirmation', async () => {
    const user = userEvent.setup();
    mount(REQUIRED_250);
    await submit(user);
    await screen.findByTestId('voucher-entry-forfeit');
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '{Backspace}');
    expect(screen.queryByTestId('voucher-entry-forfeit')).not.toBeInTheDocument();
  });

  it('editing the code dismisses a pending confirmation too', async () => {
    const user = userEvent.setup();
    mount(REQUIRED_250);
    await submit(user);
    await screen.findByTestId('voucher-entry-forfeit');
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'X');
    expect(screen.queryByTestId('voucher-entry-forfeit')).not.toBeInTheDocument();
  });

  it('a confirmed call that comes back with a different forfeit asks again with the new amount', async () => {
    const user = userEvent.setup();
    const { spy, onApplied } = mount(REQUIRED_250, {
      kind: 'forfeit_confirmation_required',
      forfeited_amount_minor: 400,
    });
    await submit(user);
    await user.click(await screen.findByTestId('voucher-entry-forfeit-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('voucher-entry-forfeit')).toHaveTextContent('4.00');
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(onApplied).not.toHaveBeenCalled();
    // The safe option owns focus again: clicking confirm disabled both buttons, which
    // dropped focus to <body>, and the prompt stayed mounted so autoFocus did not re-run.
    await waitFor(() => {
      expect(screen.getByTestId('voucher-entry-forfeit-cancel')).toHaveFocus();
    });
  });

  it('opens with the safe option (cancel) focused', async () => {
    const user = userEvent.setup();
    mount(REQUIRED_250);
    await submit(user);
    await screen.findByTestId('voucher-entry-forfeit');
    expect(screen.getByTestId('voucher-entry-forfeit-cancel')).toHaveFocus();
  });

  it('a double click on confirm sends one acknowledged request', async () => {
    const user = userEvent.setup();
    const { spy } = mount(REQUIRED_250, OK);
    await submit(user);
    const confirm = await screen.findByTestId('voucher-entry-forfeit-confirm');
    await user.dblClick(confirm);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  it('a rejected acknowledged call shows the generic refusal and closes the prompt', async () => {
    const user = userEvent.setup();
    const queue: (() => Promise<TenderApplyResponse>)[] = [
      () => Promise.resolve(REQUIRED_250),
      () => Promise.reject(new Error('ipc down')),
    ];
    const spy = vi.fn<BridgeFn>(async () => await (queue.shift() ?? (() => Promise.resolve(OK)))());
    render(<VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={spy} />);
    await submit(user);
    await user.click(await screen.findByTestId('voucher-entry-forfeit-confirm'));

    expect(await screen.findByTestId('voucher-entry-refused')).toBeInTheDocument();
    expect(screen.queryByTestId('voucher-entry-forfeit')).not.toBeInTheDocument();
  });
});
