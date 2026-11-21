/**
 * RT-1539 — the evidence builder of the Manager Sales feature (`AiEvidencePackBuilder`).
 *
 * It calls the two deterministic sales reads IN PROCESS with the caller's own `ResolvedContext`, so
 * their store-scope checks run again, and shapes what they returned into the `msx-pack/1` pack. It
 * invents no read model and computes no business number: a figure is a field of a read, copied as it
 * came (the one literal is the explicit received zero of a currency line a read omits, because both
 * reads list only the currencies that had facts).
 *
 *   - T-01 .. T-03: the summary (RT-649); one store is one call, the whole scope or several selected
 *     stores follow `nextCursor` to the end (never a partial page stated as the scope);
 *   - T-04 .. T-09, T-12: the sales by store (RT-1053), which always reads the caller's whole scope;
 *     the selected stores' rows are kept, and `share` and `rank` stay "of your whole scope";
 *   - T-06, T-07: also the summary of the baseline range; T-10: the by-store read only;
 *   - a summary template over several selected stores also reads the by-store report, only for the
 *     store names (the summary carries none).
 *
 * A failed read throws: the Gateway answers `evidence_unavailable` and releases the reservation.
 * Nothing here logs a question, a name or a figure.
 */
import { Inject, Injectable } from "@nestjs/common";

import {
  ConsoleSalesByStoreService,
  ConsoleSalesSummaryService,
  type ConsoleSalesByStore,
  type ConsoleSalesSummary,
  type MoneyFacts,
  type SalesKpis,
  type StoreSalesByStore,
  type StoreSalesSummary,
} from "../../console-sales";
import type { AiEvidenceBuildInput, AiEvidencePackBuilder } from "../gateway/ai-gateway.types";
import type { EvidenceItem, EvidencePack } from "../ports/model-provider.port";
import {
  MSX_CURRENCY_TEMPLATES,
  MSX_FEATURE_ID,
  type MsxDecline,
  type MsxGap,
  type MsxNotice,
  type MsxTemplateId,
} from "./msx.constants";
import { KPI_METRIC, RANGE, SCOPE, refOf, type FigureSource, type FigureValue, type SrcKey } from "./msx.figures";
import { matchRequest } from "./msx.matcher";
import { figureItem, metaItem, sourceItem, type PackMeta, type SourceFacts } from "./msx.pack";
import { ManagerSalesExplainRequestSchema, type ManagerSalesExplainRequest } from "./msx.request";
import { renderBlocks, type TemplateCtx } from "./msx.templates";

const SUMMARY_VERSION = "1.0.0-draft";
const BY_STORE_VERSION = "1.0.0-draft";
const PAGE_SIZE = 50;
/** 500 stores at most (the by-store bound), so 10 pages; two spare for a store created mid-read. */
const MAX_PAGES = 12;
/** ISO-4217 "no currency": the by-store read needs a currency, and a names-only read ranks nothing. */
const NO_CURRENCY = "XXX";
const DAY_MS = 86_400_000;

const SUMMARY_TEMPLATES: readonly MsxTemplateId[] = ["T-01", "T-02", "T-03", "T-07"];
const KPI_NAMES = ["receivedSales", "voids", "returns", "legacyRefunds"] as const;

// ---------------------------------------------------------------------------
// Normalized reads
// ---------------------------------------------------------------------------

interface SummaryRead {
  /** The earliest `asOf` of the pages read (two instants are never merged; the earlier is shown). */
  readonly asOf: string;
  readonly from: string;
  readonly to: string;
  readonly scope: ConsoleSalesSummary["scope"];
  readonly scopeTotals: ConsoleSalesSummary["scopeTotals"];
  readonly stores: ReadonlyMap<string, StoreSalesSummary>;
  readonly dates: ReadonlySet<string>;
}

function businessDatesOf(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= Date.parse(`${to}T00:00:00Z`); ms += DAY_MS) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

function kpisAt(read: SummaryRead, subject: string, range: string): SalesKpis | undefined {
  if (subject === SCOPE) {
    return range === RANGE ? read.scopeTotals.rangeTotals : read.scopeTotals.days.find((d) => d.businessDate === range)?.kpis;
  }
  const store = read.stores.get(subject);
  if (store === undefined) return undefined;
  return range === RANGE ? store.rangeTotals : store.days.find((d) => d.businessDate === range)?.kpis;
}

