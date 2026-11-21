/**
 * RT-1540 — a small builder for the synthetic evidence pack (`msx-pack/1`) and
 * the expected answer body of one case. It only REGISTERS literal figures and
 * ASSEMBLES them into blocks, citations and sources: it never adds, subtracts,
 * divides or rounds a number (RT-1526 §2.4). The figure values come from
 * `msx.world.ts`, written by hand.
 */
import {
  type AnswerBlock,
  type AnswerBody,
  type EvidenceCondition,
  type MsxEvidence,
  type MsxFigure,
  type MsxSource,
  type OperationId,
  type SrcKey,
  type TableCell,
} from "./msx.types";
import { AS_OF } from "./msx.world";

const PREFIX: Readonly<Record<SrcKey, string>> = { ss: "ss", sbs: "sbs", ssb: "ss.baseline" };
const OPERATION: Readonly<Record<SrcKey, OperationId>> = {
  ss: "consoleGetSalesSummary",
  ssb: "consoleGetSalesSummary",
  sbs: "consoleGetSalesByStore",
};

export class Pack {
  private readonly byRef = new Map<string, MsxFigure>();

  private register(src: SrcKey, subject: string, range: string, metric: string, value: string | number | boolean, currency?: string): string {
    const ref = [PREFIX[src], subject, range, metric, ...(currency === undefined ? [] : [currency])].join(":");
    const existing = this.byRef.get(ref);
    if (existing !== undefined && existing.value !== value) throw new Error(`conflicting figure ${ref}`);
    this.byRef.set(ref, { ref, src, metric, value, ...(currency === undefined ? {} : { currency }) });
    return ref;
  }

  /** A money figure: the cell carries its currency code. */
  money(src: SrcKey, subject: string, range: string, metric: string, value: string, currency: string): TableCell {
    return { ref: this.register(src, subject, range, metric, value, currency), value, currency };
  }

  /** A count, ratio, rank, date, state or text figure: the cell carries no currency field. */
  fact(src: SrcKey, subject: string, range: string, metric: string, value: string | number, currency?: string): TableCell {
    return { ref: this.register(src, subject, range, metric, value, currency), value };
  }

  /** A boolean pack field (RT-1526 §3.1 `src.sbs.rankable`): a statement slot cites it by ref; it is never a table cell. */
  flag(src: SrcKey, subject: string, range: string, metric: string, value: boolean): { readonly ref: string } {
    return { ref: this.register(src, subject, range, metric, value) };
  }

  figures(): readonly MsxFigure[] {
    return [...this.byRef.values()];
  }
}

export const table = (columns: readonly string[], rows: readonly (readonly TableCell[])[]): AnswerBlock => ({ type: "table", columns, rows });

export const statement = (key: string, slots: Readonly<Record<string, { readonly ref: string }>>): AnswerBlock => ({
  type: "statement",
  key,
  slots: Object.fromEntries(Object.entries(slots).map(([name, cell]) => [name, { ref: cell.ref }])),
});

const KPI = /^(receivedSales|voids|returns|legacyRefunds)\.(total|count)$/;

/**
 * The path of a cited figure in its operation's response (the drawer's field path). Hand-kept copy of
 * the grammar whose source of truth is `src/ai/manager-sales/msx.figures.ts` (`fieldPathOf`): a drift
 * between the two fails the replay. A money line is
 * `byCurrency[]`; every KPI cell of this dataset states its currency, so a KPI figure is always a
 * `byCurrency[]` leaf.
 */
function fieldPathOf(figure: MsxFigure): string {
  const [, subject = "", range = ""] = figure.ref.split(":");
  const scope = subject === "scope";
  const day = range !== "range";
  const kpi = KPI.exec(figure.metric);
  if (figure.src === "sbs") {
    if (scope) return kpi === null ? figure.metric : `rangeTotals.${kpi[1]}.byCurrency[].${kpi[2]}`;
    if (figure.metric === "storeName" || figure.metric === "currentBusinessDate") return `stores[].${figure.metric}`;
    return `stores[].ranking${day ? ".days[]" : ""}.${figure.metric.replace(/^ranking\./, "")}`;
  }
  const base = scope ? "scopeTotals" : "stores[]";
  if (figure.metric === "currentBusinessDate") return "stores[].currentBusinessDate";
  if (figure.metric === "businessDate") return `${base}.days[].businessDate`;
  const leaf = kpi === null ? figure.metric : `${kpi[1]}.byCurrency[].${kpi[2]}`;
  return `${base}${day ? ".days[].kpis" : ".rangeTotals"}.${leaf}`;
}

function sourceOf(src: SrcKey): MsxSource {
  return { operationId: OPERATION[src], contractVersion: "1.0.0-draft", asOf: AS_OF[src], completeness: "received_only" };
}

export interface AnswerSpec {
  readonly templateId: string;
  readonly mode: "store" | "stores" | "all_in_scope";
  readonly storeRefs: readonly string[];
  readonly period: AnswerBody["period"];
  readonly sources: readonly SrcKey[];
  readonly blocks: readonly AnswerBlock[];
  readonly notices?: readonly string[];
  readonly declined?: readonly string[];
  readonly gaps?: readonly string[];
  readonly condition: EvidenceCondition;
}

const refsOf = (block: AnswerBlock): string[] =>
  block.type === "table" ? block.rows.flat().map((cell) => cell.ref) : Object.values(block.slots).map((slot) => slot.ref);

/** The expected answer body and its synthetic evidence pack. Every cited ref is a registered figure. */
export function assemble(pack: Pack, spec: AnswerSpec): { body: AnswerBody; evidence: MsxEvidence } {
  const figures = pack.figures();
  const byRef = new Map(figures.map((f) => [f.ref, f]));
  const cited = [...new Set(spec.blocks.flatMap(refsOf))];
  const sources = spec.sources.map(sourceOf);
  const body: AnswerBody = {
    kind: "answer",
    templateId: spec.templateId,
    templateVersion: "msx-templates/1",
    outputSchemaId: "manager_sales.answer/1",
    scope: { mode: spec.mode, storeRefs: spec.storeRefs },
    period: spec.period,
    sources,
    blocks: spec.blocks,
    citations: cited.map((ref) => {
      const figure = byRef.get(ref);
      if (figure === undefined) throw new Error(`cited ref ${ref} is not a pack figure`);
      return { ref, operationId: OPERATION[figure.src], fieldPath: fieldPathOf(figure) };
    }),
    notices: ["received_only", ...(spec.notices ?? [])],
    declined: spec.declined ?? [],
    gaps: spec.gaps ?? [],
    ledger: {
      routeKey: "deterministic_no_model",
      routing_tier: 0,
      task_class: "manager_sales_deterministic_answer",
      classifier_version: "msx-match/1",
      catalogue_version: "msx-templates/1",
      latency_ms: 12,
    },
  };
  return { body, evidence: { packVersion: "msx-pack/1", condition: spec.condition, sources, figures } };
}
