import { describe, expect, test } from "vitest";

import {
  TREND_DAYS,
  compareDecimal,
  countTrend,
  dayCurrencies,
  glanceDay,
  glanceWindow,
  moneyTrend,
  postingSplit,
  trendModel,
} from "@/overview/glanceLogic";
import { reportModel } from "@/sales-daily/dailyLogic";
import { ZERO_KPIS } from "./metric-claim-fixtures";
import { CAIRO, EGP_USD_DAY, NEW_YORK, scopeSummary, storeSummary } from "./sales-daily-fixtures";

/**
 * RT-970 the Overview's "at a glance" logic: which business day is "today",
 * its previous business day, and how a figure compares with it. Pure: every
 * figure is the contract's own (`consoleGetSalesSummary`), selected and
 * compared, never derived (RT-751 AC 1: no net sales, no averages, no %).
 */

const RANGE = { from: "2026-10-09", to: "2026-10-24" };
const DAY = (count: number, egp: string) => ({
  ...ZERO_KPIS,
  receivedSales: { count, byCurrency: [{ currencyCode: "EGP", count, total: egp }] },
});

describe("glanceWindow", () => {
  test("16 business days ending a UTC day ahead: today, yesterday and the 14-day trend in one read", () => {
    const now = Date.parse("2026-10-23T22:30:00Z");
    expect(glanceWindow(now)).toEqual({ from: "2026-10-09", to: "2026-10-24" });
  });

  test("stays inside the contract's 31-day bound", () => {
    const { from, to } = glanceWindow(Date.parse("2026-01-01T00:00:00Z"));
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    expect(span).toBeLessThanOrEqual(30);
    expect(span + 1).toBeGreaterThanOrEqual(TREND_DAYS + 1);
  });
});

describe("glanceDay", () => {
  test("one store: its current business date and the day before, from its own days", () => {
    const summary = storeSummary(
      { ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-23" },
      RANGE,
      { "2026-10-23": DAY(3, "300.0000"), "2026-10-22": DAY(9, "950.0000") },
    );
    const day = glanceDay(summary);
    expect(day).toMatchObject({ state: "ready", date: "2026-10-23", previousDate: "2026-10-22" });
    if (day.state !== "ready") throw new Error("not ready");
    expect(day.today?.receivedSales.count).toBe(3);
    expect(day.previous?.receivedSales.count).toBe(9);
  });

  test("a date the read lacks is unknown (null), never a zero bucket", () => {
    const summary = storeSummary(
      { ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-23" },
      RANGE,
    );
    const store = summary.stores[0];
    store.days = store.days.filter((d) => d.businessDate !== "2026-10-22");
    const day = glanceDay(summary);
    if (day.state !== "ready") throw new Error("not ready");
    expect(day.today).not.toBeNull();
    expect(day.previous).toBeNull();
  });

  test("every store on one date: the server's scope totals for it", () => {
    const summary = scopeSummary(
      [
        { ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-23" },
        { ref: NEW_YORK, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-23" },
      ],
      { range: RANGE, days: { "2026-10-23": EGP_USD_DAY } },
    );
    const day = glanceDay(summary);
    if (day.state !== "ready") throw new Error("not ready");
    expect(day.today).toBe(EGP_USD_DAY);
  });

  test("stores on different business days: mixed, never one made-up today", () => {
    const summary = scopeSummary(
      [
        { ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-23" },
        { ref: NEW_YORK, timeZone: "America/New_York", currentBusinessDate: "2026-10-22" },
      ],
      { range: RANGE },
    );
    expect(glanceDay(summary)).toEqual({ state: "mixed" });
  });

  test("a further page of stores: mixed (their dates are not all known)", () => {
    const summary = scopeSummary(
      [{ ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-23" }],
      { range: RANGE, nextCursor: "c2", storeCount: 60 },
    );
    expect(glanceDay(summary)).toEqual({ state: "mixed" });
  });

  test("no store in scope: none", () => {
    const summary = scopeSummary([], { range: RANGE, storeCount: 0 });
    expect(glanceDay(summary)).toEqual({ state: "none" });
  });
});

describe("compareDecimal", () => {
  test("exact on decimal strings, whatever the scale", () => {
    expect(compareDecimal("1250.5", "1250.5000")).toBe(0);
    expect(compareDecimal("0.0001", "0")).toBe(1);
    expect(compareDecimal("99999999999.9999", "100000000000")).toBe(-1);
    expect(compareDecimal("-5", "3")).toBe(-1);
    expect(compareDecimal("0.1000", "0.10")).toBe(0);
  });
});

describe("trends against the previous business day", () => {
  test("counts: up, down, same; unknown when either side is unknown", () => {
    expect(countTrend(5, 3)).toBe("up");
    expect(countTrend(2, 3)).toBe("down");
    expect(countTrend(3, 3)).toBe("same");
    expect(countTrend(3, null)).toBe("unknown");
    expect(countTrend(null, 3)).toBe("unknown");
  });

  test("money: per currency, a currency absent from a day is that day's zero", () => {
    const today = DAY(2, "300.0000").receivedSales;
    const previous = DAY(4, "299.9999").receivedSales;
    expect(moneyTrend(today, previous, "EGP")).toBe("up");
    expect(moneyTrend(today, previous, "USD")).toBe("same");
    expect(moneyTrend(ZERO_KPIS.receivedSales, previous, "EGP")).toBe("down");
    expect(moneyTrend(today, null, "EGP")).toBe("unknown");
  });

  test("the currencies of a comparison: today's first, then the previous day's", () => {
    const usd = {
      count: 1,
      byCurrency: [{ currencyCode: "USD", count: 1, total: "4.0000" }],
    };
    expect(dayCurrencies(DAY(1, "1.0000").receivedSales, usd)).toEqual(["EGP", "USD"]);
    expect(dayCurrencies(null, usd)).toEqual(["USD"]);
  });
});

describe("postingSplit", () => {
  test("the contract's four buckets as returned; unknown stays its own bucket", () => {
    expect(postingSplit(EGP_USD_DAY)).toEqual({
      received: 5,
      posted: 2,
      pending: 1,
      failed: 0,
      unknown: 2,
    });
  });
});

describe("trendModel", () => {
  test("the last 14 business days ending at today", () => {
    const summary = storeSummary(
      { ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-23" },
      RANGE,
    );
    const model = trendModel(reportModel(summary, "2026-10-23"), "2026-10-23");
    expect(model.rows).toHaveLength(TREND_DAYS);
    expect(model.rows[0].date).toBe("2026-10-10");
    expect(model.rows.at(-1)?.date).toBe("2026-10-23");
    // Today is still running: the chart hatches it and says so.
    expect(model.rows.at(-1)?.state).toBe("so-far");
    expect(model.partial).toBe(true);
  });
});