/** The currency lines the read holds for `kpis` of `subject` over the range. */
function currenciesAt(read: SummaryRead, subject: string, kpis: readonly (typeof KPI_NAMES)[number][]): string[] {
  const at = kpisAt(read, subject, RANGE);
  if (at === undefined) return [];
  return kpis.flatMap((k) => (at[k] as MoneyFacts).byCurrency.map((line) => line.currencyCode));
}

// ---------------------------------------------------------------------------
// The figures of the live reads
// ---------------------------------------------------------------------------

/** A `FigureSource` over the live reads that records every figure a template touches into the pack. */
class ReadFigures implements FigureSource {
  readonly recorded = new Map<string, EvidenceItem>();

  constructor(
    private readonly reads: {
      readonly ss: SummaryRead | undefined;
      readonly ssb: SummaryRead | undefined;
      readonly sbs: ConsoleSalesByStore | undefined;
    },
  ) {}

  get(src: SrcKey, subject: string, range: string, metric: string, currency?: string): FigureValue | undefined {
    const figure = src === "sbs" ? this.byStore(subject, range, metric, currency) : this.summary(src === "ss" ? this.reads.ss : this.reads.ssb, subject, range, metric, currency);
    if (figure !== undefined) {
      const ref = refOf(src, subject, range, metric, currency);
      if (!this.recorded.has(ref)) this.recorded.set(ref, figureItem(ref, figure, metric, figure.unit === "money" ? currency : undefined));
    }
    return figure;
  }

  private summary(read: SummaryRead | undefined, subject: string, range: string, metric: string, currency: string | undefined): FigureValue | undefined {
    if (read === undefined) throw new Error("the template needs a summary read the builder did not make");
    if (metric === "businessDate") return range !== RANGE && read.dates.has(range) ? { value: range, unit: "date" } : undefined;
    if (metric === "currentBusinessDate") {
      const store = read.stores.get(subject);
      return store === undefined ? undefined : { value: store.currentBusinessDate, unit: "date" };
    }
    const kpi = KPI_METRIC.exec(metric);
    const kpis = kpisAt(read, subject, range);
    if (kpi === null || kpis === undefined) return undefined;
    const facts = kpis[kpi[1] as (typeof KPI_NAMES)[number]] as MoneyFacts;
    if (kpi[2] === "count" && currency === undefined) return { value: facts.count, unit: "count" };
    if (currency === undefined) return undefined;
    const line = facts.byCurrency.find((l) => l.currencyCode === currency);
    // Both reads list only the currencies that had facts: no line is an explicit received zero.
    if (kpi[2] === "count") return { value: line?.count ?? 0, unit: "count" };
    return { value: line?.total ?? "0.0000", unit: "money" };
  }

  private byStore(subject: string, range: string, metric: string, currency: string | undefined): FigureValue | undefined {
    const read = this.reads.sbs;
    if (read === undefined) throw new Error("the template needs a by-store read the builder did not make");
    if (range !== RANGE) return undefined;
    if (subject === SCOPE) return this.byStoreScope(read, metric, currency);
    const store = read.stores.find((s) => s.storeRef === subject);
    if (store === undefined) return undefined;
    return byStoreRow(store, metric, currency, read.currency);
  }

  private byStoreScope(read: ConsoleSalesByStore, metric: string, currency: string | undefined): FigureValue | undefined {
    if (metric === "storesWithoutSales") return { value: read.storesWithoutSales, unit: "count" };
    if (metric === "rankable") return { value: read.rankable, unit: "flag" };
    const kpi = KPI_METRIC.exec(metric);
    if (kpi === null || kpi[1] !== "receivedSales" || currency === undefined) return undefined;
    const line = read.rangeTotals.receivedSales.byCurrency.find((l) => l.currencyCode === currency);
    return kpi[2] === "count" ? { value: line?.count ?? 0, unit: "count" } : { value: line?.total ?? "0.0000", unit: "money" };
  }
}

