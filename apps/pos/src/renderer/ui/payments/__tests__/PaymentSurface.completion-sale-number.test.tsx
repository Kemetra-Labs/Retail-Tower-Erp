/**
 * RT-1322 (RT-249 N-S2, doc 20 §5.3, §9) — Completion shows ITS OWN sale number.
 *
 * Through the real `PaymentSurface`: with `saleFinalization` off nothing is
 * asked; with it on, the settled screen reads `sales.readForHandoff` with the
 * handoff id and the payment attempt id it already holds, shows nothing and
 * claims nothing while main says `pending`, shows the number and «اكتمل البيع»
 * on `ok`, and at the 15 s bound shows the neutral M-N5 line. A different sale
 * on the terminal-wide `recent` topic never reaches the screen. «بيع جديد»
 * keeps focus throughout.
 */

import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentAttemptRendererView } from '../../../../shared/payments/types.js';
import type {
  PaymentsBridgeAPI,
  SalesBridgeAPI,
  SalesReadForHandoffRequest,
  SalesReadForHandoffResponse,
  SaleSummary,
  TenderBridgeAPI,
} from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { PaymentSurface } from '../PaymentSurface.js';
import { POLL_BOUND_MS } from '../useSettledSaleNumber.js';

const HANDOFF_ID = 'hid-001';
const ATTEMPT_ID = 'pa-001';
const EXACT = 'TERM-01-2026-10-16-000047';
const OTHER_SALE = {
  sale_id: '99999999-aaaa-4bbb-8ccc-dddddddddddd',
  sale_number: 'TERM-01-2026-10-16-000009',
  finalized_at: '2026-09-19T10:00:00.400Z',
};

type Read = (req: SalesReadForHandoffRequest) => Promise<SalesReadForHandoffResponse>;

const PENDING: SalesReadForHandoffResponse = { kind: 'pending' };
const OK: SalesReadForHandoffResponse = {
  kind: 'ok',
  sale: { sale_number: EXACT } as SaleSummary,
  short_number: '47',
};

function makeEnvelope(): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    cart_id: 'cart-001',
    operator_session_id: 'sess-001',
    owning_operator_id: 'op-001',
    tenant_id: 'tenant-001',
    branch_id: 'branch-001',
    terminal_id: 'terminal-001',
    lines: [],
    discount_placeholders: [],
    subtotal_minor: 5000,
    created_at: '2026-09-19T09:00:00.000Z',
    handoff_action_id: HANDOFF_ID,
  };
}

function signIn(): void {
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'sess-001',
        operator_id: 'op-001',
        display_name: 'أحمد',
        role: 'cashier',
        tenant_id: 'tenant-001',
        branch_id: 'branch-001',
        started_at: '2026-09-19T08:00:00.000Z',
      },
    },
  });
}

function makeAttemptSnapshot(): PaymentAttemptRendererView {
  return {
    payment_attempt_id: ATTEMPT_ID,
    state: 'started',
    envelope_subtotal_minor: 5000,
    started_at: '2026-09-19T09:59:00.000Z',
    tender_lines: [
      {
        tender_line_id: 'tl-001',
        tender_type: 'cash',
        state: 'applied',
        amount_applied_minor: 5000,
        applied_at: '2026-09-19T09:59:30.000Z',
        apply_order: 1,
      },
    ],
  };
}

interface TestBridge {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
  sales: SalesBridgeAPI;
}

/** `read` is `sales.readForHandoff`; `null` models a bridge without it. */
function makeBridge(read: Read | null): TestBridge {
  const payments = {
    start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: ATTEMPT_ID })),
    confirm: vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, settled_at: '2026-09-19T10:00:00.000Z' }),
    ),
    cancel: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
  } as unknown as PaymentsBridgeAPI;
  const tender = { apply: vi.fn(() => Promise.resolve({ kind: 'ok' as const })) };
  const sales = {
    // The terminal-wide `recent` topic holds ANOTHER sale; it must never be shown.
    subscribe: vi.fn(() => Promise.resolve({ kind: 'ok' as const, recent: OTHER_SALE })),
    ...(read === null ? {} : { readForHandoff: read }),
  };
  return {
    payments,
    tender: tender as unknown as TenderBridgeAPI,
    sales: sales as unknown as SalesBridgeAPI,
  };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Drive `PaymentSurface` to the settled phase through its own confirm button. */
