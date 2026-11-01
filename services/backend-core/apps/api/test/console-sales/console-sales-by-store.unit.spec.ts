/**
 * RT-1053 — the pure parts of the console sales by store: the request
 * schema, the baseline bounds, the exact half-even ratios, the ranking
 * (D-4 / D-5 / D-6b), the day states and the assembly of the aggregated
 * groups. No DB, no HTTP (the HTTP suite is
 * `console-sales-by-store.http.integration.spec.ts`).
 */
import {
  assembleByStore,
  dayStateOf,
  divRoundHalfEven,
  ranksOf,
  ratio4,
  storeStatusOf,
  type AssembleByStoreInput,
  type ByStoreFactRow,
  type ByStoreStoreRow,
} from "../../src/console-sales/console-sales-by-store.projections";
import { baselineOf, ConsoleSalesByStoreQuerySchema } from "../../src/console-sales/console-sales-by-store.query";

const S1 = "0a000000-0000-7000-8000-000000000001";
const S2 = "0a000000-0000-7000-8000-000000000002";
const S3 = "0a000000-0000-7000-8000-000000000003";
const S4 = "0a000000-0000-7000-8000-000000000004";

function store(id: string, overrides: Partial<ByStoreStoreRow> = {}): ByStoreStoreRow {
  return {
    store_id: id,
    name: `Store ${id.slice(-1)}`,
    is_active: true,
    deleted: false,
    timezone: "UTC",
    current_business_date: "2026-10-02",
    ...overrides,
  };
}

function sale(storeId: string, date: string, n: number, amount: string, currency = "EGP"): ByStoreFactRow {
  return {
    kind: "sale",
    period: "range",
    store_id: storeId,
    business_date: date,
    currency_code: currency,
    n,
    amount,
  };
}

function base(storeId: string, n: number, amount: string, date = "2026-09-30"): ByStoreFactRow {
  return {
    kind: "sale",
    period: "baseline",
    store_id: storeId,
    business_date: date,
    currency_code: "EGP",
    n,
    amount,
  };
}

function input(overrides: Partial<AssembleByStoreInput> = {}): AssembleByStoreInput {
  return {
    from: "2026-10-01",
    to: "2026-10-02",
    currency: "EGP",
    compare: "previous_period",
    baseline: baselineOf("2026-10-01", "2026-10-02"),
    dates: ["2026-10-01", "2026-10-02"],
    asOf: "2026-10-02T10:00:00.000Z",
    stores: [store(S1), store(S2)],
    facts: [],
    ...overrides,
  };
}

// ===========================================================================
// Request schema and baseline
// ===========================================================================

describe("RT-1053 by store — request schema", () => {
  const ok = { from: "2026-10-01", to: "2026-10-31", currency: "EGP" };

  it("accepts the required keys and defaults compare to previous_period", () => {
    expect(ConsoleSalesByStoreQuerySchema.parse(ok)).toEqual({ ...ok, compare: "previous_period" });
    expect(ConsoleSalesByStoreQuerySchema.parse({ ...ok, compare: "none" }).compare).toBe("none");
  });

  it.each([
    ["no from", { to: "2026-10-01", currency: "EGP" }],
    ["no to", { from: "2026-10-01", currency: "EGP" }],
    ["no currency", { from: "2026-10-01", to: "2026-10-01" }],
    ["a lower-case currency", { ...ok, currency: "egp" }],
    ["a four-letter currency", { ...ok, currency: "EGPT" }],
    ["a non-calendar date", { ...ok, from: "2026-02-30" }],
    ["to before from", { ...ok, from: "2026-10-02", to: "2026-10-01" }],
    ["32 business days", { ...ok, from: "2026-10-01", to: "2026-11-01" }],
    ["an unknown compare", { ...ok, compare: "previous_year" }],
    ["store_id", { ...ok, store_id: S1 }],
    ["cursor", { ...ok, cursor: "abc" }],
    ["page_size", { ...ok, page_size: "10" }],
    ["tenant_id", { ...ok, tenant_id: S1 }],
    ["a repeated currency", { ...ok, currency: ["EGP", "USD"] }],
  ])("refuses %s", (_label, query) => {
    expect(ConsoleSalesByStoreQuerySchema.safeParse(query).success).toBe(false);
  });

  it("accepts exactly 31 business days", () => {
    expect(ConsoleSalesByStoreQuerySchema.safeParse({ ...ok, from: "2026-10-01", to: "2026-10-31" }).success).toBe(
      true,
    );
  });
});

