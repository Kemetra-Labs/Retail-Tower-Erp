/**
 * RT-1539 — the template catalogue `msx-templates/1` (RT-1526 §2.3), T-01 .. T-10 and T-12.
 *
 * A template SELECTS, ORDERS and FORMATS pack figures into blocks; it never adds, subtracts,
 * divides, converts or rounds (§2.4). Each figure is a cell whose ref is its citation. It is written
 * against `FigureSource`, so the builder (live reads) and the renderer (the pack alone) run the same
 * code. Column keys and statement slot names are the bare keys the Admin Console's `COLUMN_COPY`
 * knows (`store`, `date`, `received_sales`, `count`, `share`, `rank`, `average_sale`, `best_day`,
 * `baseline_total`, `delta_ratio`, `voids`, `returns`, `legacy_refunds`, `total`); every statement
 * slot ref also appears as a table cell, because the panel looks the value up there.
 */
import type { MsxTemplateId } from "./msx.constants";
import { decimal4Key, RANGE, refOf, SCOPE, type FigureSource, type SrcKey } from "./msx.figures";

interface Cell {
  readonly ref: string;
  readonly value: string | number;
  readonly currency?: string;
}

export type Block =
  | { readonly type: "statement"; readonly key: string; readonly slots: Readonly<Record<string, { readonly ref: string }>> }
  | { readonly type: "table"; readonly columns: readonly string[]; readonly rows: readonly (readonly Cell[])[] };

/** What a template needs to know about the request and the pack's shape (all of it is in `pack.meta`). */
export interface TemplateCtx {
  readonly templateId: MsxTemplateId;
  readonly mode: "store" | "stores" | "all_in_scope";
  /** The covered stores, in display order (by-store templates: the read's own rank order). */
  readonly storeRefs: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly dates: readonly string[];
  /** The ranking currency of the by-store reads; null when the request named none. */
  readonly currency: string | null;
  /** The currencies of the summary's money lines over the covered stores, sorted. */
  readonly currencies: readonly string[];
  /** The latest store-local business date at `asOf` over the covered stores, for scope rows. */
  readonly latestCurrentDate: string | null;
}

type Maybe<T> = T | undefined;

function cellReader(source: FigureSource) {
  const maybe = (src: SrcKey, subject: string, range: string, metric: string, currency?: string): Maybe<Cell> => {
    const figure = source.get(src, subject, range, metric, currency);
    if (figure === undefined || typeof figure.value === "boolean") return undefined;
    return {
      ref: refOf(src, subject, range, metric, currency),
      value: figure.value,
      ...(figure.unit === "money" && currency !== undefined ? { currency } : {}),
    };
  };
  const need = (src: SrcKey, subject: string, range: string, metric: string, currency?: string): Cell => {
    const found = maybe(src, subject, range, metric, currency);
    if (found === undefined) throw new Error(`pack has no figure ${refOf(src, subject, range, metric, currency)}`);
    return found;
  };
  const flag = (src: SrcKey, subject: string, range: string, metric: string): boolean => {
    const figure = source.get(src, subject, range, metric);
    if (typeof figure?.value !== "boolean") throw new Error(`pack has no flag ${refOf(src, subject, range, metric)}`);
    return figure.value;
  };
  return { maybe, need, flag };
}

type Reader = ReturnType<typeof cellReader>;

const compact = (cells: readonly Maybe<Cell>[]): Cell[] => cells.filter((c): c is Cell => c !== undefined);

const table = (columns: readonly string[], rows: readonly (readonly Cell[])[]): Block => ({ type: "table", columns, rows });

/** The store column of a row (the by-store read's name). */
const label = (r: Reader, store: string): Cell => r.need("sbs", store, RANGE, "storeName");

/** The summary subject of a non-`stores` answer: the scope totals, or the one store. */
const subjectOf = (ctx: TemplateCtx): string => (ctx.mode === "all_in_scope" ? SCOPE : ctx.storeRefs[0]!);

/** One summary row set per covered subject: the scope or the one store (no label), else one per store with its label. */
function summarySubjects(ctx: TemplateCtx, r: Reader): { readonly subject: string; readonly label: Maybe<Cell> }[] {
  if (ctx.mode !== "stores") return [{ subject: subjectOf(ctx), label: undefined }];
  return ctx.storeRefs.map((store) => ({ subject: store, label: label(r, store) }));
}

