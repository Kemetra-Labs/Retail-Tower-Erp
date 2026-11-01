/**
 * RT-1054 pure rules of the «Sales by store» report. No React, no fetch.
 *
 * AI-13 / spec 009 AC-9: the report presents the server's figures as given. It
 * never sums, subtracts or divides one. Concretely, here:
 *  - a ratio (`share`, `deltaRatio`) becomes a percentage by moving the decimal
 *    point two places in its string, never by multiplying;
 *  - a bar is sized by the store's served `share`, never by a total divided by
 *    the leader's;
 *  - a rank change is the served `baselineRank` in words, never `rank - baseline`;
 *  - the direction of a change is read from the sign of its string;
 *  - the scope's total is the served `rangeTotals` entry of the ranking currency.
 *
 * Calendar policy (D-2, D-2b): every figure is per store-local business day, the
 * baseline is always the equal-length period just before the range, and a range
 * that holds a day still running says so in words.
 */
import type { MessageKey } from "@/i18n";
import type {
  MoneyFacts,
  SalesByStore,
  SalesByStoreCompare,
  SalesByStoreQuery,
  StoreDay,
  StoreSalesByStore,
} from "@/lib/sales-by-store-queries";
import { type DailyRange, addDays, validateRange } from "@/sales-daily/dailyLogic";
import { todayIn } from "@/sales/saleFilters";

export type { DailyRange };

/** The ranking currency a read starts with, until the operator picks another. */
export const DEFAULT_CURRENCY = "EGP";

const CURRENCY_CODE = /^[A-Z]{3}$/;

export function isCurrencyCode(value: string): boolean {
  return CURRENCY_CODE.test(value);
}

// --- The URL is the report's state ------------------------------------------

export interface ReportParams {
  from: string;
  to: string;
  currency: string;
  compare: SalesByStoreCompare;
}

/** `compare=none` is the only value written; the default (previous period) is omitted. */
export function paramsFromSearch(search: URLSearchParams): ReportParams | null {
  const from = search.get("from");
  const to = search.get("to");
  if (!from || !to) return null;
  const currency = search.get("currency");
  return {
    from,
    to,
    currency: currency && isCurrencyCode(currency) ? currency : DEFAULT_CURRENCY,
    compare: search.get("compare") === "none" ? "none" : "previous_period",
  };
}

export function paramsToSearch(params: ReportParams): URLSearchParams {
  const search = new URLSearchParams({ from: params.from, to: params.to });
  if (params.currency !== DEFAULT_CURRENCY) search.set("currency", params.currency);
  if (params.compare === "none") search.set("compare", "none");
  return search;
}

export function buildQuery(params: ReportParams): SalesByStoreQuery {
  return {
    from: params.from,
    to: params.to,
    currency: params.currency,
    compare: params.compare,
  };
}

/** The contract's range rule, at the field it belongs to; null when the range is fine. */
export function rangeProblem(range: DailyRange): MessageKey | null {
  const errors = validateRange(range);
  return errors.from ?? errors.to ?? null;
}

// --- Presets -----------------------------------------------------------------

export type PresetId = "last7" | "last10" | "month";

const PRESET_DAYS = { last7: 7, last10: 10 } as const;

/** Today of the scope: the latest of its stores' business dates, so every store's day is in range. */
export function latestToday(zones: readonly string[], now: Date = new Date()): string {
  const todays = (zones.length > 0 ? zones : ["UTC"]).map((zone) => todayIn(zone, now));
  return todays.reduce((latest, day) => (day > latest ? day : latest), todays[0]);
}

/** The range of a preset ending on `today`; the month preset starts on the 1st of `today`'s month. */
export function presetRange(preset: PresetId, today: string): DailyRange {
  if (preset === "month") return { from: `${today.slice(0, 8)}01`, to: today };
  return { from: addDays(today, 1 - PRESET_DAYS[preset]), to: today };
}

export const PRESET_IDS: readonly PresetId[] = ["last7", "last10", "month"];

/** The preset the applied range equals, if any; otherwise the range is custom. */
export function activePreset(range: DailyRange, today: string): PresetId | null {
  return (
    PRESET_IDS.find((id) => {
      const p = presetRange(id, today);
      return p.from === range.from && p.to === range.to;
    }) ?? null
  );
}

/** The report starts on the last 10 business days, ending today. */
export function defaultParams(zones: readonly string[], now: Date = new Date()): ReportParams {
  return {
    ...presetRange("last10", latestToday(zones, now)),
    currency: DEFAULT_CURRENCY,
    compare: "previous_period",
  };
}

// --- Ratios as served: a decimal shifted in its string, never multiplied ------

