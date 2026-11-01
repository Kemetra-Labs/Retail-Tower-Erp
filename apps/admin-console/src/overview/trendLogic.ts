/**
 * RT-993 the Overview trend (DESIGN.md §12.4): received sales of the current
 * period against the period before it, and the hero card's sparkline. Pure:
 * no React, no fetch, geometry from the report model (never from the DOM).
 *
 * Rules (UX-13; RT-751 AC 4):
 *  - one currency at a time; currencies are never added together;
 *  - each value is the server's decimal string; a number exists only to place
 *    a point, and a difference is exact (`differenceOf`);
 *  - a date the read lacks is a gap: no point, no difference, and the line
 *    breaks there instead of being drawn through it (UX-13.24);
 *  - a present day with no sale in the currency is a real zero (the contract
 *    zero-fills `days[]`);
 *  - the baseline is zero; time runs to the inline end, mirrored in RTL by
 *    position, never by flipping the SVG.
 */
import { type Direction, niceMax } from "@/sales-daily/chartModel";
import { type DayState, type ReportModel, addDays } from "@/sales-daily/dailyLogic";
import { differenceOf, totalIn } from "./glanceLogic";

/** The periods the segmented control offers, in business days. */
export const TREND_PERIODS = [7, 14] as const;
export type TrendPeriod = (typeof TREND_PERIODS)[number];

export interface ComparisonPoint {
  date: string;
  state: DayState;
  /** The day's total in the currency; null when the read lacks the day. */
  current: string | null;
  /** The same day of the previous period. */
  previousDate: string;
  previous: string | null;
  /** `current - previous`; null when either side is unknown. */
  difference: string | null;
}

function totalOn(model: ReportModel, date: string, currency: string): string | null {
  const row = model.rows.find((r) => r.date === date);
  if (!row?.kpis || row.state === "not-begun") return null;
  return totalIn(row.kpis.receivedSales, currency);
}

/** The `period` business days ending at `endDate`, each beside the same day `period` days earlier. */
export function comparisonModel(
  model: ReportModel,
  endDate: string,
  period: number,
  currency: string,
): ComparisonPoint[] {
  return Array.from({ length: period }, (_, i) => {
    const date = addDays(endDate, i - period + 1);
    const previousDate = addDays(date, -period);
    const current = totalOn(model, date, currency);
    const previous = totalOn(model, previousDate, currency);
    const state = model.rows.find((r) => r.date === date)?.state ?? "complete";
    return {
      date,
      state,
      current,
      previousDate,
      previous,
      difference: current !== null && previous !== null ? differenceOf(current, previous) : null,
    };
  });
}

// --- Geometry ----------------------------------------------------------------------

export interface LinePoint {
  index: number;
  x: number;
  y: number;
}

/** Unbroken runs of points; a gap starts a new run. */
export type LineRun = LinePoint[];

function amount(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function runsOf(
  values: readonly (number | null)[],
  xs: readonly number[],
  y: (v: number) => number,
) {
  const runs: LineRun[] = [];
  let run: LineRun = [];
  values.forEach((v, index) => {
    if (v === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push({ index, x: xs[index], y: y(v) });
  });
  if (run.length > 0) runs.push(run);
  return runs;
}

/** Evenly spaced x positions over [start, end], mirrored in RTL. */
function positions(count: number, start: number, end: number, width: number, rtl: boolean) {
  const step = count > 1 ? (end - start) / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) => {
    const x = count > 1 ? start + i * step : (start + end) / 2;
    return rtl ? width - x : x;
  });
}

export const LINE = {
  width: 560,
  plotHeight: 160,
  top: 16,
  bottom: 28,
  axis: 56,
  end: 16,
} as const;
const TICK_INTERVALS = 4;

export interface LineGeometry {
  width: number;
  height: number;
  baselineY: number;
  max: number;
  ticks: { value: number; y: number }[];
  /** The x of each day of the period, oldest first. */
  xs: number[];
  current: LineRun[];
  previous: LineRun[];
  /** Where the axis labels end, on the inline-start side. */
  axisX: number;
}

/** Two lines on one zero-based axis: the period (current) and the one before (previous). */
export function lineGeometry(
  points: readonly ComparisonPoint[],
  direction: Direction,
): LineGeometry {
  const rtl = direction === "rtl";
  const current = points.map((p) => amount(p.current));
  const previous = points.map((p) => amount(p.previous));
  const max = niceMax(Math.max(0, ...current.map((v) => v ?? 0), ...previous.map((v) => v ?? 0)));
  const baselineY = LINE.top + LINE.plotHeight;
  const y = (v: number) => baselineY - (v / max) * LINE.plotHeight;
  const xs = positions(points.length, LINE.axis + 8, LINE.width - LINE.end, LINE.width, rtl);
  const ticks = Array.from({ length: TICK_INTERVALS + 1 }, (_, i) => {
    const value = (max / TICK_INTERVALS) * i;
    return { value, y: y(value) };
  });
  return {
    width: LINE.width,
    height: baselineY + LINE.bottom,
    baselineY,
    max,
    ticks,
    xs,
    current: runsOf(current, xs, y),
    previous: runsOf(previous, xs, y),
    axisX: rtl ? LINE.width - LINE.axis : LINE.axis,
  };
}

export const SPARK = { width: 160, height: 40, pad: 3 } as const;

export interface SparkGeometry {
  width: number;
  height: number;
  baselineY: number;
  runs: LineRun[];
}

/** The hero card's sparkline: one series, zero-based, gaps kept. */
export function sparkGeometry(
  values: readonly (string | null)[],
  direction: Direction,
): SparkGeometry {
  const amounts = values.map(amount);
  const max = niceMax(Math.max(0, ...amounts.map((v) => v ?? 0)));
  const baselineY = SPARK.height - SPARK.pad;
  const y = (v: number) => baselineY - (v / max) * (SPARK.height - 2 * SPARK.pad);
  const xs = positions(
    values.length,
    SPARK.pad,
    SPARK.width - SPARK.pad,
    SPARK.width,
    direction === "rtl",
  );
  return { width: SPARK.width, height: SPARK.height, baselineY, runs: runsOf(amounts, xs, y) };
}