const withLabel = (ctx: TemplateCtx, columns: readonly string[]): string[] => (ctx.mode === "stores" ? ["store", ...columns] : [...columns]);

// ---------------------------------------------------------------------------
// Summary templates
// ---------------------------------------------------------------------------

/** T-01 period_total: one line per currency, never summed across currencies. */
function t01(ctx: TemplateCtx, r: Reader): Block[] {
  const rows: Cell[][] = [];
  for (const { subject, label: name } of summarySubjects(ctx, r)) {
    if (ctx.currencies.length === 0) rows.push(compact([name, r.need("ss", subject, RANGE, "receivedSales.count")]));
    for (const ccy of ctx.currencies) {
      rows.push(compact([name, r.need("ss", subject, RANGE, "receivedSales.total", ccy), r.need("ss", subject, RANGE, "receivedSales.count", ccy)]));
    }
  }
  const columns = ctx.currencies.length === 0 ? ["count"] : ["received_sales", "count"];
  return [table(withLabel(ctx, columns), rows)];
}

/**
 * T-02 daily_breakdown: dense days; a zero day is a received zero. A not-begun day is never a zero and
 * never a short row: it goes in its own table of dates.
 */
function t02(ctx: TemplateCtx, r: Reader): Block[] {
  const rows: Cell[][] = [];
  const notBegun: Cell[][] = [];
  for (const { subject, label: name } of summarySubjects(ctx, r)) {
    const current = subject === SCOPE ? ctx.latestCurrentDate : (r.maybe("ss", subject, RANGE, "currentBusinessDate")?.value as string | undefined) ?? null;
    for (const date of ctx.dates) {
      const day = r.need("ss", subject, date, "businessDate");
      if (current !== null && date > current) {
        notBegun.push(compact([name, day]));
      } else if (ctx.currencies.length === 0) {
        rows.push(compact([name, day, r.need("ss", subject, date, "receivedSales.count")]));
      } else {
        for (const ccy of ctx.currencies) {
          rows.push(compact([name, day, r.need("ss", subject, date, "receivedSales.total", ccy), r.need("ss", subject, date, "receivedSales.count", ccy)]));
        }
      }
    }
  }
  const blocks: Block[] = [];
  if (rows.length > 0) {
    blocks.push(table(withLabel(ctx, ["date", ...(ctx.currencies.length === 0 ? ["count"] : ["received_sales", "count"])]), rows));
  }
  if (notBegun.length > 0) blocks.push(table(withLabel(ctx, ["date"]), notBegun));
  return blocks;
}

const KPIS = ["voids", "returns", "legacyRefunds"] as const;

/** T-03 voids_returns: counts and totals per currency, no "net sales" (no contract). */
function t03(ctx: TemplateCtx, r: Reader): Block[] {
  const rows: Cell[][] = [];
  for (const { subject, label: name } of summarySubjects(ctx, r)) {
    if (ctx.currencies.length === 0) {
      rows.push(compact([name, ...KPIS.map((k) => r.need("ss", subject, RANGE, `${k}.count`))]));
    }
    for (const ccy of ctx.currencies) {
      rows.push(compact([name, ...KPIS.flatMap((k) => [r.need("ss", subject, RANGE, `${k}.count`, ccy), r.need("ss", subject, RANGE, `${k}.total`, ccy)])]));
    }
  }
  const columns = ctx.currencies.length === 0 ? ["voids", "returns", "legacy_refunds"] : ["voids", "total", "returns", "total", "legacy_refunds", "total"];
  return [table(withLabel(ctx, columns), rows)];
}

// ---------------------------------------------------------------------------
// By-store templates
// ---------------------------------------------------------------------------

/** A store's received-sale count in the ranking currency (the denominator of its ranking figures). */
const countOf = (ctx: TemplateCtx, r: Reader, store: string): number => r.need("sbs", store, RANGE, "ranking.count", ctx.currency!).value as number;

const isMoney = (metric: string): boolean => /(\.total|averageSale|baselineTotal)$/.test(metric);

/** One store's candidate figures per column; a metric the read has no value for (null) is absent. */
interface StoreRow {
  readonly label: Cell;
  /** The `[store, count]` fallback figure; absent only when the request named no ranking currency (T-10). */
  readonly count: Cell | undefined;
  readonly cells: ReadonlyMap<string, Cell>;
}

