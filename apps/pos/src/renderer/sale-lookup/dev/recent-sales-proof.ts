import type {
  RecentSaleRow,
  SalesListRecentRequest,
  SalesListRecentResponse,
} from '../../../shared/bridge-api';
import type { SaleId, SaleNumber, SalesTenderType } from '../../../shared/sales/types';

/**
 * RT-1192 — DEV-ONLY sample of today's sales for the Returns and Void proof
 * harnesses (`#/dev/returns-proof`, `#/dev/void-proof`): fictional rows as
 * `sales.listRecent` returns them, and the in-memory read that filters by
 * `short_number` the way main does. Short number 12 appears twice: a sale just
 * after Cairo midnight still carries the previous UTC day, so one business day
 * holds two sequence runs (doc 20 §1.1, N-10). It proves layout only.
 */
const CASHIER = 'منى عبد الرحمن';
const OTHER = 'كريم السيد';

type Row = readonly [
  day: string,
  seq: string,
  atCairo: string,
  totalMinor: number,
  tenders: readonly SalesTenderType[],
  seller: string,
  print: RecentSaleRow['latest_print_outcome'],
];

const ROWS: readonly Row[] = [
  ['2026-10-17', '000051', '11:48', 31_250, ['cash'], CASHIER, 'success'],
  ['2026-10-17', '000050', '11:31', 8_500, ['external_card_terminal'], OTHER, 'none'],
  [
    '2026-10-17',
    '000049',
    '11:12',
    124_000,
    ['cash', 'external_card_terminal'],
    CASHIER,
    'failure',
  ],
  ['2026-10-17', '000048', '10:40', 2_975, ['cash'], OTHER, 'success'],
  ['2026-10-17', '000012', '09:14', 18_750, ['cash'], CASHIER, 'success'],
  ['2026-10-16', '000012', '00:20', 4_675, ['internal_voucher'], OTHER, 'none'],
];

function toRow([day, seq, at, total, tenders, seller, print]: Row, i: number): RecentSaleRow {
  const number = `TERM-01-${day}-${seq}`;
  return {
    sale_id: `proof-recent-${String(i)}` as SaleId,
    sale_number: number as SaleNumber,
    short_number: String(Number(seq)),
    finalized_at: `2026-10-17T${at}:00+03:00`,
    total_minor: total,
    tender_types: [...tenders],
    selling_operator_display_name: seller,
    latest_print_outcome: print,
  };
}

const PROOF_RECENT_SALES: readonly RecentSaleRow[] = ROWS.map(toRow);

/** `sales.listRecent` over the sample, filtered by `short_number` before the cap, newest first. */
export function proofListRecent(
  req: SalesListRecentRequest = {},
): Promise<SalesListRecentResponse> {
  const items = PROOF_RECENT_SALES.filter(
    (row) => req.short_number === undefined || row.short_number === req.short_number,
  );
  return Promise.resolve({
    kind: 'ok',
    business_day: '2026-10-17',
    items: [...items],
    truncated: false,
  });
}
