import { useId, useState, type JSX, type RefObject } from 'react';

import type { RecentSaleRow } from '../../../shared/bridge-api';
import type { SaleVoidSaleView } from '../../../shared/sale-void/types';
import { RecentSalesBody } from '../../sale-lookup/RecentSalesBody';
import { RecentSalesRows } from '../../sale-lookup/RecentSalesRows';
import { resolveSaleNumber } from '../../sale-lookup/resolve-sale-number';
import { SALE_LOOKUP_COPY as LOOKUP_COPY } from '../../sale-lookup/sale-lookup-copy';
import type { RecentSalesState } from '../../sale-lookup/useRecentSales';
import { useSingleFlight } from '../shift/shift-bridge';
import { VOID_COPY, voidRefusalMessage } from './void-copy';
import type { VoidBridges } from './void-bridges';
import { VoidAlert, VoidCode, VoidMoney, VoidPanel, VoidTime } from './void-parts';

/**
 * RT-1192 (RT-249 N-S3) — the void lookup: the number field takes the short or
 * the full sale number (M-N8) and today's sales sit under it (M-N1: «مبيعاتك
 * اليوم» for a cashier, whose rows main already limits to their own). A short
 * number is resolved through `sales.listRecent` to the exact number before
 * `saleVoid.lookup`; a full number goes straight to it, digits normalised. Several
 * matches (M-N4) are listed and never picked; none says so and adds M-N3.
 */
export type Found =
  | { kind: 'idle' }
  | { kind: 'sale'; sale: SaleVoidSaleView }
  | { kind: 'refused'; message: string }
  | { kind: 'many'; candidates: readonly RecentSaleRow[] };

export interface VoidLookupProps {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly bridges: VoidBridges;
  readonly found: Found;
  readonly recent: RecentSalesState;
  readonly scope: 'own' | 'terminal';
  readonly onFound: (found: Found) => void;
  readonly onVoid: (sale: SaleVoidSaleView) => void;
}

export function VoidLookup(props: VoidLookupProps): JSX.Element {
  const { bridges, onFound } = props;
  const [value, setValue] = useState('');
  const { busy, run } = useSingleFlight();
  const hintId = useId();

  const lookup = (saleNumber: string): Promise<void> =>
    bridges.saleVoid.lookup({ sale_number: saleNumber }).then(
      (answer) => {
        onFound(
          answer.kind === 'sale'
            ? { kind: 'sale', sale: answer.sale }
            : { kind: 'refused', message: voidRefusalMessage(answer.reason) },
        );
      },
      () => {
        onFound({ kind: 'refused', message: VOID_COPY.unavailable });
      },
    );

  const search = (raw: string): void => {
    run(async () => {
      const r = await resolveSaleNumber(bridges.sales ?? null, raw);
      if (r.kind === 'empty') return;
      if (r.kind === 'none') {
        const text = `${voidRefusalMessage('sale_not_found')} ${LOOKUP_COPY.notFoundEarlier}`;
        onFound({ kind: 'refused', message: text });
      } else if (r.kind === 'many') {
        onFound({ kind: 'many', candidates: r.candidates });
      } else if (r.kind === 'failed') {
        onFound({ kind: 'refused', message: VOID_COPY.unavailable });
      } else {
        await lookup(r.saleNumber);
      }
    });
  };

  const pick = (row: RecentSaleRow): void => {
    setValue(row.sale_number);
    search(row.sale_number);
  };

  return (
    <div className="v5-void-left">
      <VoidPanel title={VOID_COPY.lookupHeading} hug>
        <div className="v5-void-panel-body">
          <form
            className="v5-void-lookup"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              search(value);
            }}
          >
            <div className="v5-void-field">
              <label htmlFor="void-sale-number">{VOID_COPY.numberLabel}</label>
              <input
                ref={props.inputRef}
                id="void-sale-number"
                className="v5-void-input v5-void-input--code"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                aria-describedby={hintId}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
              />
              <p id={hintId} className="v5-void-hint">
                {LOOKUP_COPY.fieldHint}
              </p>
            </div>
            <button
              type="submit"
              className="v5-void-btn v5-void-btn--primary v5-btn v5-btn--primary"
              disabled={busy}
            >
              {VOID_COPY.search}
            </button>
          </form>
          <FoundSale found={props.found} onVoid={props.onVoid} onPick={pick} disabled={busy} />
        </div>
      </VoidPanel>
      {props.recent.kind !== 'absent' && (
        <VoidPanel title={props.scope === 'own' ? LOOKUP_COPY.ownTitle : LOOKUP_COPY.terminalTitle}>
          <div className="v5-void-panel-body">
            <RecentSalesBody
              state={props.recent}
              scope={props.scope}
              disabled={busy}
              onPick={pick}
            />
          </div>
        </VoidPanel>
      )}
    </div>
  );
}

function FoundSale(props: {
  found: Found;
  onVoid: (sale: SaleVoidSaleView) => void;
  onPick: (row: RecentSaleRow) => void;
  disabled: boolean;
}): JSX.Element {
  const { found } = props;
  if (found.kind === 'idle') return <p className="v5-void-hint">{VOID_COPY.sameDayHint}</p>;
  if (found.kind === 'refused') return <VoidAlert message={found.message} />;
  if (found.kind === 'many') {
    return (
      <>
        <VoidAlert message={LOOKUP_COPY.ambiguous} />
        <RecentSalesRows
          items={found.candidates}
          label={LOOKUP_COPY.ambiguousList}
          showSeller
          disabled={props.disabled}
          onPick={props.onPick}
        />
      </>
    );
  }
  const { sale } = found;
  return (
    <div className="v5-void-result" data-testid="void-sale">
      <dl className="v5-void-facts">
        <dt>{VOID_COPY.saleNumber}</dt>
        <dd>
          <VoidCode value={sale.sale_number} />
        </dd>
        <dt>{VOID_COPY.soldAt}</dt>
        <dd>
          <VoidTime iso={sale.finalized_at} />
        </dd>
        <dt>{VOID_COPY.seller}</dt>
        <dd>
          <bdi>{sale.selling_operator_display_name}</bdi>
        </dd>
        <dt>{VOID_COPY.total}</dt>
        <dd>
          <VoidMoney minor={sale.total_minor} />
        </dd>
        <dt>{VOID_COPY.cash}</dt>
        <dd>
          <VoidMoney minor={sale.cash_minor} />
        </dd>
      </dl>
      {sale.ineligible === null ? (
        <div className="v5-void-actions">
          <button
            type="button"
            className="v5-void-btn v5-void-btn--danger v5-btn v5-btn--danger-quiet"
            onClick={() => {
              props.onVoid(sale);
            }}
          >
            {VOID_COPY.voidAction}
          </button>
        </div>
      ) : (
        <VoidAlert message={voidRefusalMessage(sale.ineligible)} />
      )}
    </div>
  );
}
