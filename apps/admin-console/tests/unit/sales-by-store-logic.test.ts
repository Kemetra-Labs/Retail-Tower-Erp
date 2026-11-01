import {
  activePreset,
  barWidth,
  buildQuery,
  currencyOptions,
  defaultParams,
  latestToday,
  paramsFromSearch,
  paramsToSearch,
  percentOf,
  presetRange,
  rangeProblem,
  reportModel,
  selectedRow,
  totalOf,
} from "@/sales-by-store/storeLogic";
import { describe, expect, test } from "vitest";
import {
  MAADI,
  NASR,
  ZAMALEK,
  facts,
  maadi,
  nasr,
  report,
  zamalek,
} from "./sales-by-store-fixtures";

/**
 * RT-1054 pure rules of the sales-by-store report. The report never sums,
 * subtracts or divides a served figure (AI-13): a ratio becomes a percentage by
 * moving its decimal point in the string, and every other figure is printed as
 * served.
 */

describe("percentOf: a served ratio with its decimal point moved, never multiplied", () => {
  test.each([
    ["0.2154", "up", "21.54"],
    ["0.0544", "up", "5.44"],
    ["1.0000", "up", "100.00"],
    ["12.3456", "up", "1234.56"],
    ["-0.2500", "down", "25.00"],
    ["-1.5000", "down", "150.00"],
    ["0.0000", "flat", "0.00"],
    ["0.0001", "up", "0.01"],
  ])("%s is %s %s", (ratio, direction, digits) => {
    expect(percentOf(ratio)).toEqual({ direction, digits });
  });

  test("a value that is not a served ratio, or no value, is null", () => {
    expect(percentOf(null)).toBeNull();
    expect(percentOf(undefined)).toBeNull();
    expect(percentOf("0.25")).toBeNull();
    expect(percentOf("abc")).toBeNull();
    expect(percentOf("")).toBeNull();
  });

  test("a bar is the served share as a CSS percentage, and 0% without one", () => {
    expect(barWidth("0.3463")).toBe("34.63%");
    expect(barWidth("1.0000")).toBe("100.00%");
    expect(barWidth(null)).toBe("0%");
  });
});

describe("the URL is the report's state", () => {
  test("a missing range is not a read", () => {
    expect(paramsFromSearch(new URLSearchParams())).toBeNull();
    expect(paramsFromSearch(new URLSearchParams({ from: "2026-10-01" }))).toBeNull();
  });

  test("currency defaults to EGP and compare to the previous period", () => {
    const p = paramsFromSearch(new URLSearchParams({ from: "2026-10-01", to: "2026-10-07" }));
    expect(p).toEqual({
      from: "2026-10-01",
      to: "2026-10-07",
      currency: "EGP",
      compare: "previous_period",
    });
  });

  test("a currency that is not a three-letter code falls back to the default", () => {
    const p = paramsFromSearch(
      new URLSearchParams({ from: "2026-10-01", to: "2026-10-07", currency: "usd" }),
    );
    expect(p?.currency).toBe("EGP");
  });

  test("only the non-default values are written, and they read back", () => {
    const params = {
      from: "2026-10-01",
      to: "2026-10-07",
      currency: "USD",
      compare: "none",
    } as const;
    const search = paramsToSearch(params);
    expect(search.toString()).toBe("from=2026-10-01&to=2026-10-07&currency=USD&compare=none");
    expect(paramsFromSearch(search)).toEqual(params);
    const plain = paramsToSearch({ ...params, currency: "EGP", compare: "previous_period" });
    expect(plain.toString()).toBe("from=2026-10-01&to=2026-10-07");
  });

  test("the query sends exactly the four contract parameters", () => {
    const query = buildQuery({
      from: "2026-10-01",
      to: "2026-10-07",
      currency: "EGP",
      compare: "none",
    });
    expect(Object.keys(query).sort()).toEqual(["compare", "currency", "from", "to"]);
  });

  test("the contract's range rule: reversed and wider than 31 days are refused", () => {
    expect(rangeProblem({ from: "2026-10-01", to: "2026-10-31" })).toBeNull();
    expect(rangeProblem({ from: "2026-10-07", to: "2026-10-01" })).toBe(
      "sales.filter.rangeReversed",
    );
    expect(rangeProblem({ from: "2026-10-01", to: "2026-11-01" })).toBe("sales.filter.spanTooWide");
    expect(rangeProblem({ from: "2026-02-30", to: "2026-03-01" })).toBe("sales.filter.dateInvalid");
  });
});