async function renderSettled(bridge: TestBridge): Promise<{ unmount: () => void }> {
  const view = render(<PaymentSurface _testBridge={bridge} />);
  act(() => {
    usePaymentStore.getState().applyAttemptSnapshot(makeAttemptSnapshot());
  });
  const confirm = await screen.findByTestId('payment-surface-confirm');
  await act(async () => {
    confirm.click();
    await Promise.resolve();
  });
  await screen.findByTestId('completion-proof-payment');
  return view;
}

function hydrateFlags(saleFinalization: boolean): void {
  useFeatureFlagsStore.getState().hydrate({
    cart: true,
    payments: true,
    saleFinalization,
    productSearch: true,
  });
}

beforeEach(() => {
  // Real time keeps moving so `findBy*` works; tests step the clock explicitly.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  signIn();
  usePaymentStore.getState().mount(makeEnvelope());
  hydrateFlags(true);
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RT-1322 Completion — the flag and the key', () => {
  it('makes no call with saleFinalization off, and shows no number line and no claim', async () => {
    hydrateFlags(false);
    const read = vi.fn<Read>(() => Promise.resolve(OK));
    await renderSettled(makeBridge(read));
    await advance(POLL_BOUND_MS + 5_000);
    expect(read).not.toHaveBeenCalled();
    const root = screen.getByTestId('completion-proof-payment').closest('section');
    expect(root?.textContent).not.toMatch(/اكتمل البيع|رقم البيع/u);
  });

  it('reads with the handoff id and the attempt id it already holds, and only those', async () => {
    const read = vi.fn<Read>(() => Promise.resolve(PENDING));
    await renderSettled(makeBridge(read));
    await advance(0);
    expect(read).toHaveBeenCalledWith({
      handoff_action_id: HANDOFF_ID,
      payment_attempt_id: ATTEMPT_ID,
    });
    // The attempt id stays available for every later read until Completion unmounts.
    await advance(5_000);
    for (const [req] of read.mock.calls) {
      expect(req).toEqual({ handoff_action_id: HANDOFF_ID, payment_attempt_id: ATTEMPT_ID });
    }
    expect(usePaymentStore.getState().paymentSlice?.payment_attempt_id).toBe(ATTEMPT_ID);
  });

  it('makes no call and shows nothing extra when the bridge has no readForHandoff', async () => {
    await renderSettled(makeBridge(null));
    await advance(POLL_BOUND_MS + 1_000);
    expect(screen.queryByTestId('completion-proof-sale-number')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('completion-proof-sale-number-unavailable'),
    ).not.toBeInTheDocument();
  });
});

