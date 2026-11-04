/**
 * RT-1167 (RT-1044 S1, F-10 / M-S5 / UX-08.17) — a scanner burst into the real
 * cash field is refused: the field keeps what the cashier had typed, nothing is
 * routed to the scan owner, and no tender is applied.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CashEntry } from '../CashEntry.js';
import { ScanGuardHost, resetScanGuardForTests } from '../../../scan/ScanGuardHost.js';
import { SCAN_REFUSED_MESSAGE } from '../../../scan/scan-messages.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../../shared/bridge-api.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetScanGuardForTests();
});

describe('CashEntry refuses a scan burst (M-S5)', () => {
  it('restores the field, shows the amount notice and applies no tender', () => {
    // Freeze the clock so every key of the burst has the same timestamp.
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    const tenderApply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>();
    render(
      <>
        <ScanGuardHost />
        <CashEntry
          remainingBalanceMinor={1500}
          paymentAttemptId="pa-1"
          tenderApply={tenderApply}
          onApplied={vi.fn()}
        />
      </>,
    );
    const input = screen.getByTestId<HTMLInputElement>('cash-entry-amount-input');
    act(() => {
      input.focus();
    });
    for (const key of '6221000000011') {
      fireEvent.keyDown(input, { key });
      fireEvent.change(input, { target: { value: input.value + key } });
    }
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(input).toHaveValue('');
    expect(screen.getByText(SCAN_REFUSED_MESSAGE.amount)).toBeInTheDocument();
    expect(tenderApply).not.toHaveBeenCalled();
  });
});
