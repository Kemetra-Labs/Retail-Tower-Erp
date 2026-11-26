import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { FreshnessState } from '../../sale/useCatalogueFreshness';
import type { CartLineItem } from '../../sale/useSaleCartController';
import { LiveProductRail } from '../sale/LiveProductRail';
import { LiveSaleCart } from '../sale/LiveSaleCart';

afterEach(() => {
  cleanup();
});

const LINE: CartLineItem = {
  lineId: 'line-1',
  displayName: 'باراسيتامول',
  quantity: 2,
  unitPriceMinor: 1500,
  lineSubtotalMinor: 3000,
  note: null,
  version: 1,
};

function cart(
  over: Partial<Parameters<typeof LiveSaleCart>[0]> = {},
): Parameters<typeof LiveSaleCart>[0] {
  return {
    lines: [LINE],
    discounts: [],
    subtotalMinor: 3000,
    itemCount: 2,
    frozenSubtotalMinor: null,
    canHandoff: true,
    handingOff: false,
    cancelled: false,
    canVoid: true,
    canContinue: false,
    handoffError: null,
    onIncrement: vi.fn(),
    onDecrement: vi.fn(),
    onRemove: vi.fn(),
    onSaveNote: vi.fn().mockResolvedValue(true),
    onRemoveDiscount: vi.fn(),
    onHandoff: vi.fn(),
    onContinue: vi.fn(),
    onVoid: vi.fn().mockResolvedValue(true),
    ...over,
  };
}

function cartHeading(): HTMLElement {
  const heading = screen.getByRole('heading', { name: 'سلة المشتريات' });
  const bar = heading.closest<HTMLElement>('.v5-sale-cart-heading');
  if (bar === null) throw new Error('cart heading bar missing');
  return bar;
}

describe('v5 Sale polish — transaction state in the cart heading', () => {
  it('shows no state label while the cart is still being edited', () => {
    render(<LiveSaleCart {...cart()} />);
    expect(cartHeading().querySelector('.v5-live-cart-state')).toBeNull();
  });

  it.each([
    ['frozen, awaiting payment', { frozenSubtotalMinor: 3000, canVoid: false }, 'مُسلّمة للدفع'],
    ['paid', { frozenSubtotalMinor: 3000, canVoid: false, paid: true }, 'مدفوعة'],
    ['cancelled', { cancelled: true, canVoid: false }, 'ملغاة'],
  ] as const)('labels the %s cart from existing props only', (_name, over, label) => {
    render(<LiveSaleCart {...cart(over)} />);
    const state = cartHeading().querySelector('.v5-live-cart-state');
    expect(state).toHaveTextContent(label);
    // A label, not a live region: the actions area already announces changes.
    expect(state).not.toHaveAttribute('role');
  });

  // RT-242 (Direction B): the void moves to the money column's own region,
  // apart from the commit, and no longer sits in the cart heading.
  it('places the void in the money column, in its own region apart from the commit', () => {
    render(<LiveSaleCart {...cart()} />);
    const voidButton = screen.getByRole('button', { name: 'إلغاء البيع' });
    const money = screen.getByRole('region', { name: 'ملخص العملية' });
    expect(money).toContainElement(voidButton);
    expect(cartHeading()).not.toContainElement(voidButton);
    const commit = screen.getByRole('button', { name: /تسليم السلة للدفع/ });
    expect(voidButton.closest('.v5-sale-money-secondary')).not.toBeNull();
    expect(commit.closest('.v5-sale-money-secondary')).toBeNull();
  });

  it('drops the decorative eyebrow above the cart heading', () => {
    render(<LiveSaleCart {...cart()} />);
    expect(screen.queryByText('المعاملة الجارية')).not.toBeInTheDocument();
  });
});

describe('v5 Sale polish — action notices carry their tone', () => {
  it('renders a handoff failure as a danger notice', () => {
    render(<LiveSaleCart {...cart({ handoffError: 'تعذّر تسليم السلة.' })} />);
    expect(screen.getByRole('alert')).toHaveClass('v5-live-notice', 'v5-live-notice--danger');
  });

  it('renders the paid and voided acknowledgements as state notices', () => {
    const { rerender } = render(
      <LiveSaleCart {...cart({ frozenSubtotalMinor: 3000, canVoid: false, paid: true })} />,
    );
    expect(screen.getByText('تم الدفع لهذه السلة.')).toHaveClass('v5-live-notice--success');
    rerender(<LiveSaleCart {...cart({ lines: [], canVoid: false, voided: true })} />);
    expect(screen.getByText('تم إلغاء البيع.')).toHaveClass('v5-live-notice');
  });
});

