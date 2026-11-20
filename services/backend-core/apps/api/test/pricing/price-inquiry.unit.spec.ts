/**
 * RT-1484 (RT-282 PR-08b) — the pure "why this price" layer projection and the query DTOs of
 * `pricing/price-inquiry.yaml`. Every layer list is validated against the contract with AJV.
 * No database, no HTTP.
 */
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { PriceInquiryQuerySchema, PriceTimelineQuerySchema } from "../../src/pricing/inquiry/price-inquiry.dto";
import { explainLayers } from "../../src/pricing/inquiry/price-inquiry.projections";
import { traceResolution } from "../../src/pricing/resolution/resolve";
import type { ResolutionData } from "../../src/pricing/resolution/types";
import { allContracts, contractDocument } from "../_helpers/openapi-contract";
import {
  DEFAULT_ZONE,
  PRODUCT,
  ZONE_A,
  at,
  bookEvent,
  data,
  membership,
  store,
  storeEvent,
  zoneEvent,
} from "./resolution/fixtures";

const CONTRACT = "price-inquiry";
const CHANGE_SET = "00000000-0000-7000-8000-00000000c5e1";
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
let explanation: ValidateFunction;

beforeAll(() => {
  ajv.addSchema(contractDocument(allContracts(), CONTRACT) as object, CONTRACT);
  explanation = ajv.getSchema(`${CONTRACT}#/components/schemas/PriceExplanation`)!;
});

const layersOf = (d: ResolutionData) => {
  const trace = traceResolution(PRODUCT, "each", store(), at("2026-06-01T00:00:00Z"), 10, d);
  const layers = explainLayers(trace, "Africa/Cairo", () => CHANGE_SET);
  const body = {
    storeId: "00000000-0000-7000-8000-0000000000c1",
    productId: PRODUCT,
    sellUnit: "each",
    evaluatedAt: "2026-06-01T03:00:00+03:00",
    asOfRevision: 10,
    storeTimeZone: "Africa/Cairo",
    result: trace.result,
    layers,
    next: null,
  };
  if (!explanation(body)) throw new Error(`PriceExplanation violation: ${JSON.stringify(explanation.errors)}`);
  return layers.map((l) => ({ scope: l.scope, outcome: l.outcome, price: "price" in l ? l.price : undefined }));
};