const RATIO = /^(-)?(\d+)\.(\d{4})$/;

export interface Percent {
  /** `up` or `down` from the sign of the served string; `flat` for a served zero. */
  direction: "up" | "down" | "flat";
  /** `21.54`, the served four digits with the point moved two places. */
  digits: string;
}

/** `"0.2154"` → 21.54, `"-0.2500"` → down 25.00. Anything that is not a served ratio is null. */
export function percentOf(ratio: string | null | undefined): Percent | null {
  const match = ratio ? RATIO.exec(ratio) : null;
  if (!match) return null;
  const [, minus, whole, frac] = match;
  const integer = `${whole}${frac.slice(0, 2)}`.replace(/^0+(?=\d)/, "");
  const digits = `${integer}.${frac.slice(2)}`;
  if (/^0\.00$/.test(digits)) return { direction: "flat", digits };
  return { direction: minus ? "down" : "up", digits };
}

/** A bar's width: the served share as a CSS percentage string; 0 for a share that is not served. */
export function barWidth(share: string | null | undefined): string {
  const percent = percentOf(share);
  return percent ? `${percent.digits}%` : "0%";
}

// --- Money as served ----------------------------------------------------------

const ZERO_AMOUNT = /^0+\.0+$/;

export function isZeroAmount(value: string): boolean {
  return ZERO_AMOUNT.test(value);
}

/** The served total of one currency in a counted fact; null when the currency has no fact. */
export function totalOf(
  facts: MoneyFacts,
  currency: string,
): { count: number; total: string } | null {
  const entry = facts.byCurrency.find((c) => c.currencyCode === currency);
  return entry ? { count: entry.count, total: entry.total } : null;
}

// --- The report model ----------------------------------------------------------

export interface DayCell {
  businessDate: string;
  state: StoreDay["state"];
  count: number;
  total: string;
  best: boolean;
}

export interface StoreRow {
  store: StoreSalesByStore;
  /** The leader: rank 1 of a rankable scope. */
  leader: boolean;
  /** Ranked stores have a position; the rest are listed last and say why. */
  ranked: boolean;
  cells: DayCell[];
}

export interface ReportModel {
  rows: StoreRow[];
  /** Each currency of the scope's received sales once, ordered by code. */
  currencies: string[];
  /** The scope's served total in the ranking currency; null when it holds no fact in it. */
  scopeTotal: { count: number; total: string } | null;
  /** Some store's day in range is still running, so the figures include it (D-2b). */
  includesSoFar: boolean;
  /** Each store's zone once, first seen first. */
  zones: string[];
  comparing: boolean;
}

function cellsOf(store: StoreSalesByStore): DayCell[] {
  const best = store.ranking.bestDay?.businessDate;
  return store.ranking.days.map((d) => ({
    businessDate: d.businessDate,
    state: d.state,
    count: d.count,
    total: d.total,
    best: best === d.businessDate,
  }));
}

function currenciesOf(report: SalesByStore): string[] {
  const codes = new Set<string>();
  for (const c of report.rangeTotals.receivedSales.byCurrency) codes.add(c.currencyCode);
  for (const s of report.stores) {
    for (const c of s.facts.receivedSales.byCurrency) codes.add(c.currencyCode);
  }
  return [...codes].sort();
}

export function reportModel(report: SalesByStore): ReportModel {
  const rows = report.stores.map((store) => ({
    store,
    leader: report.rankable && store.rank === 1,
    ranked: store.rank !== null,
    cells: cellsOf(store),
  }));
  return {
    rows,
    currencies: currenciesOf(report),
    scopeTotal: totalOf(report.rangeTotals.receivedSales, report.currency),
    includesSoFar: report.stores.some((s) => s.ranking.days.some((d) => d.state === "so_far")),
    zones: [...new Set(report.stores.map((s) => s.storeTimezone))],
    comparing: report.compare === "previous_period",
  };
}

/** The ranking currencies the picker offers: the default, the one applied, and every one served. */
export function currencyOptions(applied: string, served: readonly string[]): string[] {
  return [...new Set([DEFAULT_CURRENCY, applied, ...served])].sort();
}

/** The store the panel shows: the one picked if it is still in the read, else the first listed. */
export function selectedRow(rows: readonly StoreRow[], ref: string | null): StoreRow | undefined {
  return rows.find((r) => r.store.storeRef === ref) ?? rows[0];
}

export const DAY_STATE_MARK = {
  complete: null,
  so_far: "metrics.context.soFar",
  not_begun: "salesDaily.row.notBegun",
} as const satisfies Record<StoreDay["state"], MessageKey | null>;
