/**
 * RT-1053 — the pure assembly of the console sales by store
 * (`console-sales-by-store.openapi.yaml`, RT-1008). No DB, no clock.
 *
 * The service reads one row per (fact kind, period, store, business date,
 * currency) group, already counted and summed in SQL, and this module rolls
 * them into the wire shape: each store's per-currency facts, its ranking in
 * the chosen currency (rank, share, average sale, best day, dense days and
 * the baseline figures) and the scope's per-date and range facts.
 *
 * Money stays exact: every amount is the `numeric(19,4)` text Postgres
 * returns, held as a BigInt of ten-thousandths and rendered back with four
 * fractional digits (the summary's `parseDecimal4` / `formatDecimal4`).
 * Nothing is a JS number, converted between currencies or added across
 * currencies. Ratios are exact BigInt quotients rounded half-even (D-10).
 */
import { compareCodeUnits } from "../common/compare-code-units";
import type { BaselineBounds, Compare } from "./console-sales-by-store.query";
import { formatDecimal4, parseDecimal4, type MoneyFacts } from "./console-sales-summary.projections";

// ---------------------------------------------------------------------------
// Rows read by the service
// ---------------------------------------------------------------------------

export type ByStoreFactKind = "sale" | "void" | "return" | "refund";

/**
 * One aggregated group. `period = 'baseline'` rows are received sales in the
 * ranking currency only. `amount` is the `numeric(19,4)` SUM as text.
 */
export interface ByStoreFactRow {
  readonly kind: ByStoreFactKind;
  readonly period: "range" | "baseline";
  readonly store_id: string;
  readonly business_date: string;
  readonly currency_code: string;
  readonly n: number;
  readonly amount: string;
}

export interface ByStoreStoreRow {
  readonly store_id: string;
  readonly name: string;
  readonly is_active: boolean;
  readonly deleted: boolean;
  readonly timezone: string;
  /** The store-local date at `asOf`. */
  readonly current_business_date: string;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface StoreFacts {
  readonly receivedSales: MoneyFacts;
  readonly returns: MoneyFacts;
  readonly voids: MoneyFacts;
  readonly legacyRefunds: MoneyFacts;
}

export type DayState = "complete" | "so_far" | "not_begun";
export type StoreStatus = "active" | "inactive" | "deleted";

export interface StoreDay {
  readonly businessDate: string;
  readonly state: DayState;
  readonly count: number;
  readonly total: string;
}

export interface StoreRanking {
  readonly total: string;
  readonly count: number;
  readonly share: string | null;
  readonly averageSale: string | null;
  readonly baselineTotal: string | null;
  readonly deltaRatio: string | null;
  readonly bestDay: { readonly businessDate: string; readonly total: string } | null;
  readonly days: readonly StoreDay[];
}

export interface StoreSalesByStore {
  readonly storeRef: string;
  readonly storeName: string;
  readonly storeStatus: StoreStatus;
  readonly storeTimezone: string;
  readonly currentBusinessDate: string;
  readonly rank: number | null;
  readonly baselineRank: number | null;
  readonly facts: StoreFacts;
  readonly ranking: StoreRanking;
}

export interface ConsoleSalesByStore {
  readonly from: string;
  readonly to: string;
  readonly currency: string;
  readonly compare: Compare;
  readonly asOf: string;
  readonly completeness: "received_only";
  readonly baseline: BaselineBounds;
  readonly rankable: boolean;
  readonly storeCount: number;
  readonly storesWithoutSales: number;
  readonly rangeTotals: StoreFacts;
  readonly days: ReadonlyArray<{ readonly businessDate: string; readonly facts: StoreFacts }>;
  readonly stores: readonly StoreSalesByStore[];
}

// ---------------------------------------------------------------------------
// Exact ratios (D-10)
// ---------------------------------------------------------------------------

const UNIT = 10_000n;

/** `num / den` rounded half-even to an integer; `den` must be positive. */
export function divRoundHalfEven(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error("divRoundHalfEven: the divisor must be positive");
  const negative = num < 0n;
  const abs = negative ? -num : num;
  let q = abs / den;
  const twice = (abs % den) * 2n;
  if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
  return negative ? -q : q;
}

/** `num / den` as a four-digit decimal (both in the same unit); null on a zero divisor. Never `-0.0000`. */
export function ratio4(num: bigint, den: bigint): string | null {
  if (den === 0n) return null;
  const q = divRoundHalfEven(num * UNIT, den);
  return formatDecimal4(q === 0n ? 0n : q);
}

// ---------------------------------------------------------------------------
// Accumulators
// ---------------------------------------------------------------------------

class MoneyAcc {
  private readonly byCurrency = new Map<string, { count: number; total: bigint }>();

