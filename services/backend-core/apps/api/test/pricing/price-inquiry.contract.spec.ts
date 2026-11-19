/**
 * apps/api/test/pricing/price-inquiry.contract.spec.ts
 *
 * RT-1151 (RT-282 PR-04, inquiry half): the Retail Pricing inquiry contract,
 * `pricing/price-inquiry.yaml` 1.0.0-draft. `[GATED]` contract-first; every
 * operation is `x-runtime-status: contract-only` until RT-1484 (PR-08).
 *
 * Structural / load-only plus AJV fixtures; no app boot and no HTTP. Pins:
 *   1. The three operations at their paths, contract-only with a note, and no
 *      operationId collision with any other contract.
 *   2. Auth: human `cookieAuth` only; scope never comes from a query field.
 *   3. Bitemporal parameters (`at`, `as_of_revision`) and the v1 Sell Unit.
 *   4. The shared `PricingProvenance` union (RT-282 PR-06/PR-07) and that
 *      `ResolvedPriceProvenance` carries every field of its `pricing` variant
 *      with the same wire shape.
 *   5. AJV fixtures for the resolution union, timeline and explain shapes.
 */
import "reflect-metadata";

import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  allContracts,
  contractDocument,
  contractReader,
  operationIdsExcept,
  type ApiPath,
  type ContractReader,
  type OpenApiDocument,
} from "../_helpers/openapi-contract";

const CONTRACT_ID = "price-inquiry";

const PRICE_PATH: ApiPath = "/api/v1/pricing/stores/{storeId}/products/{productId}/price";
const TIMELINE_PATH: ApiPath = "/api/v1/pricing/stores/{storeId}/products/{productId}/timeline";
const EXPLAIN_PATH: ApiPath = "/api/v1/pricing/stores/{storeId}/products/{productId}/explain";

const OPERATIONS: ReadonlyArray<{ id: string; path: ApiPath }> = [
  { id: "consoleGetStoreProductPrice", path: PRICE_PATH },
  { id: "consoleGetStoreProductPriceTimeline", path: TIMELINE_PATH },
  { id: "consoleExplainStoreProductPrice", path: EXPLAIN_PATH },
];

const STORE = "0192f000-0000-7000-8000-000000000001";
const PRODUCT = "0192f000-0000-7000-8000-000000000002";
const EVENT = "0192f000-0000-7000-8000-000000000003";
const BOOK = "0192f000-0000-7000-8000-000000000004";
const ZONE = "0192f000-0000-7000-8000-000000000005";
const EVENT_2 = "0192f000-0000-7000-8000-000000000006";
const CHANGE_SET = "0192f000-0000-7000-8000-000000000007";

let doc: OpenApiDocument;
let api: ContractReader;
let otherOperationIds: Set<string>;
// OpenAPI 3.1 schemas are JSON Schema 2020-12 (`prefixItems`, `if`/`then`).
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  doc = contractDocument(contracts, CONTRACT_ID);
  api = contractReader(doc);
  otherOperationIds = operationIdsExcept(contracts, CONTRACT_ID);
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function validator(name: string): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

const pricingProvenance = {
  origin: "pricing",
  sourceScope: "zone",
  priceEventId: EVENT,
  priceKind: "regular",
  pricingRevision: 418,
};

const resolvedProvenance = {
  ...pricingProvenance,
  priceBookId: BOOK,
  priceZoneId: ZONE,
  effectiveFrom: "2026-11-01T00:00:00+02:00",
  effectiveTo: null,
};

const priced = {
  status: "priced",
  price: "125.5000",
  currencyCode: "EGP",
  taxPriceBasis: "inclusive",
  sellUnit: "each",
  provenance: resolvedProvenance,
};