/** `columns`: [column key, by-store metric]. Money and counts are stated in the ranking currency. */
function storeRow(ctx: TemplateCtx, r: Reader, store: string, columns: readonly (readonly [string, string])[]): StoreRow {
  const ccy = ctx.currency;
  const cells = new Map<string, Cell>();
  for (const [column, metric] of columns) {
    const money = isMoney(metric) || metric === "ranking.count";
    if (money && ccy === null) continue;
    const cell = money ? r.maybe("sbs", store, RANGE, metric, ccy!) : r.maybe("sbs", store, RANGE, metric);
    if (cell !== undefined) cells.set(column, cell);
  }
  return { label: label(r, store), count: ccy === null ? undefined : r.need("sbs", store, RANGE, "ranking.count", ccy), cells };
}

/**
 * Cells are positional under their header, so a row never carries fewer cells than its table has
 * columns. A column no store has a figure for is dropped (a rank outside a ranking of one store); a
 * store missing any figure of the kept columns (no sale in the currency, a null share or delta) goes
 * to a second table of `["store", "count"]`, as T-12 states it.
 */
function alignedTables(columns: readonly string[], rows: readonly StoreRow[]): Block[] {
  let main = [...rows];
  let kept: string[] = [];
  for (;;) {
    kept = columns.filter((c) => main.some((row) => row.cells.has(c)));
    if (kept.length === 0) {
      main = [];
      break;
    }
    const full = main.filter((row) => kept.every((c) => row.cells.has(c)));
    if (full.length === main.length) break;
    main = full;
  }
  const rest = rows.filter((row) => !main.includes(row));
  const blocks: Block[] = [];
  if (main.length > 0) blocks.push(table(["store", ...kept], main.map((row) => [row.label, ...kept.map((c) => row.cells.get(c)!)])));
  if (rest.length > 0 || blocks.length === 0) blocks.push(table(["store", "count"], rest.map((row) => [row.label, row.count!])));
  return blocks;
}

/** T-04 store_ranking: rank in one currency; one store in the whole scope is not rankable. */
function t04(ctx: TemplateCtx, r: Reader): Block[] {
  const rankable = r.flag("sbs", SCOPE, RANGE, "rankable");
  if (!rankable) {
    const store = ctx.storeRefs[0]!;
    const ccy = ctx.currency!;
    const cells = {
      store: label(r, store),
      received_sales: r.need("sbs", store, RANGE, "ranking.total", ccy),
      count: r.need("sbs", store, RANGE, "ranking.count", ccy),
    };
    return [
      { type: "statement", key: "msx.t04.single_store", slots: { store: { ref: cells.store.ref }, received_sales: { ref: cells.received_sales.ref }, count: { ref: cells.count.ref } } },
      table(["store", "received_sales", "count"], [[cells.store, cells.received_sales, cells.count]]),
    ];
  }
  const columns = [["rank", "ranking.rank"], ["received_sales", "ranking.total"], ["count", "ranking.count"], ["share", "ranking.share"]] as const;
  return alignedTables(columns.map((c) => c[0]), ctx.storeRefs.map((s) => storeRow(ctx, r, s, columns)));
}

/** T-05 store_compare: the selected stores side by side; share and rank are of the whole scope. */
function t05(ctx: TemplateCtx, r: Reader): Block[] {
  const columns = [
    ["received_sales", "ranking.total"],
    ["count", "ranking.count"],
    ["average_sale", "ranking.averageSale"],
    ["share", "ranking.share"],
    ["rank", "ranking.rank"],
  ] as const;
  return alignedTables(columns.map((c) => c[0]), ctx.storeRefs.map((s) => storeRow(ctx, r, s, columns)));
}

const CHANGE_COLUMNS = [["received_sales", "ranking.total"], ["baseline_total", "ranking.baselineTotal"], ["delta_ratio", "ranking.deltaRatio"]] as const;

function changeTables(ctx: TemplateCtx, r: Reader, stores: readonly string[]): Block[] {
  return alignedTables(CHANGE_COLUMNS.map((c) => c[0]), stores.map((s) => storeRow(ctx, r, s, CHANGE_COLUMNS)));
}

/** T-06 change_vs_previous: two totals side by side for the scope, never a computed difference (G-3). */
function t06(ctx: TemplateCtx, r: Reader): Block[] {
  if (ctx.mode !== "all_in_scope") return changeTables(ctx, r, ctx.storeRefs);
  const ccy = ctx.currency!;
  return [table(["received_sales", "baseline_total"], [[r.need("sbs", SCOPE, RANGE, "receivedSales.total", ccy), r.need("ssb", SCOPE, RANGE, "receivedSales.total", ccy)]])];
}

