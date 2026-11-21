/**
 * RT-1539 — fixtures for the Manager Sales specs: fake `ConsoleSalesSummaryService` and
 * `ConsoleSalesByStoreService` that run the REAL pure assemblers (`assembleSummary`,
 * `assembleByStore`) over hand-written fact rows, so the reads' own aggregation, ranking and
 * four-digit formatting are exercised and the expected figures below are literals.
 *
 * The synthetic world is the P-07 one (`msx.world.ts`, read only): tenant A with stores A1 (EGP),
 * A2 (EGP) and A3 (SAR). `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import { assembleByStore, type ByStoreFactRow, type ByStoreStoreRow } from "../../../../src/console-sales/console-sales-by-store.projections";
import { baselineOf } from "../../../../src/console-sales/console-sales-by-store.query";
import type { SalesByStoreInput } from "../../../../src/console-sales/console-sales-by-store.service";
import {
  assembleSummary,
  type ConsoleSalesSummary,
  type SummaryFactRow,
  type SummaryStoreRow,
} from "../../../../src/console-sales/console-sales-summary.projections";
import { businessDatesOf } from "../../../../src/console-sales/console-sales-summary.query";
import { StoreNotInScopeError } from "../../../../src/console-sales/console-sales.service";
import type { SalesSummaryInput } from "../../../../src/console-sales/console-sales-summary.service";
import type { ResolvedContext } from "../../../../src/context/types";
import {
  A1_WEEK,
  A2_WEEK,
  A3_WEEK,
  NAME_A1,
  NAME_A2,
  NAME_A3,
  STORE_A1,
  STORE_A2,
  STORE_A3,
  TENANT_A,
  TODAY,
  WEEK,
  WEEK_DAYS,
} from "../../eval/manager-sales/msx.world";

export { NAME_A1, NAME_A2, NAME_A3, STORE_A1, STORE_A2, STORE_A3, TENANT_A, TODAY, WEEK, WEEK_DAYS, A1_WEEK, A2_WEEK, A3_WEEK };

export const USER_ID = "0191e540-0000-7000-8000-0000000000f1";
export const AS_OF_SUMMARY = "2026-11-18T10:30:00.000Z";
export const AS_OF_BYSTORE = "2026-11-18T10:30:02.000Z";

export const BASELINE_WEEK_DAYS = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"] as const;

export function ownerCtx(overrides: Partial<ResolvedContext> = {}): ResolvedContext {
  return { userId: USER_ID, tenantId: TENANT_A, storeId: null, isPlatformAdmin: false, source: "session", storeAccess: { kind: "all" }, ...overrides };
}

export function managerCtx(storeIds: readonly string[], activeStore: string | null = null): ResolvedContext {
  return ownerCtx({ storeAccess: { kind: "specific", storeIds }, storeId: activeStore });
}

interface StoreDef {
  readonly id: string;
  readonly name: string;
  readonly active?: boolean;
  readonly deleted?: boolean;
}

export const WORLD: readonly StoreDef[] = [
  { id: STORE_A1, name: NAME_A1 },
  { id: STORE_A2, name: NAME_A2 },
  { id: STORE_A3, name: NAME_A3 },
];

export interface Sale {
  readonly store: string;
  readonly date: string;
  readonly ccy: string;
  readonly n: number;
  readonly amount: string;
}

/** Hand-written sales: A1 and A2 daily in EGP over WEEK, A3 one SAR day, plus a baseline week for A1 and A2. */
export const SALES: readonly Sale[] = [
  ...WEEK_DAYS.map((date, i) => ({ store: STORE_A1, date, ccy: "EGP", n: A1_WEEK.days[i]!.count, amount: A1_WEEK.days[i]!.total })),
  ...WEEK_DAYS.map((date, i) => ({ store: STORE_A2, date, ccy: "EGP", n: A2_WEEK.days[i]!.count, amount: A2_WEEK.days[i]!.total })),
  { store: STORE_A3, date: "2026-11-10", ccy: "SAR", n: A3_WEEK.count, amount: A3_WEEK.total },
  { store: STORE_A1, date: "2026-11-01", ccy: "EGP", n: 50, amount: "14920.0000" },
  { store: STORE_A2, date: "2026-11-02", ccy: "EGP", n: 40, amount: "10390.2500" },
  { store: STORE_A1, date: TODAY, ccy: "EGP", n: 21, amount: "1184.7500" },
];

export interface OtherFact {
  readonly kind: "void" | "return" | "refund";
  readonly store: string;
  readonly date: string;
  readonly ccy: string;
  readonly n: number;
  readonly amount: string;
}

/** Voids and returns (counts and totals) in the week and in the baseline week. */
export const OTHER_FACTS: readonly OtherFact[] = [
  { kind: "void", store: STORE_A1, date: "2026-11-09", ccy: "EGP", n: 2, amount: "210.0000" },
  { kind: "return", store: STORE_A1, date: "2026-11-10", ccy: "EGP", n: 3, amount: "455.0000" },
  { kind: "void", store: STORE_A2, date: "2026-11-03", ccy: "EGP", n: 1, amount: "180.0000" },
  { kind: "return", store: STORE_A2, date: "2026-11-04", ccy: "EGP", n: 1, amount: "390.5000" },
  { kind: "return", store: STORE_A3, date: "2026-11-11", ccy: "SAR", n: 1, amount: "99.0000" },
];

