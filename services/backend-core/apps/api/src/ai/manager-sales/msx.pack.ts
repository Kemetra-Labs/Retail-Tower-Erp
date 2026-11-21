/**
 * RT-1539 — the evidence pack `msx-pack/1` (RT-1526 §3.1): one `pack.meta` header, one `src.*` item
 * per source read, and one item per stated figure (its `ref` is the citation). It fits the existing
 * `EvidencePack` port unchanged. No tenant id, no question text and no PII is ever put in it.
 */
import type { EvidenceFieldValue, EvidenceItem, EvidencePack } from "../ports/model-provider.port";
import {
  MSX_DECLINES,
  MSX_FEATURE_ID,
  MSX_GAPS,
  MSX_MATCH_VERSION,
  MSX_NOTICES,
  MSX_PACK_VERSION,
  MSX_TEMPLATES_VERSION,
  MSX_TEMPLATE_IDS,
  type MsxDecline,
  type MsxGap,
  type MsxNotice,
  type MsxTemplateId,
} from "./msx.constants";
import { SRC_ITEM_REF, SRC_OPERATION, SRC_ROUTE, type FigureSource, type FigureValue, type SrcKey, type Unit, refOf } from "./msx.figures";
import type { TemplateCtx } from "./msx.templates";

const META_REF = "pack.meta";

export interface PackMeta {
  readonly templateId: MsxTemplateId;
  readonly mode: TemplateCtx["mode"];
  readonly storeRefs: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly dates: readonly string[];
  readonly currency: string | null;
  readonly currencies: readonly string[];
  readonly latestCurrentDate: string | null;
  readonly compare: "previous_period" | "none";
  readonly baseline: { readonly from: string; readonly to: string; readonly dayCount: number } | null;
  readonly notices: readonly MsxNotice[];
  readonly declined: readonly MsxDecline[];
  readonly gaps: readonly MsxGap[];
  /** The reads behind the answer, in display order. */
  readonly sources: readonly SrcKey[];
}

const csv = (values: readonly string[]): string => values.join(",");
const unCsv = (text: EvidenceFieldValue | undefined): string[] => (typeof text === "string" && text.length > 0 ? text.split(",") : []);

export function metaItem(meta: PackMeta): EvidenceItem {
  return {
    ref: META_REF,
    fields: {
      packVersion: MSX_PACK_VERSION,
      featureId: MSX_FEATURE_ID,
      templateId: meta.templateId,
      templateVersion: MSX_TEMPLATES_VERSION,
      matchVersion: MSX_MATCH_VERSION,
      scopeMode: meta.mode,
      storeRefs: csv(meta.storeRefs),
      periodFrom: meta.from,
      periodTo: meta.to,
      dayCount: meta.dates.length,
      dates: csv(meta.dates),
      rankingCurrency: meta.currency,
      currencies: csv(meta.currencies),
      latestCurrentDate: meta.latestCurrentDate,
      compare: meta.compare,
      baselineFrom: meta.baseline?.from ?? null,
      baselineTo: meta.baseline?.to ?? null,
      baselineDayCount: meta.baseline?.dayCount ?? null,
      notices: csv(meta.notices),
      declined: csv(meta.declined),
      gaps: csv(meta.gaps),
      sources: csv(meta.sources),
      moneyUnit: "decimal4-text",
      ratioUnit: "ratio4-half-even",
      countUnit: "integer",
    },
  };
}

function oneOf<T extends string>(allowed: readonly T[], value: EvidenceFieldValue | undefined, what: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`pack.meta: invalid ${what}`);
}

const manyOf = <T extends string>(allowed: readonly T[], value: EvidenceFieldValue | undefined, what: string): T[] =>
  unCsv(value).map((v) => oneOf(allowed, v, what));

const text = (value: EvidenceFieldValue | undefined, what: string): string => {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`pack.meta: missing ${what}`);
};

const SRC_KEYS: readonly SrcKey[] = ["ss", "sbs", "ssb"];