describe('v5 Sale polish — catalogue freshness tone', () => {
  function renderRail(freshness: FreshnessState): HTMLElement {
    render(
      <LiveProductRail
        state={{ kind: 'idle' }}
        freshness={freshness}
        lastSuccessAt="2026-09-24T10:00:00.000Z"
        feedback="idle"
        refreshing={false}
        onRefresh={vi.fn()}
        onSearch={vi.fn()}
        onScan={vi.fn()}
        onSelect={vi.fn()}
        onRecover={vi.fn()}
        searchRef={{ current: null }}
      />,
    );
    const bar = screen.getByRole('button', { name: 'تحديث الكتالوج' }).closest('[data-tone]');
    if (!(bar instanceof HTMLElement)) throw new Error('freshness bar missing');
    return bar;
  }

  it.each([
    ['never-synced', 'warning'],
    ['unavailable', 'warning'],
    ['synced-empty', 'warning'],
    ['updated', 'neutral'],
    ['loading', 'neutral'],
  ] as const)('marks %s as %s', (freshness, tone) => {
    expect(renderRail(freshness)).toHaveAttribute('data-tone', tone);
  });

  it('keeps the scanner field distinct from typed search without renaming it', () => {
    renderRail('updated');
    const scan = screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' });
    expect(scan.closest('.v5-live-scan-field')).not.toBeNull();
    expect(scan.closest('.v5-sale-search-field')).toBeNull();
  });
});

describe('v5 Sale polish — CSS states', () => {
  const css = readFileSync(resolve(__dirname, '../sale/live-sale.css'), 'utf8');
  const buttonsCss = readFileSync(resolve(__dirname, '../foundation/buttons.css'), 'utf8');

  it('shows which search result the keyboard has selected', () => {
    expect(css).toMatch(/\.v5-sale-product-row\[aria-selected='true'\]\s*\{/);
    expect(css).toMatch(/\.v5-sale-product-list:focus-visible\s*\{/);
  });

  it('sizes the search recovery buttons with the other live controls', () => {
    // The recovery button is a shared v5-btn, which carries the 44px floor (foundation/buttons.css).
    const results = readFileSync(resolve(__dirname, '../sale/LiveSearchResults.tsx'), 'utf8');
    expect(results).toMatch(
      /<button type="button" className="v5-btn" onClick=\{props\.onRecover\}>/,
    );
    const base = /\.v5-btn\s*\{([^}]*)\}/.exec(buttonsCss)?.[1] ?? '';
    expect(base).toMatch(/min-block-size:\s*44px/);
  });

  it('makes a disabled primary action read as unavailable, not as a pale enabled button', () => {
    // The Sale CTA is a shared v5-btn--commit: its unavailable state is the system's recessed one.
    const cartSource = readFileSync(resolve(__dirname, '../sale/LiveSaleCart.tsx'), 'utf8');
    expect(cartSource).toMatch(/v5-sale-checkout v5-btn v5-btn--primary v5-btn--commit/);
    const rule = /\.v5-btn:is\(:disabled,\s*\[aria-disabled='true'\]\)\s*\{([^}]*)\}/.exec(
      buttonsCss,
    );
    expect(rule?.[1]).toMatch(/background:\s*var\(--color-surface-sunken\)/);
    expect(rule?.[1]).not.toMatch(/opacity/);
  });
});

describe('v5 Sale polish — frozen cart stays keyboard-scrollable', () => {
  it('exposes the line area as a focusable, named region', () => {
    render(<LiveSaleCart {...cart({ frozenSubtotalMinor: 3000, canVoid: false })} />);
    expect(screen.getByRole('region', { name: 'بنود السلة' })).toHaveAttribute('tabindex', '0');
  });
});

