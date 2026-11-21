/**
 * RT-1540 — the expected deterministic answers of the 17 distinct answer shapes
 * in RT-1526 v6 §6 (templates T-01 .. T-10 and T-12, `msx-templates/1`), built
 * from the hand-written figures in `msx.world.ts`.
 *
 * Gold-label rule: a builder only places a literal figure into a cell with its
 * ref. It never computes one (RT-1526 §2.4).
 */
import { assemble, Pack, statement, table } from "./msx.pack";
import type { AnswerBlock, AnswerBody, MsxEvidence, TableCell } from "./msx.types";
import {
  A1_TODAY,
  A1_WEEK,
  A2_WEEK,
  A3_WEEK,
  AVERAGE_SALE_A3_SAR,
  BASELINE_WEEK,
  CHANGE_WEEK_EGP,
  MONTH,
  MONTH_FACTS,
  NAME_A1,
  NAME_A2,
  NAME_A3,
  RANK_WEEK_EGP,
  SCOPE_WEEK,
  STORE_A1,
  STORE_A2,
  STORE_A3,
  TODAY,
  WEEK,
  WEEK_DAYS,
  type MoneyFacts,
  type StoreWeek,
} from "./msx.world";

export interface Built {
  readonly body: AnswerBody;
  readonly evidence: MsxEvidence;
}

const R = "range";
const WEEK_PERIOD = { from: WEEK.from, to: WEEK.to } as const;
const ALL_STORES = [STORE_A1, STORE_A2, STORE_A3] as const;

type StoreKey = "A1" | "A2" | "A3";
const STORE: Readonly<Record<StoreKey, { id: string; name: string }>> = {
  A1: { id: STORE_A1, name: NAME_A1 },
  A2: { id: STORE_A2, name: NAME_A2 },
  A3: { id: STORE_A3, name: NAME_A3 },
};

/** T-01 for the whole scope over WEEK: one line per currency, never summed (cases 1 and 3). */
export function t01ScopeWeek(): Built {
  const p = new Pack();
  const rows = (["EGP", "SAR"] as const).map((ccy) => [
    p.money("ss", "scope", R, "receivedSales.total", SCOPE_WEEK[ccy].total, ccy),
    p.fact("ss", "scope", R, "receivedSales.count", SCOPE_WEEK[ccy].count, ccy),
  ]);
  return assemble(p, {
    templateId: "T-01",
    mode: "all_in_scope",
    storeRefs: ALL_STORES,
    period: WEEK_PERIOD,
    sources: ["ss"],
    blocks: [table(["msx.col.received_sales", "msx.col.count"], rows)],
    notices: ["multi_currency"],
    condition: "mixed_currency",
  });
}

/** T-01 for two selected stores in two currencies: per-store lines, no subset total (case 29, gap G-1). */
export function t01SelectedStoresMixedCurrency(): Built {
  const p = new Pack();
  const line = (key: "A1" | "A3", total: string, count: number, ccy: string): TableCell[] => [
    p.fact("ss", STORE[key].id, R, "storeName", STORE[key].name),
    p.money("ss", STORE[key].id, R, "receivedSales.total", total, ccy),
    p.fact("ss", STORE[key].id, R, "receivedSales.count", count, ccy),
  ];
  return assemble(p, {
    templateId: "T-01",
    mode: "stores",
    storeRefs: [STORE_A1, STORE_A3],
    period: WEEK_PERIOD,
    sources: ["ss"],
    blocks: [
      table(
        ["msx.col.store", "msx.col.received_sales", "msx.col.count"],
        [line("A1", A1_WEEK.total, A1_WEEK.count, "EGP"), line("A3", A3_WEEK.total, A3_WEEK.count, "SAR")],
      ),
    ],
    notices: ["multi_currency"],
    gaps: ["G-1"],
    condition: "mixed_currency",
  });
}

/** T-01 for store A1 over TODAY, still in progress (case 2). */
export function t01StoreToday(): Built {
  const p = new Pack();
  const row = [
    p.money("ss", STORE_A1, R, "receivedSales.total", A1_TODAY.total, "EGP"),
    p.fact("ss", STORE_A1, R, "receivedSales.count", A1_TODAY.count, "EGP"),
  ];
  p.fact("ss", STORE_A1, R, "currentBusinessDate", TODAY);
  return assemble(p, {
    templateId: "T-01",
    mode: "store",
    storeRefs: [STORE_A1],
    period: { from: TODAY, to: TODAY },
    sources: ["ss"],
    blocks: [table(["msx.col.received_sales", "msx.col.count"], [row])],
    notices: ["day_in_progress"],
    condition: "stale_day_in_progress",
  });
}

