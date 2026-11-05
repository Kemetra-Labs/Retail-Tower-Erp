import type { JSX } from 'react';

import type { RecentSaleRow } from '../../shared/bridge-api';
import { Notice } from '../v5/foundation/Notice';
import { RecentSalesRows } from './RecentSalesRows';
import { SALE_LOOKUP_COPY as COPY } from './sale-lookup-copy';
import type { RecentSalesState } from './useRecentSales';

/**
 * RT-1192 — the body of the «مبيعات اليوم» panel: loading, the scope empty line
 * (M-N2), a neutral line when the list cannot be read, or the rows (and M-N6 when
 * main truncated them). Each screen wraps it in its own panel and heading.
 */
export interface RecentSalesBodyProps {
  readonly state: RecentSalesState;
  /** A cashier list is their own sales: the seller is not repeated. */
  readonly scope: 'own' | 'terminal';
  readonly disabled?: boolean;
  readonly onPick: (row: RecentSaleRow) => void;
}

export function RecentSalesBody({
  state,
  scope,
  disabled,
  onPick,
}: RecentSalesBodyProps): JSX.Element | null {
  const own = scope === 'own';
  if (state.kind === 'absent') return null;
  if (state.kind === 'loading') return <output>{COPY.loading}</output>;
  if (state.kind === 'unavailable') return <Notice tone="info">{COPY.unavailable}</Notice>;
  if (state.items.length === 0) {
    return <Notice tone="info">{own ? COPY.ownEmpty : COPY.terminalEmpty}</Notice>;
  }
  return (
    <>
      <div className="v5-recent-scroll">
        <RecentSalesRows
          items={state.items}
          label={own ? COPY.ownTitle : COPY.terminalTitle}
          showSeller={!own}
          disabled={disabled === true}
          onPick={onPick}
        />
      </div>
      {state.truncated && <p className="v5-recent-note">{COPY.truncated}</p>}
    </>
  );
}
