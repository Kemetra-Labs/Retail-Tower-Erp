/**
 * RT-998 (RT-276 c14719) — main refuses a cash apply `shift_not_open` while no
 * shift is open on the terminal. The cash entry says so in Arabic (owner-approved
 * copy), keeps the amount, shows no reason token, and gives a
 * cashier the way to open the shift. After the shift is opened the same cash
 * applies. A manager or admin cannot open a shift, so they get the line that
 * says who can. The settle-time refusal has its own line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { CashEntry } from '../CashEntry.js';
import { confirmRefusalCopy } from '../payment-read-copy.js';
import { SHIFT_COPY } from '../../../v5/shift/shift-copy.js';
import { resetShiftStores, signIn } from '../../../v5/__tests__/__helpers__/shift-test-kit.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../../shared/bridge-api.js';

afterEach(() => {
  cleanup();
  resetShiftStores();
});

const OK: TenderApplyResponse = {
  kind: 'ok',
  tender_line_id: 'tl-1',
  applied_at: '2026-10-30T09:00:00.000Z',
};
const REFUSED: TenderApplyResponse = { kind: 'refused', reason: 'shift_not_open' };

function renderBridged(
  tenderApply: (req: TenderApplyRequest) => Promise<TenderApplyResponse>,
  onOpenShift?: () => void,
) {
  const onApplied = vi.fn();
  render(
    <CashEntry
      remainingBalanceMinor={1500}
      paymentAttemptId="pa-1"
      tenderApply={tenderApply}
      onApplied={onApplied}
      onOpenShift={onOpenShift}
    />,
  );
  fireEvent.change(screen.getByTestId('cash-entry-amount-input'), { target: { value: '20.00' } });
  return { onApplied };
}

describe('CashEntry — main refused the cash: no open shift (RT-998)', () => {
  it('a cashier sees the draft line, never a reason token, and a way to open the shift', async () => {
    signIn('cashier');
    const onOpenShift = vi.fn();
    const { onApplied } = renderBridged(() => Promise.resolve(REFUSED), onOpenShift);
    fireEvent.click(screen.getByTestId('cash-entry-confirm'));

    const notice = await screen.findByTestId('cash-entry-needs-shift');
    expect(notice).toHaveTextContent(SHIFT_COPY.cashNeedsShiftCashier);
    expect(document.body.textContent).not.toContain('shift_not_open');
    expect(onApplied).not.toHaveBeenCalled();
    // The generic "try again" line is not shown: a retry cannot help yet.
    expect(screen.queryByTestId('cash-entry-bridge-refusal')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('cash-entry-open-shift'));
    expect(onOpenShift).toHaveBeenCalledTimes(1);
  });

  it('keeps the amount, and the same cash applies once the shift is open', async () => {
    signIn('cashier');
    const apply = vi
      .fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>()
      .mockResolvedValueOnce(REFUSED)
      .mockResolvedValueOnce(OK);
    const { onApplied } = renderBridged(apply, vi.fn());

    fireEvent.click(screen.getByTestId('cash-entry-confirm'));
    await screen.findByTestId('cash-entry-needs-shift');
    expect(screen.getByTestId('cash-entry-amount-input')).toHaveValue('20.00');

    fireEvent.click(screen.getByTestId('cash-entry-confirm'));
    await waitFor(() => {
      expect(onApplied).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('cash-entry-needs-shift')).not.toBeInTheDocument();
    expect(apply.mock.calls[0]?.[0].amount_applied_minor).toBe(2000);
    expect(apply.mock.calls[1]?.[0].amount_applied_minor).toBe(2000);
  });

  it.each(['manager', 'admin'] as const)(
    'a %s gets the line that says a cashier opens the shift, and no open-shift action',
    async (role) => {
      signIn(role);
      renderBridged(() => Promise.resolve(REFUSED), vi.fn());
      fireEvent.click(screen.getByTestId('cash-entry-confirm'));
      const notice = await screen.findByTestId('cash-entry-needs-shift');
      expect(notice).toHaveTextContent(SHIFT_COPY.cashNeedsShiftOther);
      expect(screen.queryByTestId('cash-entry-open-shift')).not.toBeInTheDocument();
    },
  );

  it('a cashier without a route to the shift screen still sees the line (no dead button)', async () => {
    signIn('cashier');
    renderBridged(() => Promise.resolve(REFUSED));
    fireEvent.click(screen.getByTestId('cash-entry-confirm'));
    expect(await screen.findByTestId('cash-entry-needs-shift')).toBeInTheDocument();
    expect(screen.queryByTestId('cash-entry-open-shift')).not.toBeInTheDocument();
  });
});

describe('confirmRefusalCopy — the settle refused for no open shift (RT-998)', () => {
  it('has its own line, which is neither the retry line nor an English token', () => {
    const copy = confirmRefusalCopy('shift_not_open', false);
    expect(copy).toBe(SHIFT_COPY.settleNeedsShift);
    expect(copy).not.toContain('shift_not_open');
  });
});