function byStoreRow(store: StoreSalesByStore, metric: string, currency: string | undefined, readCurrency: string): FigureValue | undefined {
  const r = store.ranking;
  const money = (value: string | null): FigureValue | undefined => {
    if (currency !== readCurrency) throw new Error("a by-store money figure was asked in a currency the read did not rank");
    return value === null ? undefined : { value, unit: "money" };
  };
  const ratio = (value: string | null): FigureValue | undefined => (value === null ? undefined : { value, unit: "ratio" });
  switch (metric) {
    case "storeName":
      return { value: store.storeName, unit: "text" };
    case "currentBusinessDate":
      return { value: store.currentBusinessDate, unit: "date" };
    case "ranking.rank":
      return store.rank === null ? undefined : { value: store.rank, unit: "count" };
    case "ranking.total":
      return money(r.total);
    case "ranking.count":
      return { value: r.count, unit: "count" };
    case "ranking.share":
      return ratio(r.share);
    case "ranking.averageSale":
      return money(r.averageSale);
    case "ranking.baselineTotal":
      return money(r.baselineTotal);
    case "ranking.deltaRatio":
      return ratio(r.deltaRatio);
    case "ranking.bestDay.businessDate":
      return r.bestDay === null ? undefined : { value: r.bestDay.businessDate, unit: "date" };
    case "ranking.bestDay.total":
      return r.bestDay === null ? undefined : money(r.bestDay.total);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/** Which reads a template needs. The by-store read also serves the names of a summary template over several stores. */
function readPlanOf(templateId: MsxTemplateId, selectedCount: number) {
  const summary = SUMMARY_TEMPLATES.includes(templateId);
  const names = summary && templateId !== "T-07" && selectedCount > 1;
  return {
    summary,
    byStore: !summary || templateId === "T-07" || names,
    compared: templateId === "T-06" || templateId === "T-07",
    baselineSummary: templateId === "T-07" || (templateId === "T-06" && selectedCount === 0),
  };
}

@Injectable()
export class ManagerSalesEvidenceBuilder implements AiEvidencePackBuilder {
  constructor(
    @Inject(ConsoleSalesSummaryService) private readonly summary: ConsoleSalesSummaryService,
    @Inject(ConsoleSalesByStoreService) private readonly byStore: ConsoleSalesByStoreService,
  ) {}

  async build(input: AiEvidenceBuildInput): Promise<EvidencePack> {
    // The builder branches on the feature; any other feature gets the empty pack, which ends the run.
    if (input.featureId !== MSX_FEATURE_ID) return { items: [] };
    const parsed = ManagerSalesExplainRequestSchema.safeParse(input.params);
    const tenantId = input.ctx.tenantId;
    if (!parsed.success || tenantId === null) throw new Error("the Manager Sales evidence needs the validated request of a tenant session");
    const request = parsed.data;
    const outcome = matchRequest({
      ...(request.templateId === undefined ? {} : { templateId: request.templateId }),
      ...(request.question === undefined ? {} : { question: request.question }),
      storeCount: request.storeIds.length,
      from: request.from,
      to: request.to,
    });
    if (outcome.kind !== "template") throw new Error("a refusal never reaches the evidence build");

    const reads = await this.readAll(input, tenantId, request, outcome.templateId);
    return assemble(request, outcome, reads);
  }

  private async readAll(input: AiEvidenceBuildInput, tenantId: string, request: ManagerSalesExplainRequest, templateId: MsxTemplateId) {
    const read = { tenantId, context: input.ctx };
    const selected = request.storeIds;
    const plan = readPlanOf(templateId, selected.length);

    const sbs = plan.byStore
      ? await this.byStore.byStore({
          ...read,
          from: request.from,
          to: request.to,
          currency: request.currency ?? NO_CURRENCY,
          compare: plan.compared ? "previous_period" : "none",
        })
      : undefined;
    const ss = plan.summary ? await this.readSummary(read, request.from, request.to, selected) : undefined;
    const baseline = sbs?.baseline;
    if (plan.baselineSummary && baseline === undefined) throw new Error("the baseline range is missing from the by-store read");
    const ssb = plan.baselineSummary && baseline !== undefined ? await this.readSummary(read, baseline.from, baseline.to, selected) : undefined;
    return { ss, ssb, sbs };
  }

  /** One store is one call; the whole scope or several stores follow `nextCursor` to the end. */
  private async readSummary(read: { tenantId: string; context: AiEvidenceBuildInput["ctx"] }, from: string, to: string, selected: readonly string[]): Promise<SummaryRead> {
    const stores = new Map<string, StoreSalesSummary>();
    let first: ConsoleSalesSummary | undefined;
    let asOf = "";
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body: ConsoleSalesSummary = await this.summary.summary({
        ...read,
        storeId: selected.length === 1 ? selected[0]! : null,
        from,
        to,
        cursor,
        pageSize: selected.length === 1 ? 1 : PAGE_SIZE,
      });
      first ??= body;
      if (asOf === "" || Date.parse(body.asOf) < Date.parse(asOf)) asOf = body.asOf;
      for (const store of body.stores) stores.set(store.storeRef, store);
      cursor = body.nextCursor;
      if (cursor === null) {
        return { asOf, from, to, scope: first.scope, scopeTotals: first.scopeTotals, stores, dates: new Set(businessDatesOf(from, to)) };
      }
    }
    throw new Error("the sales summary has more store pages than the scope bound allows");
  }
}

// ---------------------------------------------------------------------------
// Assembly: meta, notices, gaps, figures
// ---------------------------------------------------------------------------

type Reads = { ss: SummaryRead | undefined; ssb: SummaryRead | undefined; sbs: ConsoleSalesByStore | undefined };
type Matched = Extract<ReturnType<typeof matchRequest>, { kind: "template" }>;

/** The covered stores, in display order (by-store templates keep the read's own rank order). */
function coveredStores(mode: TemplateCtx["mode"], selected: readonly string[], templateId: MsxTemplateId, reads: Reads): string[] {
  if (reads.sbs !== undefined && (!SUMMARY_TEMPLATES.includes(templateId) || templateId === "T-07")) {
    const present = new Set(reads.sbs.stores.map((s) => s.storeRef));
    if (selected.some((id) => !present.has(id))) throw new Error("a selected store is missing from the by-store read");
    const wanted = new Set(selected);
    return reads.sbs.stores.filter((s) => mode === "all_in_scope" || wanted.has(s.storeRef)).map((s) => s.storeRef);
  }
  if (mode === "all_in_scope") return [...(reads.ss?.stores.keys() ?? [])];
  if (reads.ss !== undefined && selected.some((id) => !reads.ss!.stores.has(id))) throw new Error("a selected store is missing from the summary read");
  return [...selected];
}

/** The store-local business dates at `asOf` of the covered stores. */
function currentDatesOf(storeRefs: readonly string[], reads: Reads): string[] {
  return storeRefs.flatMap((id) => {
    const date = reads.sbs?.stores.find((s) => s.storeRef === id)?.currentBusinessDate ?? reads.ss?.stores.get(id)?.currentBusinessDate;
    return date === undefined ? [] : [date];
  });
}

/** The money currencies of the summary lines over the subjects the template states, sorted. */
function currenciesOf(templateId: MsxTemplateId, mode: TemplateCtx["mode"], storeRefs: readonly string[], reads: Reads): string[] {
  const subjects = mode === "all_in_scope" ? [SCOPE] : storeRefs;
  const kpis = templateId === "T-07" ? (["voids", "returns"] as const) : KPI_NAMES;
  const found = new Set<string>();
  for (const read of [reads.ss, templateId === "T-07" ? reads.ssb : undefined]) {
    if (read !== undefined) for (const subject of subjects) for (const c of currenciesAt(read, subject, kpis)) found.add(c);
  }
  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

interface Facts {
  readonly templateId: MsxTemplateId;
  readonly mode: TemplateCtx["mode"];
  readonly to: string;
  readonly current: readonly string[];
  readonly currencies: readonly string[];
  readonly subset: boolean;
  readonly rankable: boolean;
  readonly parametersFromControlsOnly: boolean;
}

function noticesOf(f: Facts): MsxNotice[] {
  const notices: MsxNotice[] = [];
  if (f.current.some((c) => f.to >= c)) notices.push("day_in_progress");
  if (f.current.some((c) => f.to > c)) notices.push("day_not_begun");
  if ((SUMMARY_TEMPLATES.includes(f.templateId)) && f.currencies.length > 1) notices.push("multi_currency");
  if (f.subset && (f.templateId === "T-05" || (f.templateId === "T-04" && f.rankable))) notices.push("scope_relative_ratio");
  if (f.parametersFromControlsOnly) notices.push("parameters_from_controls_only");
  return notices;
}

/** The documented W5 source gaps that shaped the answer (RT-1526 §3.4); a gap is never filled by a computation. */
function gapsOf(f: Facts): MsxGap[] {
  const all = f.mode === "all_in_scope";
  const gaps: MsxGap[] = [];
  const add = (cond: boolean, ...g: MsxGap[]): void => {
    if (cond) gaps.push(...g);
  };
  add(["T-01", "T-02", "T-03"].includes(f.templateId) && f.mode === "stores", "G-1");
  add(f.templateId === "T-04" && f.subset && f.rankable, "G-2");
  add(f.templateId === "T-05" && f.subset, "G-1", "G-2");
  add((f.templateId === "T-06" || f.templateId === "T-07") && all, "G-3");
  add(f.templateId === "T-09", "G-4");
  add(f.templateId === "T-10", "G-5");
  add(f.templateId === "T-07", "G-6");
  add(f.templateId === "T-12" && f.subset, "G-1");
  return gaps;
}

const latestOf = (dates: readonly string[]): string | null => (dates.length === 0 ? null : dates.reduce((a, b) => (a > b ? a : b)));

function sourceItems(reads: Reads): EvidenceItem[] {
  const facts = (src: SrcKey, read: SummaryRead | ConsoleSalesByStore): SourceFacts => ({
    src,
    asOf: read.asOf,
    contractVersion: src === "sbs" ? BY_STORE_VERSION : SUMMARY_VERSION,
    scope: "scopeTotals" in read ? read.scope : "all_in_scope",
    from: read.from,
    to: read.to,
    storeCount: "scopeTotals" in read ? read.scopeTotals.storeCount : read.storeCount,
  });
  return [
    ...(reads.ss ? [sourceItem(facts("ss", reads.ss))] : []),
    ...(reads.ssb ? [sourceItem(facts("ssb", reads.ssb))] : []),
    ...(reads.sbs ? [sourceItem(facts("sbs", reads.sbs))] : []),
  ];
}

/**
 * RT-1526 leaves a question-only request whose template needs a currency (none sent) undefined: it
 * fails closed as `evidence_unavailable` (released), never a guessed currency.
 */
function requireCurrency(templateId: MsxTemplateId, currency: string | undefined): void {
  if (MSX_CURRENCY_TEMPLATES.includes(templateId) && currency === undefined) {
    throw new Error("the matched template needs a ranking currency and the request named none");
  }
}

const modeOf = (selectedCount: number): TemplateCtx["mode"] => (selectedCount === 0 ? "all_in_scope" : selectedCount === 1 ? "store" : "stores");

function assemble(request: ManagerSalesExplainRequest, outcome: Matched, reads: Reads): EvidencePack {
  const { templateId } = outcome;
  requireCurrency(templateId, request.currency);
  const selected = request.storeIds;
  const mode = modeOf(selected.length);
  const byStoreRanked = !SUMMARY_TEMPLATES.includes(templateId) || templateId === "T-07";
  const storeRefs = coveredStores(mode, selected, templateId, reads);
  const current = currentDatesOf(storeRefs, reads);
  const latestCurrentDate = latestOf(current);
  const currencies = currenciesOf(templateId, mode, storeRefs, reads);
  const dates = businessDatesOf(request.from, request.to);
  const rankingCurrency = byStoreRanked ? (request.currency ?? null) : null;

  const facts: Facts = {
    templateId,
    mode,
    to: request.to,
    current,
    currencies,
    subset: reads.sbs !== undefined && mode !== "all_in_scope" && storeRefs.length < reads.sbs.storeCount,
    rankable: reads.sbs?.rankable ?? false,
    parametersFromControlsOnly: outcome.parametersFromControlsOnly,
  };
  const baseline = templateId === "T-06" || templateId === "T-07" ? reads.sbs?.baseline : undefined;
  const meta: PackMeta = {
    templateId,
    mode,
    storeRefs,
    from: request.from,
    to: request.to,
    dates,
    currency: rankingCurrency,
    currencies,
    latestCurrentDate,
    compare: baseline === undefined ? "none" : "previous_period",
    baseline: baseline === undefined ? null : { from: baseline.from, to: baseline.to, dayCount: baseline.dayCount },
    notices: noticesOf(facts),
    declined: [...outcome.declined] as MsxDecline[],
    gaps: gapsOf(facts),
    sources: [...(reads.ss ? (["ss"] as const) : []), ...(reads.ssb ? (["ssb"] as const) : []), ...(reads.sbs ? (["sbs"] as const) : [])],
  };

  // Run the template over the live reads once: it records exactly the figures it states.
  const figures = new ReadFigures(reads);
  renderBlocks({ templateId, mode, storeRefs, from: request.from, to: request.to, dates, currency: rankingCurrency, currencies, latestCurrentDate }, figures);
  return { items: [metaItem(meta), ...sourceItems(reads), ...figures.recorded.values()] };
}
