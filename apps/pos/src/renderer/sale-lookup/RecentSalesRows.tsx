import type { JSX } from 'react';

import type { RecentSaleRow } from '../../shared/bridge-api';
import { businessDateTimeOf } from '../../shared/time/business-day';
import { formatHumanMoney } from '../ui/format/human-format';
import { SALE_LOOKUP_COPY as COPY, TENDER_LABEL } from './sale-lookup-copy';
import '../v5/foundation/ledger.css';
import './sale-lookup.css';

/**
 * RT-1192 (doc 20 §7) — sale rows as Precision Ledger rows:
 * `‹short› · ‹HH:MM› · ‹total› · ‹tender›`, plus the seller when `showSeller`
 * (a manager list; a cashier sees only their own sales, so no name). The exact
 * number sits beside the short one as an isolated LTR run, so it can be read and
 * copied (UX-10 "scan short, inspect exact"). The time is the store (Cairo) clock.
 * Print state is «أُرسل الإيصال للطابعة», «تعذّرت الطباعة» or nothing, never «طُبع».
 * A row is a button: picking it fills the lookup and runs it.
 */
export interface RecentSalesRowsProps {
  readonly items: readonly RecentSaleRow[];
  readonly label: string;
  readonly showSeller: boolean;
  readonly disabled?: boolean;
  readonly onPick: (row: RecentSaleRow) => void;
}

function clock(iso: string): string {
  try {
    return businessDateTimeOf(iso).slice(11);
  } catch {
    return '—';
  }
}

function tenders(row: RecentSaleRow): string {
  return row.tender_types
    .map((t) => TENDER_LABEL[t] ?? '')
    .filter((t) => t !== '')
    .join('، ');
}

function printState(row: RecentSaleRow): string {
  if (row.latest_print_outcome === 'success') return COPY.printSent;
  return row.latest_print_outcome === 'failure' ? COPY.printFailed : '';
}

type RowProps = Omit<RecentSalesRowsProps, 'items' | 'label'> & { readonly row: RecentSaleRow };

function Facts({ parts }: { readonly parts: readonly string[] }): JSX.Element {
  return (
    <span className="v5-recent-row__facts">
      {parts.map((part, i) => (
        <span key={part}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          <bdi>{part}</bdi>
        </span>
      ))}
    </span>
  );
}

function Row({ row, showSeller, disabled, onPick }: RowProps): JSX.Element {
  const facts = [
    tenders(row),
    showSeller ? row.selling_operator_display_name : '',
    printState(row),
  ].filter((part) => part !== '');
  return (
    <li>
      <button
        type="button"
        className="v5-ledger-row v5-recent-row"
        disabled={disabled === true}
        onClick={() => {
          onPick(row);
        }}
      >
        <span className="v5-recent-row__lead">
          <bdi dir="ltr" className="v5-recent-row__short">
            {row.short_number ?? row.sale_number}
          </bdi>
          <span className="v5-recent-row__time">{clock(row.finalized_at)}</span>
          <Facts parts={facts} />
          {row.short_number !== null && (
            <bdi dir="ltr" className="v5-recent-row__exact">
              {row.sale_number}
            </bdi>
          )}
        </span>
        <bdi dir="ltr" className="v5-ledger-row__amount v5-recent-row__amount">
          {formatHumanMoney(row.total_minor)}
        </bdi>
      </button>
    </li>
  );
}

export function RecentSalesRows({ items, label, ...rest }: RecentSalesRowsProps): JSX.Element {
  return (
    <ul className="v5-recent-rows" aria-label={label}>
      {items.map((row) => (
        <Row key={row.sale_id} row={row} {...rest} />
      ))}
    </ul>
  );
}