describe("presets", () => {
  test("last 7 and last 10 business days end today and count today", () => {
    expect(presetRange("last7", "2026-10-30")).toEqual({ from: "2026-10-24", to: "2026-10-30" });
    expect(presetRange("last10", "2026-10-30")).toEqual({ from: "2026-10-21", to: "2026-10-30" });
  });

  test("this month so far starts on the first of today's month", () => {
    expect(presetRange("month", "2026-10-30")).toEqual({ from: "2026-10-01", to: "2026-10-30" });
    expect(presetRange("month", "2026-10-01")).toEqual({ from: "2026-10-01", to: "2026-10-01" });
  });

  test("a preset is on only when the applied range equals it", () => {
    expect(activePreset({ from: "2026-10-21", to: "2026-10-30" }, "2026-10-30")).toBe("last10");
    expect(activePreset({ from: "2026-10-24", to: "2026-10-30" }, "2026-10-30")).toBe("last7");
    expect(activePreset({ from: "2026-10-22", to: "2026-10-30" }, "2026-10-30")).toBeNull();
  });

  test("today is the latest of the stores' business dates, so every store's day is in range", () => {
    const now = new Date("2026-10-30T23:30:00Z");
    expect(latestToday(["America/New_York"], now)).toBe("2026-10-30");
    expect(latestToday(["Africa/Cairo", "America/New_York"], now)).toBe("2026-10-31");
    expect(latestToday([], now)).toBe("2026-10-30");
  });

  test("the default is the last 10 business days in the default currency, comparing", () => {
    expect(defaultParams(["UTC"], new Date("2026-10-30T10:00:00Z"))).toEqual({
      from: "2026-10-21",
      to: "2026-10-30",
      currency: "EGP",
      compare: "previous_period",
    });
  });
});

describe("served totals are looked up, never added", () => {
  test("totalOf finds one currency's served entry, or null", () => {
    const f = facts(3, [
      ["EGP", 2, "10.0000"],
      ["USD", 1, "5.0000"],
    ]);
    expect(totalOf(f, "USD")).toEqual({ count: 1, total: "5.0000" });
    expect(totalOf(f, "EUR")).toBeNull();
    expect(totalOf(facts(0), "EGP")).toBeNull();
  });

  test("currency options are the default, the applied one and every served one, once", () => {
    expect(currencyOptions("EGP", ["USD", "EGP"])).toEqual(["EGP", "USD"]);
    expect(currencyOptions("EUR", [])).toEqual(["EGP", "EUR"]);
  });
});

describe("reportModel", () => {
  test("keeps the server's order and marks the leader of a rankable scope", () => {
    const model = reportModel(report());
    expect(model.rows.map((r) => r.store.storeRef)).toEqual([MAADI, NASR, ZAMALEK]);
    expect(model.rows.map((r) => r.leader)).toEqual([true, false, false]);
    expect(model.rows.map((r) => r.ranked)).toEqual([true, true, false]);
  });

  test("a scope that is not rankable has no leader", () => {
    const model = reportModel(
      report({ stores: [maadi({ rank: null, baselineRank: null })], rankable: false }),
    );
    expect(model.rows[0].leader).toBe(false);
  });

  test("the scope total is the served rangeTotals entry of the ranking currency", () => {
    expect(reportModel(report()).scopeTotal).toEqual({ count: 2550, total: "944545.7500" });
    expect(reportModel(report({ currency: "USD" })).scopeTotal).toEqual({
      count: 2,
      total: "120.0000",
    });
    expect(reportModel(report({ currency: "EUR" })).scopeTotal).toBeNull();
  });

  test("a day still running is flagged, and its absence too", () => {
    expect(reportModel(report()).includesSoFar).toBe(true);
    const done = (s: ReturnType<typeof maadi>) => ({
      ...s,
      ranking: {
        ...s.ranking,
        days: s.ranking.days.map((d) => ({ ...d, state: "complete" as const })),
      },
    });
    expect(reportModel(report({ stores: [done(maadi()), done(nasr())] })).includesSoFar).toBe(
      false,
    );
  });

  test("currencies are every served currency once, ordered by code", () => {
    expect(reportModel(report()).currencies).toEqual(["EGP", "USD"]);
  });

  test("each zone is listed once, and compare off is carried", () => {
    const model = reportModel(report({ compare: "none" }));
    expect(model.zones).toEqual(["Africa/Cairo"]);
    expect(model.comparing).toBe(false);
  });

  test("a store's best day is marked from the served bestDay, not found by comparing", () => {
    const row = reportModel(report()).rows[1];
    expect(row.cells.map((c) => c.best)).toEqual([true, false, false]);
  });
});

describe("selectedRow", () => {
  const rows = reportModel(report()).rows;
  test("the picked store, else the first listed", () => {
    expect(selectedRow(rows, NASR)?.store.storeRef).toBe(NASR);
    expect(selectedRow(rows, null)?.store.storeRef).toBe(MAADI);
    expect(selectedRow(rows, "gone")?.store.storeRef).toBe(MAADI);
    expect(selectedRow([], null)).toBeUndefined();
  });
});

// The unranked store keeps its served zeros; nothing turns them into a figure.
describe("an unranked store", () => {
  test("keeps its served share and delta as given", () => {
    const z = zamalek();
    expect(z.ranking.share).toBe("0.0000");
    expect(percentOf(z.ranking.deltaRatio)).toBeNull();
  });
});