  add(currency: string, count: number, amount: bigint): void {
    const cur = this.byCurrency.get(currency) ?? { count: 0, total: 0n };
    cur.count += count;
    cur.total += amount;
    this.byCurrency.set(currency, cur);
  }

  of(currency: string): { readonly count: number; readonly total: bigint } {
    return this.byCurrency.get(currency) ?? { count: 0, total: 0n };
  }

  toWire(): MoneyFacts {
    const byCurrency = [...this.byCurrency.entries()]
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([currencyCode, v]) => ({
        currencyCode,
        count: v.count,
        total: formatDecimal4(v.total),
      }));
    return { count: byCurrency.reduce((n, c) => n + c.count, 0), byCurrency };
  }
}

const FACT_KEYS = {
  sale: "receivedSales",
  void: "voids",
  return: "returns",
  refund: "legacyRefunds",
} as const;

class FactsAcc {
  readonly receivedSales = new MoneyAcc();
  readonly voids = new MoneyAcc();
  readonly returns = new MoneyAcc();
  readonly legacyRefunds = new MoneyAcc();

  add(row: ByStoreFactRow, amount: bigint): void {
    this[FACT_KEYS[row.kind]].add(row.currency_code, row.n, amount);
  }

  toWire(): StoreFacts {
    return {
      receivedSales: this.receivedSales.toWire(),
      returns: this.returns.toWire(),
      voids: this.voids.toWire(),
      legacyRefunds: this.legacyRefunds.toWire(),
    };
  }
}

interface StoreAcc {
  readonly row: ByStoreStoreRow;
  readonly facts: FactsAcc;
  /** Received sales in the ranking currency, per range date. */
  readonly days: Map<string, { count: number; total: bigint }>;
  readonly baseline: { count: number; total: bigint };
}

function factsByDate(dates: readonly string[]): Map<string, FactsAcc> {
  return new Map(dates.map((d) => [d, new FactsAcc()]));
}

// ---------------------------------------------------------------------------
// Ranking (D-4, D-5, D-6b)
// ---------------------------------------------------------------------------

interface Rankable {
  readonly storeId: string;
  readonly count: number;
  readonly total: bigint;
}

/** Total descending, then count descending, then `storeRef` ascending. */
function byRanking(a: Rankable, b: Rankable): number {
  if (a.total !== b.total) return a.total > b.total ? -1 : 1;
  if (a.count !== b.count) return b.count - a.count;
  return compareCodeUnits(a.storeId, b.storeId);
}

/** Positions 1..n of the stores with at least one received sale in the currency; the rest are absent. */
export function ranksOf(entries: readonly Rankable[]): Map<string, number> {
  const ranked = entries.filter((e) => e.count > 0).sort(byRanking);
  return new Map(ranked.map((e, i) => [e.storeId, i + 1]));
}

export function storeStatusOf(row: Pick<ByStoreStoreRow, "is_active" | "deleted">): StoreStatus {
  if (row.deleted) return "deleted";
  return row.is_active ? "active" : "inactive";
}

export function dayStateOf(businessDate: string, currentBusinessDate: string): DayState {
  const order = compareCodeUnits(businessDate, currentBusinessDate);
  if (order < 0) return "complete";
  return order === 0 ? "so_far" : "not_begun";
}