describe('RT-1322 Completion — pending, then the number', () => {
  it('shows no number line and no claim while pending, then the number and «اكتمل البيع»', async () => {
    const read = vi.fn<Read>().mockResolvedValueOnce(PENDING).mockResolvedValue(OK);
    await renderSettled(makeBridge(read));

    // While pending: the payment is taken, nothing more is claimed.
    expect(screen.getByTestId('completion-proof-payment')).toHaveTextContent('تم استلام المبلغ');
    expect(screen.queryByTestId('completion-proof-sale-number')).not.toBeInTheDocument();
    expect(screen.queryByText('اكتمل البيع')).not.toBeInTheDocument();

    await advance(250);
    expect(screen.getByTestId('completion-proof-payment')).toHaveTextContent('اكتمل البيع');
    expect(screen.getByTestId('completion-sale-number-value')).toHaveTextContent(/^47$/u);
    expect(screen.getByTestId('completion-sale-number-exact')).toHaveTextContent(EXACT);
    expect(
      screen.queryByTestId('completion-proof-sale-number-unavailable'),
    ).not.toBeInTheDocument();

    // Polling stops once it has the number.
    const calls = read.mock.calls.length;
    await advance(POLL_BOUND_MS);
    expect(read).toHaveBeenCalledTimes(calls);
  });

  it('keeps focus on «بيع جديد» when the number arrives', async () => {
    const read = vi.fn<Read>().mockResolvedValueOnce(PENDING).mockResolvedValue(OK);
    await renderSettled(makeBridge(read));
    expect(screen.getByTestId('payment-surface-new-sale')).toHaveFocus();
    await advance(250);
    expect(screen.getByTestId('completion-proof-sale-number')).toBeInTheDocument();
    expect(screen.getByTestId('payment-surface-new-sale')).toHaveFocus();
  });

  it('never shows another sale that finalizes in between (the terminal-wide recent row)', async () => {
    // `recent` holds another sale, finalized after this payment settled: the
    // removed poll would have adopted it. This key answers `pending` instead.
    const read = vi.fn<Read>(() => Promise.resolve(PENDING));
    const bridge = makeBridge(read);
    await renderSettled(bridge);
    // Short of the bound: the real time spent reaching Completion also moves the
    // fake clock, so stay a second inside it.
    await advance(POLL_BOUND_MS - 1_000);

    const surface = screen.getByTestId('completion-proof-payment').closest('section');
    expect(surface?.textContent).not.toContain(OTHER_SALE.sale_number);
    expect(surface?.textContent).not.toContain(OTHER_SALE.sale_id);
    expect(surface?.textContent).not.toMatch(/اكتمل البيع|رقم البيع/u);
    expect(screen.queryByTestId('completion-proof-sale-number')).not.toBeInTheDocument();
    // Nothing on this surface reads the `recent` topic any more.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(bridge.sales.subscribe).not.toHaveBeenCalled();
  });
});

describe('RT-1322 Completion — the bound, a refusal and unmount', () => {
  it('shows the neutral M-N5 line at the bound, never claims the sale was saved, and stops polling', async () => {
    const read = vi.fn<Read>(() => Promise.resolve(PENDING));
    await renderSettled(makeBridge(read));

    await advance(POLL_BOUND_MS - 1_000);
    expect(
      screen.queryByTestId('completion-proof-sale-number-unavailable'),
    ).not.toBeInTheDocument();
    await advance(1_000);

    const line = screen.getByTestId('completion-proof-sale-number-unavailable');
    expect(line).toHaveTextContent('رقم البيع غير متاح الآن.');
    const surface = screen.getByTestId('completion-proof-payment').closest('section');
    expect(surface?.textContent).not.toMatch(/اكتمل البيع|سُجِّل|تم حفظ|حُفظ/u);
    expect(screen.getByTestId('completion-proof-payment')).toHaveTextContent('تم استلام المبلغ');

    const calls = read.mock.calls.length;
    await advance(POLL_BOUND_MS * 2);
    expect(read).toHaveBeenCalledTimes(calls);
    expect(screen.getByTestId('payment-surface-new-sale')).toHaveFocus();
  });

  it('shows M-N5 and stops at once on a refusal, with no number', async () => {
    const read = vi.fn<Read>(() => Promise.resolve({ kind: 'refused', reason: 'sale_not_found' }));
    await renderSettled(makeBridge(read));
    await advance(0);
    expect(screen.getByTestId('completion-proof-sale-number-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('completion-proof-sale-number')).not.toBeInTheDocument();
    await advance(POLL_BOUND_MS);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('stops polling on unmount', async () => {
    const read = vi.fn<Read>(() => Promise.resolve(PENDING));
    const { unmount } = await renderSettled(makeBridge(read));
    await advance(1_000);
    const calls = read.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    unmount();
    await advance(POLL_BOUND_MS * 2);
    expect(read).toHaveBeenCalledTimes(calls);
  });
});
