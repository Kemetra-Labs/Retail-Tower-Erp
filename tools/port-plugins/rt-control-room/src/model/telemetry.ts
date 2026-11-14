import type { TraceView } from "./types";

const CAIRO = "Africa/Cairo";
const DAY_MS = 86_400_000;

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: CAIRO,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Africa/Cairo calendar day of an instant, as `YYYY-MM-DD` (DST handled by the time-zone database). */
export function cairoDay(at: Date): string {
  const parts = dayFormat.formatToParts(at);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/** `YYYY-MM-DD` minus n calendar days; plain calendar arithmetic, so no time zone can shift it. */
function shiftDay(day: string, minusDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - minusDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Count timestamps per Cairo day, oldest first. With the default 14 days that
 * is 13 completed days followed by today, which is partial. Timestamps that
 * are unparseable, older than the window or later than today are dropped.
 */
export function dailySeries(timestamps: string[], now: Date, days = 14): number[] {
  const today = cairoDay(now);
  const index = new Map<string, number>();
  for (let i = 0; i < days; i += 1) index.set(shiftDay(today, days - 1 - i), i);
  const series = new Array<number>(days).fill(0);
  for (const stamp of timestamps) {
    const ms = Date.parse(stamp);
    if (Number.isNaN(ms)) continue;
    const slot = index.get(cairoDay(new Date(ms)));
    if (slot !== undefined) series[slot] += 1;
  }
  return series;
}

/** Drop today (the last value), which is partial and never drawn or averaged. */
export function completedDays(series: number[]): number[] {
  return series.slice(0, -1);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Figures of one trace over the 13 completed days (the same index rules as the
 * approved mockup). Failures keep a fixed 0 to 2 normal band and draw no spike
 * markers (points above the band are red); counts use the interquartile band
 * and mark days above `max(3 x median, 80th percentile, 1)` as spikes.
 */
export function traceStats(
  completed: number[],
  kind: "count" | "failures",
): Omit<TraceView, "key" | "series"> {
  const n = completed.length;
  if (n === 0) return { yesterday: 0, average: 0, band: [0, 0], cap: 1, spikes: [] };
  const sorted = completed.slice().sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(n - 1, Math.floor(n * q))];
  const average = round1(completed.reduce((a, b) => a + b, 0) / n);
  const yesterday = completed[n - 1];

  if (kind === "failures") {
    return { yesterday, average, band: [0, 2], cap: Math.max(4, sorted[n - 1]), spikes: [] };
  }
  const cap = Math.max(3 * sorted[Math.floor(n / 2)], at(0.8), 1);
  const spikes: number[] = [];
  completed.forEach((v, i) => {
    if (v > cap) spikes.push(i);
  });
  return { yesterday, average, band: [at(0.25), at(0.75)], cap, spikes };
}