describe("RT-1053 by store — baseline bounds (D-2)", () => {
  it.each([
    ["2026-10-01", "2026-10-31", { from: "2026-08-31", to: "2026-09-30", dayCount: 31 }],
    ["2026-10-05", "2026-10-05", { from: "2026-10-04", to: "2026-10-04", dayCount: 1 }],
    ["2026-03-01", "2026-03-07", { from: "2026-02-22", to: "2026-02-28", dayCount: 7 }],
    ["2028-03-01", "2028-03-02", { from: "2028-02-28", to: "2028-02-29", dayCount: 2 }],
    ["2027-01-01", "2027-01-10", { from: "2026-12-22", to: "2026-12-31", dayCount: 10 }],
  ])("%s..%s → the equal-length period just before", (from, to, expected) => {
    expect(baselineOf(from, to)).toEqual({ rule: "previous_equal_length", ...expected });
  });
});

// ===========================================================================
// Ratios (D-10)
// ===========================================================================

describe("RT-1053 by store — half-even ratios", () => {
  it.each([
    [5n, 2n, 2n],
    [7n, 2n, 4n],
    [-5n, 2n, -2n],
    [-7n, 2n, -4n],
    [1n, 3n, 0n],
    [2n, 3n, 1n],
    [10n, 5n, 2n],
  ])("%d / %d → %d", (num, den, q) => {
    expect(divRoundHalfEven(num, den)).toBe(q);
  });

  it("refuses a non-positive divisor", () => {
    expect(() => divRoundHalfEven(1n, 0n)).toThrow();
  });

  it("rounds the fifth digit half-even and never writes -0.0000", () => {
    expect(ratio4(1n, 20_000n)).toBe("0.0000");
    expect(ratio4(3n, 20_000n)).toBe("0.0002");
    expect(ratio4(-1n, 20_000n)).toBe("0.0000");
    expect(ratio4(-3n, 20_000n)).toBe("-0.0002");
    expect(ratio4(1n, 3n)).toBe("0.3333");
    expect(ratio4(2n, 3n)).toBe("0.6667");
    expect(ratio4(5n, 5n)).toBe("1.0000");
    expect(ratio4(-1n, 4n)).toBe("-0.2500");
    expect(ratio4(15n, 5n)).toBe("3.0000");
  });

  it("is null on a zero divisor", () => {
    expect(ratio4(5n, 0n)).toBeNull();
    expect(ratio4(0n, 0n)).toBeNull();
  });
});

// ===========================================================================
// Ranking, status and day state
// ===========================================================================

describe("RT-1053 by store — ranking (D-4, D-5)", () => {
  it("ranks by total, then count descending, then storeRef; a zero count is unranked", () => {
    const ranks = ranksOf([
      { storeId: S4, count: 0, total: 0n },
      { storeId: S3, count: 1, total: 100n },
      { storeId: S2, count: 2, total: 100n },
      { storeId: S1, count: 2, total: 100n },
    ]);
    expect([...ranks.entries()]).toEqual([
      [S1, 1],
      [S2, 2],
      [S3, 3],
    ]);
  });

  it("ranks a store whose only sales are zero-priced (count, not total, decides)", () => {
    expect(ranksOf([{ storeId: S1, count: 1, total: 0n }]).get(S1)).toBe(1);
  });

  it("reports status with deleted before inactive", () => {
    expect(storeStatusOf({ is_active: true, deleted: false })).toBe("active");
    expect(storeStatusOf({ is_active: false, deleted: false })).toBe("inactive");
    expect(storeStatusOf({ is_active: false, deleted: true })).toBe("deleted");
    expect(storeStatusOf({ is_active: true, deleted: true })).toBe("deleted");
  });

  it("states a day against the store's own current business date", () => {
    expect(dayStateOf("2026-10-01", "2026-10-02")).toBe("complete");
    expect(dayStateOf("2026-10-02", "2026-10-02")).toBe("so_far");
    expect(dayStateOf("2026-10-03", "2026-10-02")).toBe("not_begun");
  });
});

// ===========================================================================
// Assembly
// ===========================================================================