function explanationFixture() {
  return {
    storeId: STORE,
    productId: PRODUCT,
    sellUnit: "each",
    evaluatedAt: "2026-11-03T10:15:00+02:00",
    asOfRevision: 418,
    storeTimeZone: "Africa/Cairo",
    result: priced,
    layers: [
      { scope: "store", outcome: "none" },
      {
        scope: "zone",
        outcome: "selected",
        priceZoneId: ZONE,
        zoneMembership: "explicit",
        priceEventId: EVENT,
        price: "125.5000",
        effectiveFrom: "2026-11-01T00:00:00+02:00",
        effectiveTo: null,
        publishedInRevision: 418,
        changeSetId: CHANGE_SET,
      },
      {
        scope: "book",
        outcome: "shadowed",
        priceEventId: EVENT_2,
        price: "130.0000",
        effectiveFrom: "2026-10-01T00:00:00+02:00",
        effectiveTo: null,
        publishedInRevision: 400,
        changeSetId: CHANGE_SET,
      },
    ],
    next: { at: "2026-11-15T00:00:00+02:00", result: { ...priced, price: "119.9900" } },
  };
}

describe("price-inquiry contract — operations (RT-1151 PR-04)", () => {
  it("declares OpenAPI 3.1 at version 1.0.0-draft", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect((doc as unknown as { info: { version: string } }).info.version).toBe("1.0.0-draft");
  });

  it.each(OPERATIONS)("$id is a GET at its path, contract-only with a note", ({ id, path }) => {
    const op = api.get(path);
    expect(op.operationId).toBe(id);
    expect(op["x-runtime-status"]).toBe("contract-only");
    expect(String(op["x-runtime-note"] ?? "")).toMatch(/RT-1484/);
    expect(otherOperationIds.has(id)).toBe(false);
  });

  it.each(OPERATIONS)("$id is the human cookieAuth session only", ({ path }) => {
    expect(api.get(path).security).toEqual([{ cookieAuth: [] }]);
  });

  it.each(OPERATIONS)("$id never takes tenant or store scope from the query", ({ path }) => {
    const queryNames = api.params(path).filter((p) => p.in === "query").map((p) => p.name);
    expect(queryNames).not.toContain("tenant_id");
    expect(queryNames).not.toContain("store_id");
  });

  it.each(OPERATIONS)("$id documents 400, 401, 404, 422, 429 and 500", ({ path }) => {
    expect(Object.keys(api.get(path).responses ?? {}).sort()).toEqual(
      ["200", "400", "401", "404", "422", "429", "500"].sort(),
    );
  });

  it("the point reads are bitemporal (`at`, `as_of_revision`) with the v1 Sell Unit", () => {
    for (const path of [PRICE_PATH, EXPLAIN_PATH]) {
      expect(api.params(path).map((p) => p.name).sort()).toEqual(["as_of_revision", "at", "sell_unit"]);
      expect(api.param(path, "at").required).toBe(false);
      expect(api.param(path, "as_of_revision").required).toBe(false);
    }
    expect(api.shape(api.schema("SellUnit"))).toEqual({ type: "string", enum: ["each"], default: "each" });
  });

  it("the timeline takes a required [from, to) window", () => {
    expect(api.params(TIMELINE_PATH).map((p) => p.name).sort()).toEqual(["as_of_revision", "from", "sell_unit", "to"]);
    expect(api.param(TIMELINE_PATH, "from").required).toBe(true);
    expect(api.param(TIMELINE_PATH, "to").required).toBe(true);
    expect(api.responseDescription("TimelineValidationFailure")).toMatch(/366 days/);
  });

  it("an unknown revision is 422 pricing_revision_unknown", () => {
    expect(api.responseDescription("RevisionUnknown")).toMatch(/pricing_revision_unknown/);
  });

  it("states the authority rules: no ERPNext and no legacy fallback", () => {
    const description = String((doc as unknown as { info: { description: string } }).info.description);
    expect(description).toMatch(/never a fallback/);
    expect(description).toMatch(/never fall back to the legacy columns/);
  });
});

