/**
 * RT-1484 (RT-282 PR-08b) — wire projections and errors of `pricing/price-inquiry.yaml`
 * 1.0.0-draft. Pure: the unit spec drives them with resolver traces.
 *
 * "Why this price" (spec 041 §8; decisions 491, 502-505, 699): the three layers in precedence
 * order. The first layer that decides the result is `selected` (its event is the result, or
 * would be but for representability) or `conflict` (the defect of a `status: error` result).
 * Layers above it held nothing (`none`). Below a `selected` layer, a layer with one event is
 * `shadowed` (what a reset would leave); below a `conflict`, every layer is `none` because
 * resolution stops at a defect. Below the selected layer, the first defective layer (an overlap,
 * or an ambiguous Zone membership) and every layer after it are `none`: resolution never reaches
 * them, and `conflict` belongs to an error result only (RT-1484 comment 17874).
 */
import { formatInstantInZone } from "../resolution/store-local-time";
import type { LayerEval, ResolutionTrace } from "../resolution/resolve";
import type { PriceResolution } from "../resolution/types";

/** A Store or product of another tenant, outside the caller's store scope, or absent → the non-disclosing 404. */
export class PriceInquiryNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "PriceInquiryNotFoundError";
  }
}

type Outcome = "selected" | "shadowed" | "none" | "conflict";

/** The event fields of a `selected` or `shadowed` layer. */
interface LayerEvent {
  readonly priceEventId: string;
  readonly price: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly publishedInRevision: number;
  readonly changeSetId: string;
}

type StoreLayerTrace = { readonly scope: "store"; readonly outcome: Outcome } & Partial<LayerEvent>;
type BookLayerTrace = { readonly scope: "book"; readonly outcome: Outcome } & Partial<LayerEvent>;
type ZoneLayerTrace = {
  readonly scope: "zone";
  readonly outcome: Outcome;
  readonly priceZoneId: string | null;
  readonly zoneMembership: "explicit" | "default" | "ambiguous";
} & Partial<LayerEvent>;

export type ExplainLayers = readonly [StoreLayerTrace, ZoneLayerTrace, BookLayerTrace];

/** One layer of the precedence walk: what it holds and whether it decides the result. */
interface Step {
  readonly layer: LayerEval;
  readonly decisive: boolean;
  readonly defect: boolean;
}

function stepOf(layer: LayerEval, ambiguous = false): Step {
  return {
    layer,
    decisive: ambiguous || layer.kind !== "none",
    defect: ambiguous || layer.kind === "overlap",
  };
}

function outcomes(steps: readonly Step[]): Outcome[] {
  const decider = steps.findIndex((s) => s.decisive);
  // Below the decider, the first defective layer and every layer after it are `none`: a reset of
  // the layers above would stop at that defect, so nothing below it is "what a reset would leave".
  const firstDefectBelow = steps.findIndex((s, i) => i > decider && s.defect);
  return steps.map((step, i) => {
    if (decider === -1 || i < decider) return "none";
    if (i === decider) return step.defect ? "conflict" : "selected";
    if (steps[decider]!.defect) return "none";
    if (firstDefectBelow !== -1 && i >= firstDefectBelow) return "none";
    return step.layer.kind === "one" ? "shadowed" : "none";
  });
}

function eventFields(layer: LayerEval, zone: string, changeSetOf: (eventId: string) => string): LayerEvent | null {
  if (layer.kind !== "one") return null;
  const { event, interval } = layer.candidate;
  return {
    priceEventId: event.id,
    price: event.price,
    effectiveFrom: formatInstantInZone(new Date(interval.from), zone),
    effectiveTo: interval.to === null ? null : formatInstantInZone(new Date(interval.to), zone),
    publishedInRevision: event.publishedInRevision,
    changeSetId: changeSetOf(event.id),
  };
}

const withEvent = (outcome: Outcome, fields: LayerEvent | null): Partial<LayerEvent> =>
  (outcome === "selected" || outcome === "shadowed") && fields !== null ? fields : {};

/**
 * The three explain layers of `trace` (`StoreLayerTrace`, `ZoneLayerTrace`, `BookLayerTrace`).
 * Without a Book there is no Zone either: the Zone layer is `none` with a null Zone and
 * `zoneMembership: default` (the contract's schema allows it; nothing resolves).
 */
export function explainLayers(
  trace: ResolutionTrace,
  storeTimeZone: string,
  changeSetOf: (eventId: string) => string,
): ExplainLayers {
  const zone = trace.zone;
  const steps = [
    stepOf(trace.store),
    stepOf(zone?.layer ?? { kind: "none" }, zone?.membership === "ambiguous"),
    stepOf(trace.book),
  ];
  const [storeOutcome, zoneOutcome, bookOutcome] = outcomes(steps) as [Outcome, Outcome, Outcome];
  const fields = (layer: LayerEval) => eventFields(layer, storeTimeZone, changeSetOf);
  return [
    { scope: "store", outcome: storeOutcome, ...withEvent(storeOutcome, fields(trace.store)) },
    {
      scope: "zone",
      outcome: zoneOutcome,
      priceZoneId: zone?.zoneId ?? null,
      zoneMembership: zone?.membership ?? "default",
      ...withEvent(zoneOutcome, fields(zone?.layer ?? { kind: "none" })),
    },
    { scope: "book", outcome: bookOutcome, ...withEvent(bookOutcome, fields(trace.book)) },
  ];
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

interface InquiryHead {
  readonly storeId: string;
  readonly productId: string;
  readonly sellUnit: "each";
  readonly asOfRevision: number | null;
  readonly storeTimeZone: string;
}

export interface PriceInquiryBody extends InquiryHead {
  readonly evaluatedAt: string;
  readonly result: PriceResolution;
}

export interface PriceTimelineBody extends InquiryHead {
  readonly from: string;
  readonly to: string;
  readonly segments: ReadonlyArray<{ readonly from: string; readonly to: string; readonly result: PriceResolution }>;
}

export interface PriceExplanationBody extends PriceInquiryBody {
  readonly layers: ExplainLayers;
  readonly next: { readonly at: string; readonly result: PriceResolution } | null;
}