/** The day with the highest total among the days with a sale; the earliest on a tie. */
function bestDayOf(days: Map<string, { count: number; total: bigint }>): StoreRanking["bestDay"] {
  let best: { date: string; total: bigint } | null = null;
  for (const [date, d] of days) {
    if (d.count > 0 && (best === null || d.total > best.total)) best = { date, total: d.total };
  }
  return best === null ? null : { businessDate: best.date, total: formatDecimal4(best.total) };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AssembleByStoreInput {
  readonly from: string;
  readonly to: string;
  readonly currency: string;
  readonly compare: Compare;
  readonly baseline: BaselineBounds;
  /** Every range date, ascending. */
  readonly dates: readonly string[];
  readonly asOf: string;
  /** Every store of the scope, any order. */
  readonly stores: readonly ByStoreStoreRow[];
  readonly facts: readonly ByStoreFactRow[];
}

class ByStoreAcc {
  readonly perStore: Map<string, StoreAcc>;
  readonly scopeDays: Map<string, FactsAcc>;
  readonly scopeRange = new FactsAcc();

  constructor(private readonly input: AssembleByStoreInput) {
    this.perStore = new Map(
      input.stores.map((row) => [
        row.store_id,
        {
          row,
          facts: new FactsAcc(),
          days: new Map(input.dates.map((d) => [d, { count: 0, total: 0n }])),
          baseline: { count: 0, total: 0n },
        },
      ]),
    );
    this.scopeDays = factsByDate(input.dates);
  }

  add(row: ByStoreFactRow): void {
    const store = this.perStore.get(row.store_id);
    if (store === undefined) throw new Error("sales by store: a fact group falls outside the scoped stores");
    const amount = parseDecimal4(row.amount);
    if (row.period === "baseline") {
      if (row.kind !== "sale" || row.currency_code !== this.input.currency) {
        throw new Error("sales by store: a baseline group is not a received sale in the ranking currency");
      }
      store.baseline.count += row.n;
      store.baseline.total += amount;
      return;
    }
    const day = this.scopeDays.get(row.business_date);
    if (day === undefined) throw new Error("sales by store: a fact group falls outside the range");
    store.facts.add(row, amount);
    day.add(row, amount);
    this.scopeRange.add(row, amount);
    if (row.kind === "sale" && row.currency_code === this.input.currency) {
      const d = store.days.get(row.business_date)!;
      d.count += row.n;
      d.total += amount;
    }
  }
}

/** Roll the aggregated groups into the report. */
export function assembleByStore(input: AssembleByStoreInput): ConsoleSalesByStore {
  const acc = new ByStoreAcc(input);
  for (const row of input.facts) acc.add(row);

  const stores = [...acc.perStore.values()];
  const rankable = stores.length >= 2;
  const compared = input.compare === "previous_period";
  const current = stores.map((s) => ({
    storeId: s.row.store_id,
    ...s.facts.receivedSales.of(input.currency),
  }));
  const ranks = ranksOf(current);
  const baselineRanks = ranksOf(stores.map((s) => ({ storeId: s.row.store_id, ...s.baseline })));
  const scopeTotal = acc.scopeRange.receivedSales.of(input.currency).total;

  const wire = stores.map((s): StoreSalesByStore => {
    const own = s.facts.receivedSales.of(input.currency);
    return {
      storeRef: s.row.store_id,
      storeName: s.row.name,
      storeStatus: storeStatusOf(s.row),
      storeTimezone: s.row.timezone,
      currentBusinessDate: s.row.current_business_date,
      rank: rankable ? (ranks.get(s.row.store_id) ?? null) : null,
      baselineRank: rankable && compared ? (baselineRanks.get(s.row.store_id) ?? null) : null,
      facts: s.facts.toWire(),
      ranking: {
        total: formatDecimal4(own.total),
        count: own.count,
        share: ratio4(own.total, scopeTotal),
        averageSale: own.count === 0 ? null : formatDecimal4(divRoundHalfEven(own.total, BigInt(own.count))),
        baselineTotal: compared ? formatDecimal4(s.baseline.total) : null,
        deltaRatio: compared ? ratio4(own.total - s.baseline.total, s.baseline.total) : null,
        bestDay: bestDayOf(s.days),
        days: [...s.days.entries()].map(([businessDate, d]) => ({
          businessDate,
          state: dayStateOf(businessDate, s.row.current_business_date),
          count: d.count,
          total: formatDecimal4(d.total),
        })),
      },
    };
  });

  // Ranked stores by rank, then the unranked by storeRef (D-5). Ranks hold even when not `rankable`.
  const ordered = [...wire].sort((a, b) => {
    const ra = ranks.get(a.storeRef);
    const rb = ranks.get(b.storeRef);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return compareCodeUnits(a.storeRef, b.storeRef);
  });

  return {
    from: input.from,
    to: input.to,
    currency: input.currency,
    compare: input.compare,
    asOf: input.asOf,
    completeness: "received_only",
    baseline: input.baseline,
    rankable,
    storeCount: stores.length,
    storesWithoutSales: current.filter((c) => c.count === 0).length,
    rangeTotals: acc.scopeRange.toWire(),
    days: [...acc.scopeDays.entries()].map(([businessDate, facts]) => ({
      businessDate,
      facts: facts.toWire(),
    })),
    stores: ordered,
  };
}