/** T-01 for store A1 over the control period WEEK, the question text naming another day (case 38). */
export function t01StoreWeekControlsOnly(): Built {
  const p = new Pack();
  const row = [
    p.money("ss", STORE_A1, R, "receivedSales.total", A1_WEEK.total, "EGP"),
    p.fact("ss", STORE_A1, R, "receivedSales.count", A1_WEEK.count, "EGP"),
  ];
  return assemble(p, {
    templateId: "T-01",
    mode: "store",
    storeRefs: [STORE_A1],
    period: WEEK_PERIOD,
    sources: ["ss"],
    blocks: [table(["msx.col.received_sales", "msx.col.count"], [row])],
    notices: ["parameters_from_controls_only"],
    condition: "fresh",
  });
}

/** T-02: seven dense day rows for one store over WEEK (cases 4 and 5). */
export function t02StoreWeek(key: "A1" | "A2"): Built {
  const p = new Pack();
  const week: StoreWeek = key === "A1" ? A1_WEEK : A2_WEEK;
  const id = STORE[key].id;
  const rows = WEEK_DAYS.map((day, i) => {
    const fact = week.days[i];
    if (fact === undefined) throw new Error(`no fixture figure for ${key} on ${day}`);
    return [
      p.fact("ss", id, day, "businessDate", day),
      p.money("ss", id, day, "receivedSales.total", fact.total, week.currency),
      p.fact("ss", id, day, "receivedSales.count", fact.count, week.currency),
    ];
  });
  return assemble(p, {
    templateId: "T-02",
    mode: "store",
    storeRefs: [id],
    period: WEEK_PERIOD,
    sources: ["ss"],
    blocks: [table(["msx.col.business_date", "msx.col.received_sales", "msx.col.count"], rows)],
    condition: "fresh",
  });
}

/** T-02 with a `to` after today: two complete days, today so far, two days not begun (case 31). */
export function t02FutureDays(): Built {
  const p = new Pack();
  const done = [
    ["2026-11-16", "1520.0000", 26],
    ["2026-11-17", "1710.5000", 29],
    [TODAY, A1_TODAY.total, A1_TODAY.count],
  ] as const;
  const rows: TableCell[][] = done.map(([day, total, count]) => [
    p.fact("ss", STORE_A1, day, "businessDate", day),
    p.money("ss", STORE_A1, day, "receivedSales.total", total, "EGP"),
    p.fact("ss", STORE_A1, day, "receivedSales.count", count, "EGP"),
  ]);
  for (const day of ["2026-11-19", "2026-11-20"]) {
    rows.push([p.fact("ss", STORE_A1, day, "businessDate", day), p.fact("ss", STORE_A1, day, "dayState", "not_begun")]);
  }
  p.fact("ss", STORE_A1, R, "currentBusinessDate", TODAY);
  return assemble(p, {
    templateId: "T-02",
    mode: "store",
    storeRefs: [STORE_A1],
    period: { from: "2026-11-16", to: "2026-11-20" },
    sources: ["ss"],
    blocks: [table(["msx.col.business_date", "msx.col.received_sales", "msx.col.count"], rows)],
    notices: ["day_in_progress", "day_not_begun"],
    condition: "future_days",
  });
}

const T03_COLUMNS = [
  "msx.col.subject",
  "msx.col.voids_count",
  "msx.col.voids_total",
  "msx.col.returns_count",
  "msx.col.returns_total",
  "msx.col.legacy_refunds_count",
  "msx.col.legacy_refunds_total",
];

function t03Row(p: Pack, subject: string, label: TableCell, facts: MoneyFacts, ccy: string): TableCell[] {
  const metric = (name: "voids" | "returns" | "legacyRefunds"): TableCell[] => [
    p.fact("ss", subject, R, `${name}.count`, facts[name].count, ccy),
    p.money("ss", subject, R, `${name}.total`, facts[name].total, ccy),
  ];
  return [label, ...metric("voids"), ...metric("returns"), ...metric("legacyRefunds")];
}