describe("price-inquiry contract — the shared provenance union (RT-282 PR-06/PR-07)", () => {
  it("is a discriminated union on `origin` with exactly the pricing and legacy variants", () => {
    const union = api.schema("PricingProvenance") as Record<string, unknown>;
    expect((union["discriminator"] as { propertyName: string }).propertyName).toBe("origin");
    expect(Object.keys((union["discriminator"] as { mapping: object }).mapping).sort()).toEqual(["legacy", "pricing"]);
  });

  it("the pricing variant has exactly the five backlog fields; the legacy variant has no event or kind", () => {
    expect(api.schema("PricingProvenancePricing").required?.sort()).toEqual(
      ["origin", "priceEventId", "priceKind", "pricingRevision", "sourceScope"].sort(),
    );
    const legacy = api.schema("PricingProvenanceLegacy");
    expect(Object.keys(legacy["properties"] as object).sort()).toEqual(["catalogCursor", "origin", "sourceScope"]);
  });

  it("ResolvedPriceProvenance carries every pricing-variant field with the same wire shape", () => {
    const variant = api.schema("PricingProvenancePricing")["properties"] as Record<string, unknown>;
    const resolved = api.schema("ResolvedPriceProvenance")["properties"] as Record<string, unknown>;
    for (const [name, schema] of Object.entries(variant)) {
      expect(api.shape(resolved[name])).toEqual(api.shape(schema));
    }
    expect(api.schema("ResolvedPriceProvenance").required).toEqual(
      expect.arrayContaining(api.schema("PricingProvenancePricing").required ?? []),
    );
  });

  it("accepts each variant and rejects mixed or incomplete ones", () => {
    const v = validator("PricingProvenance");
    expect(v(pricingProvenance)).toBe(true);
    expect(v({ origin: "legacy", sourceScope: "legacy_store", catalogCursor: "c:1042" })).toBe(true);
    expect(v({ origin: "legacy", sourceScope: "legacy_tenant", catalogCursor: "c:1", priceEventId: EVENT })).toBe(false);
    expect(v({ origin: "pricing", sourceScope: "legacy_store", priceEventId: EVENT, priceKind: "regular", pricingRevision: 1 })).toBe(false);
    expect(v({ ...pricingProvenance, pricingRevision: 0 })).toBe(false);
    expect(v({ origin: "pricing", sourceScope: "book" })).toBe(false);
    expect(v({ origin: "other", sourceScope: "book" })).toBe(false);
  });
});

