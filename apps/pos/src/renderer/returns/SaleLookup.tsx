import { useId, useRef, useState, type JSX } from 'react';

import type { RecentSaleRow } from '../../shared/bridge-api';
import { Notice } from '../v5/foundation/Notice';
import { RecentSalesBody } from '../sale-lookup/RecentSalesBody';
import { RecentSalesRows } from '../sale-lookup/RecentSalesRows';
import type { RecentSalesBridge } from '../sale-lookup/recent-sales-bridge';
import { resolveSaleNumber } from '../sale-lookup/resolve-sale-number';
import { SALE_LOOKUP_COPY as COPY } from '../sale-lookup/sale-lookup-copy';
import { useRecentSales } from '../sale-lookup/useRecentSales';
import { ReturnNotice } from './ReturnNotice';
import { ReturnsPanel } from './ReturnsPanel';
import type { FlowNotice } from './return-flow-state.js';
import { OUTCOME_COPY, refusalMessage } from './returns-messages.js';
import { useFocusOnMount } from './useFocusOnMount.js';
import type { ReturnFlow } from './useReturnFlow.js';

/**
 * RT-15 S3 — step 1: find the original sale by its local sale number (D-d).
 * Enter submits the lookup (a read, not a financial confirmation).
 *
 * RT-1192 (RT-249 N-S3): the field takes the short number or the full one
 * (M-N8). A short number is resolved through `sales.listRecent` to the exact
 * number, then `returns.lookup` runs as before (RT-15 is unchanged). Today's
 * sales on this terminal sit under it (M-N1); picking a row runs the lookup.
 * Several matches (M-N4) are listed and never picked for the operator; none
 * shows the not-found line and M-N3.
 */
export interface SaleLookupProps {
  readonly flow: ReturnFlow;
  readonly notice: FlowNotice | null;
  readonly recent: RecentSalesBridge | null;
}

/** A line the field itself raised, beside the flow notice (which main raises). */
type Local =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'many'; readonly candidates: readonly RecentSaleRow[] };

export function SaleLookup({ flow, notice, recent }: SaleLookupProps): JSX.Element {
  const [value, setValue] = useState('');
  const [local, setLocal] = useState<Local | null>(null);
  const [resolving, setResolving] = useState(false);
  const flying = useRef(false);
  const inputId = useId();
  const hintId = useId();
  const input = useFocusOnMount<HTMLInputElement>();
  const list = useRecentSales(recent);
  const busy = flow.busy === 'lookup' || resolving;

  const run = async (raw: string): Promise<void> => {
    if (flying.current) return;
    flying.current = true;
    setLocal(null);
    setResolving(true);
    try {
      const r = await resolveSaleNumber(recent, raw);
      if (r.kind === 'none') {
        setLocal({
          kind: 'message',
          text: `${refusalMessage('sale_not_found')} ${COPY.notFoundEarlier}`,
        });
      } else if (r.kind === 'many') {
        setLocal({ kind: 'many', candidates: r.candidates });
      } else if (r.kind === 'failed') {
        setLocal({ kind: 'message', text: OUTCOME_COPY.callFailed });
      } else {
        await flow.lookup(r.kind === 'empty' ? raw : r.saleNumber);
      }
    } finally {
      flying.current = false;
      setResolving(false);
    }
  };

  const pick = (row: RecentSaleRow): void => {
    setValue(row.sale_number);
    void run(row.sale_number);
  };

  return (
    <>
      <ReturnsPanel id="v5-returns-lookup" title="البحث عن بيع">
        <div className="v5-manager-panel__body">
          <form
            className="v5-returns-lookup"
            onSubmit={(e) => {
              e.preventDefault();
              void run(value);
            }}
          >
            <div className="v5-manager-field">
              <label htmlFor={inputId}>{COPY.fieldLabel}</label>
              <input
                id={inputId}
                ref={input}
                className="v5-manager-input v5-manager-input--code"
                value={value}
                dir="ltr"
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={hintId}
                onChange={(e) => {
                  setValue(e.target.value);
                }}
              />
              <p id={hintId} className="v5-returns-field-hint">
                {COPY.fieldHint}
              </p>
            </div>
            <button
              type="submit"
              className="v5-manager-btn v5-manager-btn--primary v5-btn v5-btn--primary"
              disabled={busy}
              aria-busy={busy}
            >
              بحث
            </button>
          </form>
          <ReturnNotice notice={notice} />
          <LocalLine local={local} onPick={pick} disabled={busy} />
        </div>
      </ReturnsPanel>
      {list.kind !== 'absent' && (
        <ReturnsPanel id="v5-returns-recent" title={COPY.terminalTitle}>
          <div className="v5-manager-panel__body">
            <RecentSalesBody state={list} scope="terminal" disabled={busy} onPick={pick} />
          </div>
        </ReturnsPanel>
      )}
    </>
  );
}

function LocalLine({
  local,
  onPick,
  disabled,
}: {
  readonly local: Local | null;
  readonly onPick: (row: RecentSaleRow) => void;
  readonly disabled: boolean;
}): JSX.Element | null {
  if (local === null) return null;
  if (local.kind === 'message') return <Notice tone="danger">{local.text}</Notice>;
  return (
    <>
      <Notice tone="warning">{COPY.ambiguous}</Notice>
      <RecentSalesRows
        items={local.candidates}
        label={COPY.ambiguousList}
        showSeller
        disabled={disabled}
        onPick={onPick}
      />
    </>
  );
}
