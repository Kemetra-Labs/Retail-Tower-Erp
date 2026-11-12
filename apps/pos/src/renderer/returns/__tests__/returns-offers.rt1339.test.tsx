import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ReturnableSaleView, ReturnsRefusalReason } from '../../../shared/returns/types.js';
import { OFFER_ROLE_COPY, refusalMessage } from '../returns-messages.js';
import {
  fakeBridge,
  journal,
  L1,
  L2,
  L3,
  lookUpSale,
  renderReturns,
  resetStores,
  SALE,
  submitReturn,
} from './returns-test-kit.js';

/**
 * RT-1339 (RT-286 S7, spec 048 §9): a sale sold under an automatic offer. The picker marks the
 * lines that took part (display only: Backend-Core decides the refund), and when Backend-Core
 * refuses the return for the offer's discount the till shows its guidance and records nothing.
 */
afterEach(() => {
  cleanup();
  resetStores();
});

const OFFER_SALE: ReturnableSaleView = {
  ...SALE,
  lines: SALE.lines.map((line, i) => {
    if (i === 0) return { ...line, offerRole: 'reward' as const };
    if (i === 1) return { ...line, offerRole: 'participant' as const };
    return line;
  }),
};

describe('the line picker on a sale sold under an offer', () => {
  it('marks the reward unit and the participant, and no other line', async () => {
    const bridge = fakeBridge();
    bridge.lookup.mockResolvedValue({ kind: 'ok', sale: OFFER_SALE });
    renderReturns({ bridge });
    await lookUpSale(userEvent.setup());
    expect(screen.getByTestId(`offer-role-${L1}`)).toHaveTextContent(OFFER_ROLE_COPY.reward);
    expect(screen.getByTestId(`offer-role-${L2}`)).toHaveTextContent(OFFER_ROLE_COPY.participant);
    expect(screen.queryByTestId(`offer-role-${L3}`)).not.toBeInTheDocument();
  });

  it('shows the offer note only once a line under the offer is picked', async () => {
    const bridge = fakeBridge();
    bridge.lookup.mockResolvedValue({ kind: 'ok', sale: OFFER_SALE });
    const user = userEvent.setup();
    renderReturns({ bridge });
    await lookUpSale(user);
    expect(screen.queryByTestId('offer-return-note')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'زيادة شاش طبي' }));
    expect(screen.queryByTestId('offer-return-note')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'زيادة بانادول 500 مجم' }));
    expect(screen.getByTestId('offer-return-note')).toHaveTextContent(OFFER_ROLE_COPY.note);
  });

  it('a sale without an offer is as before: no marks, no note', async () => {
    const user = userEvent.setup();
    renderReturns({ bridge: fakeBridge() });
    await lookUpSale(user);
    await user.click(screen.getByRole('button', { name: 'زيادة بانادول 500 مجم' }));
    expect(screen.queryByTestId(`offer-role-${L1}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('offer-return-note')).not.toBeInTheDocument();
  });
});

describe('Backend-Core refuses a return for an offer discount', () => {
  it.each<ReturnsRefusalReason>([
    'promotion_clawback_exceeds_refund',
    'promotion_return_requires_clawback',
  ])('%s: the cashier sees its own guidance, and the return is not recorded', async (reason) => {
    const bridge = fakeBridge();
    bridge.submit.mockResolvedValueOnce({
      kind: 'refused',
      reason,
      ret: journal({ state: 'refused', returnRef: null, refusalReason: reason }),
    });
    renderReturns({ bridge });
    await submitReturn(userEvent.setup());
    await screen.findByRole('heading', { name: 'نتيجة المرتجع' });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(refusalMessage(reason));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('لم يُصرف أي نقد');
  });
});
