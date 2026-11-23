import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type {
  AvailabilityBandsResponse,
  AvailabilityBridgeAPI,
  AvailabilityFreshness,
  AvailabilityRefreshResponse,
  AvailabilityRowState,
} from '../../../shared/availability/types';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import type { CartLineItem } from '../../sale/useSaleCartController';
import { SCAN_ANCHOR_ID } from '../../scan/scan-anchor';
import { useAvailabilityStore } from '../../stores/availability-store';
import { useLineProductStore } from '../../stores/line-product-store';
import { LiveProductRail } from '../sale/LiveProductRail';
import { LiveSaleCart } from '../sale/LiveSaleCart';

/**
 * RT-1578 (RT-1511 S3, spec 013) — the availability badges and status line. Every state of the owner-approved
 * brief (RT-1578 comment 18614), and the rule that none of them ever blocks, holds or confirms a sale.
 */

const ALL_STATES: readonly AvailabilityRowState[] = [
  'in_stock',
  'low',
  'out',
  'unknown',
  'uncertain',
];
const COPY: Readonly<Record<AvailabilityRowState, string>> = {
  in_stock: 'متوفر',
  low: 'كمية قليلة',
  out: 'غير متوفر',
  unknown: 'التوفر غير معروف',
  uncertain: 'التوفر غير مؤكد',
};
const TONE: Readonly<Record<AvailabilityRowState, string>> = {
  in_stock: 'neutral',
  low: 'warning',
  out: 'warning-strong',
  unknown: 'neutral',
  uncertain: 'neutral',
};

const PRODUCT: ProductSnapshotDisplay = {
  product_id: 'p-1',
  display_name_ar: 'بنادول',
  price_minor: 1500,
  active: true,
  controlled_substance: false,
  prescription_required: true,
};
const LINE: CartLineItem = {
  lineId: 'line-1',
  displayName: 'باراسيتامول',
  quantity: 1,
  unitPriceMinor: 1500,
  lineSubtotalMinor: 1500,
  note: null,
  version: 1,
};

let freshness: AvailabilityFreshness = { state: 'fresh', as_of: '2026-11-24T10:00:00.000Z' };
let rowState: AvailabilityRowState = 'in_stock';
let api: { [K in keyof AvailabilityBridgeAPI]: Mock<AvailabilityBridgeAPI[K]> };

function bandsAnswer(ids: readonly string[]): AvailabilityBandsResponse {
  return {
    kind: 'ok',
    ...freshness,
    states: Object.fromEntries(ids.map((id) => [id, rowState])),
  };
}

beforeEach(() => {
  freshness = { state: 'fresh', as_of: '2026-11-24T10:00:00.000Z' };
  rowState = 'in_stock';
  api = {
    status: vi.fn(() => Promise.resolve({ kind: 'ok', ...freshness })),
    bands: vi.fn((req: { product_ids: readonly string[] }) =>
      Promise.resolve(bandsAnswer(req.product_ids)),
    ),
    refresh: vi.fn(() => Promise.resolve({ kind: 'done', outcome: 'refreshed' })),
  };
  (window as unknown as { api: unknown }).api = { availability: api };
  useAvailabilityStore.getState().reset();
  useLineProductStore.getState().reset();
  useLineProductStore.getState().remember('line-1', 'p-1');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { api?: unknown }).api;
});

function rail(over: Partial<Parameters<typeof LiveProductRail>[0]> = {}) {
  const props: Parameters<typeof LiveProductRail>[0] = {
    state: { kind: 'results', items: [PRODUCT], truncated: false },
    freshness: 'updated',
    lastSuccessAt: '2026-11-24T10:00:00.000Z',
    feedback: 'idle',
    refreshing: false,
    onRefresh: vi.fn(),
    onSearch: vi.fn(),
    onScan: vi.fn(),
    onSelect: vi.fn(),
    onRecover: vi.fn(),
    searchRef: { current: null },
    ...over,
  };
  return { props, ...render(<LiveProductRail {...props} />) };
}

function cartProps(over: Partial<Parameters<typeof LiveSaleCart>[0]> = {}) {
  return {
    lines: [LINE],
    discounts: [],
    subtotalMinor: 1500,
    itemCount: 1,
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
  } satisfies Parameters<typeof LiveSaleCart>[0];
}

function optionBadge(): HTMLElement {
  return within(screen.getByRole('option')).getByText(/./, {
    selector: '.v5-live-flag--availability',
  });
}