describe("explainLayers (spec 041 §8; decisions 491, 699)", () => {
  it("a selected Store price shadows the Zone and Book prices", () => {
    const d = data({
      events: [bookEvent({ price: "130.0000" }), zoneEvent(ZONE_A, { price: "125.5000" }), storeEvent({ price: "119.9900" })],
      memberships: [membership(ZONE_A)],
    });
    expect(layersOf(d)).toEqual([
      { scope: "store", outcome: "selected", price: "119.9900" },
      { scope: "zone", outcome: "shadowed", price: "125.5000" },
      { scope: "book", outcome: "shadowed", price: "130.0000" },
    ]);
  });

  it("a selected default-Zone price: none above it, the Book shadowed below", () => {
    const d = data({ events: [bookEvent({ price: "130.0000" }), zoneEvent(DEFAULT_ZONE, { price: "125.5000" })] });
    const trace = traceResolution(PRODUCT, "each", store(), at("2026-06-01T00:00:00Z"), 10, d);
    const [, zone] = explainLayers(trace, "Africa/Cairo", () => CHANGE_SET);
    expect(zone).toMatchObject({ outcome: "selected", priceZoneId: DEFAULT_ZONE, zoneMembership: "default", changeSetId: CHANGE_SET });
    expect(layersOf(d).map((l) => l.outcome)).toEqual(["none", "selected", "shadowed"]);
  });

  it("no price: every layer is none", () => {
    expect(layersOf(data()).map((l) => l.outcome)).toEqual(["none", "none", "none"]);
  });

  it("no Book: every layer is none and the Zone is the null default", () => {
    const trace = traceResolution(PRODUCT, "each", store(), at("2026-06-01T00:00:00Z"), 10, data({ book: null }));
    expect(explainLayers(trace, "Africa/Cairo", () => CHANGE_SET)[1]).toEqual({
      scope: "zone",
      outcome: "none",
      priceZoneId: null,
      zoneMembership: "default",
    });
    expect(layersOf(data({ book: null })).map((l) => l.outcome)).toEqual(["none", "none", "none"]);
  });

  it("an ambiguous membership is the Zone conflict and stops the trace", () => {
    const d = data({
      events: [bookEvent()],
      memberships: [
        membership(ZONE_A, { id: "00000000-0000-7000-8000-0000000000f1" }),
        membership(DEFAULT_ZONE, { id: "00000000-0000-7000-8000-0000000000f2" }),
      ],
    });
    expect(layersOf(d).map((l) => l.outcome)).toEqual(["none", "conflict", "none"]);
  });

  it("a Store overlap is the Store conflict and stops the trace", () => {
    const d = data({ events: [bookEvent(), storeEvent(), storeEvent()] });
    expect(layersOf(d).map((l) => l.outcome)).toEqual(["conflict", "none", "none"]);
  });

  it("a not-representable selected price is still the selected layer", () => {
    const d = data({ events: [bookEvent({ price: "10.0050" })] });
    expect(layersOf(d)).toEqual([
      { scope: "store", outcome: "none", price: undefined },
      { scope: "zone", outcome: "none", price: undefined },
      { scope: "book", outcome: "selected", price: "10.0050" },
    ]);
  });

  it("an overlap below the selected layer is not shadowed (resolution never reaches it)", () => {
    const d = data({ events: [storeEvent(), bookEvent(), bookEvent()] });
    expect(layersOf(d).map((l) => l.outcome)).toEqual(["selected", "none", "none"]);
  });

  // RT-1484 comment 17874, follow-up 1: below a selected layer, the first defective layer and
  // every layer after it are `none` (resolution never reaches them), never `shadowed`.
  it("a Zone overlap below the selected Store hides the Book too (none, not shadowed)", () => {
    const d = data({
      events: [storeEvent(), zoneEvent(ZONE_A), zoneEvent(ZONE_A), bookEvent()],
      memberships: [membership(ZONE_A)],
    });
    expect(layersOf(d).map((l) => l.outcome)).toEqual(["selected", "none", "none"]);
  });

  it("an ambiguous membership below the selected Store: the Zone and Book are none, the Zone reports it", () => {
    const d = data({
      events: [storeEvent({ price: "119.9900" }), zoneEvent(ZONE_A), bookEvent()],
      memberships: [
        membership(ZONE_A, { id: "00000000-0000-7000-8000-0000000000f1" }),
        membership(DEFAULT_ZONE, { id: "00000000-0000-7000-8000-0000000000f2" }),
      ],
    });
    expect(layersOf(d).map((l) => l.outcome)).toEqual(["selected", "none", "none"]);
    const trace = traceResolution(PRODUCT, "each", store(), at("2026-06-01T00:00:00Z"), 10, d);
    expect(explainLayers(trace, "Africa/Cairo", () => CHANGE_SET)[1]).toEqual({
      scope: "zone",
      outcome: "none",
      priceZoneId: null,
      zoneMembership: "ambiguous",
    });
  });
});

describe("price-inquiry query DTOs", () => {
  it("accepts the documented parameters and refuses anything else", () => {
    expect(PriceInquiryQuerySchema.parse({ sell_unit: "each", at: "2026-06-01T00:00:00+02:00", as_of_revision: "3" })).toEqual({
      sell_unit: "each",
      at: "2026-06-01T00:00:00+02:00",
      as_of_revision: 3,
    });
    for (const bad of [{ sell_unit: "case" }, { at: "2026-06-01T00:00:00" }, { as_of_revision: "0" }, { store_id: "x" }]) {
      expect(PriceInquiryQuerySchema.safeParse(bad).success).toBe(false);
    }
  });

  it("the timeline needs from < to within 366 days", () => {
    const ok = { from: "2026-01-01T00:00:00Z", to: "2027-01-02T00:00:00Z" };
    expect(PriceTimelineQuerySchema.safeParse(ok).success).toBe(true);
    expect(PriceTimelineQuerySchema.safeParse({ ...ok, to: "2027-01-02T00:00:00.001Z" }).success).toBe(false);
    expect(PriceTimelineQuerySchema.safeParse({ ...ok, to: ok.from }).success).toBe(false);
    expect(PriceTimelineQuerySchema.safeParse({ from: ok.from }).success).toBe(false);
  });
});