/** T-03 for the whole scope over MONTH: one row per currency, no "net sales" (case 6). */
export function t03ScopeMonth(): Built {
  const p = new Pack();
  const rows = (["EGP", "SAR"] as const).map((ccy) => t03Row(p, "scope", p.fact("ss", "scope", R, "currencyCode", ccy, ccy), MONTH_FACTS[ccy], ccy));
  return assemble(p, {
    templateId: "T-03",
    mode: "all_in_scope",
    storeRefs: ALL_STORES,
    period: { from: MONTH.from, to: MONTH.to },
    sources: ["ss"],
    blocks: [table(T03_COLUMNS, rows)],
    notices: ["multi_currency"],
    condition: "mixed_currency",
  });
}

/** T-03 for two selected stores over MONTH: per store, no subset total (case 7, gap G-1). */
export function t03SelectedStoresMonth(): Built {
  const p = new Pack();
  const rows = (["A1", "A2"] as const).map((key) =>
    t03Row(p, STORE[key].id, p.fact("ss", STORE[key].id, R, "storeName", STORE[key].name), MONTH_FACTS[key], "EGP"),
  );
  return assemble(p, {
    templateId: "T-03",
    mode: "stores",
    storeRefs: [STORE_A1, STORE_A2],
    period: { from: MONTH.from, to: MONTH.to },
    sources: ["ss"],
    blocks: [table(T03_COLUMNS, rows)],
    gaps: ["G-1"],
    condition: "fresh",
  });
}

const RANK_COLUMNS = ["msx.col.store", "msx.col.rank", "msx.col.received_sales", "msx.col.count", "msx.col.share"];

function rankedRow(p: Pack, key: "A1" | "A2", week: StoreWeek, name: TableCell): TableCell[] {
  const id = STORE[key].id;
  return [
    name,
    p.fact("sbs", id, R, "ranking.rank", RANK_WEEK_EGP[key].rank),
    p.money("sbs", id, R, "ranking.total", week.total, "EGP"),
    p.fact("sbs", id, R, "ranking.count", week.count, "EGP"),
    p.fact("sbs", id, R, "ranking.share", RANK_WEEK_EGP[key].share),
  ];
}

/** A store with no sales in the ranking currency shows only its name and the zero count. */
function noSalesRow(p: Pack, key: StoreKey, ccy: string): TableCell[] {
  return [p.fact("sbs", STORE[key].id, R, "storeName", STORE[key].name), p.fact("sbs", STORE[key].id, R, "ranking.count", 0, ccy)];
}

/**
 * T-04 over the whole scope in EGP (cases 8, 9, 21, 22 and 37). `a2Raw` is the
 * pack's store name (untrusted); `a2Shown` is what the answer carries, with
 * bidi controls stripped (RT-1526 §5.1 X-5).
 */
export function t04ScopeRanking(a2Raw: string = NAME_A2, a2Shown: string = a2Raw): Built {
  const p = new Pack();
  const a2Name = { ...p.fact("sbs", STORE_A2, R, "storeName", a2Raw), value: a2Shown };
  const rows = [
    rankedRow(p, "A1", A1_WEEK, p.fact("sbs", STORE_A1, R, "storeName", NAME_A1)),
    rankedRow(p, "A2", A2_WEEK, a2Name),
    noSalesRow(p, "A3", "EGP"),
  ];
  return assemble(p, {
    templateId: "T-04",
    mode: "all_in_scope",
    storeRefs: ALL_STORES,
    period: WEEK_PERIOD,
    sources: ["sbs"],
    blocks: [table(RANK_COLUMNS, rows)],
    condition: a2Raw === NAME_A2 ? "fresh" : "hostile_store_name",
  });
}

/** T-04 for a caller who sees one store: `rankable = false`, a one-store sentence and no rank (case 10). */
export function t04SingleStore(): Built {
  const p = new Pack();
  const slots = {
    store: p.fact("sbs", STORE_A1, R, "storeName", NAME_A1),
    total: p.money("sbs", STORE_A1, R, "ranking.total", A1_WEEK.total, "EGP"),
    count: p.fact("sbs", STORE_A1, R, "ranking.count", A1_WEEK.count, "EGP"),
    rankable: p.flag("sbs", "scope", R, "rankable", false),
  };
  return assemble(p, {
    templateId: "T-04",
    mode: "store",
    storeRefs: [STORE_A1],
    period: WEEK_PERIOD,
    sources: ["sbs"],
    blocks: [statement("msx.t04.single_store", slots)],
    condition: "fresh",
  });
}