describe('row badges (search results and cart lines)', () => {
  it.each(ALL_STATES)(
    'shows «%s» on a search result with the approved copy and tone',
    async (state) => {
      rowState = state;
      rail();
      await waitFor(() => {
        expect(optionBadge()).toHaveTextContent(COPY[state]);
      });
      expect(optionBadge()).toHaveAttribute('data-tone', TONE[state]);
    },
  );

  it.each(ALL_STATES)('shows «%s» on a cart line', async (state) => {
    rowState = state;
    render(<LiveSaleCart {...cartProps()} />);
    const row = screen.getByText('باراسيتامول').closest('li');
    await waitFor(() => {
      expect(within(row as HTMLElement).getByText(COPY[state])).toBeInTheDocument();
    });
  });

  it('reads after the Rx flag, so the pharmacy safety flag comes first', async () => {
    rail();
    await waitFor(() => {
      expect(optionBadge()).toBeInTheDocument();
    });
    const flags = Array.from(
      screen.getByRole('option').querySelectorAll('.v5-live-flag'),
      (el) => el.textContent,
    );
    expect(flags).toEqual(['بوصفة طبية', 'متوفر']);
  });

  it('a long Arabic name with Rx and «غير متوفر» keeps all three in the row', async () => {
    rowState = 'out';
    const long = {
      ...PRODUCT,
      display_name_ar: 'كبسولات إيزومبرازول ٤٠ ملغ بطيئة التحرر المغلفة معوياً عبوة اقتصادية كبيرة',
    };
    rail({ state: { kind: 'results', items: [long], truncated: false } });
    await waitFor(() => {
      expect(optionBadge()).toHaveTextContent('غير متوفر');
    });
    expect(screen.getByRole('option')).toHaveTextContent('بوصفة طبية');
    expect(screen.getByRole('option')).toHaveTextContent(long.display_name_ar);
  });

  it('shows no badge until main has answered, and none for a cart line with no known product', () => {
    api.bands.mockImplementation(() => new Promise<AvailabilityBandsResponse>(() => undefined));
    rail();
    expect(screen.getByRole('option').querySelector('.v5-live-flag--availability')).toBeNull();
    cleanup();
    useLineProductStore.getState().reset();
    render(<LiveSaleCart {...cartProps()} />);
    expect(document.querySelector('.v5-live-flag--availability')).toBeNull();
  });

  it('a refused or failing bridge shows no badge and no error', async () => {
    api.bands.mockResolvedValue({ kind: 'refused', reason: 'no_session' });
    api.status.mockRejectedValue(new Error('down'));
    rail();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector('.v5-live-flag--availability')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('batches new products into one lookup, and never asks again for one it already tracks', async () => {
    const second = { ...PRODUCT, product_id: 'p-2' };
    rail({ state: { kind: 'results', items: [PRODUCT, second], truncated: false } });
    await waitFor(() => {
      expect(api.bands).toHaveBeenCalled();
    });
    expect(api.bands).toHaveBeenCalledWith({ product_ids: ['p-1', 'p-2'] });
    await act(async () => {
      await Promise.resolve();
    });
    const settled = api.bands.mock.calls.length;
    useAvailabilityStore.getState().track('p-1');
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.bands).toHaveBeenCalledTimes(settled);
  });
  it('asks in chunks of 200, so no product queued in one tick is dropped', async () => {
    const ids = Array.from({ length: 450 }, (_, n) => `bulk-${String(n)}`);
    for (const id of ids) useAvailabilityStore.getState().track(id);
    await waitFor(() => {
      expect(Object.keys(useAvailabilityStore.getState().states)).toHaveLength(450);
    });
    const sizes = api.bands.mock.calls.map(([req]) => req.product_ids.length);
    expect(sizes).toEqual([200, 200, 50]);
  });
});

describe('a sale is never blocked by any badge state (spec 013 FR-5)', () => {
  it.each(ALL_STATES)(
    'a search result badged «%s» adds at once, by click and by Enter',
    async (state) => {
      rowState = state;
      const { props } = rail();
      await waitFor(() => {
        expect(optionBadge()).toBeInTheDocument();
      });
      const user = userEvent.setup();
      await user.click(screen.getByRole('option'));
      expect(props.onSelect).toHaveBeenCalledTimes(1);
      expect(props.onSelect).toHaveBeenCalledWith(PRODUCT);
      act(() => {
        screen.getByRole('listbox').focus();
      });
      await user.keyboard('{Enter}');
      expect(props.onSelect).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('alertdialog')).toBeNull();
    },
  );

  it.each(ALL_STATES)(
    'a cart line badged «%s» keeps every control enabled, and the handoff goes through',
    async (state) => {
      rowState = state;
      const props = cartProps();
      render(<LiveSaleCart {...props} />);
      await waitFor(() => {
        expect(screen.getByText(COPY[state])).toBeInTheDocument();
      });
      const user = userEvent.setup();
      const handoff = screen.getByRole('button', { name: /تسليم السلة للدفع/ });
      expect(handoff).toBeEnabled();
      await user.click(handoff);
      expect(props.onHandoff).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).toBeNull();
      for (const button of screen.getAllByRole('button')) {
        if (button === handoff) continue;
        expect(button).not.toBeDisabled();
      }
    },
  );

  it('the cart line badge is plain text: it is not a button, link or live region', async () => {
    rowState = 'out';
    render(<LiveSaleCart {...cartProps()} />);
    const badge = await screen.findByText('غير متوفر');
    expect(badge.tagName).toBe('SPAN');
    expect(badge.closest('button, a, [role="alert"], [aria-live]')).toBeNull();
  });
});