/** The voids and returns totals of one period per currency (the period is the read it cites). */
function voidsReturnsTable(ctx: TemplateCtx, r: Reader, src: "ss" | "ssb"): Block | null {
  const rows: Cell[][] = [];
  for (const { subject, label: name } of summarySubjects(ctx, r)) {
    for (const money of ctx.currencies) {
      rows.push(compact([name, r.need(src, subject, RANGE, "voids.total", money), r.need(src, subject, RANGE, "returns.total", money)]));
    }
  }
  return rows.length === 0 ? null : table(withLabel(ctx, ["voids", "returns"]), rows);
}

/**
 * T-07 change_explain: what changed per store (ordered by delta, sorting only), then the voids and
 * returns of the current period and of the baseline period, each as its own table with the same known
 * keys (the baseline table cites `ss.baseline` refs and follows the current one).
 */
function t07(ctx: TemplateCtx, r: Reader): Block[] {
  const delta = (s: string): bigint | null => {
    const d = r.maybe("sbs", s, RANGE, "ranking.deltaRatio");
    return d === undefined ? null : decimal4Key(d.value as string);
  };
  const ordered = [...ctx.storeRefs].sort((a, b) => {
    const da = delta(a);
    const db = delta(b);
    if (da === null || db === null) return da === db ? 0 : da === null ? 1 : -1;
    return da === db ? 0 : da < db ? -1 : 1;
  });
  return [...changeTables(ctx, r, ordered), voidsReturnsTable(ctx, r, "ss"), voidsReturnsTable(ctx, r, "ssb")].filter((b): b is Block => b !== null);
}

/** T-08 best_day: the best day of each selected store (earliest on a tie, as the read defines). */
function t08(ctx: TemplateCtx, r: Reader): Block[] {
  const columns = [["best_day", "ranking.bestDay.businessDate"], ["total", "ranking.bestDay.total"]] as const;
  return alignedTables(columns.map((c) => c[0]), ctx.storeRefs.map((s) => storeRow(ctx, r, s, columns)));
}

/** T-09 average_sale: per store, with its denominator; there is no scope-level average (G-4). */
function t09(ctx: TemplateCtx, r: Reader): Block[] {
  const columns = [["average_sale", "ranking.averageSale"], ["count", "ranking.count"]] as const;
  return alignedTables(columns.map((c) => c[0]), ctx.storeRefs.map((s) => storeRow(ctx, r, s, columns)));
}

/** T-10 why_partial: each store's own business date at `asOf`; the notices say what is still open. */
function t10(ctx: TemplateCtx, r: Reader): Block[] {
  const columns = [
    ["date", "currentBusinessDate"],
    ...(ctx.currency === null ? [] : ([["received_sales", "ranking.total"], ["count", "ranking.count"]] as const)),
  ] as readonly (readonly [string, string])[];
  return alignedTables(columns.map((c) => c[0]), ctx.storeRefs.map((s) => storeRow(ctx, r, s, columns)));
}

/** T-12 stores_without_sales: wording is "no sales received", never "no sales" or "closed". */
function t12(ctx: TemplateCtx, r: Reader): Block[] {
  const ccy = ctx.currency!;
  const count = r.need("sbs", SCOPE, RANGE, "storesWithoutSales");
  const none = ctx.storeRefs.filter((s) => countOf(ctx, r, s) === 0);
  const blocks: Block[] = [
    { type: "statement", key: "msx.t12.stores_without_sales", slots: { count: { ref: count.ref } } },
    table(["count"], [[count]]),
  ];
  if (none.length > 0) blocks.push(table(["store", "count"], none.map((s) => [label(r, s), r.need("sbs", s, RANGE, "ranking.count", ccy)])));
  return blocks;
}

const TEMPLATES: Readonly<Record<MsxTemplateId, (ctx: TemplateCtx, r: Reader) => Block[]>> = {
  "T-01": t01,
  "T-02": t02,
  "T-03": t03,
  "T-04": t04,
  "T-05": t05,
  "T-06": t06,
  "T-07": t07,
  "T-08": t08,
  "T-09": t09,
  "T-10": t10,
  "T-12": t12,
};

/** The blocks of the template over `source`. A missing figure throws: nothing is ever invented. */
export function renderBlocks(ctx: TemplateCtx, source: FigureSource): Block[] {
  return TEMPLATES[ctx.templateId](ctx, cellReader(source));
}
