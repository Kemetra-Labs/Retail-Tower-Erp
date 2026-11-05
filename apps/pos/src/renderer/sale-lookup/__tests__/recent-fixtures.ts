/**
 * RT-1192 — fixtures for the recent-sales list and the short-number field: rows
 * as `sales.listRecent` returns them, and a fake bridge whose `listRecent` honours
 * the `short_number` filter the way main does (the list is already filtered).
 */
import { vi, type Mock } from 'vitest';

import type {
  RecentSaleRow,
  SalesListRecentRequest,
  SalesListRecentResponse,
} from '../../../shared/bridge-api';
import type { SaleId, SaleNumber } from '../../../shared/sales/types';
import type { RecentSalesBridge } from '../recent-sales-bridge';

/** Plain strings for the two branded ids, so tests can write `sale_number: 'T1-…'`. */
type RowInit = Omit<Partial<RecentSaleRow>, 'sale_id' | 'sale_number'> & {
  sale_id?: string;
  sale_number?: string;
};

export const FULL_NUMBER = 'T1-2026-11-05-000047';

export function recentRow(overrides: RowInit = {}): RecentSaleRow {
  const { sale_id = 'sale-47', sale_number = FULL_NUMBER, ...rest } = overrides;
  return {
    sale_id: sale_id as SaleId,
    sale_number: sale_number as SaleNumber,
    short_number: '47',
    // 2026-11-05 09:15 in Cairo (UTC+2 in November).
    finalized_at: '2026-11-05T07:15:00.000Z',
    total_minor: 15_250,
    tender_types: ['cash'],
    selling_operator_display_name: 'رنا الكاشير',
    latest_print_outcome: 'none',
    ...rest,
  };
}

export type FakeRecentBridge = RecentSalesBridge & {
  listRecent: Mock<(req: SalesListRecentRequest) => Promise<SalesListRecentResponse>>;
};

export function fakeRecentBridge(
  items: readonly RecentSaleRow[] = [recentRow()],
  truncated = false,
): FakeRecentBridge {
  return {
    listRecent: vi.fn((req: SalesListRecentRequest) =>
      Promise.resolve<SalesListRecentResponse>({
        kind: 'ok',
        business_day: '2026-11-05',
        items:
          req.short_number === undefined
            ? [...items]
            : items.filter((row) => row.short_number === req.short_number),
        truncated,
      }),
    ),
  };
}
