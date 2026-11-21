/**
 * RT-1540 (W8 P-07 part 1) — the synthetic world of `msx-eval/1`.
 *
 * Every id is a fixed synthetic UUID and every figure is a hand-written literal
 * (RT-1526 v6 §6 "Synthetic world"; the gold labels are never computed from the
 * code under test, as in `e1.cases.ts`). Tenant A has stores A1 (EGP), A2 (EGP)
 * and A3 (SAR); tenant B has store B1. Nothing here is real data.
 */
const PREFIX = "0191e540-0000-7000-8000";

const id = (tail: string): string => `${PREFIX}-${tail.padStart(12, "0")}`;

export const TENANT_A = id("a0");
export const TENANT_B = id("b0");
export const STORE_A1 = id("a1");
export const STORE_A2 = id("a2");
export const STORE_A3 = id("a3");
export const STORE_B1 = id("b1");

export const NAME_A1 = "Maadi";
export const NAME_A2 = "Nasr City";
export const NAME_A3 = "Riyadh Olaya";
export const NAME_B1 = "Zamalek Branch B1";

/** The synthetic server time of the source reads (each read keeps its OWN asOf, RT-1526 §3.1). */
export const AS_OF = {
  ss: "2026-11-18T10:30:00.000Z",
  ssb: "2026-11-18T10:30:01.000Z",
  sbs: "2026-11-18T10:30:02.000Z",
} as const;

/** The store-local current business date at `asOf` for every store of tenant A. */
export const TODAY = "2026-11-18";

/** A completed 7-day range ("this week" / "7 days" controls) and its equal-length baseline. */
export const WEEK = { from: "2026-11-08", to: "2026-11-14" } as const;
export const WEEK_DAYS = [
  "2026-11-08",
  "2026-11-09",
  "2026-11-10",
  "2026-11-11",
  "2026-11-12",
  "2026-11-13",
  "2026-11-14",
] as const;
export const BASELINE_WEEK = { from: "2026-11-01", to: "2026-11-07", dayCount: 7 } as const;

/** A completed 31-day range ("month" control) and a 45-day range (over the 31-day limit). */
export const MONTH = { from: "2026-10-01", to: "2026-10-31" } as const;
export const LONG_RANGE = { from: "2026-10-05", to: "2026-11-18" } as const;

export interface DayFact {
  readonly total: string;
  readonly count: number;
}

export interface StoreWeek {
  readonly currency: string;
  readonly days: readonly DayFact[];
  readonly total: string;
  readonly count: number;
}

/** A1 over WEEK, as the sales read returns it: seven dense days and the range total. */
export const A1_WEEK: StoreWeek = {
  currency: "EGP",
  days: [
    { total: "1840.5000", count: 31 },
    { total: "2210.0000", count: 37 },
    { total: "1975.2500", count: 33 },
    { total: "2390.0000", count: 40 },
    { total: "2105.7500", count: 35 },
    { total: "1688.0000", count: 29 },
    { total: "1250.0000", count: 22 },
  ],
  total: "13459.5000",
  count: 227,
};

export const A2_WEEK: StoreWeek = {
  currency: "EGP",
  days: [
    { total: "1100.0000", count: 18 },
    { total: "1325.5000", count: 22 },
    { total: "1210.0000", count: 20 },
    { total: "1480.2500", count: 25 },
    { total: "1390.0000", count: 23 },
    { total: "1105.0000", count: 19 },
    { total: "995.2500", count: 17 },
  ],
  total: "8606.0000",
  count: 144,
};

export const A3_WEEK = { currency: "SAR", total: "6120.5000", count: 83 } as const;

/** Whole-scope totals over WEEK, one line per currency (never summed across currencies). */
export const SCOPE_WEEK = {
  EGP: { total: "22065.5000", count: 371 },
  SAR: { total: "6120.5000", count: 83 },
} as const;

/** By-store ranking facts over WEEK in EGP (the read's own strings). */
export const RANK_WEEK_EGP = {
  A1: { rank: 1, share: "0.6100", averageSale: "59.2930", bestDay: "2026-11-11", bestDayTotal: "2390.0000" },
  A2: { rank: 2, share: "0.3900", averageSale: "59.7639", bestDay: "2026-11-11", bestDayTotal: "1480.2500" },
} as const;
export const AVERAGE_SALE_A3_SAR = "73.7410";

/** Baseline (BASELINE_WEEK) facts for the change templates T-06 and T-07. */
export const CHANGE_WEEK_EGP = {
  scopeBaselineTotal: "25310.2500",
  A1: { baselineTotal: "14920.0000", deltaRatio: "-0.0979", baselineRank: 1 },
  A2: { baselineTotal: "10390.2500", deltaRatio: "-0.1717", baselineRank: 2 },
  voids: { current: "210.0000", baseline: "180.0000" },
  returns: { current: "455.0000", baseline: "390.5000" },
} as const;

export interface MoneyFacts {
  readonly voids: DayFact;
  readonly returns: DayFact;
  readonly legacyRefunds: DayFact;
}

/** Voids, returns and legacy refunds over MONTH, per store and per scope currency line. */
export const MONTH_FACTS: Readonly<Record<"A1" | "A2" | "A3" | "EGP" | "SAR", MoneyFacts>> = {
  A1: {
    voids: { count: 4, total: "320.0000" },
    returns: { count: 6, total: "845.5000" },
    legacyRefunds: { count: 0, total: "0.0000" },
  },
  A2: {
    voids: { count: 2, total: "150.0000" },
    returns: { count: 3, total: "410.0000" },
    legacyRefunds: { count: 0, total: "0.0000" },
  },
  A3: {
    voids: { count: 1, total: "90.0000" },
    returns: { count: 2, total: "310.0000" },
    legacyRefunds: { count: 0, total: "0.0000" },
  },
  EGP: {
    voids: { count: 6, total: "470.0000" },
    returns: { count: 9, total: "1255.5000" },
    legacyRefunds: { count: 0, total: "0.0000" },
  },
  SAR: {
    voids: { count: 1, total: "90.0000" },
    returns: { count: 2, total: "310.0000" },
    legacyRefunds: { count: 0, total: "0.0000" },
  },
};

/** A1 today (so_far): what the server had received by `asOf`. */
export const A1_TODAY: DayFact = { total: "1184.7500", count: 21 };