describe('the status line', () => {
  const line = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>('.v5-live-availability');
    if (el === null) throw new Error('availability status line missing');
    return el;
  };

  it('fresh: only the refresh button, no text', async () => {
    rail();
    await waitFor(() => {
      expect(api.status).toHaveBeenCalled();
    });
    expect(line().querySelector('span')).toBeNull();
    expect(within(line()).getByRole('button', { name: 'تحديث التوفر' })).toBeEnabled();
  });

  it('never downloaded: «لم يُنزّل التوفر بعد» in the warning tone', async () => {
    freshness = { state: 'never', as_of: null };
    rowState = 'unknown';
    rail();
    await waitFor(() => {
      expect(line()).toHaveTextContent('لم يُنزّل التوفر بعد');
    });
    expect(line()).toHaveAttribute('data-tone', 'warning');
    expect(optionBadge()).toHaveTextContent('التوفر غير معروف');
  });

  it('stale: «بيانات التوفر قديمة» with the last-updated time, and every badge uncertain', async () => {
    freshness = { state: 'stale', as_of: '2026-11-24T08:05:00.000Z' };
    rowState = 'uncertain';
    rail();
    await waitFor(() => {
      expect(line()).toHaveTextContent('بيانات التوفر قديمة · آخر تحديث:');
    });
    expect(line().textContent).toMatch(/\d{2}:\d{2}/);
    expect(line().textContent).not.toMatch(/[٠-٩]/);
    expect(optionBadge()).toHaveTextContent('التوفر غير مؤكد');
  });

  it('stale with an unparseable stamp shows the stamp verbatim instead of throwing', async () => {
    freshness = { state: 'stale', as_of: 'garbled' };
    rail();
    await waitFor(() => {
      expect(line()).toHaveTextContent('آخر تحديث: garbled');
    });
  });

  it('is not a live region: a refresh makes no announcement', async () => {
    freshness = { state: 'stale', as_of: '2026-11-24T08:05:00.000Z' };
    rail();
    await waitFor(() => {
      expect(line()).toHaveTextContent('بيانات التوفر قديمة');
    });
    expect(line().closest('[aria-live], [role="status"], [role="alert"]')).toBeNull();
    expect(line().querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
  });

  it('a click refreshes: the last badges stay, the line says it is refreshing, then fresh data shows', async () => {
    let finish: () => void = () => undefined;
    api.refresh.mockImplementation(
      () =>
        new Promise<AvailabilityRefreshResponse>((resolve) => {
          finish = () => {
            resolve({ kind: 'done', outcome: 'refreshed' });
          };
        }),
    );
    rail();
    await waitFor(() => {
      expect(optionBadge()).toHaveTextContent('متوفر');
    });
    const button = within(line()).getByRole('button', { name: 'تحديث التوفر' });
    const user = userEvent.setup();
    await user.click(button);
    expect(line()).toHaveTextContent('جارٍ تحديث التوفر…');
    expect(button).toBeDisabled();
    expect(optionBadge()).toHaveTextContent('متوفر');
    rowState = 'low';
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(optionBadge()).toHaveTextContent('كمية قليلة');
    });
    expect(line()).not.toHaveTextContent('جارٍ تحديث التوفر…');
    expect(api.refresh).toHaveBeenCalledTimes(1);
  });

  it('a click returns focus to the scan owner, and a click while refreshing does nothing more', async () => {
    rail();
    await waitFor(() => {
      expect(api.status).toHaveBeenCalled();
    });
    const user = userEvent.setup();
    await user.click(within(line()).getByRole('button', { name: 'تحديث التوفر' }));
    expect(document.activeElement).toBe(document.getElementById(SCAN_ANCHOR_ID));
    await useAvailabilityStore.getState().refresh();
    expect(api.refresh.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('a failed refresh call keeps what is shown and does not throw', async () => {
    api.refresh.mockRejectedValue(new Error('down'));
    rail();
    await waitFor(() => {
      expect(optionBadge()).toHaveTextContent('متوفر');
    });
    await useAvailabilityStore.getState().refresh();
    expect(optionBadge()).toHaveTextContent('متوفر');
    expect(useAvailabilityStore.getState().refreshing).toBe(false);
  });

  it('re-reads the freshness every minute, so the stale state appears with no event', async () => {
    vi.useFakeTimers();
    rail();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const initial = api.status.mock.calls.length;
    freshness = { state: 'stale', as_of: '2026-11-24T08:05:00.000Z' };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.status.mock.calls.length).toBeGreaterThan(initial);
    expect(line()).toHaveTextContent('بيانات التوفر قديمة');
  });

  it('with no availability bridge at all, the screen still renders and the button is inert', async () => {
    delete (window as unknown as { api?: unknown }).api;
    rail();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'تحديث التوفر' }));
    expect(screen.getByRole('option')).toBeInTheDocument();
    expect(document.querySelector('.v5-live-flag--availability')).toBeNull();
  });
});

describe('no reservation or stock call from the renderer', () => {
  it('the only bridge members ever used are status, bands and refresh', async () => {
    rail();
    await waitFor(() => {
      expect(optionBadge()).toBeInTheDocument();
    });
    await useAvailabilityStore.getState().refresh();
    expect(Object.keys(api).sort()).toEqual(['bands', 'refresh', 'status']);
  });
});
