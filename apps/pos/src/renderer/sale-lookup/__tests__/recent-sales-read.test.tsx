/**
 * RT-1192 — the read of today's sales behind the Returns and Void lists: the
 * window bridge, the hook's four states (and that a late answer after unmount
 * or a bridge change is dropped), and the dev proof sample's short-number filter.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SalesListRecentResponse } from '../../../shared/bridge-api';
import { proofListRecent } from '../dev/recent-sales-proof';
import { windowRecentSalesBridge, type RecentSalesBridge } from '../recent-sales-bridge';
import { useRecentSales } from '../useRecentSales';
import { fakeRecentBridge, recentRow } from './recent-fixtures';

type WindowWithApi = { api?: unknown };

afterEach(() => {
  delete (window as unknown as WindowWithApi).api;
});

describe('windowRecentSalesBridge', () => {
  it('is null when the preload exposes no api, no sales namespace, or no listRecent', () => {
    expect(windowRecentSalesBridge()).toBeNull();
    (window as unknown as WindowWithApi).api = {};
    expect(windowRecentSalesBridge()).toBeNull();
    (window as unknown as WindowWithApi).api = { sales: {} };
    expect(windowRecentSalesBridge()).toBeNull();
  });

  it('delegates to window.api.sales.listRecent with the request unchanged', async () => {
    const answer: SalesListRecentResponse = {
      kind: 'ok',
      business_day: '2026-11-05',
      items: [],
      truncated: false,
    };
    const listRecent = vi.fn(() => Promise.resolve(answer));
    (window as unknown as WindowWithApi).api = { sales: { listRecent } };
    const bridge = windowRecentSalesBridge();
    expect(await bridge?.listRecent({ short_number: '47' })).toBe(answer);
    expect(listRecent).toHaveBeenCalledWith({ short_number: '47' });
  });

  it('rejects when listRecent disappears after the bridge was taken', async () => {
    const sales: { listRecent?: unknown } = { listRecent: vi.fn() };
    (window as unknown as WindowWithApi).api = { sales };
    const bridge = windowRecentSalesBridge();
    delete sales.listRecent;
    await expect(bridge?.listRecent({})).rejects.toThrow('no sales');
  });
});

function pending(): {
  bridge: RecentSalesBridge;
  resolve: (r: SalesListRecentResponse) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (r: SalesListRecentResponse) => void;
  let reject!: (e: Error) => void;
  const bridge: RecentSalesBridge = {
    listRecent: vi.fn(
      () =>
        new Promise<SalesListRecentResponse>((res, rej) => {
          resolve = res;
          reject = rej;
        }),
    ),
  };
  return {
    bridge,
    resolve: (r) => {
      resolve(r);
    },
    reject: (e) => {
      reject(e);
    },
  };
}

describe('useRecentSales', () => {
  it('is absent without a bridge and never reads', () => {
    const { result } = renderHook(() => useRecentSales(null));
    expect(result.current).toEqual({ kind: 'absent' });
  });

  it('loads, then shows the rows and the truncated flag, with an empty request', async () => {
    const row = recentRow();
    const bridge = fakeRecentBridge([row], true);
    const { result } = renderHook(() => useRecentSales(bridge));
    expect(result.current).toEqual({ kind: 'loading' });
    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'ok', items: [row], truncated: true });
    });
    expect(bridge.listRecent).toHaveBeenCalledWith({});
  });

  it('is unavailable when main answers with anything but ok', async () => {
    const bridge: RecentSalesBridge = {
      listRecent: vi.fn(() =>
        Promise.resolve({ kind: 'not_signed_in' } as unknown as SalesListRecentResponse),
      ),
    };
    const { result } = renderHook(() => useRecentSales(bridge));
    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'unavailable' });
    });
  });

  it('is unavailable when the read rejects', async () => {
    const bridge: RecentSalesBridge = {
      listRecent: vi.fn(() => Promise.reject(new Error('ipc down'))),
    };
    const { result } = renderHook(() => useRecentSales(bridge));
    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'unavailable' });
    });
  });

  it('reads again when refreshKey changes', async () => {
    const bridge = fakeRecentBridge();
    const { rerender } = renderHook(({ key }) => useRecentSales(bridge, key), {
      initialProps: { key: 1 },
    });
    await waitFor(() => {
      expect(bridge.listRecent).toHaveBeenCalledTimes(1);
    });
    rerender({ key: 2 });
    await waitFor(() => {
      expect(bridge.listRecent).toHaveBeenCalledTimes(2);
    });
  });

  it('drops a late answer once the bridge went away', async () => {
    const first = pending();
    const initialProps: { bridge: RecentSalesBridge | null } = { bridge: first.bridge };
    const { result, rerender } = renderHook(({ bridge }) => useRecentSales(bridge), {
      initialProps,
    });
    rerender({ bridge: null });
    expect(result.current).toEqual({ kind: 'absent' });
    first.resolve({
      kind: 'ok',
      business_day: '2026-11-05',
      items: [recentRow()],
      truncated: false,
    });
    await Promise.resolve();
    expect(result.current).toEqual({ kind: 'absent' });
  });

  it('drops a late rejection after unmount', async () => {
    const read = pending();
    const { result, unmount } = renderHook(() => useRecentSales(read.bridge));
    const before = result.current;
    unmount();
    read.reject(new Error('late'));
    await Promise.resolve();
    expect(result.current).toBe(before);
  });
});

describe('proofListRecent (dev sample)', () => {
  it('returns every row newest first with no filter', async () => {
    const answer = await proofListRecent();
    expect(answer.kind).toBe('ok');
    if (answer.kind !== 'ok') return;
    expect(answer.items).toHaveLength(6);
    expect(answer.truncated).toBe(false);
  });

  it('filters by short_number and keeps both runs of a repeated number', async () => {
    const answer = await proofListRecent({ short_number: '12' });
    if (answer.kind !== 'ok') throw new Error('expected ok');
    expect(answer.items.map((r) => r.sale_number)).toEqual([
      'TERM-01-2026-10-17-000012',
      'TERM-01-2026-10-16-000012',
    ]);
  });
});
