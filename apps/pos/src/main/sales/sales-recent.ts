/**
 * RT-1189 (RT-249 N-S1, doc 20 §3) — `sales.listRecent`: this terminal's sales
 * on the current Africa/Cairo business day, newest first, local only, at most
 * 300, optionally narrowed to one short form.
 *
 *   • Window: the Cairo business day of main's clock, as a `finalized_at` range
 *     from `businessDayBounds`. This is the doc's "48 h then filter by day"
 *     rule made exact: the same rows, with no daylight-saving arithmetic and no
 *     JavaScript day filter. The stored `local_calendar_day` is never used for
 *     the window.
 *   • Scope: tenant / branch / terminal from the session, and for a cashier the
 *     RT-546 own-sales filter (`ownerFilter`). The request can name none of
 *     them: any key but `short_number` is `invalid_input`.
 *   • The short form is normalised (Arabic-Indic digits, leading zeros, bidi
 *     marks) in main and applied BEFORE the cap, so a match older than the
 *     newest 300 is still found. SQL prefilters on the number's tail; each row
 *     is then confirmed with `saleNumberDisplay`.
 *
 * The caller (sales-bridge) runs the forbidden-key scan and the RT-546
 * `admitSession` gate first.
 */

import { businessDayBounds, businessDayOf } from '../../shared/time/business-day.js';
import {
  normalizeSaleLookupInput,
  saleNumberDisplay,
  shortNumberSuffix,
} from '../../shared/sales/sale-number-display.js';
import {
  SALES_TENDER_TYPES,
  type PrintEventOutcome,
  type SaleId,
  type SaleNumber,
  type SalesTenderType,
} from '../../shared/sales/types.js';
import type { RecentSaleRow, SalesListRecentResponse } from '../../shared/bridge-api.js';
import type { PrintEventsRepository } from './repositories/print-events.repository.js';
import type {
  RecentSaleDbRow,
  SalesRepository,
  TenantScope,
} from './repositories/sales.repository.js';

/** M-N6: the newest 300 are shown; the rest need a search by number. */
export const RECENT_SALES_CAP = 300;

const ALLOWED_KEYS: ReadonlySet<string> = new Set(['short_number']);

/** The validated request: the short form to look for, if any. */
export interface RecentPlan {
  /** Canonical digits (no leading zeros), or null for the whole day. */
  readonly short_digits: string | null;
}

type PlanResult =
  | { readonly ok: true; readonly plan: RecentPlan }
  | { readonly ok: false; readonly refusal: SalesListRecentResponse };

const INVALID_INPUT: PlanResult = {
  ok: false,
  refusal: { kind: 'refused', reason: 'invalid_input' },
};

/** Validates the whole request; every malformed input is a closed refusal. */
export function planRecentList(req: Record<string, unknown>): PlanResult {
  if (!Object.keys(req).every((key) => ALLOWED_KEYS.has(key))) return INVALID_INPUT;
  if (!('short_number' in req)) return { ok: true, plan: { short_digits: null } };
  const typed = req.short_number;
  if (typeof typed !== 'string') return INVALID_INPUT;
  const input = normalizeSaleLookupInput(typed);
  if (input.kind !== 'short') return INVALID_INPUT;
  return { ok: true, plan: { short_digits: input.digits } };
}

/** The distinct tender types of a stored summary, in order; never throws. */
function tenderTypesOf(summaryJson: string): SalesTenderType[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(summaryJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const known: readonly unknown[] = SALES_TENDER_TYPES;
  const types = parsed
    .map((line: unknown) =>
      line !== null && typeof line === 'object'
        ? (line as { tender_type?: unknown }).tender_type
        : undefined,
    )
    .filter((type): type is SalesTenderType => known.includes(type));
  return [...new Set(types)];
}

function toRecentRow(
  row: RecentSaleDbRow,
  short: string | null,
  latestPrint: PrintEventOutcome | 'none',
): RecentSaleRow {
  return {
    sale_id: row.sale_id as SaleId,
    sale_number: row.sale_number as SaleNumber,
    short_number: short,
    finalized_at: row.finalized_at,
    total_minor: row.subtotal_minor + row.total_tax_minor,
    tender_types: tenderTypesOf(row.tender_lines_summary_json),
    selling_operator_display_name: row.selling_operator_display_name,
    latest_print_outcome: latestPrint,
  };
}

export interface RecentListDeps {
  readonly salesRepo: Pick<SalesRepository, 'listRecentInWindow'>;
  readonly printEventsRepo: Pick<PrintEventsRepository, 'readBySale'>;
}

/** What a recent-list run needs besides the repositories. */
export interface RecentListRun {
  readonly scope: TenantScope;
  /** A cashier's own id, or null for the whole terminal. */
  readonly sellingOperatorId: string | null;
  readonly plan: RecentPlan;
  /** Main's clock reading. */
  readonly now: Date;
}

/** Runs a validated plan in the session's scope on main's clock. */
export function runRecentList(
  deps: RecentListDeps,
  { scope, sellingOperatorId, plan, now }: RecentListRun,
): SalesListRecentResponse {
  const business_day = businessDayOf(now);
  const { startInclusive, endExclusive } = businessDayBounds({
    from: business_day,
    to: business_day,
  });
  const rows = deps.salesRepo.listRecentInWindow({
    scope,
    selling_operator_id: sellingOperatorId,
    start_inclusive: startInclusive,
    end_exclusive: endExclusive,
    sale_number_suffix: plan.short_digits === null ? null : shortNumberSuffix(plan.short_digits),
    limit: RECENT_SALES_CAP + 1,
  });
  const shown = rows
    .map((row) => ({ row, short: saleNumberDisplay(row).short }))
    .filter(({ short }) => plan.short_digits === null || short === plan.short_digits);
  const items = shown
    .slice(0, RECENT_SALES_CAP)
    .map(({ row, short }) =>
      toRecentRow(row, short, deps.printEventsRepo.readBySale(row.sale_id)[0]?.outcome ?? 'none'),
    );
  return { kind: 'ok', business_day, items, truncated: shown.length > RECENT_SALES_CAP };
}