describe("price-inquiry contract — AJV fixtures", () => {
  it("PriceResolution accepts priced, unpriced and error results", () => {
    const v = validator("PriceResolution");
    expect(v(priced)).toBe(true);
    expect(v({ status: "unpriced", reason: "no_price" })).toBe(true);
    expect(v({ status: "unpriced", reason: "no_price_book" })).toBe(true);
    expect(v({ status: "error", reason: "overlap_violation", eventIds: [EVENT, EVENT_2] })).toBe(true);
    expect(v({ status: "error", reason: "ambiguous_zone_membership", membershipIds: [EVENT, EVENT_2] })).toBe(true);
  });

  it("an error result carries the ids that match its reason, and only those", () => {
    const v = validator("PriceResolution");
    expect(v({ status: "error", reason: "overlap_violation" })).toBe(false);
    expect(v({ status: "error", reason: "overlap_violation", membershipIds: [EVENT, EVENT_2] })).toBe(false);
    expect(v({ status: "error", reason: "ambiguous_zone_membership", eventIds: [EVENT, EVENT_2] })).toBe(false);
    expect(v({ status: "error", reason: "overlap_violation", eventIds: [EVENT] })).toBe(false);
  });

  it("the provenance names a Zone exactly when the Zone layer was selected", () => {
    const v = validator("PriceResolution");
    expect(v({ ...priced, provenance: { ...resolvedProvenance, sourceScope: "zone", priceZoneId: null } })).toBe(false);
    expect(v({ ...priced, provenance: { ...resolvedProvenance, sourceScope: "store", priceZoneId: ZONE } })).toBe(false);
    expect(v({ ...priced, provenance: { ...resolvedProvenance, sourceScope: "book", priceZoneId: null } })).toBe(true);
  });

  it("PriceResolution rejects floats, foreign keys, tax and unknown reasons", () => {
    const v = validator("PriceResolution");
    expect(v({ ...priced, price: 125.5 })).toBe(false);
    expect(v({ ...priced, price: "125.12345" })).toBe(false);
    expect(v({ ...priced, taxAmount: "1.00" })).toBe(false);
    expect(v({ ...priced, provenance: { ...resolvedProvenance, origin: "legacy" } })).toBe(false);
    expect(v({ status: "unpriced", reason: "erp_missing" })).toBe(false);
    expect(v({ status: "priced", price: "1.00" })).toBe(false);
  });

  it("PriceInquiry wraps one resolution with the evaluated instant and revision", () => {
    const v = validator("PriceInquiry");
    const inquiry = {
      storeId: STORE,
      productId: PRODUCT,
      sellUnit: "each",
      evaluatedAt: "2026-11-03T10:15:00+02:00",
      asOfRevision: 418,
      storeTimeZone: "Africa/Cairo",
      result: priced,
    };
    expect(v(inquiry)).toBe(true);
    expect(v({ ...inquiry, asOfRevision: null, result: { status: "unpriced", reason: "no_price_book" } })).toBe(true);
    expect(v({ ...inquiry, tenantId: STORE })).toBe(false);
  });

  it("PriceTimeline is a list of segments, each with a resolution", () => {
    const v = validator("PriceTimeline");
    const timeline = {
      storeId: STORE,
      productId: PRODUCT,
      sellUnit: "each",
      from: "2026-11-01T00:00:00+02:00",
      to: "2026-12-01T00:00:00+02:00",
      asOfRevision: 418,
      storeTimeZone: "Africa/Cairo",
      segments: [
        { from: "2026-11-01T00:00:00+02:00", to: "2026-11-15T00:00:00+02:00", result: priced },
        { from: "2026-11-15T00:00:00+02:00", to: "2026-12-01T00:00:00+02:00", result: { status: "unpriced", reason: "no_price" } },
      ],
    };
    expect(v(timeline)).toBe(true);
    expect(v({ ...timeline, segments: [] })).toBe(false);
  });

  it("PriceExplanation has three layers and an optional next change", () => {
    const v = validator("PriceExplanation");
    const explanation = explanationFixture();
    expect(v(explanation)).toBe(true);
    expect(v({ ...explanation, next: null })).toBe(true);
    expect(v({ ...explanation, layers: explanation.layers.slice(0, 2) })).toBe(false);
    expect(v({ ...explanation, layers: [...explanation.layers.slice(0, 2), { scope: "book", outcome: "picked" }] })).toBe(false);
  });

  it("the layers are store, zone, book in that order, each with its own fields", () => {
    const v = validator("PriceExplanation");
    const [store, zone, book] = explanationFixture().layers;
    const base = explanationFixture();
    expect(v({ ...base, layers: [book, zone, store] })).toBe(false);
    expect(v({ ...base, layers: [store, zone, book, store] })).toBe(false);
    expect(v({ ...base, layers: [{ ...store, priceZoneId: ZONE }, zone, book] })).toBe(false);
    expect(v({ ...base, layers: [store, { scope: "zone", outcome: "none" }, book] })).toBe(false);
  });

  it("a selected or shadowed layer names its event; a none layer names none", () => {
    const v = validator("PriceExplanation");
    const [store, zone, book] = explanationFixture().layers;
    const base = explanationFixture();
    expect(v({ ...base, layers: [store, zone, { scope: "book", outcome: "shadowed" }] })).toBe(false);
    expect(v({ ...base, layers: [{ ...store, priceEventId: EVENT }, zone, book] })).toBe(false);
  });

  it("an error result reports the conflicting layer and stops", () => {
    const v = validator("PriceExplanation");
    const base = explanationFixture();
    expect(
      v({
        ...base,
        result: { status: "error", reason: "ambiguous_zone_membership", membershipIds: [ZONE, EVENT_2] },
        layers: [
          { scope: "store", outcome: "none" },
          { scope: "zone", outcome: "conflict", priceZoneId: null, zoneMembership: "ambiguous" },
          { scope: "book", outcome: "none" },
        ],
        next: null,
      }),
    ).toBe(true);
  });
});