export function parseMeta(pack: EvidencePack): PackMeta {
  const fields = pack.items.find((item) => item.ref === META_REF)?.fields;
  if (fields === undefined) throw new Error("pack has no pack.meta");
  if (fields["packVersion"] !== MSX_PACK_VERSION || fields["featureId"] !== MSX_FEATURE_ID) throw new Error("pack.meta: not an msx pack");
  const baselineFrom = fields["baselineFrom"];
  return {
    templateId: oneOf(MSX_TEMPLATE_IDS, fields["templateId"], "templateId"),
    mode: oneOf(["store", "stores", "all_in_scope"] as const, fields["scopeMode"], "scopeMode"),
    storeRefs: unCsv(fields["storeRefs"]),
    from: text(fields["periodFrom"], "periodFrom"),
    to: text(fields["periodTo"], "periodTo"),
    dates: unCsv(fields["dates"]),
    currency: typeof fields["rankingCurrency"] === "string" ? fields["rankingCurrency"] : null,
    currencies: unCsv(fields["currencies"]),
    latestCurrentDate: typeof fields["latestCurrentDate"] === "string" ? fields["latestCurrentDate"] : null,
    compare: oneOf(["previous_period", "none"] as const, fields["compare"], "compare"),
    baseline:
      typeof baselineFrom === "string"
        ? { from: baselineFrom, to: text(fields["baselineTo"], "baselineTo"), dayCount: Number(fields["baselineDayCount"]) }
        : null,
    notices: manyOf(MSX_NOTICES, fields["notices"], "notice"),
    declined: manyOf(MSX_DECLINES, fields["declined"], "decline"),
    gaps: manyOf(MSX_GAPS, fields["gaps"], "gap"),
    sources: manyOf(SRC_KEYS, fields["sources"], "source"),
  };
}

export function ctxOfMeta(meta: PackMeta): TemplateCtx {
  return {
    templateId: meta.templateId,
    mode: meta.mode,
    storeRefs: meta.storeRefs,
    from: meta.from,
    to: meta.to,
    dates: meta.dates,
    currency: meta.currency,
    currencies: meta.currencies,
    latestCurrentDate: meta.latestCurrentDate,
  };
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/** A figure item: the value as the read returned it, and what kind of value it is. */
export function figureItem(ref: string, figure: FigureValue, metric: string, currency: string | undefined): EvidenceItem {
  return { ref, fields: { value: figure.value, unit: figure.unit, metric, currency: currency ?? null } };
}

export interface SourceFacts {
  readonly src: SrcKey;
  readonly asOf: string;
  readonly contractVersion: string;
  readonly scope: string;
  readonly from: string;
  readonly to: string;
  readonly storeCount: number;
}

export function sourceItem(facts: SourceFacts): EvidenceItem {
  return {
    ref: SRC_ITEM_REF[facts.src],
    fields: {
      route: SRC_ROUTE[facts.src],
      operationId: SRC_OPERATION[facts.src],
      contractVersion: facts.contractVersion,
      asOf: facts.asOf,
      completeness: "received_only",
      scope: facts.scope,
      from: facts.from,
      to: facts.to,
      storeCount: facts.storeCount,
    },
  };
}

const UNITS: readonly Unit[] = ["money", "count", "ratio", "date", "text", "flag"];

/** A `FigureSource` over the pack alone: what the renderer reads. Absent, or a null value, is undefined. */
export function packSource(pack: EvidencePack): FigureSource {
  const byRef = new Map(pack.items.map((item) => [item.ref, item.fields] as const));
  return {
    get(src, subject, range, metric, currency) {
      const fields = byRef.get(refOf(src, subject, range, metric, currency));
      const value = fields?.["value"];
      const unit = fields?.["unit"];
      if (value === undefined || value === null || typeof unit !== "string" || !(UNITS as readonly string[]).includes(unit)) return undefined;
      return { value, unit: unit as Unit };
    },
  };
}
