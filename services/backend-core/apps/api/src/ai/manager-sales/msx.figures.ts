/**
 * RT-1539 — the figure vocabulary shared by the evidence builder and the renderer: the ref grammar
 * of `msx-pack/1`, the `FigureSource` a template reads from, and the citation field paths.
 *
 *   ref  = <src>:<store uuid | scope>:<range | YYYY-MM-DD>:<metric>[:<CUR>]
 *   src  = ss (sales summary) | sbs (sales by store) | ss.baseline (summary of the baseline range)
 *
 * A template is written once against `FigureSource`. The builder runs it over the live reads and
 * records every figure it touched into the pack; the renderer runs the SAME template over the pack
 * alone. A figure the pack does not hold is a hard error, so no template can state a number that is
 * not a pack field, and every cited ref is in the pack by construction (RT-1526 §2.4).
 */
import type { MsxOperationId } from "./msx.constants";

export type SrcKey = "ss" | "sbs" | "ssb";

const SRC_PREFIX: Readonly<Record<SrcKey, string>> = { ss: "ss", sbs: "sbs", ssb: "ss.baseline" };

export const SRC_OPERATION: Readonly<Record<SrcKey, MsxOperationId>> = {
  ss: "consoleGetSalesSummary",
  ssb: "consoleGetSalesSummary",
  sbs: "consoleGetSalesByStore",
};

export const SRC_ROUTE: Readonly<Record<SrcKey, string>> = {
  ss: "GET /api/v1/sales-summary",
  ssb: "GET /api/v1/sales-summary",
  sbs: "GET /api/v1/sales-by-store",
};

/** The pack item that describes each read (`src.*`). */
export const SRC_ITEM_REF: Readonly<Record<SrcKey, string>> = { ss: "src.ss", sbs: "src.sbs", ssb: "src.ss.baseline" };

export type Unit = "money" | "count" | "ratio" | "date" | "text" | "flag";

export interface FigureValue {
  readonly value: string | number | boolean;
  readonly unit: Unit;
}

export interface FigureSource {
  /** The figure, or undefined when the read has none (a null ratio, no best day). Never a guess. */
  get(src: SrcKey, subject: string, range: string, metric: string, currency?: string): FigureValue | undefined;
}

export const SCOPE = "scope";
export const RANGE = "range";

export function refOf(src: SrcKey, subject: string, range: string, metric: string, currency?: string): string {
  return [SRC_PREFIX[src], subject, range, metric, ...(currency === undefined ? [] : [currency])].join(":");
}

export interface ParsedRef {
  readonly src: SrcKey;
  readonly subject: string;
  readonly range: string;
  readonly metric: string;
  readonly currency: string | undefined;
}

const PREFIX_TO_SRC: ReadonlyMap<string, SrcKey> = new Map([
  ["ss", "ss"],
  ["sbs", "sbs"],
  ["ss.baseline", "ssb"],
]);

export function parseRef(ref: string): ParsedRef | null {
  const [prefix, subject, range, metric, currency, ...rest] = ref.split(":");
  const src = prefix === undefined ? undefined : PREFIX_TO_SRC.get(prefix);
  if (src === undefined || subject === undefined || range === undefined || metric === undefined || rest.length > 0) return null;
  return { src, subject, range, metric, currency };
}

/** The money metrics of the two reads, per currency line. */
export const KPI_METRIC = /^(receivedSales|voids|returns|legacyRefunds)\.(total|count)$/;

function byStorePath(parsed: ParsedRef): string {
  const { subject, range, metric } = parsed;
  if (subject === SCOPE) {
    const kpi = KPI_METRIC.exec(metric);
    return kpi === null ? metric : `rangeTotals.${kpi[1]}.byCurrency[].${kpi[2]}`;
  }
  if (metric === "storeName" || metric === "currentBusinessDate") return `stores[].${metric}`;
  return `stores[].ranking${range === RANGE ? "" : ".days[]"}.${metric.replace(/^ranking\./, "")}`;
}

function summaryPath(parsed: ParsedRef): string {
  const { subject, range, metric } = parsed;
  const base = subject === SCOPE ? "scopeTotals" : "stores[]";
  if (metric === "currentBusinessDate") return "stores[].currentBusinessDate";
  if (metric === "businessDate") return `${base}.days[].businessDate`;
  const day = range !== RANGE;
  const kpi = KPI_METRIC.exec(metric);
  const leaf = kpi === null ? metric : `${kpi[1]}.${kpi[2] === "count" && parsed.currency === undefined ? "count" : `byCurrency[].${kpi[2]}`}`;
  return `${day ? `${base}.days[].kpis` : `${base}.rangeTotals`}.${leaf}`;
}

/** The path of a cited figure in its operation's response (the drawer's field path, X-4). */
export function fieldPathOf(ref: string): string {
  const parsed = parseRef(ref);
  if (parsed === null) return ref;
  return parsed.src === "sbs" ? byStorePath(parsed) : summaryPath(parsed);
}

/** Scaled-integer view of a four-digit decimal text (`-0.0979`), for ORDERING only; never arithmetic on a figure. */
export function decimal4Key(text: string): bigint {
  const negative = text.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? text.slice(1) : text).split(".");
  const value = BigInt(whole) * 10_000n + BigInt(frac.padEnd(4, "0").slice(0, 4));
  return negative ? -value : value;
}
