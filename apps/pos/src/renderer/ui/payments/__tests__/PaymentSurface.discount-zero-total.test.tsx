/**
 * RT-855 (RT-699 I2; OZ-1 = Z-A; D1 ZeroCheckout / ZeroCompletion) — Checkout
 * on a manually discounted envelope:
 *
 * - the payment starts on the envelope's amount due (RT-854: the net), never
 *   the gross;
 * - the order summary shows each line's «خصم 10%» row (the percent isolated,
 *   so it never reads «%100») and «إجمالي الخصم»;
 * - at 0 due there is no tender tile, only why none is needed and one
 *   «إتمام البيع» commit that starts on 0 and confirms with no tender line;
 * - Completion at 0 says «لا يوجد مبلغ مستحق», never «تم استلام المبلغ».
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentAttemptRendererView } from '../../../../shared/payments/types.js';
import type {
  PaymentsBridgeAPI,
  PaymentsReadResponse,
  TenderBridgeAPI,
} from '../../../../shared/bridge-api.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { expectNoAxeViolations } from '../../../test-utils/axe-config.js';
import { PaymentSurface } from '../PaymentSurface.js';

function line(id: string, name: string, minor: number): PaymentIntentEnvelope['lines'][number] {
  return {
    line_id: id,
    item_ref: `item-${id}`,
    display_name: name,
    quantity: 1,
    unit_price_minor: minor,
    line_subtotal_minor: minor,
    note: null,
    version: 1,
    last_action_id: `act-${id}`,
  };
}

function placeholder(lineId: string, kind: string) {
  return {
    placeholder_id: `dp-${lineId}`,
    line_id: lineId,
    placeholder_kind: kind,
    requires_manager_attribution: true,
    attribution_operator_id: null,
  };
}

const BASE: Omit<PaymentIntentEnvelope, 'lines' | 'discount_placeholders' | 'subtotal_minor'> = {
  envelope_version: 'v1',
  cart_id: 'cart-001',
  operator_session_id: 'sess-001',
  owning_operator_id: 'op-001',
  tenant_id: 'tenant-001',
  branch_id: 'branch-001',
  terminal_id: 'terminal-001',
  created_at: '2026-10-26T09:00:00.000Z',
  handoff_action_id: 'hid-001',
};

/** D1 ZeroCheckout: 29.50 at 100% and 68.00 by a fixed 68.00 — nothing due. */
const ZERO: PaymentIntentEnvelope = {
  ...BASE,
  lines: [line('l-1', 'كونجستال أقراص', 2950), line('l-2', 'فولتارين جل', 6800)],
  discount_placeholders: [
    placeholder('l-1', 'manual_pct_100'),
    placeholder('l-2', 'manual_amt_6800'),
  ],
  subtotal_minor: 9750,
  discount_total_minor: 9750,
  total_due_minor: 0,
};

/** 2 × 45.00 at 10% (doc 28 §5): 81.00 due. */
const DISCOUNTED: PaymentIntentEnvelope = {
  ...BASE,
  lines: [{ ...line('l-1', 'بنادول إكسترا', 4500), quantity: 2, line_subtotal_minor: 9000 }],
  discount_placeholders: [placeholder('l-1', 'manual_pct_10')],
  subtotal_minor: 9000,
  discount_total_minor: 900,
  total_due_minor: 8100,
};

function view(state: PaymentAttemptRendererView['state'], due: number): PaymentAttemptRendererView {
  return {
    payment_attempt_id: 'pa-001',
    state,
    envelope_subtotal_minor: due,
    started_at: '2026-10-26T09:00:30.000Z',
    ...(state === 'settled' ? { settled_at: '2026-10-26T09:01:00.000Z' } : {}),
    tender_lines: [],
  };
}

interface Harness {
  readonly bridge: { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI };
  readonly start: Mock;
  readonly read: Mock<PaymentsBridgeAPI['read']>;
  readonly confirm: Mock;
}

function makeHarness(due: number): Harness {
  const start = vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' }));
  const read = vi.fn<PaymentsBridgeAPI['read']>(() =>
    Promise.resolve<PaymentsReadResponse>({ kind: 'ok', payment_attempt: view('started', due) }),
  );
  const confirm = vi.fn(() =>
    Promise.resolve({ kind: 'ok' as const, settled_at: '2026-10-26T09:01:00.000Z' }),
  );
  return {
    start,
    read,
    confirm,
    bridge: {
      payments: { start, read, confirm, cancel: vi.fn() } as unknown as PaymentsBridgeAPI,
      tender: { apply: vi.fn() } as unknown as TenderBridgeAPI,
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

function mountWith(envelope: PaymentIntentEnvelope, h: Harness): void {
  usePaymentStore.getState().mount(envelope);
  render(
    <PaymentSurface
      _testBridge={h.bridge}
      onBackToSale={() => Promise.resolve(true)}
      onNewSale={vi.fn()}
    />,
  );
}

beforeEach(() => {
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'sess-001',
        operator_id: 'op-001',
        display_name: 'منى عادل',
        role: 'cashier',
        tenant_id: 'tenant-001',
        branch_id: 'branch-001',
        started_at: '2026-10-26T08:00:00.000Z',
      },
    },
  });
  useFeatureFlagsStore.getState().hydrate({
    cart: true,
    payments: true,
    saleFinalization: true,
    productSearch: true,
  });
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  vi.restoreAllMocks();
});

