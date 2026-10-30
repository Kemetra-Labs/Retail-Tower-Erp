/**
 * RT-970 Overview v2 "at a glance" helpers: which business day is "today",
 * its previous business day, and how a figure compares with it. Pure: no React,
 * no fetch.
 *
 * Every figure is the contract's own (`consoleGetSalesSummary`), selected and
 * compared, never derived: no net sales, no averages, no percentages (RT-751
 * AC 1, `metricRegistry.ts`). A date the read lacks is unknown (null), never a
 * zero; a currency absent from a present day is that day's zero in it (the
 * contract lists a currency only when it has a fact).
 */
import type { SalesSummary } from "@/lib/sales-summary-queries";
import type { SalesKpis } from "@/metrics/metricRegistry";
import { type ReportModel, addDays } from "@/sales-daily/dailyLogic";

/** Business days the trend chart shows, ending at today. */
export const TREND_DAYS = 14;

const DAY_MS = 86_400_000;

function utcDay(ms: number): string {
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The one read the KPI strip, the pipeline strip and the chart share: 16
 * business days ending a UTC day ahead. Every store's "today" (any IANA
 * offset), its previous day and the 14-day trend fall inside it, within the
 * contract's 31-day bound.
 */
export function glanceWindow(nowMs: number): { from: string; to: string } {
  const to = addDays(utcDay(nowMs), 1);
  return { from: addDays(to, -(TREND_DAYS + 1)), to };
}

export type GlanceDay =
  | {
      state: "ready";
      /** Today: still running, so its figures are "so far". */
      date: string;
      previousDate: string;
      /** Null when the read lacks the date: unknown, never zero. */
      today: SalesKpis | null;
      previous: SalesKpis | null;
    }
  /** Stores on different business days, or a further page of stores: no one "today". */
  | { state: "mixed" }
  | { state: "none" };

type Day = SalesSummary["scopeTotals"]["days"][number];

function ready(days: readonly Day[], date: string): GlanceDay {
  const previousDate = addDays(date, -1);
  const kpisOf = (d: string) => days.find((day) => day.businessDate === d)?.kpis ?? null;
  return {
    state: "ready",
    date,
    previousDate,
    today: kpisOf(date),
    previous: kpisOf(previousDate),
  };
}

/**
 * One store: its own current business date. The whole scope: the server's
 * scope totals, only when every store is on this page and on one date.
 */
export function glanceDay(summary: SalesSummary): GlanceDay {
  const { stores } = summary;
  if (stores.length === 0) return { state: "none" };
  if (summary.scope === "store") return ready(stores[0].days, stores[0].currentBusinessDate);
  const date = stores[0].currentBusinessDate;
  const oneDate = stores.every((s) => s.currentBusinessDate === date);
  if (summary.nextCursor !== null || !oneDate) return { state: "mixed" };
  return ready(summary.scopeTotals.days, date);
}

// --- Comparison ------------------------------------------------------------------

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** A decimal string as a scaled integer, exact (amounts are never floats). */
function scaled(value: string, scale: number): bigint {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new Error(`not a decimal: ${value}`);
  const [, sign, whole, fraction = ""] = match;
  const digits = BigInt(whole + fraction.padEnd(scale, "0"));
  return sign === "-" ? -digits : digits;
}

/** Compares two decimal strings exactly: -1, 0 or 1. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const scale = Math.max(a.split(".")[1]?.length ?? 0, b.split(".")[1]?.length ?? 0);
  const x = scaled(a, scale);
  const y = scaled(b, scale);
  if (x === y) return 0;
  return x > y ? 1 : -1;
}

export type Trend = "up" | "down" | "same" | "unknown";

function trendOf(order: -1 | 0 | 1): Trend {
  if (order === 0) return "same";
  return order > 0 ? "up" : "down";
}

/** Today's count against the previous day's; unknown when either is unknown. */
export function countTrend(
  today: number | null | undefined,
  previous: number | null | undefined,
): Trend {
  if (today == null || previous == null) return "unknown";
  return trendOf(today === previous ? 0 : today > previous ? 1 : -1);
}

type MoneyFacts = SalesKpis["receivedSales"];

/** A day's total in one currency; absent from a present day is that day's zero. */
export function totalIn(facts: MoneyFacts, currency: string): string {
  return facts.byCurrency.find((c) => c.currencyCode === currency)?.total ?? "0";
}

/** Today's total in one currency against the previous day's, exactly. */
export function moneyTrend(
  today: MoneyFacts | null,
  previous: MoneyFacts | null,
  currency: string,
): Trend {
  if (!today || !previous) return "unknown";
  return trendOf(compareDecimal(totalIn(today, currency), totalIn(previous, currency)));
}

/** The currencies a comparison covers: today's first, then the previous day's. */
export function dayCurrencies(today: MoneyFacts | null, previous: MoneyFacts | null): string[] {
  const codes = [...(today?.byCurrency ?? []), ...(previous?.byCurrency ?? [])].map(
    (c) => c.currencyCode,
  );
  return [...new Set(codes)];
}

// --- Pipeline --------------------------------------------------------------------

export interface PostingSplit {
  received: number;
  posted: number;
  pending: number;
  failed: number;
  /** No posting record yet: never "not posted" (RT-956). */
  unknown: number;
}

/** The contract's four ERP posting buckets for a day, as returned (they add up to `received`). */
export function postingSplit(kpis: SalesKpis): PostingSplit {
  const { posted, pending, failed, unknown } = kpis.erpPosting;
  return { received: kpis.receivedSales.count, posted, pending, failed, unknown };
}

// --- Trend chart -----------------------------------------------------------------

/** The report's last `TREND_DAYS` business days ending at `endDate`, for the chart. */
export function trendModel(model: ReportModel, endDate: string): ReportModel {
  const rows = model.rows.filter((r) => r.date <= endDate).slice(-TREND_DAYS);
  return { ...model, rows, partial: rows.some((r) => r.state !== "complete") };
}
