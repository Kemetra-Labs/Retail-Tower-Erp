/**
 * RT-1540 (W8 P-07 part 2) — the facts the replay serves to the REAL sales assemblers.
 *
 * The rows are written from the hand-written literals of `msx.world.ts` (never from the answers
 * under test): the reads' own aggregation, ranking and four-digit formatting then produce the
 * figures the dataset expects, so a drift between the world and the runtime fails a case.
 */
import type { OtherFact, Sale } from "../../manager-sales/__support__/msx-fixtures";
import {
  A1_TODAY,
  A1_WEEK,
  A2_WEEK,
  A3_WEEK,
  BASELINE_WEEK,
  CHANGE_WEEK_EGP,
  MONTH_FACTS,
  STORE_A1,
  STORE_A2,
  STORE_A3,
  TODAY,
  WEEK_DAYS,
  type StoreWeek,
} from "./msx.world";

const week = (store: string, source: StoreWeek): Sale[] =>
  WEEK_DAYS.map((date, i) => ({ store, date, ccy: source.currency, n: source.days[i]!.count, amount: source.days[i]!.total }));

/** Sales: A1 and A2 daily in EGP over WEEK, A3 one SAR day, a baseline day each, and A1's last days (case 31). */
export const REPLAY_SALES: readonly Sale[] = [
  ...week(STORE_A1, A1_WEEK),
  ...week(STORE_A2, A2_WEEK),
  { store: STORE_A3, date: "2026-11-10", ccy: "SAR", n: A3_WEEK.count, amount: A3_WEEK.total },
  { store: STORE_A1, date: BASELINE_WEEK.from, ccy: "EGP", n: 50, amount: CHANGE_WEEK_EGP.A1.baselineTotal },
  { store: STORE_A2, date: "2026-11-02", ccy: "EGP", n: 40, amount: CHANGE_WEEK_EGP.A2.baselineTotal },
  { store: STORE_A1, date: "2026-11-16", ccy: "EGP", n: 26, amount: "1520.0000" },
  { store: STORE_A1, date: "2026-11-17", ccy: "EGP", n: 29, amount: "1710.5000" },
  { store: STORE_A1, date: TODAY, ccy: "EGP", n: A1_TODAY.count, amount: A1_TODAY.total },
];

const MONTH_STORES = [
  { store: STORE_A1, ccy: "EGP", facts: MONTH_FACTS.A1 },
  { store: STORE_A2, ccy: "EGP", facts: MONTH_FACTS.A2 },
  { store: STORE_A3, ccy: "SAR", facts: MONTH_FACTS.A3 },
] as const;

/** Voids and returns: the WEEK and baseline ones (case 13) and the MONTH ones (cases 6 and 7). */
export const REPLAY_OTHER: readonly OtherFact[] = [
  { kind: "void", store: STORE_A1, date: "2026-11-09", ccy: "EGP", n: 2, amount: CHANGE_WEEK_EGP.voids.current },
  { kind: "return", store: STORE_A1, date: "2026-11-10", ccy: "EGP", n: 3, amount: CHANGE_WEEK_EGP.returns.current },
  { kind: "void", store: STORE_A2, date: "2026-11-03", ccy: "EGP", n: 1, amount: CHANGE_WEEK_EGP.voids.baseline },
  { kind: "return", store: STORE_A2, date: "2026-11-04", ccy: "EGP", n: 1, amount: CHANGE_WEEK_EGP.returns.baseline },
  ...MONTH_STORES.flatMap(({ store, ccy, facts }): OtherFact[] => [
    { kind: "void", store, date: "2026-10-10", ccy, n: facts.voids.count, amount: facts.voids.total },
    { kind: "return", store, date: "2026-10-12", ccy, n: facts.returns.count, amount: facts.returns.total },
  ]),
];