describe('RT-855 — a discounted envelope at Checkout', () => {
  it('starts the payment on the net amount due, never the gross', async () => {
    const h = makeHarness(8100);
    mountWith(DISCOUNTED, h);
    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    await settle();
    expect(h.start).toHaveBeenCalledWith(
      expect.objectContaining({ envelope_subtotal_minor: 8100, envelope_cart_id: 'cart-001' }),
    );
    expect(usePaymentStore.getState().paymentSlice?.envelope_subtotal_minor).toBe(8100);
  });

  it('shows each line discount and «إجمالي الخصم» in the order summary', async () => {
    const h = makeHarness(8100);
    mountWith(DISCOUNTED, h);
    const summary = screen.getByTestId('payment-cart-summary');
    const percent = within(summary).getByText('10%');
    expect(percent.tagName).toBe('BDI');
    expect(percent).toHaveAttribute('dir', 'ltr');
    expect(summary).toHaveTextContent('−9.00 EGP');
    expect(within(summary).getByText('إجمالي الخصم').parentElement).toHaveTextContent('−9.00 EGP');
    expect(screen.getByTestId('payment-summary-subtotal')).toHaveTextContent('90.00 EGP');
    await expectNoAxeViolations(summary);
  });
});

describe('RT-855 — a zero total completes with no tender (OZ-1 = Z-A)', () => {
  it('offers no tender tile, says why, and focuses «إتمام البيع»', async () => {
    const h = makeHarness(0);
    mountWith(ZERO, h);
    await settle();
    expect(screen.queryByTestId('tender-cash')).toBeNull();
    expect(screen.getByTestId('tender-zero-due')).toHaveTextContent(
      'لا يوجد مبلغ مستحق: الخصم يغطي إجمالي البيع، فلا حاجة لطريقة دفع.',
    );
    const complete = screen.getByTestId('payment-surface-complete-zero');
    expect(complete).toHaveTextContent('إتمام البيع');
    expect(complete).toHaveFocus();
    // The 100% reads «خصم 100%», isolated (the D1 sign-off correction).
    const summary = screen.getByTestId('payment-cart-summary');
    expect(within(summary).getByText('100%').tagName).toBe('BDI');
    expect(within(summary).getByText('إجمالي الخصم').parentElement).toHaveTextContent('−97.50 EGP');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('starts on 0, confirms with no tender line, and completes without «تم استلام المبلغ»', async () => {
    const h = makeHarness(0);
    // The settle's follow-up read: main has the attempt settled with no tender line.
    h.read.mockResolvedValue({ kind: 'ok', payment_attempt: view('settled', 0) });
    mountWith(ZERO, h);
    await act(async () => {
      screen.getByTestId('payment-surface-complete-zero').click();
      await Promise.resolve();
    });
    await settle();
    expect(h.start).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope_subtotal_minor: 0,
        envelope_handoff_action_id: 'hid-001',
      }),
    );
    expect(h.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ payment_attempt_id: 'pa-001' }),
    );
    expect(screen.getByText('لا يوجد مبلغ مستحق')).toBeInTheDocument();
    expect(screen.queryByText('تم استلام المبلغ')).toBeNull();
    expect(screen.queryByText('الباقي للعميل')).toBeNull();
    expect(screen.getByText('0.00 EGP')).toBeInTheDocument();
    expect(usePaymentStore.getState().paymentSlice?.state).toBe('settled');
  });

  it('keeps the commit and says so when the start is refused', async () => {
    const h = makeHarness(0);
    h.start.mockResolvedValueOnce({ kind: 'refused', reason: 'cart_not_frozen' });
    mountWith(ZERO, h);
    await act(async () => {
      screen.getByTestId('payment-surface-complete-zero').click();
      await Promise.resolve();
    });
    await settle();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(screen.getByText(/تعذّر بدء عملية الدفع/)).toBeInTheDocument();
    expect(screen.getByTestId('payment-surface-complete-zero')).toBeEnabled();
  });

  it('confirms an attempt already open on 0 without starting another', async () => {
    const h = makeHarness(0);
    usePaymentStore.getState().mount(ZERO);
    usePaymentStore.getState().applyAttemptSnapshot(view('started', 0));
    usePaymentStore.setState({ attemptHandoffId: 'hid-001' });
    render(<PaymentSurface _testBridge={h.bridge} onNewSale={vi.fn()} />);
    await settle();
    await act(async () => {
      screen.getByTestId('payment-surface-complete-zero').click();
      await Promise.resolve();
    });
    await settle();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(screen.getByText('لا يوجد مبلغ مستحق')).toBeInTheDocument();
  });

  it('reads main back when the zero confirm is refused, as any settle (RT-340)', async () => {
    const h = makeHarness(0);
    h.confirm.mockResolvedValueOnce({ kind: 'refused', reason: 'attempt_terminal' });
    h.read.mockResolvedValue({ kind: 'ok', payment_attempt: view('settled', 0) });
    mountWith(ZERO, h);
    await act(async () => {
      screen.getByTestId('payment-surface-complete-zero').click();
      await Promise.resolve();
    });
    await settle();
    expect(h.read).toHaveBeenCalled();
    expect(screen.getByText('لا يوجد مبلغ مستحق')).toBeInTheDocument();
  });
});
