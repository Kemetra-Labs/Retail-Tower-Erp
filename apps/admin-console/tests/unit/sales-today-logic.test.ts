import type { SalesSummary } from "@/lib/sales-summary-queries";
import { asSalesSummary, salesDrillDown } from "@/overview/salesTodayLogic";
import { describe, expect, test } from "vitest";
import { KPIS, ZERO_KPIS } from "./metric-claim-fixtures";

/** RT-820 helpers the Overview keeps (RT-970): the drill-down link and the body check. */
type Store = SalesSummary["stores"][number];

const S1 = "0190f000-0000-7000-8000-0000000000a1";

function store(ref: string, date: string, dates: string[], zone = "Africa/Cairo"): Store {
  return {
    storeRef: ref,
    storeTimezone: zone,
    currentBusinessDate: date,
    days: dates.map((businessDate) => ({ businessDate, kpis: KPIS })),
    rangeTotals: KPIS,
  };
}

function summary(stores: Store[], over: Partial<SalesSummary> = {}): SalesSummary {
  return {
    scope: "all_in_scope",
    storeRef: null,
    from: "2026-10-15",
    to: "2026-10-17",
    asOf: "2026-10-15T22:30:00Z",
    completeness: "received_only",
    stores,
    nextCursor: null,
    scopeTotals: {
      storeCount: stores.length,
      days: [
        { businessDate: "2026-10-15", kpis: ZERO_KPIS },
        { businessDate: "2026-10-16", kpis: KPIS },
      ],
      rangeTotals: KPIS,
    },
    ...over,
  };
}

const ALL = ["2026-10-15", "2026-10-16", "2026-10-17"];

describe("salesDrillDown", () => {
  test("carries the store and the one business date, in the keys /sales parses", () => {
    expect(salesDrillDown(S1, "2026-10-16")).toBe(
      `/sales?store=${S1}&from=2026-10-16&to=2026-10-16`,
    );
  });
});

describe("asSalesSummary", () => {
  test("accepts a summary and rejects a malformed body", () => {
    expect(asSalesSummary(summary([store(S1, "2026-10-16", ALL)]))).toBeDefined();
    expect(asSalesSummary({})).toBeUndefined();
    expect(
      asSalesSummary({ stores: [{}], scopeTotals: { days: [], storeCount: 1 } }),
    ).toBeUndefined();
    expect(asSalesSummary(null)).toBeUndefined();
  });
});
