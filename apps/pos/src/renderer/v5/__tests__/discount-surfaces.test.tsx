/**
 * RT-855 — the discount's read-only surfaces: a frozen cart's totals come from
 * its envelope (OD-3), and a zero-total Completion never claims money was
 * taken (OZ-1 = Z-A, D1 ZeroCompletion).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { CompletionPanel } from '../checkout/CompletionPanel';
import { LiveSaleCart } from '../sale/LiveSaleCart';
import { DiscountKindLabel } from '../sale/discount/DiscountParts';

afterEach(() => {
  cleanup();
});

const LINE = {
  lineId: 'line-1',
  displayName: 'بنادول',
  quantity: 2,
  unitPriceMinor: 4500,
  lineSubtotalMinor: 9000,
  note: null,
  version: 1,
};

function frozenCart(due: number | null): Parameters<typeof LiveSaleCart>[0] {
  return {
    lines: [LINE],
    discounts: [{ placeholderId: 'dp-1', lineId: 'line-1', attribution_operator_id: null }],
    subtotalMinor: 9000,
    itemCount: 2,
    frozenSubtotalMinor: 9000,
    frozenDiscountMinor: 900,
    frozenDueMinor: due,
    canHandoff: false,
    handingOff: false,
    cancelled: false,
    canVoid: false,
    canContinue: true,
    handoffError: null,
    onIncrement: vi.fn(),
    onDecrement: vi.fn(),
    onRemove: vi.fn(),
    onSaveNote: vi.fn().mockResolvedValue(true),
    onRemoveDiscount: vi.fn(),
    onHandoff: vi.fn(),
    onContinue: vi.fn(),
    onVoid: vi.fn().mockResolvedValue(true),
  };
}

function row(label: string): HTMLElement | null {
  return screen.getByText(label).parentElement;
}

describe('RT-855 frozen cart totals', () => {
  it('shows the envelope’s discount and amount due, and no discount controls', () => {
    render(<LiveSaleCart {...frozenCart(8100)} />);
    expect(row('إجمالي الخصم')).toHaveTextContent('−9.00 EGP');
    expect(row('الإجمالي الحالي')).toHaveTextContent('81.00 EGP');
    expect(row('المجموع الفرعي')).toHaveTextContent('90.00 EGP');
    expect(screen.queryByRole('button', { name: 'إزالة الخصم' })).toBeNull();
    expect(screen.queryByText('أزل الخصم لتغيير الكمية.')).toBeNull();
  });

  it('shows «—» when the envelope’s amount due cannot be read', () => {
    render(<LiveSaleCart {...frozenCart(null)} />);
    expect(row('الإجمالي الحالي')).toHaveTextContent('—');
  });
});

describe('RT-855 discount label', () => {
  it('isolates the percent, reads an amount as «خصم» alone, and never guesses', () => {
    const { container, rerender } = render(<DiscountKindLabel token="manual_pct_100" />);
    expect(container.querySelector('bdi[dir="ltr"]')).toHaveTextContent('100%');
    rerender(<DiscountKindLabel token="manual_amt_500" />);
    expect(container).toHaveTextContent(/^خصم$/);
    rerender(<DiscountKindLabel token="opaque_kind" />);
    expect(container).toHaveTextContent(/^خصم$/);
  });
});

describe('RT-855 zero-total Completion (OZ-1 = Z-A)', () => {
  it('says «لا يوجد مبلغ مستحق», never «تم استلام المبلغ»', () => {
    render(
      <CompletionPanel
        paidMinor={0}
        changeDueMinor={0}
        saleFinalization
        cardVoidCopy={null}
        drawerNotice={null}
        operator={null}
      />,
    );
    expect(screen.getByText('لا يوجد مبلغ مستحق')).toBeInTheDocument();
    expect(screen.getByText('0.00 EGP')).toBeInTheDocument();
    expect(screen.queryByText('تم استلام المبلغ')).toBeNull();
    expect(screen.queryByText('الباقي للعميل')).toBeNull();
  });
});
