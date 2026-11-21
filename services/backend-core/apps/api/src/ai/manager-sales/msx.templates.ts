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

/** T-02 daily_breakdown: dense days; a zero day is a received zero, a not-begun day is never a zero. */
function t02(ctx: TemplateCtx, r: Reader): Block[] {
  const rows: Cell[][] = [];
  for (const { subject, label: name } of summarySubjects(ctx, r)) {
    const current = subject === SCOPE ? ctx.latestCurrentDate : (r.maybe("ss", subject, RANGE, "currentBusinessDate")?.value as string | undefined) ?? null;
    for (const date of ctx.dates) {
      const day = r.need("ss", subject, date, "businessDate");
      if (current !== null && date > current) {
        rows.push(compact([name, day]));
      } else if (ctx.currencies.length === 0) {
        rows.push(compact([name, day, r.need("ss", subject, date, "receivedSales.count")]));
      } else {
        for (const ccy of ctx.currencies) {
          rows.push(compact([name, day, r.need("ss", subject, date, "receivedSales.total", ccy), r.need("ss", subject, date, "receivedSales.count", ccy)]));
        }
      }
    }
  }
  return [table(withLabel(ctx, ["date", ctx.currencies.length === 0 ? "count" : "received_sales", ...(ctx.currencies.length === 0 ? [] : ["count"])]), rows)];
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

function rankingRow(ctx: TemplateCtx, r: Reader, store: string, metrics: readonly string[], zeroOnly: boolean): Cell[] {
  const ccy = ctx.currency!;
  const name = label(r, store);
  if (zeroOnly && countOf(ctx, r, store) === 0) return [name, r.need("sbs", store, RANGE, "ranking.count", ccy)];
  return compact([name, ...metrics.map((m) => (isMoney(m) || m === "ranking.count" ? r.maybe("sbs", store, RANGE, m, ccy) : r.maybe("sbs", store, RANGE, m)))]);
}

const isMoney = (metric: string): boolean => /(\.total|averageSale|baselineTotal)$/.test(metric);

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
  const rows = ctx.storeRefs.map((s) => rankingRow(ctx, r, s, ["ranking.rank", "ranking.total", "ranking.count", "ranking.share"], true));
  return [table(["store", "rank", "received_sales", "count", "share"], rows)];
}

/** T-05 store_compare: the selected stores side by side; share and rank are of the whole scope. */
function t05(ctx: TemplateCtx, r: Reader): Block[] {
  const rows = ctx.storeRefs.map((s) => rankingRow(ctx, r, s, ["ranking.total", "ranking.count", "ranking.averageSale", "ranking.share", "ranking.rank"], true));
  return [table(["store", "received_sales", "count", "average_sale", "share", "rank"], rows)];
}

function changeRows(ctx: TemplateCtx, r: Reader, stores: readonly string[]): Cell[][] {
  const ccy = ctx.currency!;
  return stores.map((s) =>
    compact([
      label(r, s),
      r.need("sbs", s, RANGE, "ranking.total", ccy),
      r.maybe("sbs", s, RANGE, "ranking.baselineTotal", ccy),
      r.maybe("sbs", s, RANGE, "ranking.deltaRatio"),
    ]),
  );
}

const CHANGE_COLUMNS = ["store", "received_sales", "baseline_total", "delta_ratio"];

/** T-06 change_vs_previous: two totals side by side for the scope, never a computed difference (G-3). */
function t06(ctx: TemplateCtx, r: Reader): Block[] {
  if (ctx.mode !== "all_in_scope") return [table(CHANGE_COLUMNS, changeRows(ctx, r, ctx.storeRefs))];
  const ccy = ctx.currency!;
  return [table(["received_sales", "baseline_total"], [[r.need("sbs", SCOPE, RANGE, "receivedSales.total", ccy), r.need("ssb", SCOPE, RANGE, "receivedSales.total", ccy)]])];
}

/** T-07 change_explain: what changed per store (ordered by delta, sorting only), voids and returns of both periods. */
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
  const rows: Cell[][] = [];
  for (const { subject, label: name } of summarySubjects(ctx, r)) {
    for (const money of ctx.currencies) {
      rows.push(
        compact([
          name,
          r.need("ss", subject, RANGE, "voids.total", money),
          r.need("ss", subject, RANGE, "returns.total", money),
          r.need("ssb", subject, RANGE, "voids.total", money),
          r.need("ssb", subject, RANGE, "returns.total", money),
        ]),
      );
    }
  }
  const blocks: Block[] = [table(CHANGE_COLUMNS, changeRows(ctx, r, ordered))];
  if (rows.length > 0) blocks.push(table(withLabel(ctx, ["voids", "returns", "voids_baseline", "returns_baseline"]), rows));
  return blocks;
}

/** T-08 best_day: the best day of each selected store (earliest on a tie, as the read defines). */
function t08(ctx: TemplateCtx, r: Reader): Block[] {
  const ccy = ctx.currency!;
  const rows = ctx.storeRefs.map((s) => {
    const day = r.maybe("sbs", s, RANGE, "ranking.bestDay.businessDate");
    if (day === undefined) return [label(r, s), r.need("sbs", s, RANGE, "ranking.count", ccy)];
    return [label(r, s), day, r.need("sbs", s, RANGE, "ranking.bestDay.total", ccy)];
  });
  return [table(["store", "best_day", "total"], rows)];
}

/** T-09 average_sale: per store, with its denominator; there is no scope-level average (G-4). */
function t09(ctx: TemplateCtx, r: Reader): Block[] {
  const ccy = ctx.currency!;
  const rows = ctx.storeRefs.map((s) => {
    const average = r.maybe("sbs", s, RANGE, "ranking.averageSale", ccy);
    const count = r.need("sbs", s, RANGE, "ranking.count", ccy);
    return average === undefined ? [label(r, s), count] : [label(r, s), average, count];
  });
  return [table(["store", "average_sale", "count"], rows)];
}

/** T-10 why_partial: each store's own business date at `asOf`; the notices say what is still open. */
function t10(ctx: TemplateCtx, r: Reader): Block[] {
  const ccy = ctx.currency;
  const rows = ctx.storeRefs.map((s) =>
    compact([
      label(r, s),
      r.need("sbs", s, RANGE, "currentBusinessDate"),
      ...(ccy === null ? [] : [r.need("sbs", s, RANGE, "ranking.total", ccy), r.need("sbs", s, RANGE, "ranking.count", ccy)]),
    ]),
  );
  return [table(["store", "date", ...(ccy === null ? [] : ["received_sales", "count"])], rows)];
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
