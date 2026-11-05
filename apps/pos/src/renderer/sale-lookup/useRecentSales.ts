import { useEffect, useState } from 'react';

import type { RecentSaleRow } from '../../shared/bridge-api';
import type { RecentSalesBridge } from './recent-sales-bridge';

/** `absent`: no bridge, so the screen shows no list at all. */
export type RecentSalesState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ok'; readonly items: readonly RecentSaleRow[]; readonly truncated: boolean };

/**
 * RT-1192 — reads today's sales when the screen mounts and again whenever
 * `refreshKey` changes (a void was requested, so the list is current). The
 * request is empty: main owns the scope (cashier or terminal, Cairo day, cap).
 */
export function useRecentSales(
  bridge: RecentSalesBridge | null,
  refreshKey: unknown = null,
): RecentSalesState {
  const [state, setState] = useState<RecentSalesState>(
    bridge === null ? { kind: 'absent' } : { kind: 'loading' },
  );
  useEffect(() => {
    if (bridge === null) {
      setState({ kind: 'absent' });
      return;
    }
    let live = true;
    bridge.listRecent({}).then(
      (answer) => {
        if (!live) return;
        setState(
          answer.kind === 'ok'
            ? { kind: 'ok', items: answer.items, truncated: answer.truncated }
            : { kind: 'unavailable' },
        );
      },
      () => {
        if (live) setState({ kind: 'unavailable' });
      },
    );
    return () => {
      live = false;
    };
  }, [bridge, refreshKey]);
  return state;
}