// RT-1119: DESIGN.md "The Twelve-Pixel Rule": the command-bar labels are read all shift.
describe('v5 Sale polish — command-bar labels read at 12px', () => {
  const css = readFileSync(resolve(__dirname, '../sale/sale-direction-b.css'), 'utf8');
  const rule = /\.v5-sale-command-input label\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

  it('sizes the labels with the meta token, never the 11px keyboard-hint token', () => {
    expect(rule).toMatch(/font-size:\s*var\(--type-meta\)/);
    expect(rule).not.toMatch(/--font-size-2xs/);
  });

  it('keeps the label colour and weight', () => {
    expect(rule).toMatch(/color:\s*var\(--color-primary-emphasis\)/);
    expect(rule).toMatch(/font-weight:\s*var\(--font-weight-bold\)/);
  });
});

// RT-1119 (M-S11, M-S12; DESIGN.md "Unavailable commit"): the reason sits under the commit.
describe('v5 Sale polish — the unavailable handoff says why', () => {
  const HANDOFF = 'تسليم السلة للدفع';

  function reasonOf(button: HTMLElement): HTMLElement {
    const id = button.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    const reason = document.getElementById(id ?? '');
    if (reason === null) throw new Error('aria-describedby points at nothing');
    return reason;
  }

  it('gives an empty cart a reason, wired to the disabled commit', () => {
    render(<LiveSaleCart {...cart({ lines: [], itemCount: 0, canHandoff: false })} />);
    const button = screen.getByRole('button', { name: HANDOFF });
    expect(button).toBeDisabled();
    const reason = reasonOf(button);
    expect(reason).toHaveTextContent('أضف صنفًا لتسليم السلة للدفع');
    expect(reason).toHaveClass('v5-sale-checkout-reason');
    // Guidance, not a refusal: no live-region role.
    expect(reason).not.toHaveAttribute('role');
  });

  it('says an add is still landing while one is in flight', () => {
    render(<LiveSaleCart {...cart({ canHandoff: false, addInFlight: true })} />);
    const button = screen.getByRole('button', { name: HANDOFF });
    expect(button).toBeDisabled();
    expect(reasonOf(button)).toHaveTextContent('جارٍ إضافة الصنف…');
  });

  it('says the first add is landing, not that the cart is empty, while it is in flight', () => {
    render(
      <LiveSaleCart {...cart({ lines: [], itemCount: 0, canHandoff: false, addInFlight: true })} />,
    );
    const button = screen.getByRole('button', { name: HANDOFF });
    expect(reasonOf(button)).toHaveTextContent('جارٍ إضافة الصنف…');
  });

  it('shows no stale reason while the handoff is in flight', () => {
    render(
      <LiveSaleCart
        {...cart({
          lines: [],
          itemCount: 0,
          canHandoff: false,
          addInFlight: true,
          handingOff: true,
        })}
      />,
    );
    const button = screen.getByRole('button', { name: 'جارٍ تسليم السلة…' });
    expect(button).not.toHaveAttribute('aria-describedby');
    expect(document.querySelector('.v5-sale-checkout-reason')).toBeNull();
  });

  it('shows no reason and no description when the handoff is available', () => {
    render(<LiveSaleCart {...cart()} />);
    const button = screen.getByRole('button', { name: HANDOFF });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-describedby');
    expect(document.querySelector('.v5-sale-checkout-reason')).toBeNull();
  });

  it('sets the reason as meta text, neutral, never below 12px', () => {
    const css = readFileSync(resolve(__dirname, '../sale/live-sale.css'), 'utf8');
    const body = /\.v5-live-sale \.v5-sale-checkout-reason\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(body).toMatch(/font-size:\s*var\(--type-meta\)/);
    expect(body).toMatch(/color:\s*var\(--color-text-muted\)/);
    expect(body).not.toMatch(/--font-size-2xs/);
  });
});

describe('v5 Sale polish — CTA label size', () => {
  it('keeps the CTA label at the CTA size when the arrow is absent (handing off)', () => {
    const css = readFileSync(resolve(__dirname, '../sale/live-sale.css'), 'utf8');
    const rule = /\.v5-live-sale \.v5-sale-checkout span:last-child\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'live CTA label override').not.toBeNull();
    expect(rule?.[1]).toMatch(/font-size:\s*inherit/);
  });
});

