import type { DayRow, ReportModel } from "@/sales-daily/dailyLogic";

/**
 * The posting-health verdict of one business day, from the day's served
 * `erpPosting` counts (`console-sales-summary`, RT-751). The contract's own
 * rules, never redefined here:
 *
 * - `posted + pending + failed + unknown` is the day's received sales;
 * - `unknown` counts received sales with no ERP posting row and NEVER means
 *   "not posted", so it is shown as its own count and never folded into
 *   another verdict;
 * - `pending` includes `failed_transient`; `failed` is permanently rejected.
 */
export type PostingVerdict =
  /** Complete day, every received sale posted, none stuck, failed or row-less. */
  | "fullyPosted"
  /** Complete day with a stuck (pending) or permanently rejected posting. */
  | "needsAttention"
  /** Complete day with no stuck or failed posting, but sales with no posting row. */
  | "unknownRows"
  /** Complete day with no received sales at all. */
  | "noSales"
  /** The day is missing from the read: unknown, never 0. */
  | "noData"
  /** The day is still running for at least one store. */
  | "running"
  /** The day has not begun for any store. */
  | "notBegun";

interface PostingDayRow {
  date: string;
  state: DayRow["state"];
  /** The day's served counts; null when the day is missing from the read. */
  posted: number | null;
  pending: number | null;
  failed: number | null;
  unknown: number | null;
  verdict: PostingVerdict;
}

export interface PostingHealthModel {
  rows: PostingDayRow[];
  /** Completed days in the range. */
  completedDays: number;
  /** Completed days that ended fully posted. */
  fullyPostedDays: number;
  /** Completed days with at least one failed posting. */
  daysWithFailures: number;
  /** The server's `rangeTotals` erpPosting; null when the read carries none. */
  totals: { posted: number; pending: number; failed: number; unknown: number } | null;
  /** Some row is not complete, so the totals include a day still running. */
  partial: boolean;
  /** False when more stores exist than the read returned: some zones may be missing. */
  zonesComplete: boolean;
  /** Stores the read returned, for the partial-zones note. */
  readStores: number;
  asOf: string;
}

export function verdictOf(row: DayRow): PostingVerdict {
  if (row.state === "not-begun") return "notBegun";
  const kpis = row.kpis;
  // A started day with no bucket is unknown, never "running" or 0.
  if (!kpis) return "noData";
  if (row.state === "so-far") return "running";
  const e = kpis.erpPosting;
  if (e.pending > 0 || e.failed > 0) return "needsAttention";
  if (e.unknown > 0) return "unknownRows";
  if (kpis.receivedSales.count === 0) return "noSales";
  return "fullyPosted";
}

/** The posting-health report of one sales-summary read. No arithmetic beyond the verdicts. */
export function postingHealthModel(model: ReportModel): PostingHealthModel {
  const rows: PostingDayRow[] = model.rows.map((row) => {
    const e = row.kpis?.erpPosting ?? null;
    return {
      date: row.date,
      state: row.state,
      posted: e?.posted ?? null,
      pending: e?.pending ?? null,
      failed: e?.failed ?? null,
      unknown: e?.unknown ?? null,
      verdict: verdictOf(row),
    };
  });
  const completed = rows.filter((r) => r.state === "complete");
  return {
    rows,
    completedDays: completed.length,
    fullyPostedDays: completed.filter((r) => r.verdict === "fullyPosted").length,
    daysWithFailures: completed.filter((r) => (r.failed ?? 0) > 0).length,
    totals: model.totals ? { ...model.totals.erpPosting } : null,
    partial: model.partial,
    zonesComplete: model.zonesComplete,
    readStores: model.stores.length,
    asOf: model.asOf,
  };
}