export interface WorldOptions {
  /** The stores the caller's scope holds (default: all three). */
  readonly scope?: readonly string[];
  /** Replace a store's display name (hostile text). */
  readonly names?: Readonly<Record<string, string>>;
  /** The store-local business date at `asOf` (default TODAY). */
  readonly today?: string;
  /** The `asOf` of a summary read over a range starting at `from` (default: one instant for every read). */
  readonly summaryAsOf?: (from: string) => string;
  /** Replace the sales facts the reads serve (RT-1540 replay: the `msx.world.ts` figures). */
  readonly sales?: readonly Sale[];
  /** Replace the void, return and refund facts the reads serve. */
  readonly other?: readonly OtherFact[];
}

function inScope(options: WorldOptions): StoreDef[] {
  const ids = options.scope ?? WORLD.map((s) => s.id);
  return WORLD.filter((s) => ids.includes(s.id)).map((s) => ({ ...s, name: options.names?.[s.id] ?? s.name }));
}

const summaryFacts = (stores: readonly string[], from: string, to: string, sales: readonly Sale[], other: readonly OtherFact[]): SummaryFactRow[] => [
  ...sales.filter((s) => stores.includes(s.store) && s.date >= from && s.date <= to).map(
    (s): SummaryFactRow => ({ kind: "sale", store_id: s.store, business_date: s.date, currency_code: s.ccy, k1: "synced", k2: null, k3: null, n: s.n, amount: s.amount }),
  ),
  ...other.filter((f) => stores.includes(f.store) && f.date >= from && f.date <= to).map(
    (f): SummaryFactRow => ({ kind: f.kind, store_id: f.store, business_date: f.date, currency_code: f.ccy, k1: null, k2: null, k3: null, n: f.n, amount: f.amount }),
  ),
];

export interface FakeReads {
  readonly summary: { summary(input: SalesSummaryInput): Promise<ConsoleSalesSummary> };
  readonly byStore: { byStore(input: SalesByStoreInput): Promise<ReturnType<typeof assembleByStore>> };
  readonly calls: { summary: SalesSummaryInput[]; byStore: SalesByStoreInput[] };
}

/** Fake reads over the world. `fail` makes one of them throw (an evidence failure). */
export function fakeReads(options: WorldOptions & { readonly fail?: "summary" | "byStore" } = {}): FakeReads {
  const stores = inScope(options);
  const today = options.today ?? TODAY;
  const sales = options.sales ?? SALES;
  const other = options.other ?? OTHER_FACTS;
  const calls: FakeReads["calls"] = { summary: [], byStore: [] };
  return {
    calls,
    summary: {
      async summary(input) {
        calls.summary.push(input);
        if (options.fail === "summary") throw new Error("summary read failed");
        const chosen = input.storeId === null ? stores : stores.filter((s) => s.id === input.storeId);
        if (input.storeId !== null && chosen.length === 0) throw new StoreNotInScopeError();
        const rows: SummaryStoreRow[] = chosen.map((s) => ({ store_id: s.id, timezone: "Africa/Cairo", current_business_date: today }));
        const assembled = assembleSummary({
          scope: input.storeId === null ? "all_in_scope" : "store",
          storeRef: input.storeId,
          from: input.from,
          to: input.to,
          dates: businessDatesOf(input.from, input.to),
          asOf: options.summaryAsOf?.(input.from) ?? AS_OF_SUMMARY,
          stores: rows,
          facts: summaryFacts(chosen.map((s) => s.id), input.from, input.to, sales, other),
          after: input.cursor,
          pageSize: input.pageSize,
        });
        return { ...assembled.body, nextCursor: assembled.resumeAfter };
      },
    },
    byStore: {
      async byStore(input) {
        calls.byStore.push(input);
        if (options.fail === "byStore") throw new Error("by-store read failed");
        const baseline = baselineOf(input.from, input.to);
        const compared = input.compare === "previous_period";
        const rows: ByStoreStoreRow[] = stores.map((s) => ({
          store_id: s.id,
          name: s.name,
          is_active: s.active ?? true,
          deleted: s.deleted ?? false,
          timezone: "Africa/Cairo",
          current_business_date: today,
        }));
        const ids = stores.map((s) => s.id);
        const facts: ByStoreFactRow[] = [
          ...sales.filter((s) => ids.includes(s.store) && s.date >= input.from && s.date <= input.to).map(
            (s): ByStoreFactRow => ({ kind: "sale", period: "range", store_id: s.store, business_date: s.date, currency_code: s.ccy, n: s.n, amount: s.amount }),
          ),
          ...(compared
            ? sales.filter((s) => ids.includes(s.store) && s.ccy === input.currency && s.date >= baseline.from && s.date <= baseline.to).map(
                (s): ByStoreFactRow => ({ kind: "sale", period: "baseline", store_id: s.store, business_date: s.date, currency_code: s.ccy, n: s.n, amount: s.amount }),
              )
            : []),
          ...other.filter((f) => ids.includes(f.store) && f.date >= input.from && f.date <= input.to).map(
            (f): ByStoreFactRow => ({ kind: f.kind, period: "range", store_id: f.store, business_date: f.date, currency_code: f.ccy, n: f.n, amount: f.amount }),
          ),
        ];
        return assembleByStore({
          from: input.from,
          to: input.to,
          currency: input.currency,
          compare: input.compare,
          baseline,
          dates: businessDatesOf(input.from, input.to),
          asOf: AS_OF_BYSTORE,
          stores: rows,
          facts,
        });
      },
    },
  };
}