describe("RT-1053 by store — assembly", () => {
  it("states the request, the baseline, asOf and received_only", () => {
    const out = assembleByStore(input());
    expect(out).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-02",
      currency: "EGP",
      compare: "previous_period",
      asOf: "2026-10-02T10:00:00.000Z",
      completeness: "received_only",
      baseline: {
        rule: "previous_equal_length",
        from: "2026-09-29",
        to: "2026-09-30",
        dayCount: 2,
      },
      rankable: true,
      storeCount: 2,
      storesWithoutSales: 2,
    });
  });

  it("ranks, shares, averages and compares to the baseline exactly", () => {
    const out = assembleByStore(
      input({
        facts: [
          sale(S1, "2026-10-01", 1, "100.0000"),
          sale(S1, "2026-10-02", 2, "50.0000"),
          sale(S2, "2026-10-01", 3, "300.0000"),
          base(S1, 1, "200.0000"),
          base(S2, 1, "100.0000"),
        ],
      }),
    );
    expect(out.stores.map((s) => [s.storeRef, s.rank, s.baselineRank])).toEqual([
      [S2, 1, 2],
      [S1, 2, 1],
    ]);
    const [s2, s1] = out.stores;
    expect(s2!.ranking).toMatchObject({
      total: "300.0000",
      count: 3,
      share: "0.6667",
      averageSale: "100.0000",
      baselineTotal: "100.0000",
      deltaRatio: "2.0000",
    });
    expect(s1!.ranking).toMatchObject({
      total: "150.0000",
      count: 3,
      share: "0.3333",
      averageSale: "50.0000",
      baselineTotal: "200.0000",
      deltaRatio: "-0.2500",
      bestDay: { businessDate: "2026-10-01", total: "100.0000" },
    });
    expect(out.storesWithoutSales).toBe(0);
  });

  it("rounds the average sale half-even in money", () => {
    const out = assembleByStore(
      input({ stores: [store(S1), store(S2)], facts: [sale(S1, "2026-10-01", 3, "10.0000")] }),
    );
    expect(out.stores[0]!.ranking.averageSale).toBe("3.3333");
  });

  it("lists unranked stores last by storeRef, with null share divisor only when the scope sold nothing", () => {
    const out = assembleByStore(
      input({
        stores: [store(S3), store(S1), store(S2)],
        facts: [sale(S3, "2026-10-01", 1, "5.0000")],
      }),
    );
    expect(out.stores.map((s) => [s.storeRef, s.rank])).toEqual([
      [S3, 1],
      [S1, null],
      [S2, null],
    ]);
    expect(out.stores[1]!.ranking).toMatchObject({
      total: "0.0000",
      count: 0,
      share: "0.0000",
      averageSale: null,
      bestDay: null,
    });
    expect(out.storesWithoutSales).toBe(2);

    const none = assembleByStore(input());
    expect(none.stores.every((s) => s.ranking.share === null && s.rank === null)).toBe(true);
  });

  it("never adds across currencies and ranks in the ranking currency only", () => {
    const facts = [
      sale(S1, "2026-10-01", 1, "100.0000", "EGP"),
      sale(S2, "2026-10-01", 1, "50.0000", "EGP"),
      sale(S2, "2026-10-01", 1, "5.0000", "USD"),
    ];
    const egp = assembleByStore(input({ facts }));
    expect(egp.stores.map((s) => s.storeRef)).toEqual([S1, S2]);
    expect(egp.stores[1]!.facts.receivedSales).toEqual({
      count: 2,
      byCurrency: [
        { currencyCode: "EGP", count: 1, total: "50.0000" },
        { currencyCode: "USD", count: 1, total: "5.0000" },
      ],
    });
    expect(egp.stores[1]!.ranking.total).toBe("50.0000");
    expect(egp.rangeTotals.receivedSales.byCurrency).toEqual([
      { currencyCode: "EGP", count: 2, total: "150.0000" },
      { currencyCode: "USD", count: 1, total: "5.0000" },
    ]);

    const usd = assembleByStore(input({ currency: "USD", facts }));
    expect(usd.stores.map((s) => [s.storeRef, s.rank])).toEqual([
      [S2, 1],
      [S1, null],
    ]);
    expect(usd.storesWithoutSales).toBe(1);
  });

  it("is not rankable with one store, but still counts it as with or without sales", () => {
    const one = assembleByStore(
      input({
        stores: [store(S1)],
        facts: [sale(S1, "2026-10-01", 1, "1.0000"), base(S1, 1, "1.0000")],
      }),
    );
    expect(one).toMatchObject({ rankable: false, storeCount: 1, storesWithoutSales: 0 });
    expect(one.stores[0]).toMatchObject({ rank: null, baselineRank: null });
    expect(one.stores[0]!.ranking).toMatchObject({
      share: "1.0000",
      baselineTotal: "1.0000",
      deltaRatio: "0.0000",
    });
  });

  it("answers an empty scope with zero totals and dense scope days", () => {
    const out = assembleByStore(input({ stores: [] }));
    expect(out).toMatchObject({
      rankable: false,
      storeCount: 0,
      storesWithoutSales: 0,
      stores: [],
    });
    expect(out.days.map((d) => d.businessDate)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(out.rangeTotals.receivedSales).toEqual({ count: 0, byCurrency: [] });
  });

  it("leaves every baseline figure null with compare=none, but keeps the bounds", () => {
    const out = assembleByStore(
      input({
        compare: "none",
        facts: [sale(S1, "2026-10-01", 1, "1.0000"), sale(S2, "2026-10-01", 1, "2.0000")],
      }),
    );
    expect(out.baseline).toEqual({
      rule: "previous_equal_length",
      from: "2026-09-29",
      to: "2026-09-30",
      dayCount: 2,
    });
    for (const s of out.stores) {
      expect(s.baselineRank).toBeNull();
      expect(s.ranking.baselineTotal).toBeNull();
      expect(s.ranking.deltaRatio).toBeNull();
    }
  });

  it("gives a null delta and baseline rank to a store that sold nothing in the baseline", () => {
    const out = assembleByStore(
      input({
        facts: [sale(S1, "2026-10-01", 1, "1.0000"), sale(S2, "2026-10-01", 1, "2.0000"), base(S2, 1, "4.0000")],
      }),
    );
    const s1 = out.stores.find((s) => s.storeRef === S1)!;
    expect(s1).toMatchObject({ baselineRank: null });
    expect(s1.ranking).toMatchObject({ baselineTotal: "0.0000", deltaRatio: null });
    expect(out.stores.find((s) => s.storeRef === S2)!.ranking.deltaRatio).toBe("-0.5000");
  });

  it("fills dense per-store days with each store's own day state", () => {
    const out = assembleByStore(
      input({
        stores: [
          store(S1, { current_business_date: "2026-10-01" }),
          store(S2, { current_business_date: "2026-10-05" }),
        ],
        facts: [sale(S1, "2026-10-01", 1, "1.0000")],
      }),
    );
    const s1 = out.stores.find((s) => s.storeRef === S1)!;
    const s2 = out.stores.find((s) => s.storeRef === S2)!;
    expect(s1.ranking.days).toEqual([
      { businessDate: "2026-10-01", state: "so_far", count: 1, total: "1.0000" },
      { businessDate: "2026-10-02", state: "not_begun", count: 0, total: "0.0000" },
    ]);
    expect(s2.ranking.days.map((d) => d.state)).toEqual(["complete", "complete"]);
  });

  it("keeps a fact recorded on a date the store has not begun (a timezone moved back); the state stays not_begun", () => {
    const out = assembleByStore(
      input({
        stores: [store(S1, { current_business_date: "2026-10-01" }), store(S2)],
        facts: [sale(S1, "2026-10-02", 1, "7.0000")],
      }),
    );
    const s1 = out.stores.find((s) => s.storeRef === S1)!;
    expect(s1.ranking.days[1]).toEqual({
      businessDate: "2026-10-02",
      state: "not_begun",
      count: 1,
      total: "7.0000",
    });
  });

  it("picks the best day by total among days with a sale, the earliest on a tie", () => {
    const out = assembleByStore(
      input({
        dates: ["2026-10-01", "2026-10-02", "2026-10-03"],
        to: "2026-10-03",
        facts: [
          sale(S1, "2026-10-02", 1, "9.0000"),
          sale(S1, "2026-10-03", 2, "9.0000"),
          sale(S1, "2026-10-01", 1, "3.0000"),
        ],
      }),
    );
    expect(out.stores[0]!.ranking.bestDay).toEqual({ businessDate: "2026-10-02", total: "9.0000" });
  });

  it("adds voids, returns and legacy refunds per store and per scope day, never netted", () => {
    const out = assembleByStore(
      input({
        facts: [
          sale(S1, "2026-10-01", 2, "20.0000"),
          { ...sale(S1, "2026-10-01", 1, "10.0000"), kind: "void" },
          { ...sale(S2, "2026-10-02", 1, "4.0000"), kind: "return" },
          { ...sale(S2, "2026-10-02", 1, "2.0000"), kind: "refund" },
        ],
      }),
    );
    const s1 = out.stores.find((s) => s.storeRef === S1)!;
    expect(s1.facts.receivedSales.byCurrency).toEqual([{ currencyCode: "EGP", count: 2, total: "20.0000" }]);
    expect(s1.facts.voids.byCurrency).toEqual([{ currencyCode: "EGP", count: 1, total: "10.0000" }]);
    expect(s1.ranking.total).toBe("20.0000");
    expect(out.days[1]!.facts.returns.byCurrency).toEqual([{ currencyCode: "EGP", count: 1, total: "4.0000" }]);
    expect(out.days[1]!.facts.legacyRefunds.byCurrency).toEqual([{ currencyCode: "EGP", count: 1, total: "2.0000" }]);
    expect(out.rangeTotals.voids.count).toBe(1);
  });

  it("refuses a group outside the scoped stores, the range, or a baseline group that is not a sale in the currency", () => {
    expect(() => assembleByStore(input({ facts: [sale(S3, "2026-10-01", 1, "1.0000")] }))).toThrow();
    expect(() => assembleByStore(input({ facts: [sale(S1, "2026-10-09", 1, "1.0000")] }))).toThrow();
    expect(() => assembleByStore(input({ facts: [{ ...base(S1, 1, "1.0000"), currency_code: "USD" }] }))).toThrow();
  });
});