// RT-1177: DESIGN.md "The Twelve-Pixel Rule": the Rx and controlled-substance flags are read on
// every flagged line, so they sit at the 12px meta token, never the 11px keyboard-hint token.
describe('v5 Sale polish — product flags read at 12px', () => {
  const css = readFileSync(resolve(__dirname, '../sale/live-sale.css'), 'utf8');
  const rule = /\.v5-live-flag\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

  it('sizes the flags with the meta token, never the 11px keyboard-hint token', () => {
    expect(rule, 'the .v5-live-flag rule').not.toBe('');
    expect(rule).toMatch(/font-size:\s*var\(--type-meta\)/);
    expect(rule).not.toMatch(/--font-size-2xs/);
  });

  it('keeps the flag weight and padding, so only the text size changes', () => {
    expect(rule).toMatch(/font-weight:\s*var\(--font-weight-semibold\)/);
    expect(rule).toMatch(/padding:\s*2px var\(--space-2\)/);
  });
});

// RT-1177 AC2 and AC3, as stylesheet guards (the cloud session has no display, so no capture was taken).
const liveSaleCss = readFileSync(resolve(__dirname, '../sale/live-sale.css'), 'utf8');
/** Body of the first `<selector> { ... }` rule in live-sale.css; the selector is fully regex-escaped. */
const liveSaleRule = (selector: string): string =>
  new RegExp(`${selector.replace(/[.*+?^$(){}|[\]\\-]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(
    liveSaleCss,
  )?.[1] ?? '';

describe('v5 Sale polish — product flags cannot grow the cart row', () => {
  const sale = readFileSync(resolve(__dirname, '../sale/sale-direction-b.css'), 'utf8');
  const flag = liveSaleRule('.v5-live-flag');
  const flags = liveSaleRule('.v5-live-flags');

  it('keeps the row floor on the shared token: 60px comfortable, 52px compact', () => {
    expect(sale).toMatch(/\.v5-sale-cart-table\s*\{[^}]*--v5-fit-row-size:\s*60px;/);
    expect(sale).toMatch(
      /\.v5-live-sale \.v5-sale-cart-line\s*\{\s*min-block-size:\s*var\(--v5-fit-row-size\);\s*padding-block:\s*var\(--space-1\);/,
    );
    const compact = sale.split('@container v5-screen (max-width: 1120px)')[1] ?? '';
    expect(compact).toMatch(/--v5-fit-row-size:\s*52px;/);
    expect(compact).toMatch(/\.v5-live-sale \.v5-sale-cart-line\s*\{\s*padding-block:\s*2px;/);
  });

  it('adds only the 2px block padding to the flag line box: no height, line-height, margin or border', () => {
    expect(flag, 'the .v5-live-flag rule').not.toBe('');
    expect(flag).toMatch(/padding:\s*2px var\(--space-2\)/);
    expect(flag).not.toMatch(/(?:^|[\s;{-])(?:min-|max-)?(?:block-size|height)\s*:/);
    expect(flag).not.toMatch(/line-height\s*:/);
    expect(flag).not.toMatch(/margin/);
    expect(flag).not.toMatch(/border\s*:/);
  });

  it('wraps the flags in a flex-wrap row with a small gap, so extra flags wrap inside the line', () => {
    expect(flags).toMatch(/display:\s*flex/);
    expect(flags).toMatch(/flex-wrap:\s*wrap/);
    expect(flags).toMatch(/gap:\s*var\(--space-1\)/);
    expect(flags).not.toMatch(/(?:block-size|height|margin|padding)/);
  });
});

describe('v5 Sale polish — product flags in forced-colours mode', () => {
  const rule = liveSaleRule;

  it('leaves the Rx and controlled flags to the UA: token colours only, no forced-color-adjust opt-out', () => {
    for (const name of ['.v5-live-flag', '.v5-live-flag--controlled', '.v5-live-flag--rx']) {
      const body = rule(name);
      expect(body, name).not.toBe('');
      expect(body, name).not.toMatch(/forced-color-adjust/);
      expect(body, name).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
    // The meaning is the Arabic text, so the flag stays readable when its background is dropped.
    expect(rule('.v5-live-flag--controlled')).toMatch(/color:\s*var\(--color-warning-emphasis\)/);
    expect(rule('.v5-live-flag--rx')).toMatch(/color:\s*var\(--color-primary-emphasis\)/);
  });

  it('keeps the availability badge shape visible with a transparent border', () => {
    expect(rule('.v5-live-flag--availability')).toMatch(/border:\s*1px solid transparent/);
  });
});
