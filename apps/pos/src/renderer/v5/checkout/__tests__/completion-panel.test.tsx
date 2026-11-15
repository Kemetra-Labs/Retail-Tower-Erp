/**
 * RT-243 W1-C (freeze 15 S14, A4) — the completion panel lists only proven
 * facts: payment taken (success), main's change to hand back (M-P5), and the
 * receipt as not issued (info) or never issued (warning). It never claims a
 * print, a sale number, a completed sale or sync unless the caller proves THIS
 * payment's own sale number (RT-1322, doc 20 §5.3), and «بيع جديد» owns focus
 * without letting the Enter that settled the payment fall through onto it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { CompletionPanel, type CompletionPanelProps } from '../CompletionPanel';
import { expectNoAxeViolations } from '../../../test-utils/axe-config.js';

const IDS = {
  root: 'root',
  panel: 'panel',
  proofs: 'proofs',
  amount: 'amount',
  change: 'change',
  cardVoid: 'card-void',
  newSale: 'new-sale',
} as const;

const CARD_VOID = 'أُلغي الدفع هنا فقط. ألغِ العملية على جهاز البطاقات قبل أي خصم جديد.';

function renderPanel(overrides: Partial<CompletionPanelProps> = {}): {
  onNewSale: ReturnType<typeof vi.fn>;
} {
  const onNewSale = vi.fn();
  render(
    <CompletionPanel
      paidMinor={99_225}
      changeDueMinor={0}
      saleFinalization
      cardVoidCopy={null}
      drawerNotice={null}
      operator={<span>أحمد</span>}
      onNewSale={onNewSale}
      testIds={IDS}
      {...overrides}
    />,
  );
  return { onNewSale };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RT-243 completion — proof list shows only proven facts', () => {
  it('marks the payment as the one proven success, with the amount isolated LTR', () => {
    renderPanel();
    const payment = screen.getByTestId('completion-proof-payment');
    expect(payment).toHaveAttribute('data-tone', 'success');
    expect(payment).toHaveTextContent('تم استلام المبلغ');
    const amount = screen.getByTestId(IDS.amount);
    expect(amount.tagName).toBe('BDI');
    expect(amount).toHaveAttribute('dir', 'ltr');
    expect(amount).toHaveTextContent('992.25 EGP');
    // FR-16: the settled amount stays the dominant figure even with no change.
    expect(payment).toHaveAttribute('data-emphasis', 'hero');

    // Every other line is not a success: success is for proven facts only.
    const lines = within(screen.getByTestId(IDS.proofs)).getAllByRole('listitem');
    expect(lines.filter((l) => l.getAttribute('data-tone') === 'success')).toHaveLength(1);
  });

  it('says no receipt has issued yet (info) while finalization is on', () => {
    renderPanel();
    const receipt = screen.getByTestId('completion-proof-receipt');
    expect(receipt).toHaveAttribute('data-tone', 'info');
    expect(receipt).toHaveTextContent('لم يصدر إيصال بعد.');
  });

  it('says no record or receipt will exist (warning) when finalization is off', () => {
    renderPanel({ saleFinalization: false });
    const receipt = screen.getByTestId('completion-proof-receipt');
    expect(receipt).toHaveAttribute('data-tone', 'warning');
    expect(receipt).toHaveTextContent('لن يُسجَّل هذا البيع ولا يوجد إيصال له.');
    expect(receipt.textContent).not.toMatch(/جارٍ|يجري/u);
  });

  it('claims no print, no receipt sent, no completed sale, no sale number and no sync by default', () => {
    renderPanel({ changeDueMinor: 775 });
    const root = screen.getByTestId(IDS.root);
    // N-09 / M-C2: «طُبع» and «أُرسل الإيصال» need proof tied to this sale.
    expect(root.textContent).not.toMatch(/طُبع|طبع|أُرسل|أرسل/u);
    // M-C1 «اكتمل البيع» and «رقم البيع» need this payment's own number (RT-1322).
    expect(root.textContent).not.toMatch(/اكتمل البيع|رقم البيع/u);
    // Sync health is shown only from a real signal; there is none here.
    expect(root.textContent).not.toMatch(/مزامن|تمت المزامنة|متصل/u);
    expect(within(root).queryAllByRole('listitem')).toHaveLength(3);
  });

  it('is announced politely, never as an alert', () => {
    renderPanel();
    const proofs = screen.getByTestId(IDS.proofs);
    expect(proofs).toHaveAttribute('role', 'status');
    expect(proofs).toHaveAttribute('aria-live', 'polite');
  });
});

describe('RT-1322 completion — this payment’s own sale number (M-C1, M-N5)', () => {
  const NUMBER = { short: '47', exact: 'TERM-01-2026-10-16-000047' } as const;

  it('shows no number line and makes no claim while the caller is still waiting', () => {
    renderPanel({ saleNumber: undefined });
    const root = screen.getByTestId(IDS.root);
    expect(root.textContent).not.toMatch(/اكتمل البيع|رقم البيع/u);
    expect(screen.getByTestId('completion-proof-payment')).toHaveTextContent('تم استلام المبلغ');
  });

  it('turns the headline into «اكتمل البيع» and lists «رقم البيع» with the short form', () => {
    renderPanel({ saleNumber: NUMBER });
    const payment = screen.getByTestId('completion-proof-payment');
    expect(payment).toHaveTextContent('اكتمل البيع');
    expect(payment).not.toHaveTextContent('تم استلام المبلغ');
    // The settled amount stays the one proven success and the hero figure.
    expect(payment).toHaveAttribute('data-tone', 'success');
    expect(payment).toHaveAttribute('data-emphasis', 'hero');
    expect(screen.getByTestId(IDS.amount)).toHaveTextContent('992.25 EGP');

    const line = screen.getByTestId('completion-proof-sale-number');
    expect(line).toHaveTextContent('رقم البيع');
    expect(line).toHaveAttribute('data-tone', 'neutral');
    const value = screen.getByTestId('completion-sale-number-value');
    expect(value).toHaveTextContent(/^47$/u);
    expect(value.tagName).toBe('BDI');
    expect(value).toHaveAttribute('dir', 'ltr');
  });

  it('shows the exact number secondary, as a selectable LTR run', () => {
    renderPanel({ saleNumber: NUMBER });
    const exact = screen.getByTestId('completion-sale-number-exact');
    expect(exact).toHaveTextContent('TERM-01-2026-10-16-000047');
    expect(exact.tagName).toBe('BDI');
    expect(exact).toHaveAttribute('dir', 'ltr');
    expect(exact).toHaveClass('v5-proof-line__detail');
    // The short form is what the cashier scans first.
    const line = screen.getByTestId('completion-proof-sale-number');
    const order = within(line).getAllByText(/47/u);
    expect(order[0]).toBe(screen.getByTestId('completion-sale-number-value'));
  });

  it('shows the exact number alone when main could not derive a short form', () => {
    renderPanel({ saleNumber: { short: null, exact: 'FREE-TEXT-NUMBER' } });
    expect(screen.getByTestId('completion-sale-number-value')).toHaveTextContent(
      'FREE-TEXT-NUMBER',
    );
    expect(screen.queryByTestId('completion-sale-number-exact')).not.toBeInTheDocument();
  });

  it('lists the number right after the payment, before the change and the receipt', () => {
    renderPanel({ saleNumber: NUMBER, changeDueMinor: 775 });
    const ids = within(screen.getByTestId(IDS.proofs))
      .getAllByRole('listitem')
      .map((l) => l.getAttribute('data-testid'));
    expect(ids).toEqual([
      'completion-proof-payment',
      'completion-proof-sale-number',
      IDS.change,
      'completion-proof-receipt',
    ]);
  });

  it('keeps the zero-total headline («لا يوجد مبلغ مستحق») rather than a money claim, and still lists the number', () => {
    renderPanel({ paidMinor: 0, saleNumber: NUMBER });
    expect(screen.getByTestId('completion-proof-payment')).not.toHaveTextContent(
      'تم استلام المبلغ',
    );
    expect(screen.getByTestId('completion-proof-sale-number')).toBeInTheDocument();
  });

  it('shows the neutral M-N5 line at the bound, and never claims the sale was saved', () => {
    renderPanel({ saleNumberUnavailable: true });
    const line = screen.getByTestId('completion-proof-sale-number-unavailable');
    expect(line).toHaveTextContent('رقم البيع غير متاح الآن.');
    expect(line).toHaveAttribute('data-tone', 'info');
    const root = screen.getByTestId(IDS.root);
    expect(root.textContent).not.toMatch(/اكتمل البيع|سُجِّل|تم حفظ|حُفظ/u);
    expect(screen.getByTestId('completion-proof-payment')).toHaveTextContent('تم استلام المبلغ');
    expect(screen.queryByTestId('completion-proof-sale-number')).not.toBeInTheDocument();
  });

  it('prefers a proven number over the neutral line', () => {
    renderPanel({ saleNumber: NUMBER, saleNumberUnavailable: true });
    expect(screen.getByTestId('completion-proof-sale-number')).toBeInTheDocument();
    expect(
      screen.queryByTestId('completion-proof-sale-number-unavailable'),
    ).not.toBeInTheDocument();
  });

  it('keeps focus on «بيع جديد» when the number arrives after mount', () => {
    const { rerender } = render(
      <CompletionPanel
        paidMinor={99_225}
        changeDueMinor={0}
        saleFinalization
        cardVoidCopy={null}
        drawerNotice={null}
        operator={<span>أحمد</span>}
        testIds={IDS}
      />,
    );
    expect(screen.getByTestId(IDS.newSale)).toHaveFocus();
    rerender(
      <CompletionPanel
        paidMinor={99_225}
        changeDueMinor={0}
        saleFinalization
        saleNumber={NUMBER}
        cardVoidCopy={null}
        drawerNotice={null}
        operator={<span>أحمد</span>}
        testIds={IDS}
      />,
    );
    expect(screen.getByTestId('completion-proof-sale-number')).toBeInTheDocument();
    expect(screen.getByTestId(IDS.newSale)).toHaveFocus();
  });

  it('uses Western digits and neither «طُبع», «فاتورة» nor English on the new lines', () => {
    for (const props of [{ saleNumber: NUMBER }, { saleNumberUnavailable: true }] as const) {
      renderPanel(props);
      const lines = ['completion-proof-sale-number', 'completion-proof-sale-number-unavailable']
        .map((id) => screen.queryByTestId(id)?.textContent ?? '')
        .join(' ');
      // Arabic-Indic and Extended Arabic-Indic digits.
      expect(lines).not.toMatch(/[٠-٩۰-۹]/u);
      expect(lines).not.toMatch(/طُبع|طبع|فاتورة/u);
      // Letters are only the exact number's own (an LTR run), never copy.
      const copy = lines.replace(NUMBER.exact, '');
      expect(copy).not.toMatch(/[A-Za-z]/u);
      cleanup();
    }
  });

  it('has no axe violations with the number, and with the neutral line', async () => {
    for (const props of [{ saleNumber: NUMBER }, { saleNumberUnavailable: true }] as const) {
      const { container, unmount } = render(
        <main>
          <CompletionPanel
            paidMinor={99_225}
            changeDueMinor={775}
            saleFinalization
            cardVoidCopy={null}
            drawerNotice={null}
            operator={<span>أحمد</span>}
            testIds={IDS}
            {...props}
          />
        </main>,
      );
      await expectNoAxeViolations(container);
      unmount();
    }
  });
});

describe('RT-243 completion — change to hand back (M-P5)', () => {
  it("shows main's change, large and neutral, as an LTR run", () => {
    renderPanel({ changeDueMinor: 125_000 });
    const change = screen.getByTestId(IDS.change);
    expect(change).toHaveTextContent('الباقي للعميل');
    expect(change).toHaveAttribute('data-tone', 'neutral');
    expect(change).toHaveAttribute('data-emphasis', 'strong');
    expect(within(change).getByText('1,250.00 EGP')).toHaveAttribute('dir', 'ltr');
  });

  it.each([0, -100, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    'shows no change line for %s rather than a misleading value',
    (changeDueMinor) => {
      renderPanel({ changeDueMinor });
      expect(screen.queryByTestId(IDS.change)).not.toBeInTheDocument();
    },
  );

  it('lists the change right after the payment, before the receipt', () => {
    renderPanel({ changeDueMinor: 775 });
    const ids = within(screen.getByTestId(IDS.proofs))
      .getAllByRole('listitem')
      .map((l) => l.getAttribute('data-testid'));
    expect(ids).toEqual(['completion-proof-payment', IDS.change, 'completion-proof-receipt']);
  });
});

describe('RT-243 completion — card void and drawer slots', () => {
  it('shows the terminal-void notice as danger above the proofs', () => {
    renderPanel({ cardVoidCopy: CARD_VOID });
    const notice = screen.getByTestId(IDS.cardVoid);
    expect(notice).toHaveAttribute('data-tone', 'danger');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(notice).toHaveTextContent(CARD_VOID);
    expect(
      notice.compareDocumentPosition(screen.getByTestId(IDS.panel)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders no void notice and no drawer slot when none is passed', () => {
    renderPanel();
    expect(screen.queryByTestId(IDS.cardVoid)).not.toBeInTheDocument();
    expect(screen.queryByTestId('drawer-slot')).not.toBeInTheDocument();
  });

  it('renders the drawer slot it is given', () => {
    renderPanel({ drawerNotice: <p data-testid="drawer-slot">درج</p> });
    expect(screen.getByTestId('drawer-slot')).toBeInTheDocument();
  });
});

describe('RT-243 completion — «بيع جديد» focus and the held-Enter guard', () => {
  it('moves focus to «بيع جديد» on mount (freeze 15 §3.2)', () => {
    renderPanel();
    expect(screen.getByTestId(IDS.newSale)).toHaveFocus();
    expect(screen.getByTestId(IDS.newSale)).toHaveAccessibleName('بيع جديد');
  });

  it('asks for the visible focus ring (RT-840: no ring after a pointer confirm)', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'focus');
    renderPanel();
    const button = screen.getByTestId(IDS.newSale);
    const call = spy.mock.calls.findIndex((_, i) => spy.mock.contexts[i] === button);
    expect(spy.mock.calls[call]?.[0]).toEqual({ focusVisible: true });
    spy.mockRestore();
  });

  it('swallows an Enter inside the arm window and a key repeat', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T09:00:00.000Z'));
    renderPanel();
    const button = screen.getByTestId(IDS.newSale);

    const early = fireEvent.keyDown(button, { key: 'Enter' });
    expect(early).toBe(false); // default prevented

    vi.setSystemTime(new Date('2026-10-09T09:00:01.000Z'));
    const held = fireEvent.keyDown(button, { key: 'Enter', repeat: true });
    expect(held).toBe(false);

    const deliberate = fireEvent.keyDown(button, { key: 'Enter' });
    expect(deliberate).toBe(true);
  });

  it('starts a new sale on click', () => {
    const { onNewSale } = renderPanel();
    fireEvent.click(screen.getByTestId(IDS.newSale));
    expect(onNewSale).toHaveBeenCalledTimes(1);
  });

  it('is a safe no-op without a handler', () => {
    renderPanel({ onNewSale: undefined });
    expect(() => fireEvent.click(screen.getByTestId(IDS.newSale))).not.toThrow();
  });
});

describe('RT-847 completion — focus and ring come back when the window is re-activated', () => {
  /** The `focus()` options of every call made on `element` since `spy` started. */
  function focusOptionsOn(
    spy: MockInstance<HTMLElement['focus']>,
    element: HTMLElement,
  ): (FocusOptions | undefined)[] {
    return spy.mock.calls
      .filter((_, i) => spy.mock.contexts[i] === element)
      .map(([options]) => options);
  }

  it('re-asks for the ring on «بيع جديد» when it still holds focus', () => {
    renderPanel();
    const button = screen.getByTestId(IDS.newSale);
    const spy = vi.spyOn(HTMLElement.prototype, 'focus');

    window.dispatchEvent(new FocusEvent('focus'));

    expect(focusOptionsOn(spy, button)).toEqual([{ focusVisible: true }]);
    expect(button).toHaveFocus();
    spy.mockRestore();
  });

  it('restores focus to «بيع جديد» when it fell to the page', () => {
    renderPanel();
    const button = screen.getByTestId(IDS.newSale);
    button.blur();
    expect(button).not.toHaveFocus();
    const spy = vi.spyOn(HTMLElement.prototype, 'focus');

    window.dispatchEvent(new FocusEvent('focus'));

    expect(focusOptionsOn(spy, button)).toEqual([{ focusVisible: true }]);
    expect(button).toHaveFocus();
    spy.mockRestore();
  });

  it('leaves focus the cashier moved elsewhere where it is', () => {
    renderPanel({ drawerNotice: <button type="button">درج</button> });
    const other = screen.getByRole('button', { name: 'درج' });
    other.focus();
    const spy = vi.spyOn(HTMLElement.prototype, 'focus');

    window.dispatchEvent(new FocusEvent('focus'));

    expect(spy).not.toHaveBeenCalled();
    expect(other).toHaveFocus();
    spy.mockRestore();
  });

  it('stops listening once the screen is gone', () => {
    renderPanel();
    cleanup();
    const spy = vi.spyOn(HTMLElement.prototype, 'focus');

    window.dispatchEvent(new FocusEvent('focus'));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('RT-243 completion — accessibility', () => {
  it('has no axe violations with change, a void notice and a drawer slot', async () => {
    const { container } = render(
      <main>
        <CompletionPanel
          paidMinor={99_225}
          changeDueMinor={775}
          saleFinalization
          cardVoidCopy={CARD_VOID}
          drawerNotice={<p>لم يُفتح درج النقود. افتحه يدويًا.</p>}
          operator={<span>أحمد</span>}
          testIds={IDS}
        />
      </main>,
    );
    await expectNoAxeViolations(container);
  });

  it('names the screen and its one heading', () => {
    renderPanel();
    expect(screen.getByRole('region', { name: 'الدفع' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'الدفع' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'حالة البيع' })).toBeInTheDocument();
  });
});

describe('RT-243 completion — numeric hierarchy (FR-16 over M-P5)', () => {
  const css = readFileSync(resolve(__dirname, '../completion.css'), 'utf8');

  /** The font-size token a value rule uses, e.g. `4xl`. */
  function valueSize(emphasis: string): string | undefined {
    const rule = new RegExp(
      `\\[data-emphasis='${emphasis}'\\] \\.v5-proof-line__value \\{[^}]*--font-size-(\\w+)`,
    );
    return rule.exec(css)?.[1];
  }

  it('sizes the settled amount above the change', () => {
    renderPanel({ changeDueMinor: 775 });
    expect(screen.getByTestId('completion-proof-payment')).toHaveAttribute('data-emphasis', 'hero');
    expect(screen.getByTestId(IDS.change)).toHaveAttribute('data-emphasis', 'strong');
    const order = ['md', 'lg', 'xl', '2xl', '3xl', '4xl'];
    const hero = order.indexOf(valueSize('hero') ?? '');
    const strong = order.indexOf(valueSize('strong') ?? '');
    expect(strong).toBeGreaterThan(-1);
    expect(hero).toBeGreaterThan(strong);
  });
});