/** T-05 for two selected stores: share and rank are "of your whole scope" (case 11, gaps G-1 and G-2). */
export function t05SelectedStoresCompare(): Built {
  const p = new Pack();
  const row = (key: "A1" | "A2", week: StoreWeek, average: string): TableCell[] => {
    const id = STORE[key].id;
    return [
      p.fact("sbs", id, R, "storeName", STORE[key].name),
      p.money("sbs", id, R, "ranking.total", week.total, "EGP"),
      p.fact("sbs", id, R, "ranking.count", week.count, "EGP"),
      p.money("sbs", id, R, "ranking.averageSale", average, "EGP"),
      p.fact("sbs", id, R, "ranking.share", RANK_WEEK_EGP[key].share),
      p.fact("sbs", id, R, "ranking.rank", RANK_WEEK_EGP[key].rank),
    ];
  };
  return assemble(p, {
    templateId: "T-05",
    mode: "stores",
    storeRefs: [STORE_A1, STORE_A2],
    period: WEEK_PERIOD,
    sources: ["sbs"],
    blocks: [
      table(
        ["msx.col.store", "msx.col.received_sales", "msx.col.count", "msx.col.average_sale", "msx.col.share_of_scope", "msx.col.rank_of_scope"],
        [row("A1", A1_WEEK, RANK_WEEK_EGP.A1.averageSale), row("A2", A2_WEEK, RANK_WEEK_EGP.A2.averageSale)],
      ),
    ],
    notices: ["scope_relative_ratio"],
    gaps: ["G-1", "G-2"],
    condition: "fresh",
  });
}

const BASELINE = { from: BASELINE_WEEK.from, to: BASELINE_WEEK.to, dayCount: BASELINE_WEEK.dayCount } as const;

/** T-06: both periods' scope totals side by side, never a computed difference (case 12, gap G-3). */
export function t06ScopeChange(): Built {
  const p = new Pack();
  const row = [
    p.money("sbs", "scope", R, "receivedSales.total", SCOPE_WEEK.EGP.total, "EGP"),
    p.money("ssb", "scope", R, "receivedSales.total", CHANGE_WEEK_EGP.scopeBaselineTotal, "EGP"),
  ];
  return assemble(p, {
    templateId: "T-06",
    mode: "all_in_scope",
    storeRefs: ALL_STORES,
    period: { ...WEEK_PERIOD, baseline: BASELINE },
    sources: ["sbs", "ssb"],
    blocks: [table(["msx.col.current_total", "msx.col.baseline_total"], [row])],
    gaps: ["G-3"],
    condition: "fresh",
  });
}

/** T-07: what changed per store (sorted by delta, sorting only), voids and returns of both periods, and the causal decline (case 13). */
export function t07ScopeChangeExplain(): Built {
  const p = new Pack();
  const storeRow = (key: "A1" | "A2", week: StoreWeek): TableCell[] => {
    const id = STORE[key].id;
    return [
      p.fact("sbs", id, R, "storeName", STORE[key].name),
      p.money("sbs", id, R, "ranking.total", week.total, "EGP"),
      p.money("sbs", id, R, "ranking.baselineTotal", CHANGE_WEEK_EGP[key].baselineTotal, "EGP"),
      p.fact("sbs", id, R, "ranking.deltaRatio", CHANGE_WEEK_EGP[key].deltaRatio),
    ];
  };
  const stores = [storeRow("A2", A2_WEEK), storeRow("A1", A1_WEEK)];
  const facts: AnswerBlock = table(
    ["msx.col.voids_current", "msx.col.voids_baseline", "msx.col.returns_current", "msx.col.returns_baseline"],
    [
      [
        p.money("ss", "scope", R, "voids.total", CHANGE_WEEK_EGP.voids.current, "EGP"),
        p.money("ssb", "scope", R, "voids.total", CHANGE_WEEK_EGP.voids.baseline, "EGP"),
        p.money("ss", "scope", R, "returns.total", CHANGE_WEEK_EGP.returns.current, "EGP"),
        p.money("ssb", "scope", R, "returns.total", CHANGE_WEEK_EGP.returns.baseline, "EGP"),
      ],
    ],
  );
  return assemble(p, {
    templateId: "T-07",
    mode: "all_in_scope",
    storeRefs: ALL_STORES,
    period: { ...WEEK_PERIOD, baseline: BASELINE },
    sources: ["sbs", "ss", "ssb"],
    blocks: [table(["msx.col.store", "msx.col.received_sales", "msx.col.baseline_total", "msx.col.delta_ratio"], stores), facts],
    declined: ["causal_not_supported"],
    gaps: ["G-6"],
    condition: "fresh",
  });
}

