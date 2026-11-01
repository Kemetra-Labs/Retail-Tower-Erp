import { describe, expect, test } from "vitest";

import { TREND_PERIODS, comparisonModel, lineGeometry, sparkGeometry } from "@/overview/trendLogic";
import { reportModel } from "@/sales-daily/dailyLogic";
import { ZERO_KPIS } from "./metric-claim-fixtures";
import { CAIRO, storeSummary } from "./sales-daily-fixtures";

/**
 * RT-993 the Overview trend (DESIGN.md §12.4): received sales of the current
 * period against the period before it, one currency at a time. Pure: every
 * value is the server's decimal string; a date the read lacks is a gap
 * (UX-13.24), never a zero, and the lines break there.
 */

const RANGE = { from: "2026-09-25", to: "2026-10-24" };
const TODAY = "2026-10-23";
const DAY = (egp: string) => ({
  ...ZERO_KPIS,
  receivedSales: { count: 1, byCurrency: [{ currencyCode: "EGP", count: 1, total: egp }] },
});

function model(days: Record<string, ReturnType<typeof DAY>>, drop: string[] = []) {
  const summary = storeSummary(
    { ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: TODAY },
    RANGE,
    days,
  );
  summary.stores[0].days = summary.stores[0].days.filter((d) => !drop.includes(d.businessDate));
  return reportModel(summary, TODAY);
}

describe("comparisonModel", () => {
  test("the periods offered are 7 and 14 business days", () => {
    expect(TREND_PERIODS).toEqual([7, 14]);
  });

  test("each day of the period beside the same day of the period before, with the exact difference", () => {
    const points = comparisonModel(
      model({ [TODAY]: DAY("300.0000"), "2026-10-16": DAY("250.5000") }),
      TODAY,
      7,
      "EGP",
    );
    expect(points).toHaveLength(7);
    expect(points[0]).toMatchObject({ date: "2026-10-17", previousDate: "2026-10-10" });
    expect(points.at(-1)).toMatchObject({
      date: TODAY,
      previousDate: "2026-10-16",
      current: "300.0000",
      previous: "250.5000",
      difference: "49.5000",
      state: "so-far",
    });
  });

  test("a present day with no sale in the currency is a real zero (the contract zero-fills days)", () => {
    const points = comparisonModel(model({}), TODAY, 7, "EGP");
    expect(points[2]).toMatchObject({ current: "0", previous: "0", difference: "0" });
  });

  test("a date the read lacks is a gap on either side: no value, no difference", () => {
    const points = comparisonModel(model({}, ["2026-10-20", "2026-10-07"]), TODAY, 14, "EGP");
    const gap = points.find((p) => p.date === "2026-10-20");
    expect(gap).toMatchObject({ current: null, difference: null });
    const previousGap = points.find((p) => p.previousDate === "2026-10-07");
    expect(previousGap).toMatchObject({ previous: null, difference: null });
    expect(previousGap?.current).toBe("0");
  });

  test("14 days ending today reach back 28 days, inside the one read", () => {
    const points = comparisonModel(model({}), TODAY, 14, "EGP");
    expect(points[0]).toMatchObject({ date: "2026-10-10", previousDate: "2026-09-26" });
  });
});

describe("lineGeometry", () => {
  const points = comparisonModel(
    model({ "2026-10-21": DAY("100.0000"), "2026-10-22": DAY("200.0000") }, ["2026-10-19"]),
    TODAY,
    7,
    "EGP",
  );

  test("a zero baseline and a nice top", () => {
    const g = lineGeometry(points, "ltr");
    expect(g.ticks[0]).toMatchObject({ value: 0, y: g.baselineY });
    expect(g.max).toBe(200);
  });

  test("the current line breaks at a gap, never drawn through it", () => {
    const g = lineGeometry(points, "ltr");
    // 2026-10-17 … 23 with the 19th missing: two runs, 2 and 4 points.
    expect(g.current.map((run) => run.length)).toEqual([2, 4]);
    expect(g.previous.map((run) => run.length)).toEqual([7]);
  });

  test("time runs to the inline end: mirrored by position in RTL", () => {
    const ltr = lineGeometry(points, "ltr");
    const rtl = lineGeometry(points, "rtl");
    expect(ltr.xs[0]).toBeLessThan(ltr.xs[6]);
    expect(rtl.xs[0]).toBeGreaterThan(rtl.xs[6]);
    expect(rtl.xs[0]).toBeCloseTo(ltr.width - ltr.xs[0], 6);
  });
});

describe("sparkGeometry", () => {
  test("gaps stay gaps, and an all-zero series still draws on the baseline", () => {
    const g = sparkGeometry(["1", null, "3", "0"], "ltr");
    expect(g.runs.map((run) => run.length)).toEqual([1, 2]);
    const flat = sparkGeometry(["0", "0"], "ltr");
    expect(flat.runs[0].every((p) => p.y === flat.baselineY)).toBe(true);
  });
});
