import { describe, expect, test } from "vitest";
import { ZERO_KPIS } from "./metric-claim-fixtures";
import {
  CAIRO,
  EGP_USD_DAY,
  RANGE_TOTALS,
  storeSummary,
  zeroDays,
} from "./sales-daily-fixtures";

import type { SalesKpis } from "@/metrics/metricRegistry";
import { postingHealthModel, verdictOf } from "@/posting-health/postingHealthLogic";
import { reportModel } from "@/sales-daily/dailyLogic";

/**
 * The posting-health report is a pure view over the daily report's read: one
 * verdict per business day from the served `erpPosting` counts. `unknown`
 * never means "not posted", so it is its own verdict, never folded into
 * another. No arithmetic beyond the verdicts; the totals are the server's
 * `rangeTotals`.
 */

function postedDay(received: number, erpPosting: SalesKpis["erpPosting"]): SalesKpis {
  return {
    ...ZERO_KPIS,
    receivedSales: {
      count: received,
      byCurrency: [{ currencyCode: "EGP", count: received, total: "100.0000" }],
    },
    erpPosting,
  };
}

describe("one verdict per day, from the served counts", () => {
  test("pending or failed is needs-attention; unknown alone is unknown-rows", () => {
    const model = postingHealthModel(
      reportModel(
        storeSummary(
          {
            ref: CAIRO,
            timeZone: "Africa/Cairo",
            currentBusinessDate: "2026-10-23",
            days: zeroDays("2026-10-16", "2026-10-23", {
              // received 5, posted 2, pending 1, unknown 2.
              "2026-10-16": EGP_USD_DAY,
              "2026-10-17": postedDay(3, { posted: 3, pending: 0, failed: 0, unknown: 0 }),
              "2026-10-18": postedDay(2, { posted: 1, pending: 0, failed: 1, unknown: 0 }),
              "2026-10-19": postedDay(2, { posted: 1, pending: 0, failed: 0, unknown: 1 }),
            }),
          },
        ),
      ),
    );
    expect(model.rows.map((r) => [r.date, r.verdict])).toEqual([
      ["2026-10-16", "needsAttention"],
      ["2026-10-17", "fullyPosted"],
      ["2026-10-18", "needsAttention"],
      ["2026-10-19", "unknownRows"],
      ["2026-10-20", "noSales"],
      ["2026-10-21", "noSales"],
      ["2026-10-22", "noSales"],
      ["2026-10-23", "running"],
    ]);
    expect(model.completedDays).toBe(7);
    expect(model.fullyPostedDays).toBe(1);
    expect(model.daysWithFailures).toBe(1);
    expect(model.partial).toBe(true);
  });

  test("a missing day is no-data, never zero; a day after today has not begun", () => {
    const model = postingHealthModel(
      reportModel(
        storeSummary({
          ref: CAIRO,
          timeZone: "Africa/Cairo",
          currentBusinessDate: "2026-10-22",
          days: zeroDays("2026-10-16", "2026-10-23").filter(
            (d) => d.businessDate !== "2026-10-19",
          ),
        }),
      ),
    );
    const missing = model.rows.find((r) => r.date === "2026-10-19");
    expect(missing?.verdict).toBe("noData");
    expect(missing?.posted).toBeNull();
    expect(model.rows.find((r) => r.date === "2026-10-22")?.verdict).toBe("running");
    expect(model.rows.find((r) => r.date === "2026-10-23")?.verdict).toBe("notBegun");
  });

  test("the verdict follows the day's state before its counts", () => {
    expect(verdictOf({ date: "2026-10-23", state: "so-far", kpis: ZERO_KPIS })).toBe("running");
    expect(verdictOf({ date: "2026-10-24", state: "not-begun", kpis: ZERO_KPIS })).toBe(
      "notBegun",
    );
    expect(verdictOf({ date: "2026-10-22", state: "complete", kpis: null })).toBe("noData");
  });
});

describe("the totals are the server's rangeTotals, never a sum of the rows", () => {
  test("a read whose rangeTotals carry failures reports them, not the rows' sum", () => {
    const model = postingHealthModel(
      reportModel(
        storeSummary({ ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-23" }),
      ),
    );
    expect(model.totals).toEqual(RANGE_TOTALS.erpPosting);
    // The rows are all zero days; a client-side sum would say posted 0.
    expect(model.totals?.posted).toBe(70);
  });

  test("a read with no store bucket has no totals and unknown rows", () => {
    const summary = storeSummary({
      ref: CAIRO,
      timeZone: "Africa/Cairo",
      currentBusinessDate: "2026-10-23",
    });
    const model = postingHealthModel(reportModel({ ...summary, stores: [] }));
    expect(model.totals).toBeNull();
    expect(model.rows.every((r) => r.verdict === "noData")).toBe(true);
  });
});