/** T-08: the best day of each selected store (case 14). */
export function t08SelectedStoresBestDay(): Built {
  const p = new Pack();
  const row = (key: "A1" | "A2"): TableCell[] => [
    p.fact("sbs", STORE[key].id, R, "storeName", STORE[key].name),
    p.fact("sbs", STORE[key].id, R, "ranking.bestDay.businessDate", RANK_WEEK_EGP[key].bestDay),
    p.money("sbs", STORE[key].id, R, "ranking.bestDay.total", RANK_WEEK_EGP[key].bestDayTotal, "EGP"),
  ];
  return assemble(p, {
    templateId: "T-08",
    mode: "stores",
    storeRefs: [STORE_A1, STORE_A2],
    period: WEEK_PERIOD,
    sources: ["sbs"],
    blocks: [table(["msx.col.store", "msx.col.best_day", "msx.col.best_day_total"], [row("A1"), row("A2")])],
    condition: "fresh",
  });
}

/** T-09: average sale per store in SAR; no scope average (case 15, gap G-4). */
export function t09ScopeAverageSar(): Built {
  const p = new Pack();
  const sar = [
    p.fact("sbs", STORE_A3, R, "storeName", NAME_A3),
    p.money("sbs", STORE_A3, R, "ranking.averageSale", AVERAGE_SALE_A3_SAR, "SAR"),
    p.fact("sbs", STORE_A3, R, "ranking.count", A3_WEEK.count, "SAR"),
  ];
  return assemble(p, {
    templateId: "T-09",
    mode: "all_in_scope",
    storeRefs: ALL_STORES,
    period: WEEK_PERIOD,
    sources: ["sbs"],
    blocks: [table(["msx.col.store", "msx.col.average_sale", "msx.col.count"], [noSalesRow(p, "A1", "SAR"), noSalesRow(p, "A2", "SAR"), sar])],
    gaps: ["G-4"],
    condition: "fresh",
  });
}

/** T-10 for the whole scope today: why a figure is partial (case 16, gap G-5). */
export function t10ScopeWhyPartial(): Built {
  const p = new Pack();
  const rows = (["A1", "A2", "A3"] as const).map((key) => [
    p.fact("sbs", STORE[key].id, R, "storeName", STORE[key].name),
    p.fact("ss", STORE[key].id, R, "currentBusinessDate", TODAY),
    p.fact("sbs", STORE[key].id, TODAY, "dayState", "so_far"),
  ]);
  return assemble(p, {
    templateId: "T-10",
    mode: "all_in_scope",
    storeRefs: ALL_STORES,
    period: { from: TODAY, to: TODAY },
    sources: ["ss", "sbs"],
    blocks: [table(["msx.col.store", "msx.col.current_business_date", "msx.col.day_state"], rows)],
    notices: ["day_in_progress"],
    gaps: ["G-5"],
    condition: "partial_received_only",
  });
}

/** T-10 with a conclusive claim declined: the figure is shown only with its notices (case 17). */
export function t10StoreNotConclusive(): Built {
  const p = new Pack();
  const row = [
    p.fact("sbs", STORE_A1, R, "storeName", NAME_A1),
    p.money("ss", STORE_A1, R, "receivedSales.total", A1_TODAY.total, "EGP"),
    p.fact("sbs", STORE_A1, TODAY, "dayState", "so_far"),
  ];
  p.fact("ss", STORE_A1, R, "currentBusinessDate", TODAY);
  return assemble(p, {
    templateId: "T-10",
    mode: "store",
    storeRefs: [STORE_A1],
    period: { from: TODAY, to: TODAY },
    sources: ["ss", "sbs"],
    blocks: [table(["msx.col.store", "msx.col.received_sales", "msx.col.day_state"], [row])],
    notices: ["day_in_progress"],
    declined: ["partial_data_not_conclusive"],
    gaps: ["G-5"],
    condition: "stale_day_in_progress",
  });
}

/** T-12: the stores with no received sales, from `storesWithoutSales` and the zero count (case 30). */
export function t12StoresWithoutSales(): Built {
  const p = new Pack();
  const count = p.fact("sbs", "scope", R, "storesWithoutSales", 1);
  return assemble(p, {
    templateId: "T-12",
    mode: "stores",
    storeRefs: [STORE_A1, STORE_A2],
    period: WEEK_PERIOD,
    sources: ["sbs"],
    blocks: [statement("msx.t12.stores_without_sales", { count }), table(["msx.col.store", "msx.col.count"], [noSalesRow(p, "A2", "EGP")])],
    condition: "missing_facts",
  });
}
